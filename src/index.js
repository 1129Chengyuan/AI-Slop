// src/index.js
//
// Public API surface for Tenet: parse + check a program once, then run,
// call, uncall, invert, or single-step it. Re-exported so both bin/tenet.js
// and web/app.js (and the test suite) go through the same door.

export { tokenize, LexError } from "./lexer.js";
export { parse, ParseError } from "./parser.js";
export { check, CheckError } from "./check.js";
export {
  Store,
  ReversibilityError,
  evalExpr,
  execStmt,
  execStmts,
  execAtomicForward,
  execAtomicInverse,
  callProc,
  uncallProc,
} from "./interp.js";
export { invertStmt, invertStmts, invertProc } from "./invert.js";
export { printExpr, printStmts, printProc, printDecl, printProgram } from "./printer.js";
export { Machine } from "./machine.js";

import { parse } from "./parser.js";
import { check } from "./check.js";
import { Store, callProc, uncallProc } from "./interp.js";

// Convenience one-shot helpers used by the CLI.

export function load(source) {
  const program = parse(source);
  const { procs } = check(program);
  return { program, procs };
}

export function run(source, entryProc) {
  const { program, procs } = load(source);
  const store = new Store(program);
  callProc(store, procs, entryProc);
  return store;
}

export function uncall(source, entryProc) {
  const { program, procs } = load(source);
  const store = new Store(program);
  uncallProc(store, procs, entryProc);
  return store;
}
