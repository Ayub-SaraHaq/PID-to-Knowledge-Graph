"""Local web UI for the pid-to-kg skill.

Run from the repository root:

    .venv/bin/python -m uvicorn webapp.server:app --host 127.0.0.1 --port 8700

then open http://127.0.0.1:8700. Bind to 127.0.0.1 only: the app has no login.
"""
from __future__ import annotations

import io
import json
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import kb as kbmod
from . import pipeline as pl

STATIC = Path(__file__).resolve().parent / "static"
# Values are passed to `claude --model`. Cost per run is measured, not estimated:
# it comes from Claude Code's own report at the end of each run.
MODELS = [
    {"id": "default", "label": "Claude Code default", "note": "whatever your Claude Code is set to"},
    {"id": "claude-opus-5-5", "label": "Claude Opus 5.5", "note": "strong visual reading of dense sheets"},
    {"id": "claude-fable-5-2", "label": "Claude Fable 5.2", "note": ""},
    {"id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "note": "faster and cheaper"},
    {"id": "claude-haiku-5-5", "label": "Claude Haiku 5.5", "note": "fastest and cheapest; may miss small text"},
]
MODEL_IDS = {m["id"] for m in MODELS}

# One run at a time: each run is a long Claude Code session; queue the rest.
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pidkg-run")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    pl.recover_interrupted()
    pl.backfill_usage()
    pl.write_index()
    yield
    executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="P&ID to Knowledge Graph", lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def _run_or_404(run_id: str) -> Path:
    try:
        return pl.run_dir(run_id)
    except KeyError:
        raise HTTPException(404, "Run not found")


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse((STATIC / "index.html").read_text(encoding="utf-8"))


@app.get("/api/config")
def config() -> dict:
    return {"models": MODELS, "runs_dir": str(pl.RUNS_DIR), "steps": pl.STEPS,
            "step_labels": pl.STEP_LABELS, "max_upload_mb": pl.MAX_UPLOAD_BYTES // (1024 * 1024)}


@app.get("/api/runs")
def runs() -> list[dict]:
    return pl.list_runs()


@app.post("/api/runs")
async def create_run(file: UploadFile = File(...), plant: str = Form(""),
                     model: str = Form("default")) -> dict:
    if model not in MODEL_IDS:
        raise HTTPException(400, "Unknown model")
    data = await file.read(pl.MAX_UPLOAD_BYTES + 1)
    try:
        meta = pl.create_upload_run(data, file.filename or "drawing.png", plant, model)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    executor.submit(pl.execute, meta["id"])
    return meta


@app.post("/api/runs/sample")
def create_sample() -> dict:
    # Instant and free (no Claude call), so it does not wait in the Claude queue.
    meta = pl.create_sample_run()
    pl.execute(meta["id"])
    return pl.load_run(meta["id"])


@app.get("/api/runs/{run_id}")
def run_status(run_id: str, since: int = 0) -> dict:
    _run_or_404(run_id)
    return {"run": pl.load_run(run_id), "activity": pl.read_activity(run_id, since)}


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict:
    _run_or_404(run_id)
    return {"cancelled": pl.cancel(run_id)}


@app.get("/api/runs/{run_id}/result")
def run_result(run_id: str) -> JSONResponse:
    """Everything the result view needs in one response."""
    path = _run_or_404(run_id)
    work = path / "work"
    pages = []
    for page_file in sorted((work / "extract").glob("page_*.json")):
        page = pl.read_json(page_file)
        if not isinstance(page, dict):
            continue
        num = page.get("page", 0)
        image = None
        overview = work / "pages" / f"page_{num:02d}" / "overview.png"
        if overview.exists():
            image = f"work/pages/page_{num:02d}/overview.png"
        else:
            meta = pl.load_run(run_id)
            stored = (meta.get("source") or {}).get("stored_as")
            if stored and num == 1:
                image = stored
        pages.append({"file": f"work/extract/{page_file.name}", "page": num,
                      "image": image, "extraction": page})

    def text(rel: str) -> str | None:
        p = work / "kg" / rel
        return p.read_text(encoding="utf-8") if p.exists() else None

    return JSONResponse({
        "run": pl.load_run(run_id),
        "graph": pl.read_json(work / "kg" / "graph.json"),
        "pages": pages,
        "summary_md": text("summary.md"),
        "qa_md": text("qa_report.md"),
        "report_md": text("report.md"),
        "manifest": pl.read_json(work / "manifest.json"),
    })


def _allowed_file(path: Path, rel: str) -> Path:
    """Serve only known output locations inside the run folder."""
    allowed_prefixes = ("input/", "work/kg/", "work/extract/", "work/pages/", "work/hints/",
                        "work/manifest.json", "logs/activity.jsonl", "run.json")
    if not rel.startswith(allowed_prefixes) or "\\" in rel:
        raise HTTPException(404, "Not found")
    target = (path / rel).resolve()
    if not target.is_relative_to(path.resolve()) or not target.is_file():
        raise HTTPException(404, "Not found")
    return target


@app.get("/api/runs/{run_id}/files/{rel:path}")
def run_file(run_id: str, rel: str, download: bool = False) -> FileResponse:
    path = _run_or_404(run_id)
    target = _allowed_file(path, rel)
    return FileResponse(target, filename=target.name if download else None)


@app.get("/api/runs/{run_id}/download.zip")
def run_zip(run_id: str) -> Response:
    path = _run_or_404(run_id)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(path / "run.json", "run.json")
        for sub in ("input", "work/extract", "work/kg", "chat"):
            folder = path / sub
            if folder.is_dir():
                for f in sorted(folder.iterdir()):
                    if f.is_file():
                        zf.write(f, f.relative_to(path))
        if (path / "work" / "manifest.json").exists():
            zf.write(path / "work" / "manifest.json", "work/manifest.json")
    return Response(buffer.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{run_id}.zip"'})


# ---------------------------------------------------------------- Sara-AI-Chat
class ChatRequest(BaseModel):
    question: str = Field(..., max_length=kbmod.MAX_QUESTION_CHARS)
    model: str = "claude-sonnet-5-5"
    mode: str = "ai"  # "ai" (Claude, grounded and verified) or "search" (exact search, no AI)


def _kb_or_404(run_id: str) -> kbmod.KnowledgeBase:
    _run_or_404(run_id)
    try:
        return kbmod.load_kb(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))


@app.get("/api/runs/{run_id}/chat")
def chat_history(run_id: str) -> dict:
    kb = _kb_or_404(run_id)
    return {"history": [kbmod.enrich(kb, r) for r in kbmod.history(run_id)],
            "suggestions": kbmod.suggestions(kb),
            "kb": {"nodes": len(kb.nodes), "edges": len(kb.edges)}}


@app.post("/api/runs/{run_id}/chat")
def chat_ask(run_id: str, req: ChatRequest) -> dict:
    _kb_or_404(run_id)
    if req.model not in MODEL_IDS:
        raise HTTPException(400, "Unknown model")
    if req.mode not in ("ai", "search"):
        raise HTTPException(400, "Unknown mode")
    try:
        return kbmod.ask(run_id, req.question, req.model, req.mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except (RuntimeError, OSError, TimeoutError) as exc:
        raise HTTPException(502, f"{exc}. Try again, or use exact search (no AI).")
    except Exception as exc:  # subprocess.TimeoutExpired and friends
        raise HTTPException(502, f"Sara could not answer: {type(exc).__name__}. Try again, or use exact search.")


@app.delete("/api/runs/{run_id}/chat")
def chat_clear(run_id: str) -> dict:
    _run_or_404(run_id)
    kbmod.clear_history(run_id)
    return {"cleared": True}


@app.get("/api/runs.csv")
def runs_csv() -> FileResponse:
    pl.write_index()
    return FileResponse(pl.RUNS_DIR / "index.csv", filename="pid-runs-index.csv")


def main() -> None:  # pragma: no cover - convenience entry point
    import uvicorn
    uvicorn.run("webapp.server:app", host="127.0.0.1", port=8700)


if __name__ == "__main__":  # pragma: no cover
    main()
