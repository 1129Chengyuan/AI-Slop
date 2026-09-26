// src/interp.js
//
// Big-step interpreter. This is the reference semantics: given a checked
// program, `callProc` / `uncallProc` execute a procedure to completion and
// mutate a Store in place. It's also the "oracle" the test suite checks the
// small-step machine (src/machine.js) against.
//
// The nice trick: `execStmt`'s If/From/Local cases only ever run forward
// (using assertions to *check* reversibility, per the language semantics).
// `uncall p` is implemented as "invert p's body with src/invert.js, then run
// the inverted statements forward" -- so no separate backward code path is
// needed for compound statements. Atomic statements (Update/Swap/Push/Pop)
// additionally get a direct inverse (execAtomicInverse) that src/machine.js
// uses to undo one statement at a time without going through invert.js.

import { wrap, truthy, binOp, unaryOp, inverseUpdateOp } from "./values.js";
import { invertStmts } from "./invert.js";

export class ReversibilityError extends Error {
  constructor(message, line, col) {
    super(`${message}${line != null ? ` (line ${line}, col ${col})` : ""}`);
    this.name = "ReversibilityError";
    this.line = line;
    this.col = col;
  }
}

// --- Store: the mutable runtime state ---

export class Store {
  constructor(program) {
    this.globals = new Map();
    this.scopes = []; // local scopes pushed by `local`/`delocal`, innermost last
    for (const d of program.decls) {
      if (d.kind === "StackDecl") {
        this.globals.set(d.name, { kind: "stack", values: [] });
      } else if (d.size != null) {
        this.globals.set(d.name, { kind: "array", type: d.type, values: new Array(d.size).fill(0n) });
      } else {
        this.globals.set(d.name, { kind: "scalar", type: d.type, value: 0n });
      }
    }
  }

  cell(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    const c = this.globals.get(name);
    if (!c) throw new ReversibilityError(`undeclared variable '${name}' at runtime`);
    return c;
  }

  pushLocal(name, type, value) {
    const scope = new Map();
    scope.set(name, { kind: "scalar", type, value });
    this.scopes.push(scope);
  }

  popLocal() {
    this.scopes.pop();
  }

  // A plain-object snapshot of every variable, for the debugger UI and for
  // equality checks in tests. Locals from currently-open scopes are included
  // under their own name (shadowing globals, matching runtime lookup).
  snapshot() {
    const out = {};
    for (const [name, cell] of this.globals) out[name] = snapshotCell(cell);
    for (const scope of this.scopes) {
      for (const [name, cell] of scope) out[name] = snapshotCell(cell);
    }
    return out;
  }
}

function snapshotCell(cell) {
  if (cell.kind === "scalar") return cell.value;
  if (cell.kind === "array") return cell.values.slice();
  if (cell.kind === "stack") return cell.values.slice();
  throw new Error(`snapshotCell: unknown cell kind '${cell.kind}'`);
}

// --- Expression evaluation ---

export function evalExpr(expr, store) {
  switch (expr.kind) {
    case "Literal":
      return expr.value;
    case "VarRef":
      return store.cell(expr.name).value;
    case "IndexRef": {
      const cell = store.cell(expr.name);
      const idx = Number(evalExpr(expr.index, store));
      checkBounds(cell, idx, expr);
      return cell.values[idx];
    }
    case "Empty":
      return store.cell(expr.name).values.length === 0 ? 1n : 0n;
    case "Top": {
      const cell = store.cell(expr.name);
      if (cell.values.length === 0) {
        throw new ReversibilityError(`top() of empty stack '${expr.name}'`, expr.line, expr.col);
      }
      return cell.values[cell.values.length - 1];
    }
    case "Unary":
      return unaryOp(expr.op, evalExpr(expr.operand, store));
    case "Binary":
      return binOp(expr.op, evalExpr(expr.left, store), evalExpr(expr.right, store));
    default:
      throw new Error(`evalExpr: unknown expr kind '${expr.kind}'`);
  }
}

function checkBounds(cell, idx, node) {
  if (idx < 0 || idx >= cell.values.length) {
    throw new ReversibilityError(`array index ${idx} out of bounds [0,${cell.values.length})`, node.line, node.col);
  }
}

// --- Statement execution (forward only -- see file header) ---

export function execStmts(stmts, store, procs) {
  for (const s of stmts) execStmt(s, store, procs);
}

export function execStmt(s, store, procs) {
  switch (s.kind) {
    case "Skip":
      return;

    case "Update":
    case "Swap":
    case "Push":
    case "Pop":
      return execAtomicForward(s, store);

    case "If": {
      const entry = truthy(evalExpr(s.testEntry, store));
      execStmts(entry ? s.thenBody : s.elseBody, store, procs);
      const exit = truthy(evalExpr(s.testExit, store));
      if (exit !== entry) {
        throw new ReversibilityError(
          `if-exit assertion failed: expected ${entry}, got ${exit}`, s.line, s.col,
        );
      }
      return;
    }

    case "From": {
      if (!truthy(evalExpr(s.testEntry, store))) {
        throw new ReversibilityError(`from-loop entry assertion failed`, s.line, s.col);
      }
      let first = true;
      while (true) {
        if (!first && truthy(evalExpr(s.testEntry, store))) {
          throw new ReversibilityError(`from-loop entry test unexpectedly true on re-entry`, s.line, s.col);
        }
        execStmts(s.doBody, store, procs);
        first = false;
        if (truthy(evalExpr(s.testExit, store))) break;
        execStmts(s.loopBody, store, procs);
      }
      return;
    }

    case "Local": {
      const v0 = wrap(s.type, evalExpr(s.initExpr, store));
      store.pushLocal(s.name, s.type, v0);
      execStmts(s.body, store, procs);
      const expected = wrap(s.type, evalExpr(s.finalExpr, store));
      const actual = store.cell(s.name).value;
      if (actual !== expected) {
        throw new ReversibilityError(
          `delocal mismatch for '${s.name}': expected ${expected}, got ${actual}`, s.line, s.col,
        );
      }
      store.popLocal();
      return;
    }

    case "Call":
      callProc(store, procs, s.name);
      return;
    case "Uncall":
      uncallProc(store, procs, s.name);
      return;

    default:
      throw new Error(`execStmt: unknown statement kind '${s.kind}'`);
  }
}

// Applies exactly one atomic (non-control-flow) statement in its natural
// forward sense. Shared by the big-step interpreter above and the
// small-step machine (src/machine.js), so both agree by construction on
// what "one step" of an Update/Swap/Push/Pop means.
export function execAtomicForward(stmt, store) {
  switch (stmt.kind) {
    case "Skip":
      return;
    case "Update": {
      const cur = readTarget(stmt.target, store);
      const delta = evalExpr(stmt.value, store);
      const next = wrap(cur.type, applyUpdate(stmt.op, cur.value, delta));
      writeTarget(stmt.target, store, next);
      return;
    }
    case "Swap": {
      const a = readTarget(stmt.left, store);
      const b = readTarget(stmt.right, store);
      writeTarget(stmt.left, store, b.value);
      writeTarget(stmt.right, store, a.value);
      return;
    }
    case "Push": {
      const varCell = store.cell(stmt.varName);
      const stackCell = store.cell(stmt.stackName);
      stackCell.values.push(varCell.value);
      varCell.value = 0n;
      return;
    }
    case "Pop": {
      const varCell = store.cell(stmt.varName);
      const stackCell = store.cell(stmt.stackName);
      if (varCell.value !== 0n) {
        throw new ReversibilityError(`pop into '${stmt.varName}' which is not zero`, stmt.line, stmt.col);
      }
      if (stackCell.values.length === 0) {
        throw new ReversibilityError(`pop from empty stack '${stmt.stackName}'`, stmt.line, stmt.col);
      }
      varCell.value = stackCell.values.pop();
      return;
    }
    default:
      throw new Error(`execAtomicForward: '${stmt.kind}' is not an atomic statement`);
  }
}

// The inverse of exactly one atomic statement, applied directly (no AST
// transform) -- this is what makes single-step "back" in the debugger cheap:
// no history, just flip the operator and go.
export function execAtomicInverse(stmt, store) {
  switch (stmt.kind) {
    case "Skip":
      return;
    case "Update": {
      const cur = readTarget(stmt.target, store);
      const delta = evalExpr(stmt.value, store);
      const next = wrap(cur.type, applyUpdate(inverseUpdateOp(stmt.op), cur.value, delta));
      writeTarget(stmt.target, store, next);
      return;
    }
    case "Swap": {
      const a = readTarget(stmt.left, store);
      const b = readTarget(stmt.right, store);
      writeTarget(stmt.left, store, b.value);
      writeTarget(stmt.right, store, a.value);
      return;
    }
    case "Push": {
      // undoing a push is a pop
      const varCell = store.cell(stmt.varName);
      const stackCell = store.cell(stmt.stackName);
      if (varCell.value !== 0n) {
        throw new ReversibilityError(`pop into '${stmt.varName}' which is not zero`, stmt.line, stmt.col);
      }
      if (stackCell.values.length === 0) {
        throw new ReversibilityError(`pop from empty stack '${stmt.stackName}'`, stmt.line, stmt.col);
      }
      varCell.value = stackCell.values.pop();
      return;
    }
    case "Pop": {
      // undoing a pop is a push
      const varCell = store.cell(stmt.varName);
      const stackCell = store.cell(stmt.stackName);
      stackCell.values.push(varCell.value);
      varCell.value = 0n;
      return;
    }
    default:
      throw new Error(`execAtomicInverse: '${stmt.kind}' is not an atomic statement`);
  }
}

function readTarget(target, store) {
  if (target.kind === "Var") {
    const cell = store.cell(target.name);
    return { value: cell.value, type: cell.type };
  }
  const cell = store.cell(target.name);
  const idx = Number(evalExpr(target.index, store));
  checkBounds(cell, idx, target);
  return { value: cell.values[idx], type: cell.type, _idx: idx };
}

function writeTarget(target, store, value) {
  if (target.kind === "Var") {
    store.cell(target.name).value = value;
    return;
  }
  const cell = store.cell(target.name);
  const idx = Number(evalExpr(target.index, store));
  checkBounds(cell, idx, target);
  cell.values[idx] = value;
}

function applyUpdate(op, cur, delta) {
  if (op === "+=") return cur + delta;
  if (op === "-=") return cur - delta;
  if (op === "^=") return cur ^ delta;
  throw new Error(`applyUpdate: unknown op '${op}'`);
}

export function callProc(store, procs, name) {
  const proc = procs.get(name);
  if (!proc) throw new ReversibilityError(`call to undefined procedure '${name}'`);
  execStmts(proc.body, store, procs);
}

export function uncallProc(store, procs, name) {
  const proc = procs.get(name);
  if (!proc) throw new ReversibilityError(`uncall of undefined procedure '${name}'`);
  execStmts(invertStmts(proc.body), store, procs);
}
