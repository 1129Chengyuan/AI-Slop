// test/fuzz.test.js
//
// A seeded random-program generator. Hand-written examples only prove the
// language works for the programs we thought to write; this proves the
// properties hold across hundreds of programs we didn't. Every generated
// program is constructed to satisfy Tenet's static reversibility rules by
// construction (counted loops with a dedicated counter, if-conditions on
// variables the branches don't touch, etc.), then we check:
//
//   1. it type-checks (src/check.js never rejects what we generated)
//   2. call-then-uncall returns to the exact initial store
//   3. invert(invert(p)) is structurally p
//   4. the small-step Machine agrees with the big-step interpreter

import test from "node:test";
import assert from "node:assert/strict";
import { check } from "../src/check.js";
import { Store, callProc, uncallProc } from "../src/interp.js";
import { invertProc } from "../src/invert.js";
import { Machine } from "../src/machine.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stripPositions(node) {
  if (Array.isArray(node)) return node.map(stripPositions);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "line" || k === "col") continue;
      out[k] = typeof v === "bigint" ? v.toString() : stripPositions(v);
    }
    return out;
  }
  return node;
}

// --- Random reversible program generator ---
//
// Variables used: a scratch pool of plain int scalars named v0..v(N-1), one
// dedicated loop-counter variable per generated `from`, and one dedicated
// flag variable per generated `if` (both fresh, never touched by the
// bodies), which sidesteps the "how do I pick a provably-consistent exit
// test" problem entirely -- the same trick examples/sort.tnt uses for real.

function genProgram(rng, opts = {}) {
  const nVars = opts.nVars ?? 4;
  let freshCounter = 0;
  const fresh = (prefix) => `${prefix}${freshCounter++}`;
  const scratch = Array.from({ length: nVars }, (_, i) => `v${i}`);
  const extraDecls = [];
  const stackDecls = [];

  function pick(arr) {
    return arr[Math.floor(rng() * arr.length)];
  }

  function genExpr(depth) {
    if (depth <= 0 || rng() < 0.5) {
      if (rng() < 0.5) return { kind: "Literal", value: BigInt(Math.floor(rng() * 20)) };
      return { kind: "VarRef", name: pick(scratch) };
    }
    const op = pick(["+", "-", "^"]);
    return { kind: "Binary", op, left: genExpr(depth - 1), right: genExpr(depth - 1) };
  }

  function genUpdate() {
    const target = pick(scratch);
    const op = pick(["+=", "-=", "^="]);
    // Build a value expression, then reject/rebuild if it happens to
    // reference `target` (keeps generation simple and still exercises
    // every op with real structure).
    let value = genExpr(2);
    while (referencesVar(value, target)) value = genExpr(2);
    return [{ kind: "Update", op, target: { kind: "Var", name: target }, value }];
  }

  function referencesVar(expr, name) {
    switch (expr.kind) {
      case "Literal": return false;
      case "VarRef": return expr.name === name;
      case "Binary": return referencesVar(expr.left, name) || referencesVar(expr.right, name);
      default: return false;
    }
  }

  function genSwap() {
    const a = pick(scratch);
    let b = pick(scratch);
    while (b === a) b = pick(scratch);
    return [{ kind: "Swap", left: { kind: "Var", name: a }, right: { kind: "Var", name: b } }];
  }

  function genIf(depth) {
    // flag is a fresh *global*, so if this If sits inside a body that can
    // run more than once (a from-loop's do/loop body, or another If's
    // branch reached repeatedly) it must be reset to 0 before the next
    // activation -- otherwise the second run's testEntry/testExit
    // bookkeeping is corrupted by a stale value left over from the first.
    // Push/pop (already exercised and correct) does that for free: it
    // banks whatever flag ended up at and zeroes it, and `uncall`/invert
    // restore it via the matching pop/push automatically.
    const flag = fresh("flag");
    extraDecls.push(flag);
    const flagStack = fresh("flagStack");
    stackDecls.push(flagStack);
    const cond = { kind: "Binary", op: pick(["==", "!=", "<", ">="]), left: genExpr(1), right: genExpr(1) };
    const thenBody = genBlock(depth - 1, 1 + Math.floor(rng() * 2));
    const elseBody = genBlock(depth - 1, 1 + Math.floor(rng() * 2));
    // flag stays 0 unless we explicitly set it, giving us an unambiguous,
    // branch-specific exit test with no data dependence at all.
    thenBody.push({ kind: "Update", op: "+=", target: { kind: "Var", name: flag }, value: { kind: "Literal", value: 1n } });
    const ifStmt = {
      kind: "If",
      testEntry: cond,
      thenBody,
      elseBody,
      testExit: { kind: "Binary", op: "==", left: { kind: "VarRef", name: flag }, right: { kind: "Literal", value: 1n } },
    };
    return [ifStmt, { kind: "Push", varName: flag, stackName: flagStack }];
  }

  function genFrom(depth) {
    // IMPORTANT: the exit test is only ever checked right after doBody runs
    // (never after loopBody), so the counter must be incremented exactly
    // once per doBody execution and *not* in loopBody -- incrementing it in
    // both, or checking a different cadence, either skips every other
    // checkpoint (silently wrong, or an infinite loop if the bound is never
    // hit exactly) or corrupts the "testEntry is false on re-entry"
    // invariant. See examples/fib.tnt's comment for the worked-out failure.
    //
    // Same re-entrancy hazard as genIf's flag, and the same fix: bank the
    // finished counter's value (always `bound`) on a stack and zero it, so
    // a from nested inside a repeating body starts every activation at 0.
    const counter = fresh("cnt");
    extraDecls.push(counter);
    const counterStack = fresh("cntStack");
    stackDecls.push(counterStack);
    const bound = 2 + Math.floor(rng() * 3);
    const doBody = genBlock(depth - 1, 1 + Math.floor(rng() * 2));
    const loopBody = genBlock(depth - 1, 1 + Math.floor(rng() * 2));
    doBody.push({ kind: "Update", op: "+=", target: { kind: "Var", name: counter }, value: { kind: "Literal", value: 1n } });
    const fromStmt = {
      kind: "From",
      testEntry: { kind: "Binary", op: "==", left: { kind: "VarRef", name: counter }, right: { kind: "Literal", value: 0n } },
      doBody,
      loopBody,
      testExit: { kind: "Binary", op: "==", left: { kind: "VarRef", name: counter }, right: { kind: "Literal", value: BigInt(bound) } },
    };
    return [fromStmt, { kind: "Push", varName: counter, stackName: counterStack }];
  }

  function genLocal(depth) {
    const name = fresh("t");
    const body = genBlock(depth - 1, 1 + Math.floor(rng() * 2));
    // delocal must match whatever the local's final live value is; keep it
    // simple and provably correct by never touching the local in the body.
    // (Local doesn't have genIf/genFrom's re-entrancy hazard: pushLocal
    // seeds a *fresh* scope from initExpr on every activation regardless of
    // any previous one, so nesting it inside a repeating body is fine as-is.)
    return [{
      kind: "Local", type: "int", name,
      initExpr: { kind: "Literal", value: 0n },
      body,
      finalExpr: { kind: "Literal", value: 0n },
    }];
  }

  function genStmt(depth) {
    const choices = ["update", "swap"];
    if (depth > 0) choices.push("if", "from", "local");
    switch (pick(choices)) {
      case "update": return genUpdate();
      case "swap": return genSwap();
      case "if": return genIf(depth);
      case "from": return genFrom(depth);
      case "local": return genLocal(depth);
      default: throw new Error("unreachable");
    }
  }

  function genBlock(depth, count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(...genStmt(depth));
    return out;
  }

  const body = genBlock(opts.depth ?? 3, opts.stmts ?? 6);
  const decls = scratch.map((name) => ({ kind: "VarDecl", type: "int", name, size: null, line: 0, col: 0 }))
    .concat(extraDecls.map((name) => ({ kind: "VarDecl", type: "int", name, size: null, line: 0, col: 0 })))
    .concat(stackDecls.map((name) => ({ kind: "StackDecl", name, line: 0, col: 0 })));
  addPositions(body);
  const proc = { kind: "Proc", name: "p", body, line: 0, col: 0 };
  return { kind: "Program", decls, procs: [proc] };
}

function addPositions(node) {
  if (Array.isArray(node)) {
    for (const n of node) addPositions(n);
    return;
  }
  if (node && typeof node === "object") {
    if (node.line === undefined) node.line = 0;
    if (node.col === undefined) node.col = 0;
    for (const v of Object.values(node)) addPositions(v);
  }
}

const SEED = 1234567;
const N_PROGRAMS = 250;

test(`fuzz: ${N_PROGRAMS} random reversible programs all check, uncall cleanly, invert involutively, and agree small-step vs big-step`, () => {
  const rng = mulberry32(SEED);
  let executed = 0;
  for (let i = 0; i < N_PROGRAMS; i++) {
    const program = genProgram(rng, {
      nVars: 3 + Math.floor(rng() * 3),
      depth: 2 + Math.floor(rng() * 2),
      stmts: 4 + Math.floor(rng() * 5),
    });

    const { procs } = check(program); // must never throw

    // Seed variables with small random values so branches/loops actually
    // exercise different paths across runs. The values are drawn ONCE per
    // program (not once per seed() call!) so every store we construct below
    // starts from the exact same state -- otherwise each call would
    // consume fresh rng() draws and the three stores would silently start
    // from different initial values, which looks exactly like a
    // small-step/big-step disagreement but isn't one.
    const initialValues = new Map();
    for (const d of program.decls) {
      if (!d.name.startsWith("v")) continue; // leave flags/counters at 0
      initialValues.set(d.name, BigInt(Math.floor(rng() * 10) - 5));
    }
    const seed = () => {
      const store = new Store(program);
      for (const [name, value] of initialValues) store.cell(name).value = value;
      return store;
    };

    // 1. call then uncall == identity.
    const store1 = seed();
    const before = store1.snapshot();
    callProc(store1, procs, "p");
    uncallProc(store1, procs, "p");
    assert.deepEqual(store1.snapshot(), before, `program ${i}: call+uncall did not restore state`);

    // 2. invert(invert(p)) structurally equals p.
    const proc = procs.get("p");
    const twice = invertProc(invertProc(proc));
    assert.deepEqual(stripPositions(twice.body), stripPositions(proc.body), `program ${i}: invert not involutive`);

    // 3. small-step machine agrees with big-step interpreter, forward and
    //    round-tripped back to the start.
    const store2 = seed();
    const initialSnapshot = store2.snapshot();
    const store3 = seed();
    callProc(store3, procs, "p"); // big-step oracle

    const machine = new Machine(store2, procs, "p");
    const result = machine.run("fwd");
    assert.equal(result.status, "halted");
    assert.deepEqual(store2.snapshot(), store3.snapshot(), `program ${i}: small-step != big-step`);

    let steps = 0;
    while (machine.step("bwd").status === "ok") steps++;
    assert.deepEqual(store2.snapshot(), initialSnapshot, `program ${i}: stepping all the way back != initial state`);

    executed++;
  }
  assert.equal(executed, N_PROGRAMS);
});
