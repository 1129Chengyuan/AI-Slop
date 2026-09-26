// src/machine.js
//
// The small-step reversible machine: this is the engine behind the
// time-travel debugger. It executes (and un-executes) one atomic statement
// per `step()` call, and it stores *zero execution history*. Stepping
// backward through a million-iteration loop costs the same O(1) extra
// memory as stepping forward through it -- "undo" is computed fresh from
// the current store and control position every time, by re-deriving which
// branch/iteration we must be in from the language's entry/exit assertions,
// never by replaying a log.
//
// The control state is a stack of `Frame`s, one per currently-open nested
// construct (an if-branch, a loop iteration, a local scope, a call). Its
// size is bounded by *nesting depth*, not by how many statements have run --
// that's the whole trick. See README.md ("How the machine works") for the
// worked example this file's logic is based on.
//
// ## The core invariant
//
// Every Frame has an `arrayDir` of +1 or -1: the direction `idx` moves when
// this frame is making progress in the sense it was created for (executing
// a statement list top-to-bottom, or un-executing one bottom-to-top), and a
// `createdWith` ('fwd'/'bwd') recording which global request was active the
// moment the frame was pushed. Both are fixed for the frame's entire
// lifetime -- a frame is never re-pointed at a different arrayDir; when a
// from-loop needs new semantics (switching between its do/loop bodies) it
// gets a brand new owner/arrayDir/createdWith triple, computed the same way
// a fresh push would be.
//
// A single request -- step(machine, 'fwd') or step(machine, 'bwd') -- means
// "advance/retreat the whole program by one atomic statement." Whichever
// frame is currently on top might have been created by a *different* past
// request than the current one (the user can reverse direction mid-frame,
// any number of times), so the concrete index movement is never read off
// `direction` directly: it's `direction === frame.createdWith ? frame.arrayDir
// : -frame.arrayDir`. Comparing `direction` to the frame's OWN createdWith
// (not blindly XOR-ing the live request against arrayDir every time) is
// what makes resuming a frame across separate step() calls correct no
// matter how many times the user has changed their mind about direction in
// between -- get this comparison wrong and stepping back and forth near a
// loop or branch boundary quietly redoes instead of undoing (or vice
// versa), which will either scramble the store or spin forever.
//
// A resolution can also land on a frame's terminal idx from either of two
// distinct "senses" -- see the comment on resolveFrame() for what that
// means and why it changes which assertion gets checked.

import { evalExpr, execAtomicForward, execAtomicInverse, ReversibilityError } from "./interp.js";
import { truthy, wrap } from "./values.js";

const COMPOUND_KINDS = new Set(["If", "From", "Local", "Call", "Uncall"]);

function isCompound(stmt) {
  return COMPOUND_KINDS.has(stmt.kind);
}

export class Machine {
  constructor(store, procs, entryProcName, { uncall = false } = {}) {
    this.store = store;
    this.procs = procs;
    const proc = procs.get(entryProcName);
    if (!proc) throw new ReversibilityError(`no such procedure '${entryProcName}'`);
    this.entryProcName = entryProcName;
    this.uncall = uncall;
    // The initial frame: forward call starts at idx 0 moving toward the
    // end; an uncall starts at the end moving toward 0.
    // createdWith: "fwd" always, for the entry frame -- "step fwd" always
    // means "make more progress on whatever this frame is doing" (which is
    // itself already encoded by arrayDir: +1 to run forward, -1 to uncall).
    this.stack = uncall
      ? [{ stmts: proc.body, idx: proc.body.length, arrayDir: -1, owner: null, createdWith: "fwd" }]
      : [{ stmts: proc.body, idx: 0, arrayDir: +1, owner: null, createdWith: "fwd" }];
  }

  // Advances the whole machine by exactly one atomic statement.
  // Returns { status: 'ok', stmt, dir } after executing/undoing one
  // statement, or { status: 'halted', edge } if there is nothing more to do
  // in that direction (edge is 'end' for the natural finish of the entry
  // call, 'start' for having unwound all the way back to its beginning).
  step(direction) {
    if (direction !== "fwd" && direction !== "bwd") {
      throw new Error(`step: direction must be 'fwd' or 'bwd', got '${direction}'`);
    }
    const { stack, store, procs } = this;

    while (true) {
      const frame = stack[stack.length - 1];
      // moveDir: which way idx moves to make ONE MORE UNIT OF PROGRESS on
      // whatever this frame is doing, given the current request. If the
      // request matches the direction that was active when we entered this
      // frame (frame.createdWith), progress continues in the frame's own
      // arrayDir; a request pointing the other way reverses it. This must
      // be recomputed from frame.createdWith (fixed at push time) rather
      // than blindly re-XORing against `direction` every time -- a frame
      // that was pushed to *undo* something during a 'bwd' step still needs
      // moveDir = arrayDir on a *later* 'bwd' step that resumes it (not
      // -arrayDir), since we're continuing that same undo, not reversing it.
      const moveDir = direction === frame.createdWith ? frame.arrayDir : -frame.arrayDir;

      const terminal = moveDir === +1 ? frame.stmts.length : 0;
      if (frame.idx === terminal) {
        if (frame.owner === null) {
          return { status: "halted", edge: moveDir === +1 ? "end" : "start" };
        }
        resolveFrame(frame, stack, store, direction);
        continue;
      }

      const entryIdx = frame.idx; // outer idx, unchanged until the pushed frame resolves
      const nextOuterIdx = moveDir === +1 ? frame.idx + 1 : frame.idx - 1;
      const stmtIdx = moveDir === +1 ? frame.idx : frame.idx - 1;
      const stmt = frame.stmts[stmtIdx];

      if (isCompound(stmt)) {
        const crossedForward = moveDir === +1;
        enterCompound(stmt, crossedForward, entryIdx, nextOuterIdx, store, procs, stack, direction);
        continue;
      }

      if (moveDir === +1) {
        execAtomicForward(stmt, store);
        frame.idx += 1;
      } else {
        execAtomicInverse(stmt, store);
        frame.idx -= 1;
      }
      return { status: "ok", stmt, dir: moveDir };
    }
  }

  // Runs to completion (or a step cap, to make infinite-loop bugs fail
  // fast in tests rather than hang) in the given direction.
  run(direction, maxSteps = 10_000_000) {
    for (let i = 0; i < maxSteps; i++) {
      const r = this.step(direction);
      if (r.status === "halted") return r;
    }
    throw new Error(`Machine.run: exceeded ${maxSteps} steps without halting`);
  }

  // How many nested frames are currently open -- proportional to call/loop
  // *nesting depth*, never to how many statements have executed. This is
  // the number the playground displays as "history memory."
  frameDepth() {
    return this.stack.length;
  }

  snapshot() {
    return this.store.snapshot();
  }

  // The statement the machine would execute next if stepped 'fwd', and
  // separately the one it would undo if stepped 'bwd' -- both computed
  // read-only (no mutation), for UI highlighting. Either may be null at a
  // true boundary (start/end of the whole program).
  peek() {
    return { next: this.peekDirection("fwd"), prev: this.peekDirection("bwd") };
  }

  peekDirection(direction) {
    // Walk the same resolution logic as step(), but read-only. Two things
    // must not leak into the real machine: the frame stack (we clone each
    // frame we touch) and local-variable scoping (pushLocal/popLocal), so
    // Local-entry/exit boundary crossings run against a "shadow" store that
    // shares the real globals/arrays but keeps its own scope stack.
    const virtualStack = this.stack.map((f) => ({ ...f }));
    const shadow = shadowStore(this.store);
    try {
      while (true) {
        const frame = virtualStack[virtualStack.length - 1];
        const moveDir = direction === frame.createdWith ? frame.arrayDir : -frame.arrayDir;
        const terminal = moveDir === +1 ? frame.stmts.length : 0;
        if (frame.idx === terminal) {
          if (frame.owner === null) return null;
          resolveFrame(frame, virtualStack, shadow, direction);
          continue;
        }
        const entryIdx = frame.idx;
        const stmtIdx = moveDir === +1 ? frame.idx : frame.idx - 1;
        const stmt = frame.stmts[stmtIdx];
        if (isCompound(stmt)) {
          const crossedForward = moveDir === +1;
          const nextOuterIdx = moveDir === +1 ? frame.idx + 1 : frame.idx - 1;
          enterCompound(stmt, crossedForward, entryIdx, nextOuterIdx, shadow, this.procs, virtualStack, direction);
          continue;
        }
        return { line: stmt.line, col: stmt.col, kind: stmt.kind };
      }
    } catch {
      return null;
    }
  }
}

// A read-only-safe wrapper for peek(): shares the real store's globals
// (arrays/scalars/stacks) but keeps a private copy of the local-scope
// stack, so speculative Local entry/exit during peeking never mutates the
// real machine's scopes.
function shadowStore(store) {
  const scopes = store.scopes.slice();
  return {
    cell(name) {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].has(name)) return scopes[i].get(name);
      }
      const c = store.globals.get(name);
      if (!c) throw new ReversibilityError(`undeclared variable '${name}' at runtime`);
      return c;
    },
    pushLocal(name, type, value) {
      const scope = new Map();
      scope.set(name, { kind: "scalar", type, value });
      scopes.push(scope);
    },
    popLocal() {
      scopes.pop();
    },
  };
}

// Pushes a new frame descending into `stmt` (an If/From/Local/Call/Uncall).
// `crossedForward` says whether we're encountering it while making forward
// array-progress through the parent (i.e. "doing" it) or backward
// array-progress ("undoing" it). `entryIdx` is the parent's idx *before*
// this crossing (what to restore it to if we later reverse all the way back
// out of this frame without ever finishing it); `targetIdx` is what the
// parent's idx becomes once the pushed frame finishes normally.
function enterCompound(stmt, crossedForward, entryIdx, targetIdx, store, procs, stack, direction) {
  switch (stmt.kind) {
    case "If": {
      if (crossedForward) {
        const entry = truthy(evalExpr(stmt.testEntry, store));
        const branch = entry ? "then" : "else";
        const body = entry ? stmt.thenBody : stmt.elseBody;
        stack.push({ stmts: body, idx: 0, arrayDir: +1, createdWith: direction, owner: { kind: "if", node: stmt, branch, crossedForward: true, entryIdx, targetIdx } });
      } else {
        const exit = truthy(evalExpr(stmt.testExit, store));
        const branch = exit ? "then" : "else";
        const body = exit ? stmt.thenBody : stmt.elseBody;
        stack.push({ stmts: body, idx: body.length, arrayDir: -1, createdWith: direction, owner: { kind: "if", node: stmt, branch, crossedForward: false, entryIdx, targetIdx } });
      }
      return;
    }
    case "From": {
      // A from-loop's owner remembers fixed `beforeIdx`/`afterIdx` (the
      // outer positions just before/after the *whole statement*), not
      // entry/target relative to this particular crossing -- resolveFrame
      // re-derives (sub, moveDir) fresh on every resolution regardless of
      // how the frame now on the stack was originally pushed, so the pop
      // targets it uses must be equally direction-agnostic. See its
      // comment.
      const beforeIdx = crossedForward ? entryIdx : targetIdx;
      const afterIdx = crossedForward ? targetIdx : entryIdx;
      if (crossedForward) {
        if (!truthy(evalExpr(stmt.testEntry, store))) {
          throw new ReversibilityError("from-loop entry assertion failed", stmt.line, stmt.col);
        }
        stack.push({ stmts: stmt.doBody, idx: 0, arrayDir: +1, createdWith: direction, owner: { kind: "from", node: stmt, sub: "do", beforeIdx, afterIdx } });
      } else {
        if (!truthy(evalExpr(stmt.testExit, store))) {
          throw new ReversibilityError("from-loop exit assertion failed while undoing", stmt.line, stmt.col);
        }
        stack.push({ stmts: stmt.doBody, idx: stmt.doBody.length, arrayDir: -1, createdWith: direction, owner: { kind: "from", node: stmt, sub: "do", beforeIdx, afterIdx } });
      }
      return;
    }
    case "Local": {
      if (crossedForward) {
        const v0 = wrap(stmt.type, evalExpr(stmt.initExpr, store));
        store.pushLocal(stmt.name, stmt.type, v0);
        stack.push({ stmts: stmt.body, idx: 0, arrayDir: +1, createdWith: direction, owner: { kind: "local", node: stmt, crossedForward: true, entryIdx, targetIdx } });
      } else {
        const vf = wrap(stmt.type, evalExpr(stmt.finalExpr, store));
        store.pushLocal(stmt.name, stmt.type, vf);
        stack.push({ stmts: stmt.body, idx: stmt.body.length, arrayDir: -1, createdWith: direction, owner: { kind: "local", node: stmt, crossedForward: false, entryIdx, targetIdx } });
      }
      return;
    }
    case "Call":
    case "Uncall": {
      const proc = procs.get(stmt.name);
      if (!proc) throw new ReversibilityError(`undefined procedure '${stmt.name}'`, stmt.line, stmt.col);
      // "Doing" a Call forward, or "undoing" an Uncall, both run the callee
      // forward. "Doing" an Uncall forward, or "undoing" a Call, both run
      // the callee backward.
      const runForward = (stmt.kind === "Call") === crossedForward;
      if (runForward) {
        stack.push({ stmts: proc.body, idx: 0, arrayDir: +1, createdWith: direction, owner: { kind: "call", node: stmt, entryIdx, targetIdx } });
      } else {
        stack.push({ stmts: proc.body, idx: proc.body.length, arrayDir: -1, createdWith: direction, owner: { kind: "call", node: stmt, entryIdx, targetIdx } });
      }
      return;
    }
    default:
      throw new Error(`enterCompound: '${stmt.kind}' is not a compound statement`);
  }
}

// Called when the top frame has reached a terminal idx: either 0 or
// frame.stmts.length, whichever `moveDir` (recomputed here from the CURRENT
// `direction` vs. this frame's fixed createdWith/arrayDir) was heading
// toward. Two structurally different things can have just happened, and
// resolution must tell them apart:
//
//   sense "A" (moveDir === frame.arrayDir): the frame finished normally, in
//   the sense it was created for -- e.g. an If's chosen branch ran to its
//   end. Hand control back to the parent at `targetIdx` (the position right
//   after this compound statement, from whichever side we entered it).
//
//   sense "B" (moveDir === -frame.arrayDir): we've been resuming this frame
//   in the *opposite* sense (the user reversed direction while inside it)
//   and have now reversed it all the way back to ITS OWN start. Hand
//   control back to the parent at `entryIdx` instead -- as far as the
//   parent is concerned, this compound statement was never entered.
//
// Which of testEntry/testExit to check is therefore NOT simply a function
// of how the frame was originally entered (`crossedForward`) -- it flips
// under sense B. A frame entered by *doing* an If forward (crossedForward
// = true) normally checks testExit (sense A); but reversed all the way back
// to its own start (sense B), the check that must hold is testEntry --
// exactly the check a crossedForward=false frame uses in ITS sense-A case.
// `checkExit` below is exactly that XOR.
function resolveFrame(frame, stack, store, direction) {
  const owner = frame.owner;
  const moveDir = direction === frame.createdWith ? frame.arrayDir : -frame.arrayDir;
  const senseA = moveDir === frame.arrayDir;

  switch (owner.kind) {
    case "if": {
      const { node, branch, crossedForward } = owner;
      const checkExit = crossedForward === senseA;
      const value = truthy(evalExpr(checkExit ? node.testExit : node.testEntry, store));
      if (value !== (branch === "then")) {
        throw new ReversibilityError(
          `if-${checkExit ? "exit" : "entry"} assertion failed`, node.line, node.col,
        );
      }
      stack.pop();
      stack[stack.length - 1].idx = senseA ? owner.targetIdx : owner.entryIdx;
      return;
    }
    case "local": {
      const { node, crossedForward } = owner;
      const checkExit = crossedForward === senseA;
      const expectExpr = checkExit ? node.finalExpr : node.initExpr;
      const expected = wrap(node.type, evalExpr(expectExpr, store));
      const actual = store.cell(node.name).value;
      if (actual !== expected) {
        throw new ReversibilityError(
          `delocal mismatch for '${node.name}': expected ${expected}, got ${actual}`, node.line, node.col,
        );
      }
      store.popLocal();
      stack.pop();
      stack[stack.length - 1].idx = senseA ? owner.targetIdx : owner.entryIdx;
      return;
    }
    case "call": {
      stack.pop();
      stack[stack.length - 1].idx = senseA ? owner.targetIdx : owner.entryIdx;
      return;
    }
    case "from": {
      // No `crossedForward` here by design: a from-loop's sub-frame gets
      // resumed in either sense arbitrarily often as the user steps back
      // and forth through it, so which check/transition applies is decided
      // fresh every time from (owner.sub, moveDir) alone -- never from how
      // the frame was originally created. See the file-level comment.
      const { node, sub, beforeIdx, afterIdx } = owner;
      if (sub === "do") {
        if (moveDir === +1) {
          // Just finished doBody forward -- decide whether the loop is done.
          const exit = truthy(evalExpr(node.testExit, store));
          if (exit) {
            stack.pop();
            stack[stack.length - 1].idx = afterIdx;
          } else {
            frame.stmts = node.loopBody;
            frame.idx = 0;
            frame.arrayDir = +1;
            frame.createdWith = direction;
            frame.owner = { kind: "from", node, sub: "loop", beforeIdx, afterIdx };
          }
        } else {
          // Just undid doBody back to its start -- decide whether we've
          // unwound the entire loop or need to keep undoing a prior loopBody.
          const entry = truthy(evalExpr(node.testEntry, store));
          if (entry) {
            stack.pop();
            stack[stack.length - 1].idx = beforeIdx;
          } else {
            frame.stmts = node.loopBody;
            frame.idx = node.loopBody.length;
            frame.arrayDir = -1;
            frame.createdWith = direction;
            frame.owner = { kind: "from", node, sub: "loop", beforeIdx, afterIdx };
          }
        }
      } else {
        if (moveDir === +1) {
          // Just finished loopBody forward -- must be about to start doBody again.
          const entry = truthy(evalExpr(node.testEntry, store));
          if (entry) {
            throw new ReversibilityError("from-loop entry test unexpectedly true on re-entry", node.line, node.col);
          }
          frame.stmts = node.doBody;
          frame.idx = 0;
          frame.arrayDir = +1;
          frame.createdWith = direction;
          frame.owner = { kind: "from", node, sub: "do", beforeIdx, afterIdx };
        } else {
          // Just undid loopBody back to its start -- resume undoing the doBody before it.
          frame.stmts = node.doBody;
          frame.idx = node.doBody.length;
          frame.arrayDir = -1;
          frame.createdWith = direction;
          frame.owner = { kind: "from", node, sub: "do", beforeIdx, afterIdx };
        }
      }
      return;
    }
    default:
      throw new Error(`resolveFrame: unknown owner kind '${owner.kind}'`);
  }
}
