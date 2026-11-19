/* P&ID -> Knowledge Graph web UI. All text from drawings/Claude is untrusted:
   it is inserted with textContent, and Markdown goes through DOMPurify. */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, ...kids) {
  const n = tag.startsWith("svg:") ? document.createElementNS(SVGNS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.setAttribute("class", v);
    else if (k === "text") n.textContent = v;
    else if (k === "style" && typeof v === "object") Object.entries(v).forEach(([p, x]) => n.style.setProperty(p, x));
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : String(kid));
  return n;
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
const hhmmss = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
function duration(a, b) {
  if (!a) return "";
  const s = Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2600);
}
function md(target, text, empty) {
  target.replaceChildren();
  if (!text) { target.append(el("p", { class: "hint", text: empty })); return; }
  const html = window.marked && window.DOMPurify
    ? DOMPurify.sanitize(marked.parse(text)) : null;
  if (html) target.innerHTML = html; else target.append(el("pre", { text }));
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

/* ---------------- categories ---------------- */
const DET = [
  { key: "equipment", label: "Equipment", color: "--c-equipment" },
  { key: "components", label: "Valves & fittings", color: "--c-component" },
  { key: "instruments", label: "Instruments", color: "--c-instrument" },
  { key: "off_page_connectors", label: "Off-page connectors", color: "--c-offpage" },
  { key: "boundaries", label: "Boundaries", color: "--c-boundary" },
  { key: "lines", label: "Process lines", color: "--c-line", conn: true },
  { key: "signals", label: "Signal lines", color: "--c-signal", conn: true },
  { key: "labels", label: "Labels", color: "--muted", pseudo: true },
];
const NODE_COLORS = {
  Equipment: "--c-equipment", Component: "--c-component", Instrument: "--c-instrument",
  OffPageConnector: "--c-offpage", Boundary: "--c-boundary", ControlLoop: "--c-loop",
  PipeSegment: "--c-pipe", Sheet: "--c-sheet", Plant: "--c-sheet",
};
const NODE_HIDDEN_DEFAULT = new Set(["Plant", "Sheet"]);

/* ---------------- state ---------------- */
const S = {
  config: null, runs: [], current: null, activityCount: 0, pollTimer: null,
  // Schematic process lines are busy on real sheets, so they start hidden.
  result: null, pageIdx: 0, detOn: new Set(DET.map((d) => d.key).filter((k) => k !== "lines")), minConf: 0,
  view: null, cy: null, nodeOn: new Set(), edgeOn: new Set(), jsonKey: "graph",
  qaOn: new Set(["error", "warning", "info"]), file: null,
  chat: { history: [], items: [], sel: null, mode: "ai", busy: false, view: null, size: null, page: null },
};

/* ---------------- boot ---------------- */
async function boot() {
  initTheme();
  initSidebar();
  S.config = await api("/api/config");
  // Older servers sent plain id strings; accept both shapes.
  S.config.models = (S.config.models || []).map((m) => (typeof m === "string" ? { id: m, label: m, note: "" } : m));
  $("#runsDir").textContent = `Saved to ${S.config.runs_dir}`;
  $("#modelSelect").onchange = renderModelNote;
  bindUpload();
  bindTabs();
  bindDetections();
  bindGraph();
  bindChat();
  $("#cancelBtn").onclick = cancelRun;
  await refreshRuns();
  const id = new URLSearchParams(location.hash.slice(1)).get("run");
  if (id && S.runs.some((r) => r.id === id)) openRun(id);
  window.addEventListener("hashchange", () => {
    const h = new URLSearchParams(location.hash.slice(1)).get("run");
    if (h && h !== S.current) openRun(h);
  });
  setInterval(() => { if (S.runs.some((r) => ["running", "queued"].includes(r.status))) refreshRuns(); }, 5000);
}

// Sidebar: collapse "New run" and drag the divider to give Run history more room.
// Layout is a per-viewer convenience, so it lives in localStorage (best effort).
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};
function initSidebar() {
  const card = $("#newRunCard"), btn = $("#collapseNew"), split = $("#sideSplit");
  const MIN = 90;
  const maxH = () => Math.max(MIN, $(".sidebar").clientHeight - split.offsetHeight - 160);
  const setH = (h) => { if (h == null) { card.style.height = ""; return; } card.style.height = `${Math.round(Math.min(maxH(), Math.max(MIN, h)))}px`; };
  const setCollapsed = (on) => {
    card.classList.toggle("collapsed", on);
    btn.textContent = on ? "▸ Show" : "▾ Hide";
    btn.setAttribute("aria-expanded", String(!on));
    if (on) card.style.height = ""; else { const h = store.get("pidkg.newRunH"); setH(h ? +h : null); }
    store.set("pidkg.newRunCollapsed", on ? "1" : null);
  };
  btn.onclick = () => setCollapsed(!card.classList.contains("collapsed"));
  setCollapsed(store.get("pidkg.newRunCollapsed") === "1");

  let start = null;
  split.addEventListener("pointerdown", (e) => {
    if (card.classList.contains("collapsed")) return;
    start = { y: e.clientY, h: card.getBoundingClientRect().height };
    split.setPointerCapture(e.pointerId); split.classList.add("dragging"); e.preventDefault();
  });
  split.addEventListener("pointermove", (e) => { if (start) setH(start.h + e.clientY - start.y); });
  const end = () => {
    if (!start) return; start = null; split.classList.remove("dragging");
    store.set("pidkg.newRunH", String(card.getBoundingClientRect().height));
  };
  split.addEventListener("pointerup", end); split.addEventListener("pointercancel", end);
  split.ondblclick = () => { setH(null); store.set("pidkg.newRunH", null); };
  split.onkeydown = (e) => {
    if (card.classList.contains("collapsed") || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    setH(card.getBoundingClientRect().height + (e.key === "ArrowDown" ? 24 : -24));
    store.set("pidkg.newRunH", String(card.getBoundingClientRect().height));
  };
  window.addEventListener("resize", () => { if (card.style.height) setH(parseFloat(card.style.height)); });
}

function initTheme() {
  let t = null;
  try { t = localStorage.getItem("pidkg-theme"); } catch (_) {}
  if (t) document.documentElement.dataset.theme = t;
  $("#themeBtn").onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("pidkg-theme", next); } catch (_) {}
    if (S.result) { renderOverlay(); renderGraph(); }
  };
}

/* ---------------- upload ---------------- */
function bindUpload() {
  const drop = $("#drop"), input = $("#fileInput");
  const setFile = (f) => {
    if (!f) return;
    S.file = f;
    $("#dropText").replaceChildren(el("strong", { text: f.name }), el("br"), `${(f.size / 1048576).toFixed(1)} MB · click to change`);
    const img = $("#dropPreview");
    if (/image\/(png|jpeg|webp)/.test(f.type)) { img.src = URL.createObjectURL(f); img.hidden = false; } else img.hidden = true;
    if (!$("#plantInput").value) $("#plantInput").value = f.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").slice(0, 80);
    $("#runBtn").disabled = false;
  };
  input.onchange = () => setFile(input.files[0]);
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));

  $("#uploadForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!S.file) return;
    const fd = new FormData();
    fd.append("file", S.file);
    fd.append("plant", $("#plantInput").value);
    fd.append("model", $("#modelSelect").value);
    $("#runBtn").disabled = true; $("#runBtn").textContent = "Uploading…";
    try {
      const meta = await api("/api/runs", { method: "POST", body: fd });
      await refreshRuns(); openRun(meta.id);
      toast("Run started. Its folder: " + meta.folder);
    } catch (err) { toast("Upload failed: " + err.message); }
    finally { $("#runBtn").disabled = false; $("#runBtn").textContent = "Generate knowledge graph"; }
  };
  $("#sampleBtn").onclick = async () => {
    try { const meta = await api("/api/runs/sample", { method: "POST" }); await refreshRuns(); openRun(meta.id); }
    catch (err) { toast(err.message); }
  };
}

/* ---------------- run list ---------------- */
/* ---------------- tokens & cost ---------------- */
const fmtTok = (n) => n == null ? "–" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
const fmtUsd = (v) => v == null ? "–" : "$" + Number(v).toFixed(Number(v) < 1 ? 3 : 2);
const runCost = (r) => (r.claude || {}).cost_usd;
const runTokens = (r) => ((r.claude || {}).usage || {}).total ?? (r.live_usage || {}).total;
const modelLabel = (id) => (S.config.models.find((m) => m.id === id) || {}).label || id;

// Measured averages from this machine's completed runs, by the model Claude Code reported.
function modelStats() {
  const by = {};
  for (const r of S.runs) {
    if (r.status !== "done" || runCost(r) == null) continue;
    const key = r.model && r.model !== "default" ? r.model : "default";
    const real = (r.claude || {}).model;
    for (const k of new Set([key, real])) {
      if (!k) continue;
      const b = (by[k] ||= { n: 0, cost: 0, tok: 0, sheets: 0 });
      b.n++; b.cost += runCost(r); b.tok += runTokens(r) || 0; b.sheets += (r.counts || {}).pages || 1;
    }
  }
  return by;
}
function renderModelSelect() {
  const sel = $("#modelSelect"); const keep = sel.value; const st = modelStats();
  sel.replaceChildren(...S.config.models.map((m) => {
    const b = st[m.id];
    return el("option", { value: m.id, text: m.label + (b ? ` · avg ${fmtUsd(b.cost / b.sheets)}/sheet` : "") });
  }));
  if (keep) sel.value = keep;
  renderModelNote();
}
function renderModelNote() {
  const m = S.config.models.find((x) => x.id === $("#modelSelect").value) || {};
  const b = modelStats()[m.id];
  const parts = [m.note, b ? `${b.n} run${b.n > 1 ? "s" : ""} so far: avg ${fmtUsd(b.cost / b.n)} and ${fmtTok(b.tok / b.n)} tokens per request` : "no runs with this model yet"];
  $("#modelNote").textContent = parts.filter(Boolean).join(" · ");
}
function renderTotals() {
  const done = S.runs.filter((r) => runCost(r) != null);
  const cost = done.reduce((a, r) => a + runCost(r), 0), tok = done.reduce((a, r) => a + (runTokens(r) || 0), 0);
  $("#runTotals").replaceChildren(
    el("div", {}, el("b", { text: S.runs.length }), el("span", { text: "runs" })),
    el("div", { title: "Sum of Claude Code's reported cost for all runs" }, el("b", { text: fmtUsd(cost) }), el("span", { text: "total cost" })),
    el("div", {}, el("b", { text: fmtTok(tok) }), el("span", { text: "total tokens" })));
}

async function refreshRuns() {
  S.runs = await api("/api/runs");
  renderTotals(); renderModelSelect();
  const ul = $("#runList"); ul.replaceChildren();
  if (!S.runs.length) ul.append(el("li", { class: "hint", text: "No runs yet." }));
  for (const r of S.runs) {
    const c = r.counts || {};
    const sub = r.status === "done"
      ? `${c.equipment ?? 0} equip · ${c.instruments ?? 0} instr · ${c.loops ?? 0} loops`
      : r.status;
    ul.append(el("li", { class: r.id === S.current ? "active" : "", onclick: () => openRun(r.id), title: r.id },
      el("div", { class: "t" }, el("span", { class: `dot ${r.status}` }), el("span", { text: r.plant })),
      el("div", { class: "s", text: `${fmtTime(r.created_at)} · ${(r.source || {}).filename || ""}` }),
      el("div", { class: "s", text: sub }),
      runCost(r) != null || runTokens(r) ? el("div", { class: "s mono", text: `${fmtUsd(runCost(r))} · ${fmtTok(runTokens(r))} tokens · ${modelLabel((r.claude || {}).model || r.model)}` }) : null));
  }
}

/* ---------------- run view ---------------- */
async function openRun(id) {
  clearTimeout(S.pollTimer);
  S.current = id; S.activityCount = 0; S.result = null;
  history.replaceState(null, "", "#run=" + encodeURIComponent(id));
  $$("#runList li").forEach((li) => li.classList.toggle("active", li.title === id));
  $("#emptyState").hidden = true; $("#runView").hidden = false;
  $("#feed").replaceChildren(); $("#feedAll").replaceChildren();
  $("#resultView").hidden = true; $("#progressView").hidden = true; $("#errorBox").hidden = true;
  await poll();
}

async function poll() {
  const id = S.current;
  let data;
  try { data = await api(`/api/runs/${id}?since=${S.activityCount}`); }
  catch (err) { toast(err.message); return; }
  if (id !== S.current) return;
  const run = data.run;
  S.activityCount += data.activity.length;
  data.activity.forEach((a) => { addFeed($("#feed"), a); addFeed($("#feedAll"), a); });
  renderHead(run);
  const active = ["running", "queued"].includes(run.status);
  $("#progressView").hidden = !active && run.status === "done";
  renderStepper(run);
  if (run.error) { $("#errorBox").hidden = false; $("#errorBox").textContent = run.error; }
  if (active) { S.pollTimer = setTimeout(poll, 2000); return; }
  if (run.status === "done" && !S.result) { await loadResult(id); refreshRuns(); }
  else if (!active) { refreshRuns(); }
}

function renderHead(run) {
  $("#rvTitle").textContent = run.plant;
  const st = $("#rvStatus"); st.className = `status ${run.status}`; st.textContent = run.status;
  const src = run.source || {};
  const parts = [src.filename, src.width ? `${src.width}×${src.height}px` : null,
    `model: ${(run.claude || {}).model || run.model}`, `started ${fmtTime(run.started_at || run.created_at)}`,
    run.started_at ? `took ${duration(run.started_at, run.finished_at)}` : null,
    runCost(run) != null ? `cost ${fmtUsd(runCost(run))}` : null,
    runTokens(run) ? `${fmtTok(runTokens(run))} tokens` : null];
  $("#rvMeta").textContent = parts.filter(Boolean).join(" · ");
  $("#rvFolder").textContent = run.folder;
  $("#cancelBtn").hidden = !["running", "queued"].includes(run.status);
  const zip = $("#zipBtn"); zip.hidden = run.status !== "done"; zip.href = `/api/runs/${run.id}/download.zip`;
  $("#elapsed").textContent = run.started_at ? duration(run.started_at, run.finished_at) : "queued";
  const live = run.live_usage;
  $("#liveTokens").textContent = live ? `${fmtTok(live.total)} tokens so far ·` : "";
}

function renderStepper(run) {
  const ol = $("#stepper"); ol.replaceChildren();
  const prog = run.progress || {}; const done = new Set(prog.done || []);
  S.config.steps.forEach((s, i) => {
    const cur = s === prog.step && run.status !== "done";
    ol.append(el("li", { "data-n": i + 1, class: cur ? "current" : done.has(s) || run.status === "done" ? "done" : "",
      text: S.config.step_labels[s] + (s === "qa" && prog.builds > 1 ? ` ×${prog.builds - 1}` : "") }));
  });
}

function addFeed(ul, a) {
  const atBottom = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
  const kind = a.kind === "tool" ? (a.tool || "tool") : a.kind;
  ul.append(el("li", { class: a.kind }, el("span", { class: "time", text: hhmmss(a.t) }),
    el("span", { class: "kind", text: kind }), el("span", { class: "msg", text: a.text })));
  if (atBottom) ul.scrollTop = ul.scrollHeight;
}

async function cancelRun() {
  if (!confirm("Cancel this run? The Claude Code session will be stopped.")) return;
  await api(`/api/runs/${S.current}/cancel`, { method: "POST" });
  toast("Cancelling…");
}

/* ---------------- result ---------------- */
async function loadResult(id) {
  const res = await api(`/api/runs/${id}/result`);
  if (id !== S.current) return;
  S.result = res; S.pageIdx = 0;
  $("#resultView").hidden = false;
  renderStats(); renderUsage(res.run); renderPageSelect(); renderDetToggles(); renderOverlay(true);
  initGraphToggles(); renderGraph();
  renderJsonToggles(); renderJson();
  md($("#tab-summary"), res.summary_md, "No summary.md was written.");
  md($("#tab-report"), res.report_md, res.run.mode === "sample" ? "Sample runs have no Claude report." : "Claude did not write a final report.");
  renderQa();
  loadChat(id);
}

function renderUsage(run) {
  const c = run.claude || {}, u = c.usage;
  const cards = $("#usageCards"), table = $("#usageModels");
  table.replaceChildren(); $("#usageBasis").textContent = "";
  if (run.mode === "sample") {
    cards.replaceChildren(el("p", { class: "hint", text: "Sample run: built from the bundled extraction, no Claude call, $0." }));
    return;
  }
  if (!u) {
    cards.replaceChildren(el("p", { class: "hint", text: c.cost_usd != null ? `Cost ${fmtUsd(c.cost_usd)}; token details were not recorded for this run.` : "Claude Code did not report usage for this run." }));
    return;
  }
  const sheets = (run.counts || {}).pages || 1;
  const card = (v, l, cls, title) => el("div", { class: "ustat" + (cls ? " " + cls : ""), title }, el("div", { class: "v", text: v }), el("div", { class: "l", text: l }));
  cards.replaceChildren(
    card(fmtUsd(c.cost_usd), "Cost of this request", "hero", "As reported by Claude Code at the end of the run"),
    card(fmtUsd(c.cost_usd / sheets), `Cost per P&ID sheet (${sheets} sheet${sheets > 1 ? "s" : ""})`),
    card(fmtTok(u.total), "Total tokens"),
    card(fmtTok(u.input), "Input (uncached)", null, String(u.input)),
    card(fmtTok(u.cache_write), "Cache write", null, String(u.cache_write)),
    card(fmtTok(u.cache_read), "Cache read", null, String(u.cache_read)),
    card(fmtTok(u.output), "Output", null, `${u.output} incl. ${u.thinking} thinking`),
    card(fmtTok(u.thinking), "of which thinking"),
    card(c.turns ?? "–", "Turns"),
    card(c.duration_ms ? duration(new Date(0).toISOString(), new Date(c.duration_ms).toISOString()) : "–", "Claude time"));
  const parts = [["input", u.input, "--c-equipment"], ["cache write", u.cache_write, "--c-offpage"], ["cache read", u.cache_read, "--c-boundary"], ["output", u.output, "--c-component"]];
  const tot = parts.reduce((a, p) => a + p[1], 0) || 1;
  const bar = el("div", { class: "bar" }, parts.map(([l, v, col]) => el("span", { title: `${l}: ${v.toLocaleString()}`, style: { width: (100 * v / tot) + "%", background: `var(${col})` } })));
  const legend = el("div", { class: "legend" }, parts.map(([l, v, col]) => el("span", {}, el("i", { style: { background: `var(${col})` } }), `${l} ${(100 * v / tot).toFixed(1)}%`)));
  $$("#usage .bar, #usage .legend").forEach((n) => n.remove());
  cards.after(bar, legend);
  const basis = (c.models || []).map((m) => m.cost_basis).filter(Boolean)[0];
  $("#usageBasis").textContent = basis === "list" ? "Cost at API list prices; on a Claude subscription plan this is usage against your plan, not a bill." : "";
  if ((c.models || []).length) {
    const num = (v) => el("td", { class: "num", text: typeof v === "number" ? v.toLocaleString() : v });
    table.replaceChildren(
      el("thead", {}, el("tr", {}, el("th", { text: "Model" }), ...["Input", "Cache write", "Cache read", "Output", "Thinking", "Cost"].map((h) => el("th", { class: "num", text: h })))),
      el("tbody", {}, c.models.map((m) => el("tr", {}, el("td", { text: modelLabel(m.model) }), num(m.input), num(m.cache_write), num(m.cache_read), num(m.output), num(m.thinking), num(fmtUsd(m.cost_usd))))));
  }
}

function renderStats() {
  const g = S.result.graph || { nodes: [], edges: [], issues: [] };
  const by = {}; g.nodes.forEach((n) => (by[n.type] = (by[n.type] || 0) + 1));
  const sev = (g.stats || {}).issues_by_severity || {};
  const items = [
    ["Equipment", by.Equipment, "--c-equipment"], ["Valves & fittings", by.Component, "--c-component"],
    ["Instruments", by.Instrument, "--c-instrument"], ["Control loops", by.ControlLoop, "--c-loop"],
    ["Pipe segments", by.PipeSegment, "--c-pipe"], ["Graph edges", g.edges.length, "--accent"],
    ["QA errors", sev.error, "--danger"], ["QA warnings", sev.warning, "--warn"],
  ];
  $("#stats").replaceChildren(...items.map(([l, v, c]) =>
    el("div", { class: "stat", style: { "--sc": `var(${c})` } }, el("div", { class: "v", text: v ?? 0 }), el("div", { class: "l", text: l }))));
}

function bindTabs() {
  $$(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
}
function showTab(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tabpanel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  if (name === "graph" && S.cy) { S.cy.resize(); S.cy.fit(undefined, 30); }
  if (name === "detections") fitOverlay();
  if (name === "chat") { renderChatView(); setTimeout(() => $("#chatInput").focus(), 0); }
}

/* ---------------- detections overlay ---------------- */
function page() { return S.result.pages[S.pageIdx]; }

function renderPageSelect() {
  const sel = $("#pageSelect"); sel.replaceChildren();
  S.result.pages.forEach((p, i) => sel.append(el("option", { value: i, text: `Page ${p.page}${p.extraction.sheet?.drawing_number ? " · " + p.extraction.sheet.drawing_number : ""}` })));
  sel.hidden = S.result.pages.length < 2;
  sel.onchange = () => { S.pageIdx = +sel.value; renderDetToggles(); renderOverlay(true); };
}

function renderDetToggles() {
  const ex = page()?.extraction || {};
  const box = $("#detToggles"); box.replaceChildren();
  for (const d of DET) {
    const n = d.pseudo ? null : (ex[d.key] || []).length;
    const chip = el("span", { class: "chip" + (S.detOn.has(d.key) ? " on" : ""), style: { "--cc": `var(${d.color})` }, role: "switch",
      "aria-checked": S.detOn.has(d.key), tabindex: 0 },
      el("span", { class: "sw" }), d.label, n != null ? el("span", { class: "n", text: n }) : null);
    const flip = () => { S.detOn.has(d.key) ? S.detOn.delete(d.key) : S.detOn.add(d.key); renderDetToggles(); renderOverlay(); };
    chip.onclick = flip; chip.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } };
    box.append(chip);
  }
}

function itemIndex(ex) {
  const idx = {};
  for (const k of ["equipment", "components", "instruments", "off_page_connectors", "boundaries"])
    for (const it of ex[k] || []) idx[it.id] = { ...it, _cat: k };
  return idx;
}
// Tag if printed, else the short id: long descriptions stay in the tooltip and details panel.
const shortLabel = (it) => { const t = it.tag || it.id || ""; return t.length > 18 ? t.slice(0, 17) + "…" : t; };
const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

function renderOverlay(resetView) {
  const svg = $("#overlay"); svg.replaceChildren();
  const p = page();
  if (!p) return;
  const ex = p.extraction;
  const img = p.image ? `/api/runs/${S.current}/files/${p.image}` : null;
  $("#noImage").hidden = !!img;
  const draw = (W, H) => {
    S.size = [W, H];
    if (resetView || !S.view) S.view = [0, 0, W, H];
    applyView();
    if (img) svg.append(el("svg:image", { href: img, x: 0, y: 0, width: W, height: H }));
    else svg.append(el("svg:rect", { x: 0, y: 0, width: W, height: H, fill: cssVar("--panel") }));
    const idx = itemIndex(ex);
    const fs = Math.max(10, W / 110);
    const toPt = (b) => center(b).map((v, i) => v * (i ? H : W));
    const conn = svg.appendChild(el("svg:g"));
    if (S.detOn.has("lines")) {
      for (const ln of ex.lines || []) {
        const ids = [ln.from, ...(ln.path || []), ln.to].map((e) => typeof e === "string" ? e : e && (e.item || e.after));
        const pts = ids.map((i) => idx[i]?.bbox).filter(Boolean).map(toPt);
        if (pts.length > 1) conn.append(el("svg:polyline", { class: "conn line", points: pts.map((q) => q.join(",")).join(" ") }));
      }
    }
    if (S.detOn.has("signals")) {
      for (const sg of ex.signals || []) {
        const a = idx[sg.from]?.bbox, b = idx[sg.to]?.bbox;
        if (a && b) { const [x1, y1] = toPt(a), [x2, y2] = toPt(b); conn.append(el("svg:line", { class: "conn signal", x1, y1, x2, y2 })); }
      }
    }
    for (const d of DET) {
      if (d.conn || d.pseudo || !S.detOn.has(d.key)) continue;
      for (const it of ex[d.key] || []) {
        if (!it.bbox || (it.confidence ?? 1) < S.minConf) continue;
        const [x0, y0, x1, y1] = it.bbox;
        const g = el("svg:g", { class: "det" + ((it.confidence ?? 1) < 0.7 ? " lowconf" : ""), "data-id": it.id, style: { "--dc": `var(${d.color})` },
          onclick: (e) => { e.stopPropagation(); selectDet(it, d); } },
          el("svg:rect", { x: x0 * W, y: y0 * H, width: Math.max(4, (x1 - x0) * W), height: Math.max(4, (y1 - y0) * H), rx: 3 }),
          el("svg:title", { text: `${it.tag || it.name || it.id} · ${it.kind || it.function || d.label}` }));
        if (S.detOn.has("labels")) g.append(el("svg:text", { x: x0 * W, y: y0 * H - fs * 0.3, "font-size": fs, text: shortLabel(it) }));
        svg.append(g);
      }
    }
  };
  if (img) {
    const probe = new Image();
    probe.onload = () => draw(probe.naturalWidth, probe.naturalHeight);
    probe.onerror = () => { $("#noImage").hidden = false; draw(1414, 1000); };
    probe.src = img;
  } else draw(1414, 1000);
}

function applyView() { $("#overlay").setAttribute("viewBox", S.view.join(" ")); }
function fitOverlay() { if (S.size) { S.view = [0, 0, ...S.size]; applyView(); } }

// Wheel zoom and drag pan for an SVG drawing viewer; `get`/`set` read and write its viewBox array.
function panZoom(svg, get, set) {
  svg.addEventListener("wheel", (e) => {
    const v = get(); if (!v) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const [x, y, w, h] = v;
    // Map the pointer into viewBox coordinates (preserveAspectRatio: xMidYMid meet).
    const s = Math.max(w / r.width, h / r.height);
    const ox = x - (r.width * s - w) / 2, oy = y - (r.height * s - h) / 2;
    const px = ox + (e.clientX - r.left) * s, py = oy + (e.clientY - r.top) * s;
    set([px - (px - x) * k, py - (py - y) * k, w * k, h * k]);
  }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", (e) => { const v = get(); if (v) drag = { x: e.clientX, y: e.clientY, v: [...v], id: e.pointerId, moving: false }; });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moving) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;  // still a click
      drag.moving = true; svg.setPointerCapture(drag.id); svg.classList.add("dragging");
    }
    const r = svg.getBoundingClientRect(); const s = Math.max(drag.v[2] / r.width, drag.v[3] / r.height);
    set([drag.v[0] - (e.clientX - drag.x) * s, drag.v[1] - (e.clientY - drag.y) * s, drag.v[2], drag.v[3]]);
  });
  const end = () => { drag = null; svg.classList.remove("dragging"); };
  svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
}

function bindDetections() {
  panZoom($("#overlay"), () => S.view, (v) => { S.view = v; applyView(); });
  $("#fitBtn").onclick = fitOverlay;
  $("#confRange").oninput = (e) => { S.minConf = +e.target.value; $("#confVal").textContent = S.minConf.toFixed(2); renderOverlay(); };
  $("#detSearch").onkeydown = (e) => { if (e.key === "Enter") findTag(e.target.value); };
}

function findTag(q) {
  q = q.trim().toLowerCase(); if (!q || !S.result) return;
  for (let pi = 0; pi < S.result.pages.length; pi++) {
    const ex = S.result.pages[pi].extraction;
    for (const d of DET) for (const it of ex[d.key] || []) {
      if (it.bbox && [it.id, it.tag, it.name].some((v) => v && v.toLowerCase().includes(q))) {
        if (pi !== S.pageIdx) { S.pageIdx = pi; $("#pageSelect").value = pi; renderDetToggles(); }
        showOnDrawing(it.bbox, it.id, d); selectDet(it, d); return;
      }
    }
  }
  toast(`No detection matches "${q}"`);
}

function showOnDrawing(bbox, id, d) {
  showTab("detections");
  if (d && !S.detOn.has(d.key)) { S.detOn.add(d.key); renderDetToggles(); }
  renderOverlay();
  setTimeout(() => {
    if (!S.size) return;
    const [W, H] = S.size; const [x0, y0, x1, y1] = bbox;
    const pad = 0.08;
    const w = Math.max((x1 - x0) * W, W * 0.12) + W * pad, h = Math.max((y1 - y0) * H, H * 0.12) + H * pad;
    S.view = [((x0 + x1) / 2) * W - w / 2, ((y0 + y1) / 2) * H - h / 2, w, h]; applyView();
    const g = $(`#overlay g[data-id="${CSS.escape(id)}"]`);
    if (g) { g.classList.add("flash", "sel"); setTimeout(() => g.classList.remove("flash"), 2000); }
  }, 120);
}

function selectDet(it, d) {
  $$("#overlay .det.sel").forEach((g) => g.classList.remove("sel"));
  const g = $(`#overlay g[data-id="${CSS.escape(it.id)}"]`); if (g) g.classList.add("sel");
  const node = (S.result.graph?.nodes || []).find((n) => (n.provenance || []).some((p) => p.local_id === it.id && p.page === page().page));
  const rows = [["Category", d.label], ["Tag", it.tag], ["Kind", it.kind || it.function], ["Name", it.name],
    ["Confidence", it.confidence != null ? it.confidence.toFixed(2) : "default"], ["Location", it.location],
    ["Measures", it.measures ? JSON.stringify(it.measures) : null], ["Actuator", it.actuator], ["Fail pos.", it.fail_position],
    ["Direction", it.direction], ["Other dwg", it.other_drawing], ["Graph node", node?.id], ["Notes", it.notes]];
  const box = $("#detDetails");
  box.replaceChildren(
    el("span", { class: "badge", style: { "--bc": `var(${d.color})` }, text: d.label }),
    el("h4", { text: it.tag || it.name || it.id }),
    el("dl", { class: "kv" }, rows.filter(([, v]) => v != null && v !== "").flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: String(v) })])),
    node ? el("button", { class: "small", onclick: () => { showTab("graph"); focusNode(node.id); }, text: "Show in graph" }) : null,
    el("h3", { text: "Extraction JSON", style: { "margin-top": "14px" } }),
    jsonPre(it));
}

/* ---------------- graph ---------------- */
function initGraphToggles() {
  const g = S.result.graph; if (!g) return;
  S.nodeOn = new Set(g.nodes.map((n) => n.type).filter((t) => !NODE_HIDDEN_DEFAULT.has(t)));
  S.edgeOn = new Set(g.edges.map((e) => e.type));
  renderGraphToggles();
}
function renderGraphToggles() {
  const g = S.result.graph; if (!g) return;
  const count = (arr, k) => arr.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {});
  const mk = (box, counts, on, colorOf) => {
    box.replaceChildren();
    for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      const chip = el("span", { class: "chip" + (on.has(t) ? " on" : ""), style: { "--cc": colorOf(t) }, role: "switch", "aria-checked": on.has(t), tabindex: 0 },
        el("span", { class: "sw" }), t, el("span", { class: "n", text: n }));
      const flip = () => { on.has(t) ? on.delete(t) : on.add(t); renderGraphToggles(); applyGraphFilter(); };
      chip.onclick = flip; chip.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } };
      box.append(chip);
    }
  };
  mk($("#nodeToggles"), count(g.nodes, "type"), S.nodeOn, (t) => `var(${NODE_COLORS[t] || "--muted"})`);
  mk($("#edgeToggles"), count(g.edges, "type"), S.edgeOn, (t) => edgeColor(t));
}
function edgeColor(t) {
  if (t === "FLOWS_TO" || t === "FEEDS") return "var(--c-line)";
  if (["SIGNAL_TO", "ACTUATES", "TRIPS", "CASCADES_TO"].includes(t)) return "var(--c-signal)";
  if (t === "MEASURES") return "var(--c-instrument)";
  if (t === "MEMBER_OF") return "var(--c-loop)";
  return "var(--muted)";
}
const resolveColor = (v) => v.startsWith("var(") ? cssVar(v.slice(4, -1)) : v;

function renderGraph() {
  const g = S.result?.graph;
  const box = $("#cy");
  if (!g || !window.cytoscape) { box.replaceChildren(el("p", { class: "hint", style: { padding: "12px" }, text: g ? "Graph library failed to load (offline?). Use the JSON tab." : "No graph.json." })); return; }
  if (S.cy) S.cy.destroy();
  const elements = [
    ...g.nodes.map((n) => ({ data: { id: n.id, label: n.label, type: n.type, color: resolveColor(`var(${NODE_COLORS[n.type] || "--muted"})`), size: n.type === "PipeSegment" ? 10 : n.type === "Equipment" ? 34 : 22 } })),
    ...g.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, type: e.type, color: resolveColor(edgeColor(e.type)), dashed: ["SIGNAL_TO", "ACTUATES", "TRIPS", "CASCADES_TO", "MEMBER_OF"].includes(e.type) ? "dashed" : "solid" } })),
  ];
  const text = cssVar("--text"), bg = cssVar("--viewer-bg");
  S.cy = cytoscape({
    container: box, elements, wheelSensitivity: 0.25, minZoom: 0.05, maxZoom: 4,
    style: [
      { selector: "node", style: { "background-color": "data(color)", width: "data(size)", height: "data(size)", label: "data(label)", "font-size": 9, color: text, "text-outline-color": bg, "text-outline-width": 2, "text-valign": "bottom", "text-margin-y": 3 } },
      { selector: 'node[type="PipeSegment"]', style: { label: "" } },
      { selector: 'node[type="Equipment"]', style: { shape: "round-rectangle", "font-size": 11, "font-weight": 700 } },
      { selector: 'node[type="ControlLoop"]', style: { shape: "diamond" } },
      { selector: 'node[type="OffPageConnector"]', style: { shape: "tag" } },
      { selector: "edge", style: { width: 1.4, "line-color": "data(color)", "target-arrow-color": "data(color)", "target-arrow-shape": "triangle", "arrow-scale": 0.7, "curve-style": "bezier", "line-style": "data(dashed)", "font-size": 7, color: text, "text-rotation": "autorotate", "text-outline-color": bg, "text-outline-width": 2 } },
      { selector: "edge.lbl", style: { label: "data(type)" } },
      { selector: ".hidden", style: { display: "none" } },
      { selector: ":selected", style: { "border-width": 3, "border-color": cssVar("--accent"), "line-color": cssVar("--accent"), "target-arrow-color": cssVar("--accent") } },
      { selector: ".faded", style: { opacity: 0.15 } },
      { selector: "node.hl", style: { "border-width": 4, "border-style": "dashed", "border-color": cssVar("--accent"), "z-index": 99, "font-weight": 700, "font-size": 11 } },
    ],
  });
  S.cy.on("tap", "node", (e) => showNode(e.target.id()));
  S.cy.on("tap", "edge", (e) => showEdge(e.target.id()));
  S.cy.on("tap", (e) => { if (e.target === S.cy) { S.cy.elements().removeClass("faded hl"); } });
  applyGraphFilter(true);
}
function applyGraphFilter(relayout) {
  if (!S.cy) return;
  S.cy.batch(() => {
    S.cy.nodes().forEach((n) => n.toggleClass("hidden", !S.nodeOn.has(n.data("type"))));
    S.cy.edges().forEach((e) => e.toggleClass("hidden", !S.edgeOn.has(e.data("type")) || e.source().hasClass("hidden") || e.target().hasClass("hidden")));
    S.cy.edges().toggleClass("lbl", $("#edgeLabels").checked);
  });
  if (relayout !== false) runLayout();
}
function runLayout() {
  const name = $("#layoutSelect").value;
  const opts = { name, animate: false, fit: true, padding: 30, nodeDimensionsIncludeLabels: true };
  if (name === "cose") Object.assign(opts, { nodeRepulsion: 9000, idealEdgeLength: 60, numIter: 1500 });
  if (name === "breadthfirst") Object.assign(opts, { directed: true, spacingFactor: 1.1 });
  if (name === "concentric") Object.assign(opts, { concentric: (n) => ({ Equipment: 4, ControlLoop: 3, Instrument: 2, Component: 2 }[n.data("type")] || 1), levelWidth: () => 1 });
  S.cy.elements(":visible").layout(opts).run();
}
function bindGraph() {
  $("#layoutSelect").onchange = () => runLayout();
  $("#edgeLabels").onchange = () => applyGraphFilter(false);
  $("#graphFit").onclick = () => S.cy && S.cy.fit(S.cy.elements(":visible"), 30);
}
function focusNode(id) {
  const n = S.cy?.getElementById(id); if (!n || n.empty()) return;
  if (n.hasClass("hidden")) { S.nodeOn.add(n.data("type")); renderGraphToggles(); applyGraphFilter(); }
  setTimeout(() => {
    S.cy.elements().addClass("faded"); n.closedNeighborhood().removeClass("faded");
    S.cy.elements().unselect(); n.select(); S.cy.animate({ fit: { eles: n.closedNeighborhood(), padding: 60 } }, { duration: 300 });
    showNode(id);
  }, 50);
}
function showNode(id) {
  const g = S.result.graph; const n = g.nodes.find((x) => x.id === id); if (!n) return;
  S.cy.elements().addClass("faded"); S.cy.getElementById(id).closedNeighborhood().removeClass("faded");
  const out = g.edges.filter((e) => e.source === id), inc = g.edges.filter((e) => e.target === id);
  const label = (nid) => g.nodes.find((x) => x.id === nid)?.label || nid;
  const prov = (n.provenance || []).find((p) => p.bbox);
  const list = (title, arr, key) => arr.length ? [el("h3", { text: `${title} (${arr.length})`, style: { "margin-top": "12px" } }),
    el("ul", { style: { margin: "4px 0", "padding-left": "18px" } }, arr.slice(0, 40).map((e) => el("li", {},
      el("a", { href: "#", onclick: (ev) => { ev.preventDefault(); focusNode(e[key]); }, text: label(e[key]) }), ` · ${e.type}`)))] : [];
  $("#graphDetails").replaceChildren(
    el("span", { class: "badge", style: { "--bc": `var(${NODE_COLORS[n.type] || "--muted"})` }, text: n.type }),
    el("h4", { text: n.label }),
    el("dl", { class: "kv" }, [["Id", n.id], ["Kind", n.kind], ["Name", n.name], ["DEXPI", n.dexpi_class], ["Confidence", n.confidence?.toFixed(2)], ["Sheets", (n.sheets || []).join(", ")]]
      .filter(([, v]) => v).flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
    prov ? el("button", { class: "small", text: "Show on drawing", onclick: () => {
      const pi = S.result.pages.findIndex((p) => p.page === prov.page); if (pi >= 0 && pi !== S.pageIdx) { S.pageIdx = pi; $("#pageSelect").value = pi; renderDetToggles(); }
      showOnDrawing(prov.bbox, prov.local_id || n.id, null); } }) : null,
    ...list("Outgoing", out, "target"), ...list("Incoming", inc, "source"),
    el("h3", { text: "Node JSON", style: { "margin-top": "12px" } }), jsonPre(n));
}
function showEdge(id) {
  const e = S.result.graph.edges.find((x) => x.id === id); if (!e) return;
  $("#graphDetails").replaceChildren(el("span", { class: "badge", style: { "--bc": edgeColor(e.type) }, text: e.type }),
    el("h4", { text: `${e.source} → ${e.target}` }), jsonPre(e));
}

/* ---------------- JSON ---------------- */
function jsonSources() {
  const r = S.result; const src = [];
  if (r.graph) src.push({ key: "graph", label: "graph.json", data: r.graph, file: "work/kg/graph.json" });
  r.pages.forEach((p) => src.push({ key: p.file, label: p.file.split("/").pop(), data: p.extraction, file: p.file }));
  src.push({ key: "run", label: "run.json", data: r.run, file: "run.json" });
  if (r.manifest) src.push({ key: "manifest", label: "manifest.json", data: r.manifest, file: "work/manifest.json" });
  return src;
}
function renderJsonToggles() {
  const src = jsonSources(); if (!src.some((s) => s.key === S.jsonKey)) S.jsonKey = src[0].key;
  $("#jsonToggles").replaceChildren(...src.map((s) => el("button", { class: s.key === S.jsonKey ? "on" : "", text: s.label,
    onclick: () => { S.jsonKey = s.key; renderJsonToggles(); renderJson(); } })));
}
function renderJson() {
  const s = jsonSources().find((x) => x.key === S.jsonKey); if (!s) return;
  const text = JSON.stringify(s.data, null, 2);
  highlight($("#jsonView"), text);
  $("#copyJson").onclick = () => navigator.clipboard.writeText(text).then(() => toast("Copied " + s.label));
  $("#dlJson").href = `/api/runs/${S.current}/files/${s.file}?download=true`;
}
function highlight(pre, text) {
  pre.replaceChildren();
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0, m; const frag = document.createDocumentFragment();
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const cls = m[1] ? (m[2] ? "k" : "s") : m[3] ? "b" : m[4] ? "z" : "n";
    frag.append(el("span", { class: cls, text: m[1] || m[0] }));
    if (m[2]) frag.append(m[2]);
    last = re.lastIndex;
  }
  frag.append(text.slice(last)); pre.append(frag);
}
function jsonPre(obj) { const pre = el("pre", { class: "json", style: { "max-height": "320px" } }); highlight(pre, JSON.stringify(obj, null, 2)); return pre; }

/* ---------------- Sara-AI-Chat ---------------- */
/* Answers come from the server, which grounds them in this run's graph.json and
   verifies every cited id; only verified items are outlined here. */
const normTag = (t) => String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const imgSizes = {};

function bindChat() {
  const sel = $("#chatModel");
  sel.replaceChildren(...S.config.models.map((m) => el("option", { value: m.id, text: m.label })));
  const saved = store.get("pidkg.chatModel");
  sel.value = S.config.models.some((m) => m.id === saved) ? saved
    : S.config.models.some((m) => m.id === "claude-sonnet-5-5") ? "claude-sonnet-5-5" : S.config.models[0].id;
  sel.onchange = () => store.set("pidkg.chatModel", sel.value);
  $$("#chatMode button").forEach((b) => (b.onclick = () => {
    S.chat.mode = b.dataset.mode;
    $$("#chatMode button").forEach((x) => x.classList.toggle("on", x === b));
    sel.disabled = S.chat.mode !== "ai";
  }));
  $("#chatForm").onsubmit = (e) => { e.preventDefault(); askSara($("#chatInput").value); };
  $("#chatInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); askSara(e.target.value); } };
  $("#chatClear").onclick = async () => {
    if (!S.current || !confirm("Start a new chat? The current conversation is kept in the run folder (chat/archive).")) return;
    await api(`/api/runs/${S.current}/chat`, { method: "DELETE" });
    loadChat(S.current);
  };
  $("#chatFit").onclick = () => renderChatView(true);
  $("#chatShowAll").onchange = () => renderChatView();
  $("#chatGraphBtn").onclick = showItemsInGraph;
  $("#chatPage").onchange = (e) => { S.chat.page = +e.target.value; renderChatView(true); };
  panZoom($("#chatSvg"), () => S.chat.view, (v) => { S.chat.view = v; $("#chatSvg").setAttribute("viewBox", v.join(" ")); });
}

async function loadChat(id) {
  S.chat = { ...S.chat, history: [], items: [], sel: null, view: null, page: null };
  $("#chatLog").replaceChildren(); $("#chatSuggest").replaceChildren(); $("#chatKb").textContent = "";
  let data;
  try { data = await api(`/api/runs/${id}/chat`); }
  catch (err) { $("#chatKb").textContent = "Chat unavailable: " + err.message; return; }
  if (id !== S.current) return;
  S.chat.history = data.history;
  $("#chatKb").textContent = `Knowledge base: this drawing's graph (${data.kb.nodes} nodes, ${data.kb.edges} edges). Sara answers only from it, and every tag she cites is checked against it.`;
  $("#chatSuggest").replaceChildren(...data.suggestions.map((q) => el("button", { type: "button", text: q, onclick: () => askSara(q) })));
  renderChatLog();
  $("#chatSuggestBox").open = !S.chat.history.length;
  const last = [...S.chat.history].reverse().find((r) => (r.items || []).some((i) => (i.boxes || []).length));
  setChatItems(last ? last.items : []);
}

function renderChatCost() {
  const h = S.chat.history, cost = h.reduce((a, r) => a + (r.cost_usd || 0), 0);
  const tok = h.reduce((a, r) => a + ((r.usage || {}).total || 0), 0);
  $("#chatCost").textContent = h.length ? `${h.length} question${h.length > 1 ? "s" : ""} · ${fmtUsd(cost)} · ${fmtTok(tok)} tokens` : "";
}

function renderChatLog() {
  const log = $("#chatLog"); log.replaceChildren();
  if (!S.chat.history.length) {
    log.append(el("div", { class: "msg sara" }, el("div", { class: "who", text: "SARA" }),
      el("div", { class: "body", text: "Ask me about this drawing: where an item is, what is on a line, which instruments are in a loop, what a valve's fail position is. I answer only from this run's knowledge graph and outline what I find on the drawing. If something is not in the graph, I will say so." })));
  }
  S.chat.history.forEach((r) => log.append(...chatMessages(r)));
  renderChatCost();
  log.scrollTop = log.scrollHeight;
}

function chatMessages(r) {
  const user = el("div", { class: "msg user", text: r.question });
  const body = el("div", { class: "body" }); md(body, r.answer, "(no answer)");
  const items = r.items || [];
  const byKey = {}; items.forEach((it) => { byKey[normTag(it.id)] = it; byKey[normTag(it.label)] = it; });
  $$("code", body).forEach((c) => {
    const it = byKey[normTag(c.textContent)];
    if (it) { c.classList.add("ref"); c.title = "Show on drawing"; c.onclick = () => { setChatItems(items, it.id); }; }
  });
  const checks = el("div", { class: "checks" });
  const chk = (cls, text, title) => checks.append(el("span", { class: `check ${cls}`, text, title }));
  if (r.mode === "search") chk("ok", "Exact matches from the knowledge base (no AI)");
  else {
    if (r.found === false) chk("warn", "Not in the knowledge base");
    if (items.length) chk("ok", `✓ ${items.length} cited item${items.length > 1 ? "s" : ""} verified in the graph`);
    if ((r.dropped_citations || []).length) chk("bad", `Removed ${r.dropped_citations.length} citation(s) not in the graph: ${r.dropped_citations.join(", ")}`, "Sara cited ids that do not exist in this drawing's graph; they were not shown.");
    if ((r.unknown_tokens || []).length) chk("bad", `Not in the graph: ${r.unknown_tokens.join(", ")}. Treat with caution.`, "Tag-like text in the answer that does not appear anywhere in the knowledge base.");
    else if (r.answer) chk("ok", "Every tag in the answer exists in the graph");
  }
  const refs = el("div", { class: "refs" }, items.map((it) => refChip(it, items)));
  const u = r.usage || {};
  const meta = r.mode === "search" ? `exact search · free · ${r.duration_ms ?? 0} ms`
    : [modelLabel(r.claude_model || r.model), fmtUsd(r.cost_usd), u.total ? `${fmtTok(u.total)} tokens` : null, r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : null].filter(Boolean).join(" · ");
  const sara = el("div", { class: "msg sara" }, el("div", { class: "who", text: "SARA" }), body, checks, items.length ? refs : null, el("div", { class: "meta", text: meta }));
  return [user, sara];
}

function refChip(it, items) {
  const loc = (it.boxes || []).length > 0;
  return el("button", { type: "button", class: "ref-chip" + (loc ? "" : " noloc") + (S.chat.sel === it.id ? " on" : ""),
    style: { "--rc": `var(${NODE_COLORS[it.type] || "--muted"})` },
    title: `${it.type}${it.name ? " · " + it.name : ""}${loc ? (it.how === "box" ? "" : ` · shown by its ${it.how === "line" ? "connected items" : it.how === "loop" ? "member instruments" : "neighbours"}`) : " · no position recorded on the drawing"}`,
    text: it.label || it.id, onclick: () => setChatItems(items, it.id) });
}

async function askSara(q) {
  q = (q || "").trim();
  if (!q || S.chat.busy || !S.current) return;
  const id = S.current;
  S.chat.busy = true; $("#chatSend").disabled = true; $("#chatInput").value = "";
  const log = $("#chatLog");
  if (!S.chat.history.length) log.replaceChildren();
  const t0 = Date.now();
  const pending = el("div", { class: "msg sara pending" }, el("div", { class: "who", text: "SARA" }), el("div", { class: "body", text: "Reading the knowledge base…" }));
  log.append(el("div", { class: "msg user", text: q }), pending); log.scrollTop = log.scrollHeight;
  const tick = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    pending.lastChild.textContent = `Reading the knowledge base… ${sec}s` +
      (sec >= 12 ? " (the first question on a drawing takes longer: Claude reads the whole graph once, later questions reuse it)" : "");
  }, 1000);
  const ctrl = new AbortController(); const limit = setTimeout(() => ctrl.abort(), 300000);
  try {
    const rec = await api(`/api/runs/${id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ question: q, model: $("#chatModel").value, mode: S.chat.mode }) });
    if (id !== S.current) return;
    S.chat.history.push(rec); renderChatLog(); setChatItems(rec.items || []);
    $("#chatSuggestBox").open = false;
  } catch (err) {
    const why = err.name === "AbortError" ? "no reply after 5 minutes. Try again, or use Exact search."
      : /not found|method not allowed/i.test(err.message) ? "the server is running older code without the chat. Restart the server and reload this page."
      : err instanceof TypeError ? "the server is not reachable. Is it still running?" : err.message;
    pending.className = "msg sara err"; pending.lastChild.textContent = "Sara could not answer: " + why;
  } finally {
    clearTimeout(limit); clearInterval(tick); S.chat.busy = false; $("#chatSend").disabled = false;
  }
}

function setChatItems(items, selId) {
  S.chat.items = items || []; S.chat.sel = selId || null;
  const focus = S.chat.items.find((i) => i.id === selId) || S.chat.items.find((i) => (i.boxes || []).length);
  const pages = (S.result?.pages || []).map((p) => p.page);
  const pg = focus && (focus.boxes || [])[0]?.page;
  S.chat.page = pages.includes(pg) ? pg : (pages.includes(S.chat.page) ? S.chat.page : pages[0]);
  $("#chatItems").replaceChildren(...(S.chat.items.length ? S.chat.items.map((it) => refChip(it, S.chat.items))
    : [el("span", { class: "hint", text: "Nothing highlighted yet." })]));
  $("#chatGraphBtn").disabled = !S.chat.items.length;
  $$("#chatLog .ref-chip").forEach((c) => c.classList.toggle("on", c.textContent === (S.chat.items.find((i) => i.id === selId)?.label || "\u0000")));
  renderChatView(true);
}

function renderChatView(fit) {
  const svg = $("#chatSvg");
  // A hidden SVG has no size; remember to zoom to the answer when the tab is opened.
  if (!S.result || $("#tab-chat").hidden) { if (fit) S.chat.needFit = true; return; }
  if (S.chat.needFit) { fit = true; S.chat.needFit = false; }
  const pages = S.result.pages;
  const p = pages.find((x) => x.page === S.chat.page) || pages[0];
  const psel = $("#chatPage");
  psel.hidden = pages.length < 2;
  psel.replaceChildren(...pages.map((x) => el("option", { value: x.page, text: `Page ${x.page}` }))); if (p) psel.value = p.page;
  svg.replaceChildren();
  if (!p) return;
  const img = p.image ? `/api/runs/${S.current}/files/${p.image}` : null;
  const draw = ([W, H]) => {
    S.chat.size = [W, H];
    if (!S.chat.view) S.chat.view = [0, 0, W, H];
    svg.append(img ? el("svg:image", { href: img, x: 0, y: 0, width: W, height: H }) : el("svg:rect", { x: 0, y: 0, width: W, height: H, fill: cssVar("--panel") }));
    const R = (b) => ({ x: b[0] * W, y: b[1] * H, width: Math.max(4, (b[2] - b[0]) * W), height: Math.max(4, (b[3] - b[1]) * H) });
    if ($("#chatShowAll").checked) {
      for (const d of DET) for (const it of (d.conn || d.pseudo) ? [] : p.extraction[d.key] || [])
        if (it.bbox) svg.append(el("svg:g", { class: "faint", style: { "--dc": `var(${d.color})` } }, el("svg:rect", R(it.bbox))));
    }
    const fs = Math.max(11, W / 95);
    const shown = [], unionsDrawn = new Set();
    for (const it of S.chat.items) {
      const sel = it.id === S.chat.sel;
      const col = `var(${NODE_COLORS[it.type] || "--accent"})`;
      // Segments of one line share an outline: draw it (and its label) once.
      const ukey = it.union && it.union.bbox.join(",");
      if (it.union && it.union.page === p.page && (sel || !unionsDrawn.has(ukey))) {
        unionsDrawn.add(ukey);
        const u = R(it.union.bbox), pad = W * 0.006;
        svg.append(el("svg:rect", { class: "hlunion", x: u.x - pad, y: u.y - pad, width: u.width + 2 * pad, height: u.height + 2 * pad, rx: 6 }));
        svg.append(el("svg:g", { class: "hl" + (sel ? " sel" : ""), style: { "--dc": col } }, el("svg:text", { x: u.x - pad, y: u.y - pad - fs * 0.35, "font-size": fs, text: it.label || it.id })));
      }
      for (const b of it.boxes || []) {
        if (b.page !== p.page) continue;
        const own = it.how === "box";
        const g = el("svg:g", { class: "hl" + (sel ? " sel" : ""), style: { "--dc": own ? col : `var(${NODE_COLORS[nodeType(b.id)] || "--accent"})` },
          onclick: (e) => { e.stopPropagation(); setChatItems(S.chat.items, it.id); } },
          el("svg:rect", { ...R(b.bbox), rx: 3 }),
          el("svg:title", { text: own ? `${it.label} · ${it.type}${it.name ? " · " + it.name : ""}` : `${b.label} (part of ${it.label})` }));
        if (own || sel) g.append(el("svg:text", { x: b.bbox[0] * W, y: b.bbox[1] * H - fs * 0.35, "font-size": fs * (own ? 1 : 0.8), text: own ? (it.label || it.id) : b.label }));
        svg.append(g);
        if (!S.chat.sel || sel) shown.push(b.bbox);
      }
    }
    if (fit) {
      if (shown.length) {
        const x0 = Math.min(...shown.map((b) => b[0])) * W, y0 = Math.min(...shown.map((b) => b[1])) * H;
        const x1 = Math.max(...shown.map((b) => b[2])) * W, y1 = Math.max(...shown.map((b) => b[3])) * H;
        const w = Math.max(x1 - x0, W * 0.15) * 1.35, h = Math.max(y1 - y0, H * 0.15) * 1.35;
        S.chat.view = [(x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - h / 2, w, h];
      } else S.chat.view = [0, 0, W, H];
    }
    svg.setAttribute("viewBox", S.chat.view.join(" "));
    const it = S.chat.items.find((i) => i.id === S.chat.sel);
    $("#chatViewTitle").textContent = it ? `${it.label} · ${it.type}${it.name ? " · " + it.name : ""}${(it.boxes || []).length ? "" : " · no position recorded on the drawing"}`
      : S.chat.items.length ? `${S.chat.items.length} item${S.chat.items.length > 1 ? "s" : ""} from Sara's answer, outlined with dotted boxes. Click one to focus it.`
      : "Items in Sara's answer are outlined on the drawing with dotted boxes.";
  };
  if (!img) return draw([1414, 1000]);
  if (imgSizes[img]) return draw(imgSizes[img]);
  const probe = new Image();
  probe.onload = () => { imgSizes[img] = [probe.naturalWidth, probe.naturalHeight]; draw(imgSizes[img]); };
  probe.onerror = () => draw([1414, 1000]);
  probe.src = img;
}
function nodeType(id) { return (S.result.graph?.nodes || []).find((n) => n.id === id)?.type; }

function showItemsInGraph() {
  const ids = S.chat.items.map((i) => i.id);
  if (!ids.length || !S.cy) return;
  showTab("graph");
  let changed = false;
  ids.forEach((id) => { const t = nodeType(id); if (t && !S.nodeOn.has(t)) { S.nodeOn.add(t); changed = true; } });
  if (changed) { renderGraphToggles(); applyGraphFilter(); }
  setTimeout(() => {
    const hl = S.cy.collection(ids.map((id) => S.cy.getElementById(id)).filter((n) => n.nonempty()));
    S.cy.elements().removeClass("hl").addClass("faded");
    hl.addClass("hl"); hl.closedNeighborhood().removeClass("faded");
    S.cy.elements().unselect();
    S.cy.animate({ fit: { eles: hl.closedNeighborhood(), padding: 50 } }, { duration: 300 });
    if (hl.length === 1) showNode(hl[0].id());
  }, 60);
}

/* ---------------- QA ---------------- */
function renderQa() {
  const issues = S.result.graph?.issues || [];
  const counts = { error: 0, warning: 0, info: 0 }; issues.forEach((i) => (counts[i.severity] = (counts[i.severity] || 0) + 1));
  const colors = { error: "--danger", warning: "--warn", info: "--muted" };
  $("#qaToggles").replaceChildren(...Object.keys(counts).map((s) => {
    const chip = el("span", { class: "chip" + (S.qaOn.has(s) ? " on" : ""), style: { "--cc": `var(${colors[s]})` }, role: "switch", tabindex: 0 },
      el("span", { class: "sw" }), s, el("span", { class: "n", text: counts[s] }));
    chip.onclick = () => { S.qaOn.has(s) ? S.qaOn.delete(s) : S.qaOn.add(s); renderQa(); };
    return chip;
  }));
  const rows = issues.filter((i) => S.qaOn.has(i.severity));
  $("#qaTable").replaceChildren(el("thead", {}, el("tr", {}, ["Severity", "Code", "Message", "Where"].map((h) => el("th", { text: h })))),
    el("tbody", {}, rows.length ? rows.map((i) => el("tr", {},
      el("td", {}, el("span", { class: `sev ${i.severity}`, text: i.severity })), el("td", { class: "mono", text: i.code }),
      el("td", { text: i.message }), el("td", { class: "mono", text: [i.node, i.page ? `p${i.page}` : null, (i.tiles || []).join(" ")].filter(Boolean).join(" · ") })))
      : el("tr", {}, el("td", { colspan: 4, class: "hint", text: "No issues for the selected severities." }))));
  md($("#qaMd"), S.result.qa_md, "No qa_report.md.");
}

boot().catch((err) => toast("Failed to start: " + err.message));
