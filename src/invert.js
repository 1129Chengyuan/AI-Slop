// src/invert.js
//
// The AST inverter. This is the heart of the "reversible" claim: for every
// statement form in Tenet, we can produce another statement that undoes it,
// purely syntactically, without ever running the program. `uncall p` in the
// interpreter is implemented as "invert p's body, then run it forward" --
// see src/interp.js. `bin/tenet.js invert` exposes this directly so you can
// print the decoder for an encoder you wrote.
//
// The two structural rules worth remembering:
//   - A *sequence* reverses order: invert([s1, s2, s3]) = [inv(s3), inv(s2), inv(s1)].
//   - An *if* or *loop* swaps its entry/exit tests but keeps its branches in
//     place (see the comments on invertIf/invertFrom for why that's not a
//     typo -- it trips people up the first time).
//
// Expressions are never touched -- only statements have a direction.

export function invertStmts(stmts) {
  const out = [];
  for (let i = stmts.length - 1; i >= 0; i--) {
    out.push(invertStmt(stmts[i]));
  }
  return out;
}

const UPDATE_INVERSE = { "+=": "-=", "-=": "+=", "^=": "^=" };

export function invertStmt(s) {
  switch (s.kind) {
    case "Skip":
      return s;

    case "Update":
      return { ...s, op: UPDATE_INVERSE[s.op] };

    case "Swap":
      // A swap is its own inverse: doing it twice is the identity.
      return s;

    case "Push":
      return { kind: "Pop", varName: s.varName, stackName: s.stackName, line: s.line, col: s.col };
    case "Pop":
      return { kind: "Push", varName: s.varName, stackName: s.stackName, line: s.line, col: s.col };

    case "If":
      // Forward: e1 picks a branch, e2 confirms which one ran.
      // Inverse: read e2 to pick the same branch, undo it, and land back on
      // whatever e1 originally certified. The branches are NOT swapped --
      // "thenBody" is still the code associated with the branch where the
      // *entry* test (now e2) is true, because that's the branch that was
      // forward-executed whenever e2 came out true.
      return {
        kind: "If",
        testEntry: s.testExit,
        thenBody: invertStmts(s.thenBody),
        elseBody: invertStmts(s.elseBody),
        testExit: s.testEntry,
        line: s.line,
        col: s.col,
      };

    case "From":
      // Forward: enter while e1 holds, run doBody, stop when e2 holds,
      // otherwise run loopBody and repeat. Inverse: enter while e2 holds
      // (i.e. start from a state that was a stopping point), undo doBody,
      // stop once e1 holds (the original entry condition), otherwise undo
      // loopBody and repeat undoing doBody.
      return {
        kind: "From",
        testEntry: s.testExit,
        doBody: invertStmts(s.doBody),
        loopBody: invertStmts(s.loopBody),
        testExit: s.testEntry,
        line: s.line,
        col: s.col,
      };

    case "Local":
      // Swap which expression is the "known" one at each end, and invert
      // the body that runs in between.
      return {
        kind: "Local",
        type: s.type,
        name: s.name,
        initExpr: s.finalExpr,
        body: invertStmts(s.body),
        finalExpr: s.initExpr,
        line: s.line,
        col: s.col,
      };

    case "Call":
      return { kind: "Uncall", name: s.name, line: s.line, col: s.col };
    case "Uncall":
      return { kind: "Call", name: s.name, line: s.line, col: s.col };

    default:
      throw new Error(`invertStmt: unknown statement kind '${s.kind}'`);
  }
}

export function invertProc(proc) {
  return { kind: "Proc", name: proc.name, body: invertStmts(proc.body), line: proc.line, col: proc.col };
}
