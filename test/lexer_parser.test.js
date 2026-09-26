import test from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/lexer.js";
import { parse } from "../src/parser.js";
import { printProgram } from "../src/printer.js";

test("lexer: numbers, hex, identifiers, operators with positions", () => {
  const toks = tokenize("x += 0x1F; y <=> z");
  const types = toks.map((t) => t.type);
  assert.deepEqual(types, ["IDENT", "+=", "NUMBER", ";", "IDENT", "<=>", "IDENT", "EOF"]);
  assert.equal(toks[2].value, 31n);
  assert.equal(toks[0].line, 1);
  assert.equal(toks[0].col, 1);
  assert.equal(toks[4].col, 12);
});

test("lexer: comments are skipped", () => {
  const toks = tokenize("x += 1; // trailing\n# hash\n/* block\ncomment */ y -= 2;");
  const types = toks.map((t) => t.type);
  assert.deepEqual(types, ["IDENT", "+=", "NUMBER", ";", "IDENT", "-=", "NUMBER", ";", "EOF"]);
});

test("lexer: rejects unterminated block comment and bad characters", () => {
  assert.throws(() => tokenize("/* never closed"), /unterminated block comment/);
  assert.throws(() => tokenize("x @ y;"), /unexpected character/);
});

test("parser: expression precedence matches C-like conventions", () => {
  const src = `
    int x;
    proc p() {
      x += 1 + 2 * 3;
    }
  `;
  const prog = parse(src);
  const upd = prog.procs[0].body[0];
  assert.equal(upd.kind, "Update");
  // 1 + (2 * 3)
  assert.equal(upd.value.op, "+");
  assert.equal(upd.value.right.op, "*");
});

test("parser: full grammar (if/from/local/call) parses", () => {
  const src = `
    int x;
    int y;
    stack s;
    proc helper() {
      skip;
    }
    proc main() {
      if x > 0 then
        x += 1;
      else
        x -= 1;
      fi x > 0;
      from y == 0 do
        y += 1;
      loop
        y += 1;
      until y == 3;
      local int t = 5
        x += t;
      delocal t = 5;
      call helper;
      uncall helper;
      push x s;
      pop x s;
    }
  `;
  const prog = parse(src);
  assert.equal(prog.procs.length, 2);
  const main = prog.procs[1];
  assert.deepEqual(main.body.map((s) => s.kind), [
    "If", "From", "Local", "Call", "Uncall", "Push", "Pop",
  ]);
});

test("parser: reports line/col on syntax errors", () => {
  assert.throws(() => parse("int x\n"), (err) => {
    return err.name === "ParseError" && err.line === 2;
  });
});

test("round trip: parse -> print -> parse yields the same structure", () => {
  const src = `
int n;
int x1;
int x2;

proc fib() {
  x2 += 1;
  from x1 == 0 do
    x1 += x2;
    x1 <=> x2;
  loop
    x1 += x2;
    x1 <=> x2;
  until n == 0;
}
`;
  const p1 = parse(src);
  const printed = printProgram(p1);
  const p2 = parse(printed);
  assert.deepEqual(stripPositions(p1), stripPositions(p2));
});

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
