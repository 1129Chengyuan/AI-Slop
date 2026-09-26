// web/app.js
//
// The playground's only job is UI plumbing -- every bit of Tenet semantics
// (parsing, checking, execution, inversion, stepping) comes straight from
// src/, unmodified, the same modules the CLI and the test suite use. This
// file never re-implements anything the language core already does.

import { parse, check, Store, Machine, invertProc, printProc, ReversibilityError } from "../src/index.js";

const EXAMPLES = ["fib.tnt", "xtea.tnt", "sqrt.tnt", "rle.tnt", "sort.tnt"];

const el = {
  exampleSelect: document.getElementById("example-select"),
  procSelect: document.getElementById("proc-select"),
  modeSelect: document.getElementById("mode-select"),
  source: document.getElementById("source"),
  initValues: document.getElementById("init-values"),
  load: document.getElementById("load"),
  stepBack: document.getElementById("step-back"),
  stepFwd: document.getElementById("step-fwd"),
  runFwd: document.getElementById("run-fwd"),
  runBwd: document.getElementById("run-bwd"),
  reset: document.getElementById("reset"),
  status: document.getElementById("status"),
  stateTable: document.querySelector("#state-table tbody"),
  memoryCount: document.getElementById("memory-count"),
  invertedSource: document.getElementById("inverted-source"),
};

let current = null; // { program, procs, store, machine, initSnapshot }
let lastSnapshot = null;

for (const name of EXAMPLES) {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = name;
  el.exampleSelect.appendChild(opt);
}

async function loadExampleSource(name) {
  // Absolute path: fetch() resolves relative to the *document's* URL (this
  // page is served at "/"), not this module's own URL like `import`s are.
  const res = await fetch(`/examples/${name}`);
  return res.text();
}

el.exampleSelect.addEventListener("change", async () => {
  el.source.value = await loadExampleSource(el.exampleSelect.value);
  el.initValues.value = suggestedInit(el.exampleSelect.value);
});

function suggestedInit(name) {
  switch (name) {
    case "fib.tnt": return "n=10";
    case "xtea.tnt": return "v0=0x01234567\nv1=0x89abcdef\nkey=0x00010203,0x04050607,0x08090a0b,0x0c0d0e0f";
    case "sqrt.tnt": return "x=9999";
    case "rle.tnt": return "bits=0,0,0,1,1,1,0,0,1,0,0,0,0,1,1,1";
    case "sort.tnt": return "a=4,2,0,3,1";
    default: return "";
  }
}

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.className = "status" + (kind ? ` ${kind}` : "");
}

function parseInitValues(text) {
  const sets = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    sets.push({ name: line.slice(0, eq).trim(), rhs: line.slice(eq + 1).trim() });
  }
  return sets;
}

function parseNumberLiteral(s) {
  s = s.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
  if (s.startsWith("-")) return -BigInt(s.slice(1));
  return BigInt(s);
}

function applyInitValues(store, sets) {
  for (const { name, rhs } of sets) {
    const cell = store.cell(name);
    if (rhs.includes(",")) {
      if (cell.kind !== "array") throw new Error(`'${name}' is not an array`);
      rhs.split(",").forEach((p, i) => (cell.values[i] = parseNumberLiteral(p)));
    } else if (cell.kind === "array") {
      cell.values.fill(parseNumberLiteral(rhs));
    } else {
      cell.value = parseNumberLiteral(rhs);
    }
  }
}

el.load.addEventListener("click", () => {
  try {
    const program = parse(el.source.value);
    const { procs } = check(program);

    el.procSelect.innerHTML = "";
    for (const p of program.procs) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      el.procSelect.appendChild(opt);
    }
    if (program.procs.length === 0) throw new Error("file declares no procedures");
    const procName = program.procs[program.procs.length - 1].name;
    el.procSelect.value = procName;

    const store = new Store(program);
    applyInitValues(store, parseInitValues(el.initValues.value));

    const doUncall = el.modeSelect.value === "uncall";
    const machine = new Machine(store, procs, procName, { uncall: doUncall });

    current = { program, procs, store, machine, procName };
    lastSnapshot = store.snapshot();

    el.invertedSource.textContent = printProc(invertProc(procs.get(procName)));
    renderSource();
    renderState();
    setEnabled(true);
    setStatus(`loaded '${procName}' (${doUncall ? "uncall" : "call"} mode)`, "ok");
  } catch (e) {
    setEnabled(false);
    setStatus(`${e.name || "Error"}: ${e.message}`, "error");
  }
});

el.procSelect.addEventListener("change", () => {
  if (!current) return;
  const proc = current.procs.get(el.procSelect.value);
  el.invertedSource.textContent = printProc(invertProc(proc));
  // Re-load fresh with the newly selected entry proc.
  el.load.click();
});

function setEnabled(on) {
  for (const b of [el.stepBack, el.stepFwd, el.runFwd, el.runBwd, el.reset]) b.disabled = !on;
}

function step(direction) {
  if (!current) return;
  try {
    const r = current.machine.step(direction);
    if (r.status === "halted") {
      setStatus(`halted (${r.edge === "end" ? "reached the end" : "back at the start"})`, "ok");
    } else {
      setStatus(`${r.dir === 1 ? "→" : "←"} ${r.stmt.kind} at line ${r.stmt.line}`);
    }
    renderState();
    renderSource();
  } catch (e) {
    if (e instanceof ReversibilityError) setStatus(`ReversibilityError: ${e.message}`, "error");
    else setStatus(`${e.name}: ${e.message}`, "error");
  }
}

el.stepFwd.addEventListener("click", () => step("fwd"));
el.stepBack.addEventListener("click", () => step("bwd"));

el.runFwd.addEventListener("click", () => {
  if (!current) return;
  let guard = 0;
  while (guard++ < 1_000_000) {
    const r = current.machine.step("fwd");
    if (r.status === "halted") break;
  }
  renderState();
  renderSource();
  setStatus("ran to the end", "ok");
});

el.runBwd.addEventListener("click", () => {
  if (!current) return;
  let guard = 0;
  while (guard++ < 1_000_000) {
    const r = current.machine.step("bwd");
    if (r.status === "halted") break;
  }
  renderState();
  renderSource();
  setStatus("ran back to the start", "ok");
});

el.reset.addEventListener("click", () => el.load.click());

function renderState() {
  if (!current) return;
  const snap = current.machine.snapshot();
  el.stateTable.innerHTML = "";
  for (const [name, value] of Object.entries(snap)) {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.textContent = name;
    const valTd = document.createElement("td");
    const text = Array.isArray(value) ? `[${value.map(String).join(", ")}]` : String(value);
    valTd.textContent = text;
    const prev = lastSnapshot ? lastSnapshot[name] : undefined;
    const prevText = Array.isArray(prev) ? `[${prev.map(String).join(", ")}]` : String(prev);
    if (prev !== undefined && prevText !== text) valTd.className = "changed";
    tr.append(nameTd, valTd);
    el.stateTable.appendChild(tr);
  }
  lastSnapshot = snap;
  el.memoryCount.textContent = String(current.machine.frameDepth());
}

function renderSource() {
  if (!current) return;
  const peek = current.machine.peek();
  const highlightLine = peek.next ? peek.next.line : (peek.prev ? peek.prev.line : null);
  const lines = el.source.value.split("\n");
  // Replace the editable textarea's visual with a read-only line-numbered
  // view by overlaying a <pre> would need extra markup; instead we simply
  // select the current line's text in the textarea and scroll to it, which
  // works everywhere without extra DOM.
  if (highlightLine && highlightLine >= 1 && highlightLine <= lines.length) {
    const before = lines.slice(0, highlightLine - 1).join("\n");
    const lineText = lines[highlightLine - 1];
    const start = before.length + (highlightLine > 1 ? 1 : 0);
    el.source.focus();
    el.source.setSelectionRange(start, start + lineText.length);
    const lineHeight = 19.5;
    el.source.scrollTop = Math.max(0, (highlightLine - 4) * lineHeight);
  }
}

// Boot with the first example preloaded.
(async () => {
  el.exampleSelect.value = EXAMPLES[0];
  el.source.value = await loadExampleSource(EXAMPLES[0]);
  el.initValues.value = suggestedInit(EXAMPLES[0]);
})();
