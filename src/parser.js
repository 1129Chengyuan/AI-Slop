// src/parser.js
//
// Recursive-descent parser producing a plain-object AST. Grammar is
// documented in README.md ("Language tour"); the short version:
//
//   program   := decl* proc*
//   decl      := ('int'|'u32') IDENT ('[' NUMBER ']')? ';'
//              | 'stack' IDENT ';'
//   proc      := 'proc' IDENT '(' ')' block
//   block     := '{' stmt* '}'
//   stmt      := lvalue ('+='|'-='|'^=') expr ';'
//              | lvalue '<=>' lvalue ';'
//              | 'push' IDENT IDENT ';'
//              | 'pop' IDENT IDENT ';'
//              | 'if' expr 'then' stmt* 'else' stmt* 'fi' expr ';'
//              | 'from' expr 'do' stmt* 'loop' stmt* 'until' expr ';'
//              | 'local' ('int'|'u32') IDENT '=' expr stmt* 'delocal' IDENT '=' expr ';'
//              | 'call' IDENT ';' | 'uncall' IDENT ';' | 'skip' ';'
//   lvalue    := IDENT | IDENT '[' expr ']'
//
// Expressions use standard precedence climbing (|| < && < equality <
// relational < bitor < bitxor < bitand < shift < additive < multiplicative
// < unary < primary).

import { tokenize } from "./lexer.js";

export class ParseError extends Error {
  constructor(message, line, col) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = "ParseError";
    this.line = line;
    this.col = col;
  }
}

// Binary operator precedence table (higher binds tighter).
const PRECEDENCE = {
  "||": 1,
  "&&": 2,
  "==": 3, "!=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "|": 5,
  "^": 6,
  "&": 7,
  "<<": 8, ">>": 8,
  "+": 9, "-": 9,
  "*": 10, "/": 10, "%": 10,
};

export function parse(source) {
  const tokens = tokenize(source);
  let pos = 0;

  function peek(offset = 0) {
    return tokens[pos + offset];
  }
  function cur() {
    return tokens[pos];
  }
  function at(type) {
    return cur().type === type;
  }
  function advance() {
    const t = tokens[pos];
    pos++;
    return t;
  }
  function expect(type) {
    if (!at(type)) {
      throw new ParseError(`expected '${type}' but found '${cur().type}'`, cur().line, cur().col);
    }
    return advance();
  }

  function parseProgram() {
    const decls = [];
    const procs = [];
    while (!at("EOF")) {
      if (at("PROC")) {
        procs.push(parseProc());
      } else {
        decls.push(parseDecl());
      }
    }
    return { kind: "Program", decls, procs };
  }

  function parseDecl() {
    const line = cur().line, col = cur().col;
    if (at("STACK")) {
      advance();
      const name = expect("IDENT").value;
      expect(";");
      return { kind: "StackDecl", name, line, col };
    }
    const type = parseTypeName();
    const name = expect("IDENT").value;
    let size = null;
    if (at("[")) {
      advance();
      size = Number(expect("NUMBER").value);
      expect("]");
    }
    expect(";");
    return { kind: "VarDecl", type, name, size, line, col };
  }

  function parseTypeName() {
    if (at("INT")) { advance(); return "int"; }
    if (at("U32")) { advance(); return "u32"; }
    throw new ParseError(`expected type ('int' or 'u32') but found '${cur().type}'`, cur().line, cur().col);
  }

  function parseProc() {
    const line = cur().line, col = cur().col;
    expect("PROC");
    const name = expect("IDENT").value;
    expect("(");
    expect(")");
    const body = parseBlock();
    return { kind: "Proc", name, body, line, col };
  }

  function parseBlock() {
    expect("{");
    const stmts = [];
    while (!at("}")) {
      stmts.push(parseStmt());
    }
    expect("}");
    return stmts;
  }

  // Statement lists inside if/from bodies are delimited by keywords, not braces.
  function parseStmtsUntil(...terminators) {
    const stmts = [];
    while (!terminators.includes(cur().type)) {
      stmts.push(parseStmt());
    }
    return stmts;
  }

  function parseLvalue() {
    const line = cur().line, col = cur().col;
    const name = expect("IDENT").value;
    if (at("[")) {
      advance();
      const index = parseExpr();
      expect("]");
      return { kind: "Index", name, index, line, col };
    }
    return { kind: "Var", name, line, col };
  }

  function parseStmt() {
    const line = cur().line, col = cur().col;

    if (at("SKIP")) { advance(); expect(";"); return { kind: "Skip", line, col }; }

    if (at("CALL")) {
      advance();
      const name = expect("IDENT").value;
      expect(";");
      return { kind: "Call", name, line, col };
    }
    if (at("UNCALL")) {
      advance();
      const name = expect("IDENT").value;
      expect(";");
      return { kind: "Uncall", name, line, col };
    }

    if (at("PUSH")) {
      advance();
      const varName = expect("IDENT").value;
      const stackName = expect("IDENT").value;
      expect(";");
      return { kind: "Push", varName, stackName, line, col };
    }
    if (at("POP")) {
      advance();
      const varName = expect("IDENT").value;
      const stackName = expect("IDENT").value;
      expect(";");
      return { kind: "Pop", varName, stackName, line, col };
    }

    if (at("IF")) {
      advance();
      const testEntry = parseExpr();
      expect("THEN");
      const thenBody = parseStmtsUntil("ELSE");
      expect("ELSE");
      const elseBody = parseStmtsUntil("FI");
      expect("FI");
      const testExit = parseExpr();
      expect(";");
      return { kind: "If", testEntry, thenBody, elseBody, testExit, line, col };
    }

    if (at("FROM")) {
      advance();
      const testEntry = parseExpr();
      expect("DO");
      const doBody = parseStmtsUntil("LOOP");
      expect("LOOP");
      const loopBody = parseStmtsUntil("UNTIL");
      expect("UNTIL");
      const testExit = parseExpr();
      expect(";");
      return { kind: "From", testEntry, doBody, loopBody, testExit, line, col };
    }

    if (at("LOCAL")) {
      advance();
      const type = parseTypeName();
      const name = expect("IDENT").value;
      expect("=");
      const initExpr = parseExpr();
      const body = parseStmtsUntil("DELOCAL");
      expect("DELOCAL");
      const delocalName = expect("IDENT").value;
      if (delocalName !== name) {
        throw new ParseError(
          `delocal name '${delocalName}' does not match local name '${name}'`,
          cur().line, cur().col,
        );
      }
      expect("=");
      const finalExpr = parseExpr();
      expect(";");
      return { kind: "Local", type, name, initExpr, body, finalExpr, line, col };
    }

    // Remaining forms all start with an lvalue.
    const target = parseLvalue();

    if (at("+=") || at("-=") || at("^=")) {
      const op = advance().type;
      const value = parseExpr();
      expect(";");
      return { kind: "Update", op, target, value, line, col };
    }
    if (at("<=>")) {
      advance();
      const other = parseLvalue();
      expect(";");
      return { kind: "Swap", left: target, right: other, line, col };
    }

    throw new ParseError(`unexpected token '${cur().type}' after lvalue`, cur().line, cur().col);
  }

  // --- Expressions: precedence climbing ---

  function parseExpr() {
    return parseBinary(1);
  }

  function parseBinary(minPrec) {
    let left = parseUnary();
    while (true) {
      const t = cur();
      const prec = PRECEDENCE[t.type];
      if (prec === undefined || prec < minPrec) break;
      const op = advance().type;
      const right = parseBinary(prec + 1);
      left = { kind: "Binary", op, left, right, line: t.line, col: t.col };
    }
    return left;
  }

  function parseUnary() {
    const t = cur();
    if (t.type === "!" || t.type === "-") {
      advance();
      const operand = parseUnary();
      return { kind: "Unary", op: t.type, operand, line: t.line, col: t.col };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = cur();
    if (t.type === "NUMBER") {
      advance();
      return { kind: "Literal", value: t.value, line: t.line, col: t.col };
    }
    if (t.type === "(") {
      advance();
      const e = parseExpr();
      expect(")");
      return e;
    }
    if (t.type === "EMPTY") {
      advance();
      expect("(");
      const name = expect("IDENT").value;
      expect(")");
      return { kind: "Empty", name, line: t.line, col: t.col };
    }
    if (t.type === "TOP") {
      advance();
      expect("(");
      const name = expect("IDENT").value;
      expect(")");
      return { kind: "Top", name, line: t.line, col: t.col };
    }
    if (t.type === "IDENT") {
      const lv = parseLvalue();
      return lv.kind === "Index"
        ? { kind: "IndexRef", name: lv.name, index: lv.index, line: t.line, col: t.col }
        : { kind: "VarRef", name: lv.name, line: t.line, col: t.col };
    }
    throw new ParseError(`unexpected token '${t.type}' in expression`, t.line, t.col);
  }

  const program = parseProgram();
  expect("EOF");
  return program;
}
