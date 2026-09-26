// src/printer.js
//
// Pretty-prints an AST back to Tenet source. Used for:
//   - `tenet invert file.tnt` -- showing the inverted program as real,
//     re-parseable Tenet source (the whole point of having an inverter you
//     can trust is being able to read what it produced).
//   - round-trip tests: parse(print(parse(src))) should be structurally
//     equivalent to parse(src).
//   - the web playground's "inverted source" pane.

function indent(depth) {
  return "  ".repeat(depth);
}

export function printExpr(e) {
  switch (e.kind) {
    case "Literal":
      return e.value.toString();
    case "VarRef":
      return e.name;
    case "IndexRef":
      return `${e.name}[${printExpr(e.index)}]`;
    case "Empty":
      return `empty(${e.name})`;
    case "Top":
      return `top(${e.name})`;
    case "Unary":
      return `${e.op}${printAtom(e.operand)}`;
    case "Binary":
      return `${printAtom(e.left)} ${e.op} ${printAtom(e.right)}`;
    default:
      throw new Error(`printExpr: unknown expr kind '${e.kind}'`);
  }
}

// Wraps compound sub-expressions in parens so precedence survives the round
// trip; leaves atoms bare for readability.
function printAtom(e) {
  if (e.kind === "Binary" || e.kind === "Unary") return `(${printExpr(e)})`;
  return printExpr(e);
}

function printLvalue(lv) {
  if (lv.kind === "Var") return lv.name;
  return `${lv.name}[${printExpr(lv.index)}]`;
}

function printStmt(s, depth) {
  const pad = indent(depth);
  switch (s.kind) {
    case "Skip":
      return `${pad}skip;`;
    case "Update":
      return `${pad}${printLvalue(s.target)} ${s.op} ${printExpr(s.value)};`;
    case "Swap":
      return `${pad}${printLvalue(s.left)} <=> ${printLvalue(s.right)};`;
    case "Push":
      return `${pad}push ${s.varName} ${s.stackName};`;
    case "Pop":
      return `${pad}pop ${s.varName} ${s.stackName};`;
    case "Call":
      return `${pad}call ${s.name};`;
    case "Uncall":
      return `${pad}uncall ${s.name};`;
    case "If":
      return [
        `${pad}if ${printExpr(s.testEntry)} then`,
        printStmts(s.thenBody, depth + 1),
        `${pad}else`,
        printStmts(s.elseBody, depth + 1),
        `${pad}fi ${printExpr(s.testExit)};`,
      ].join("\n");
    case "From":
      return [
        `${pad}from ${printExpr(s.testEntry)} do`,
        printStmts(s.doBody, depth + 1),
        `${pad}loop`,
        printStmts(s.loopBody, depth + 1),
        `${pad}until ${printExpr(s.testExit)};`,
      ].join("\n");
    case "Local":
      return [
        `${pad}local ${s.type} ${s.name} = ${printExpr(s.initExpr)}`,
        printStmts(s.body, depth + 1),
        `${pad}delocal ${s.name} = ${printExpr(s.finalExpr)};`,
      ].join("\n");
    default:
      throw new Error(`printStmt: unknown statement kind '${s.kind}'`);
  }
}

export function printStmts(stmts, depth = 1) {
  if (stmts.length === 0) return indent(depth) + "skip;";
  return stmts.map((s) => printStmt(s, depth)).join("\n");
}

export function printProc(proc) {
  return [`proc ${proc.name}() {`, printStmts(proc.body, 1), `}`].join("\n");
}

export function printDecl(d) {
  if (d.kind === "StackDecl") return `stack ${d.name};`;
  if (d.size != null) return `${d.type} ${d.name}[${d.size}];`;
  return `${d.type} ${d.name};`;
}

export function printProgram(program) {
  const parts = [];
  for (const d of program.decls) parts.push(printDecl(d));
  if (program.decls.length && program.procs.length) parts.push("");
  for (let i = 0; i < program.procs.length; i++) {
    if (i > 0) parts.push("");
    parts.push(printProc(program.procs[i]));
  }
  return parts.join("\n") + "\n";
}
