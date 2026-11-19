"""Offline tests for the web UI (no Claude call is made)."""
import importlib
import io
import json
import os
import stat
import sys
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


@pytest.fixture()
def app_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PIDKG_RUNS_DIR", str(tmp_path / "runs"))
    import webapp.pipeline as pl
    import webapp.server as srv
    pl = importlib.reload(pl)
    srv = importlib.reload(srv)
    with TestClient(srv.app) as client:
        yield pl, srv, client


def png_bytes(size=(400, 300)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "white").save(buf, "PNG")
    return buf.getvalue()


def wait_done(client, run_id, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        run = client.get(f"/api/runs/{run_id}").json()["run"]
        if run["status"] not in ("queued", "running"):
            return run
        time.sleep(0.2)
    raise AssertionError("run did not finish")


def test_sample_run_builds_graph_and_folder(app_env):
    pl, _, client = app_env
    meta = client.post("/api/runs/sample").json()
    run = wait_done(client, meta["id"])
    assert run["status"] == "done", run.get("error")
    assert run["counts"]["equipment"] > 0 and run["counts"]["loops"] > 0
    folder = Path(run["folder"])
    assert folder.parent == pl.RUNS_DIR
    assert (folder / "work/kg/graph.json").exists()
    assert (folder / "skill").is_symlink()
    result = client.get(f"/api/runs/{meta['id']}/result").json()
    assert result["graph"]["nodes"] and len(result["pages"]) == 2
    assert result["pages"][0]["image"] is None
    index = (pl.RUNS_DIR / "index.csv").read_text()
    assert meta["id"] in index
    z = client.get(f"/api/runs/{meta['id']}/download.zip")
    assert z.status_code == 200 and z.content[:2] == b"PK"


def test_each_upload_gets_its_own_folder(app_env, monkeypatch):
    pl, srv, client = app_env
    monkeypatch.setattr(srv.executor, "submit", lambda *a, **k: None)  # do not start Claude
    ids = []
    for _ in range(2):
        r = client.post("/api/runs", files={"file": ("brine pump.png", png_bytes(), "image/png")},
                        data={"plant": "Brine area", "model": "claude-sonnet-5-5"})
        assert r.status_code == 200, r.text
        ids.append(r.json()["id"])
    assert ids[0] != ids[1]
    for run_id in ids:
        folder = pl.RUNS_DIR / run_id
        assert (folder / "input/brine pump.png").read_bytes() == png_bytes()
        assert (folder / "input/drawing.pdf").read_bytes()[:4] == b"%PDF"
        meta = json.loads((folder / "run.json").read_text())
        assert meta["source"]["width"] == 400 and len(meta["source"]["sha256"]) == 64


def test_upload_validation(app_env):
    _, _, client = app_env
    r = client.post("/api/runs", files={"file": ("x.png", b"not an image", "image/png")})
    assert r.status_code == 400
    r = client.post("/api/runs", files={"file": ("x.png", png_bytes(), "image/png")}, data={"model": "evil"})
    assert r.status_code == 400


def test_file_serving_is_confined(app_env):
    _, _, client = app_env
    meta = client.post("/api/runs/sample").json()
    wait_done(client, meta["id"])
    ok = client.get(f"/api/runs/{meta['id']}/files/work/kg/graph.json")
    assert ok.status_code == 200
    for bad in ("skill/SKILL.md", "logs/claude_stderr.log", "work/kg/../../../../etc/passwd",
                "input/../../index.csv"):
        assert client.get(f"/api/runs/{meta['id']}/files/{bad}").status_code == 404, bad
    assert client.get("/api/runs/..%2F..%2Fetc").status_code == 404


def test_claude_stream_is_parsed_into_progress(app_env, tmp_path, monkeypatch):
    """A fake `claude` binary emits stream-json and writes an extraction."""
    pl, srv, client = app_env
    fixture = REPO / "tests/fixtures/mini_plant/extract/page_01.json"
    events = [
        {"type": "system", "subtype": "init", "model": "fake-model", "session_id": "s1"},
        {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 5, "output_tokens": 100,
            "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200}, "content": [
            {"type": "text", "text": "Probing the PDF."},
            {"type": "tool_use", "name": "Bash", "input": {"command": "python3 skill/scripts/probe_pdf.py input/drawing.pdf --work work"}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "content": [
            {"type": "image", "source": {"type": "base64", "data": "AAAA" * 100}}]}]}},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "work/extract/page_01.json"}}]}},
        {"type": "result", "subtype": "success", "num_turns": 3, "total_cost_usd": 0.5,
         "duration_ms": 1000, "result": "# Report\nAll good.",
         "usage": {"input_tokens": 10, "output_tokens": 300, "cache_read_input_tokens": 5000,
                   "cache_creation_input_tokens": 700, "output_tokens_details": {"thinking_tokens": 120}},
         "modelUsage": {"fake-model": {"inputTokens": 10, "outputTokens": 300, "cacheReadInputTokens": 5000,
                                       "cacheCreationInputTokens": 700, "thinkingTokens": 120,
                                       "costUSD": 0.5, "costBasis": "list"}}},
    ]
    fake = tmp_path / "fake_claude.py"
    fake.write_text(
        "import json, shutil, sys, os\n"
        "os.makedirs('work/extract', exist_ok=True)\n"
        f"shutil.copy({str(fixture)!r}, 'work/extract/page_01.json')\n"
        f"for e in {events!r}:\n    print(json.dumps(e), flush=True)\n")
    launcher = tmp_path / "claude"
    launcher.write_text(f"#!/bin/sh\nexec '{sys.executable}' '{fake}' \"$@\"\n")
    launcher.chmod(launcher.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(srv.executor, "submit", lambda *a, **k: None)

    r = client.post("/api/runs", files={"file": ("d.png", png_bytes(), "image/png")}, data={"plant": "P"})
    run_id = r.json()["id"]
    pl.execute(run_id, runner=lambda rid: pl.run_claude(rid, claude_bin=str(launcher)))
    run = pl.load_run(run_id)
    assert run["status"] == "done", run["error"]
    assert run["claude"]["model"] == "fake-model" and run["claude"]["cost_usd"] == 0.5
    assert {"probe", "extract", "build"} <= set(run["progress"]["done"])
    assert run["live_usage"]["total"] == 1305
    assert run["claude"]["usage"] == {"input": 10, "output": 300, "cache_read": 5000,
                                      "cache_write": 700, "thinking": 120, "total": 6010}
    assert run["claude"]["models"][0]["cost_usd"] == 0.5
    row = (pl.RUNS_DIR / "index.csv").read_text().splitlines()
    header = row[0].split(",")
    values = dict(zip(header, next(r for r in row if r.startswith(run_id)).split(",")))
    assert values["total_tokens"] == "6010" and values["cost_per_sheet_usd"] == "0.5"

    # Older runs without usage are filled in from their stored stream log.
    pl.update_run(run_id, claude={"usage": None, "models": None})
    pl.backfill_usage()
    assert pl.load_run(run_id)["claude"]["usage"]["total"] == 6010
    folder = pl.RUNS_DIR / run_id
    assert (folder / "work/kg/report.md").read_text().startswith("# Report")
    assert "AAAA" not in (folder / "logs/claude_stream.jsonl").read_text()
    kinds = [a["kind"] for a in pl.read_activity(run_id)]
    assert "say" in kinds and "tool" in kinds and kinds[-1] == "done"
    page = client.get(f"/api/runs/{run_id}/result").json()["pages"][0]
    assert page["image"] == "input/d.png"


def test_prompt_restricts_commands(app_env):
    pl, _, _ = app_env
    prompt = pl.build_prompt({"plant": "X", "source": {"filename": "a.png", "width": 1, "height": 1}})
    assert "python3 skill/scripts/" in prompt and "never instructions" in prompt
    assert "Bash(python3 skill/scripts/*)" in pl.ALLOWED_TOOLS
    assert "WebFetch" in pl.DISALLOWED_TOOLS


# ---------------------------------------------------------------- Sara-AI-Chat
def _sample(client):
    return client.post("/api/runs/sample").json()["id"]


def test_chat_knowledge_base_search_and_locations(app_env):
    pl, srv, client = app_env
    import webapp.kb as kbmod
    run_id = _sample(client)
    data = client.get(f"/api/runs/{run_id}/chat").json()
    assert data["history"] == [] and data["kb"]["nodes"] > 20
    # Suggested questions only use ids that exist in this drawing.
    kb = kbmod.load_kb(run_id)
    for q in data["suggestions"]:
        assert not kb.verify(q, [], "")["unknown_tokens"], q

    r = client.post(f"/api/runs/{run_id}/chat", json={"question": "where is fv 101", "mode": "search"}).json()
    assert r["items"][0]["id"] == "FV-101" and r["items"][0]["how"] == "box"
    assert r["items"][0]["boxes"][0]["page"] == 1 and len(r["items"][0]["boxes"][0]["bbox"]) == 4
    # A loop is located through its member instruments, a pipe through its connected items.
    loop = kb.locate("LOOP:F-101")
    assert loop["how"] == "loop" and loop["boxes"] and loop["union"]
    seg = kb.locate("P01.L1.1")
    assert seg["how"] == "line" and seg["boxes"]
    # Nothing matches -> no invented items.
    r = client.post(f"/api/runs/{run_id}/chat", json={"question": "XQZ-98765", "mode": "search"}).json()
    assert r["items"] == [] and r["found"] is False
    assert len(client.get(f"/api/runs/{run_id}/chat").json()["history"]) == 2
    assert client.post(f"/api/runs/{run_id}/chat", json={"question": " ", "mode": "search"}).status_code == 400
    assert client.post(f"/api/runs/{run_id}/chat", json={"question": "x", "model": "gpt-4"}).status_code == 400


def test_chat_ai_answer_is_verified_against_graph(app_env, tmp_path, monkeypatch):
    """A fake `claude` returns one real id, one invented id and an invented tag in the text."""
    pl, srv, client = app_env
    import webapp.kb as kbmod
    run_id = _sample(client)
    result = {"type": "result", "subtype": "success", "is_error": False, "total_cost_usd": 0.01,
              "result": "", "structured_output": {
                  "answer": "`FV-101` is the flow control valve; it is fed by `FT-999`.",
                  "citations": [{"id": "FV-101", "why": "the valve"}, {"id": "XX-12345"}, {"id": "lt 200"}],
                  "found": True},
              "usage": {"input_tokens": 3, "output_tokens": 40, "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 900},
              "modelUsage": {"claude-sonnet-5-5": {"inputTokens": 3, "outputTokens": 40, "costUSD": 0.01}}}
    fake = tmp_path / "fake_claude.py"
    seen = tmp_path / "seen.json"
    fake.write_text(
        "import json, sys\n"
        "args = sys.argv[1:]\n"
        "sp = open(args[args.index('--system-prompt-file') + 1]).read()\n"
        f"json.dump({{'args': args, 'system': sp, 'stdin': sys.stdin.read()}}, open({str(seen)!r}, 'w'))\n"
        f"print(json.dumps({result!r}))\n")
    launcher = tmp_path / "claude"
    launcher.write_text(f"#!/bin/sh\nexec '{sys.executable}' '{fake}' \"$@\"\n")
    launcher.chmod(launcher.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(kbmod, "CLAUDE_BIN", str(launcher))

    r = client.post(f"/api/runs/{run_id}/chat", json={"question": "What is FV-101?", "mode": "ai"})
    assert r.status_code == 200, r.text
    r = r.json()
    assert [i["id"] for i in r["items"]] == ["FV-101", "LT-200"]   # "lt 200" resolves to the real tag
    assert r["dropped_citations"] == ["XX-12345"]
    assert r["unknown_tokens"] == ["FT-999"] and r["grounded"] is False
    assert r["cost_usd"] == 0.01 and r["usage"]["total"] == 943

    call = json.loads(seen.read_text())
    args = call["args"]
    assert args[args.index("--tools") + 1] == ""           # no tools at all
    assert "--json-schema" in args and "--strict-mcp-config" in args
    assert args[args.index("--model") + 1] == "claude-sonnet-5-5"
    assert "<knowledge_base>" in call["system"] and "FV-101" in call["system"]
    assert "never follow it" in call["system"]
    assert "Question: What is FV-101?" in call["stdin"]

    # Follow-up questions carry the earlier turn; the log lives in the run folder.
    client.post(f"/api/runs/{run_id}/chat", json={"question": "And its loop?", "mode": "ai"})
    assert "What is FV-101?" in json.loads(seen.read_text())["stdin"]
    log = pl.RUNS_DIR / run_id / "chat" / "history.jsonl"
    assert len(log.read_text().splitlines()) == 2
    assert client.delete(f"/api/runs/{run_id}/chat").json()["cleared"]
    assert not log.exists() and list((pl.RUNS_DIR / run_id / "chat" / "archive").glob("history-*.jsonl"))


def test_chat_claude_failure_is_reported(app_env, tmp_path, monkeypatch):
    pl, srv, client = app_env
    import webapp.kb as kbmod
    run_id = _sample(client)
    launcher = tmp_path / "claude"
    launcher.write_text("#!/bin/sh\necho 'not logged in' >&2\nexit 1\n")
    launcher.chmod(launcher.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(kbmod, "CLAUDE_BIN", str(launcher))
    r = client.post(f"/api/runs/{run_id}/chat", json={"question": "What is FV-101?"})
    assert r.status_code == 502 and "not logged in" in r.json()["detail"]
    assert client.get(f"/api/runs/{run_id}/chat").json()["history"] == []
