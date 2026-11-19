# P&ID to Knowledge Graph

By Scott Duncan. Reach me on [LinkedIn](https://www.linkedin.com/in/s-r-duncan/) or at [scottduncanai.com](https://scottduncanai.com/).

**Turn P&ID drawings into a process knowledge graph that an LLM can reason over.**

`pid-to-kg` is a [Claude skill](https://code.claude.com/docs/en/skills) that reads piping and instrumentation diagrams (P&IDs) and PFDs from PDF and builds a knowledge graph of the process. The PDFs can be digital (exported from CAD) or scanned. The graph captures:

- **Process flow:** what is upstream and downstream of every tank, pump, valve and pipe segment.
- **Measurement:** which instrument measures which variable, and exactly where it sits in the flow.
- **Control:** control loops from sensor through controller to final element, including I/P relays, cascades, interlocks and VFD drives.

The output is meant to be one layer of a chemical-manufacturing **context layer**. An LLM application can query it to answer questions such as "what feeds this clarifier?", "which transmitters sit downstream of P-101?" or "what does FIC-0502 manipulate?" from the drawings themselves.

## Quick start: run the web app

The web app is the easiest way in. Upload a P&ID image, watch Claude read it, then explore the detections, the knowledge graph and the JSON, and ask questions about the drawing.

### 1. What you need

- **Python 3.10 or newer.** 3.12 is best: on 3.13 and later everything works, but without the OCR cross-check and automatic page orientation.
- **[Claude Code](https://code.claude.com/docs/en/overview)** (the `claude` command) installed. Check with `claude --version`.
- **A Claude account** that Claude Code is logged in to (next step).
- macOS or Linux. On Windows, use WSL, because each run folder links to the skill with a symlink.

### 2. Log in to your Claude account

The web app has no login screen of its own and never asks for an API key. Each run, and each Sara-AI-Chat answer, starts the `claude` command in the background **as the same user who started the server**. That command uses whatever account Claude Code is logged in to on this computer. Usage is counted against that account.

**Log in once, in a normal terminal, as the user who will run the server:**

```bash
claude auth login              # Claude subscription (Pro, Max, Team or Enterprise); opens the browser
claude auth login --sso        # if your organisation signs in with SSO
claude auth login --console    # Anthropic Console account instead (pay-as-you-go API billing)
```

You can also run `claude` and type `/login`. On macOS the sign-in is kept in the Keychain; on Linux it is kept under `~/.claude/`. You never copy it into this repository.

**Check that it works before starting the server:**

```bash
claude auth status --text      # login method, organisation, account, when the sign-in ends
claude -p "Reply with OK"      # a one-line test call; should print OK
```

**Which account pays.** With a subscription login, runs and chats count against your plan; with a Team or Enterprise account, they count against your organisation's plan, and your admin's model and usage limits apply. With a Console login they are billed to that Console organisation. The costs the app shows are Claude Code's own figures at API list prices.

**Watch for `ANTHROPIC_API_KEY`.** If this variable is set in the terminal where you start the server, Claude Code can use that key instead of your login, and billing then goes to the key's owner. Check with `echo $ANTHROPIC_API_KEY`, and run `unset ANTHROPIC_API_KEY` before starting the server unless you mean to use the key.

**When the sign-in ends** (`claude auth status --text` shows the date), new runs and chat answers fail with a login error. Run `claude auth login` again in a terminal and retry; you do not need to restart the server. A run that was already going when the sign-in ended has to be started again.

**Servers without a browser** (a remote machine or a service):
- Run `claude setup-token` on a computer where you can sign in. This needs a Claude subscription and creates a long-lived token.
- Give the token to the server process as the environment variable `CLAUDE_CODE_OAUTH_TOKEN`, using your secret manager or service configuration.
- Never put the token in this repository, in a README or in shell history, and revoke it when the server is retired.
- Anyone who can use the app then uses that account, so keep such a server off untrusted networks (see step 5).

### 3. Get the code and install the packages

```bash
git clone <this repository URL> PID-to-Knowledge-Graph
cd PID-to-Knowledge-Graph

python3 -m venv .venv
source .venv/bin/activate              # run this again in every new terminal
pip install -r webapp/requirements.txt
```

### 4. Install the skill in Claude Code (optional for the web app)

The web app always uses the skill inside this repository (`skills/pid-to-kg`), so it works without this step. Copy the skill only if you also want to use it directly in Claude Code (see [Using the skill directly in Claude Code](#using-the-skill-directly-in-claude-code-pdf)):

```bash
mkdir -p ~/.claude/skills
cp -R skills/pid-to-kg ~/.claude/skills/
```

### 5. Start the server

From the repository folder, with the virtual environment active:

```bash
uvicorn webapp.server:app --host 127.0.0.1 --port 8100
```

Open <http://127.0.0.1:8100>. Leave the terminal open while you use the app, and press **Ctrl+C** to stop it.

To let other computers on a **trusted** network open it, bind to all interfaces instead:

```bash
uvicorn webapp.server:app --host 0.0.0.0 --port 8100
```

They then use `http://<your computer's IP>:8100`. **The app has no login.** Anyone who can reach the port can see every uploaded drawing and start Claude runs and chats that are billed to your Claude account. Do not use `0.0.0.0` on public or shared Wi-Fi, and stop the server when you are done.

Start the server from a terminal where step 2's checks pass. The server passes that terminal's environment (`PATH`, any `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) on to Claude Code.

### 6. Use it

1. Click **Load bundled sample (no Claude call)** to check that everything works. It is instant and free.
2. Drop a P&ID image (PNG, JPEG, WebP or TIFF, up to 30 MB) on **New run**, give it a name, pick a Claude model, and click **Generate knowledge graph**.
3. Watch the step tracker and live activity. A sheet usually takes 5–20 minutes.
4. When it is done, explore the tabs (see [What the web app shows](#what-the-web-app-shows)), or open any earlier run from **Run history**.

### Restarting and troubleshooting

- **After changing or updating the code, restart the server** (Ctrl+C, then start it again) and reload the page with Cmd+Shift+R or Ctrl+Shift+R. A running server keeps the code it started with, so new features such as Sara-AI-Chat stay unavailable until you restart.
- **Wait until no run is in progress before restarting.** A restart marks unfinished runs as `interrupted`.
- **Port already in use:** pick another port (`--port 8700`), or find what is using it with `lsof -i :8100`.
- **`claude: command not found`:** install Claude Code (step 1), then start the server again from a terminal where `claude --version` works.
- **Runs or chat answers fail with a login, "not logged in" or authentication error:** run `claude auth status --text`, sign in again with `claude auth login`, and retry (step 2). Also check that `ANTHROPIC_API_KEY` is not set to an old key. A run's own error log is in `runs/<run>/logs/claude_stderr.log`.
- **Runs stop with a usage or rate limit message:** your plan's limit was reached. Wait for it to reset, choose a smaller model, or ask your admin.
- **`uvicorn: command not found`:** activate the virtual environment first (`source .venv/bin/activate`), or run `.venv/bin/python -m uvicorn ...`.

## What the web app shows

- **Detections**: the drawing with the extracted boxes drawn on it. Toggle buttons switch equipment, valves, instruments, off-page connectors, boundaries, process lines, signal lines and labels on and off. There is also a confidence filter, tag search and zoom/pan. Click a box to see its extraction JSON.
- **Graph**: an interactive knowledge graph with node-type and edge-type toggles.
- **JSON**: switch between `graph.json`, each `extract/page_NN.json`, `run.json` and `manifest.json`, with copy and download buttons.
- **Summary**, **QA issues** (filtered by severity), **Claude report** and the full **activity log**.
- **Sara-AI-Chat**: ask questions about the drawing, such as "where is XV-30792?", "what is on line 2"-H-1601-A28?" or "list the equipment". The knowledge base is the run's own `graph.json` and nothing else. Answers outline the items on the drawing with dotted boxes (a line is shown by the items on it, a loop by its members), and **Show in graph** highlights them in the graph. To keep answers grounded:
  - Claude runs with **no tools** and must return JSON listing the node ids it used.
  - The server **verifies** every answer. Cited ids that are not in the graph are dropped and reported, and any tag or line number in the text that is not in the graph is flagged in red.
  - Counts come from exact totals computed from the graph, not from Claude counting.
  - **Exact search (no AI, free)** answers tag and line-number lookups without calling Claude.
- **Usage**: every run and every chat answer shows its model, measured cost and tokens.

## Where results are saved

Every run gets its own folder under `runs/`, so drawings never mix:

```
runs/
  index.csv                                   one row per run (file, hash, counts, tokens, cost, folder)
  20261111-093144_brine-receiver_be7fcf/
    run.json                                  status, timings, model, cost, headline counts
    input/<original image>  input/drawing.pdf
    work/                                     the skill's work dir: manifest, pages/, hints/, extract/, kg/
    logs/activity.jsonl  logs/claude_stream.jsonl  logs/claude_stderr.log
    chat/history.jsonl  chat/archive/         Sara-AI-Chat questions, answers, citations, cost
```

**Download outputs (.zip)** on a run page packs the input, extraction, graph files and chat. Set `PIDKG_RUNS_DIR` to keep runs somewhere else. `runs/` is git-ignored because drawings are usually confidential; back it up like any other engineering data.

## Security, cost and quality notes

- **Sandbox.** Extraction runs use `claude -p --permission-mode acceptEdits` with an allow-list: Read/Write/Edit/Glob/Grep plus `Bash(python3 skill/scripts/*)`. Web tools and subagents are disabled. Chat answers run with no tools at all. Drawing text is treated as data, never as instructions.
- **No login.** Keep the server on `127.0.0.1` unless you need network access (see step 5). Everyone who can open the app uses the Claude account the server is logged in to.
- **One run at a time.** Later uploads wait in a queue.
- **Cost.** Runs and chats use your Claude Code plan or API credits. Costs are Claude Code's own measured figures at API list prices; on a subscription plan they count against your plan rather than being billed. A sheet on Opus 5.5 has cost about $3.50. A chat costs about $0.30 for the first question on a drawing (Sonnet 5.5) and about $0.02 for each one after that. Pick the model per run: Opus 5.5, Fable 5.2, Sonnet 5.5, Haiku 5.5 or the Claude Code default.
- **Review.** The output is machine-extracted. Check the QA tab before any engineering use (see [Disclaimer](#disclaimer)).

## Using the skill directly in Claude Code (PDF)

Without the web app, you can use the skill on multi-page PDF sets straight from Claude Code. No programming is needed.

1. **Install the skill.** Copy `skills/pid-to-kg` into your personal skills folder: `~/.claude/skills/` on macOS and Linux, `C:\Users\<your user name>\.claude\skills\` on Windows. The `.claude` folder is hidden: in Finder press **Cmd + Shift + .**, and in Windows File Explorer use **View → Show → Hidden items**.
2. **Add your P&IDs.** Put the PDF in a new project folder and open that folder in Claude Code. No P&IDs at hand? The [public chemical manufacturing datasets](https://github.com/ScottDuncanAI/public-chemical-manufacturing-datasets#pids) repo lists public P&ID sets from real facilities.
3. **Ask Claude to convert them**, for example:
   > Convert `haile.pdf` into a knowledge graph. The P&IDs are on pages 47–60.

   The skill loads by itself. The first time, Claude installs the Python packages it needs and asks before running commands. It may ask a question along the way, such as which revision to use when a PDF holds two versions of a drawing.
4. **Check the graph by asking questions** you can verify on the drawings, such as "What sensor measures the flow into TK-101, and where exactly is it?"

The results are saved in `work/<plant name>/kg/` inside your project folder. `summary.md` is a readable overview of the plant, and `qa_report.md` lists anything Claude could not confirm.

## How it works

![How the skill works: your P&ID PDF, Claude reads it, build and check, ask questions](docs/how-it-works.svg)

**Claude reads the drawings; Python scripts do everything else.** Recognising symbols and tracing lines needs visual judgement, so that part is Claude's. Preparing pages, building the graph and checking it are routine, so tested scripts do them the same way every time.

### 1. Preparing the pages

A script first looks at every page and works out what kind of drawing it is. Digital and scanned P&IDs need different handling:

| Page type | How to recognise it | What the skill does |
|---|---|---|
| **Digital, searchable text** | Exported from CAD; you can select the text in a PDF viewer | Renders the page straight from the vector data, so lines stay sharp at any zoom. The exact text in the PDF is used to cross-check the tags Claude reads. |
| **Digital, outlined text** | Looks digital, but the text can't be selected: every letter was drawn as shapes. Common in CAD exports. | Renders from the vector data at high resolution. Since there is no text to pull out, OCR (text recognition) reads the tags for the cross-check. |
| **Scanned** | Each page is a picture of a paper drawing | Takes the scanned image at its original resolution, enlarges it up to 2.5×, and boosts the contrast so faded lines and small text stand out. OCR reads the tags for the cross-check. Low-resolution scans are flagged, because small text may be lost. |
| **Scanned with OCR text** | A scan with a searchable text layer added | Handled like a scan. The added text layer is only used as a hint, since it often contains errors. |

Then, for every page:
- **Orientation:** the page is turned so the text is upright, since drawings are often stored sideways in a PDF.
- **Resolution:** chosen from the size of the drawing's text, so the smallest tags stay legible.
- **Tiles:** the sheet is cut into overlapping tiles, and blank tiles (empty margins, border lines) are skipped.

### 2. Claude reads each sheet

- Claude reads the whole sheet first, then every tile up close.
- It records equipment, pipe runs, valves, instruments, signal lines and off-page connectors.
- Each item gets the place on the sheet where it was found and a confidence level. Anything unreadable is marked as such, never guessed.
- Each sheet is saved to its own file before the next one starts, so large drawing sets don't overload Claude.

### 3. Building and checking the knowledge graph

The scripts turn Claude's readings into one connected knowledge graph:
- **Process flow:** each pipe is split into segments between its valves and fittings, and off-page connectors link the sheets, so flow can be traced upstream or downstream across the whole plant.
- **Measurement:** every instrument is attached to the exact pipe segment or vessel it measures.
- **Control:** loops are assembled from the instrument tags (per ISA-5.1) and the signal lines, from sensor to controller to valve or drive.

A QA report then lists anything doubtful: a sensor with no location, an off-page connector with no partner, a tag OCR saw that Claude didn't record. Claude re-checks each one on the drawing and rebuilds until the report is clean.

### 4. Asking questions

- `summary.md` is a readable overview to give an LLM as context.
- `graph.json` holds the full graph for any tool to read.
- `graph.duckdb` is a small database file for precise queries. Nothing needs a server.
- Every item records the sheet it came from, so any answer can be traced back to the drawing.

## Outputs

| File | What it is |
|---|---|
| `summary.md` | A readable overview of the plant: equipment-level flow, equipment, instruments with their locations, control loops and off-page links. This is the file to give an LLM as context. |
| `qa_report.md` | Errors, warnings and notes, each pointing to the part of the drawing to re-check |
| `graph.json` | The complete graph (schema: [`graph.schema.json`](skills/pid-to-kg/references/schema/graph.schema.json)) |
| `graph.duckdb` | The same graph as a [DuckDB](https://duckdb.org) database file, for SQL queries, including recursive upstream and downstream searches |

For larger projects, the graph can also be exported to Neo4j or to GraphML (for yEd, Gephi or NetworkX). Ask Claude to do it.

The node and edge types are described in [`references/ontology.md`](skills/pid-to-kg/references/ontology.md). Equipment and instruments also carry the closest [DEXPI](https://dexpi.org) class, the industry standard for exchanging P&ID data.

## Repository layout

```
webapp/
  server.py                   FastAPI app: uploads, run queue, results, files, chat API
  pipeline.py                 run folders, Claude Code runner, progress and cost tracking
  kb.py                       Sara-AI-Chat: knowledge base, search, grounded answers, verification
  static/                     the web page (index.html, app.js, style.css)
  requirements.txt            web app packages (includes the skill's requirements)
skills/pid-to-kg/
  SKILL.md                    workflow Claude follows
  references/                 extraction procedure, ISA-5.1 guide, symbol guide, ontology, JSON schemas
  scripts/                    probe, render, hints, build, query, export, eval, crop
  scripts/pidkg/              library: models, ISA parsing, builder, loops, QA, storage, summary
docs/                         README diagram
tests/                        pytest suite: synthetic two-sheet plant, synthetic PDFs, web app
runs/                         created at run time; one folder per web app run (git-ignored)
```

## Limitations

- **Extraction quality depends on legibility.** Low-resolution scans lose small text. Unreadable items are recorded as such, never guessed.
- **Loops come from ISA tag numbers and drawn signal lines.** Logic that lives only in control narratives or cause-and-effect charts is not on the P&ID and is not captured.
- **Line direction is taken from arrows and equipment logic.** Edges whose direction had to be inferred are marked `flow_direction: inferred`.
- **The DEXPI mapping is informative.** It is not a certified DEXPI export.

## Development

```bash
source .venv/bin/activate
pip install -e ".[dev]" -r webapp/requirements.txt httpx
pytest                                                        # no Claude calls; fake binaries stand in
python skills/pid-to-kg/scripts/build_kg.py --write-schemas   # after changing pidkg/models.py
```

## Disclaimer

The graph is machine-extracted from drawings. It must be reviewed by a qualified engineer before it is used for design, operations, management of change, or safety studies such as HAZOP or LOPA.

## License

MIT. See [LICENSE](LICENSE).
