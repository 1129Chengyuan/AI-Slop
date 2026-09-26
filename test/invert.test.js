import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "../src/parser.js";
import { check } from "../src/check.js";
import { Store, callProc, execStmts } from "../src/interp.js";
import { invertStmts, invertProc } from "../src/invert.js";
import { printProc } from "../src/printer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.join(__dirname, "..", "examples");

function loadExample(name) {
  const src = fs.readFileSync(path.join(examplesDir, name), "utf8");
  const program = parse(src);
  const { procs } = check(program);
  return { program, procs };
}

// Deep-equality that ignores line/col so structurally-equal ASTs compare
// equal even when synthesized nodes reuse a different node's position.
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

for (const name of ["fib.tnt", "xtea.tnt", "sqrt.tnt", "rle.tnt", "sort.tnt"]) {
  test(`invert(invert(p)) == p structurally for ${name}`, () => {
    const { program } = loadExample(name);
    for (const proc of program.procs) {
      const once = invertProc(proc);
      const twice = invertProc(once);
      assert.deepEqual(stripPositions(twice.body), stripPositions(proc.body));
    }
  });
}

test("invert(p) parses back as valid, re-parseable Tenet source", () => {
  const { program } = loadExample("xtea.tnt");
  const inverted = invertProc(program.procs[0]);
  const src = printProc(inverted);
  assert.doesNotThrow(() => parse(`u32 v0; u32 v1; u32 sum; u32 key[4]; int round;\n${src}\n`));
});

test("running invert(p) forward == running p backward, for every example", () => {
  const cases = [
    { file: "fib.tnt", proc: "fib", setup: (s) => (s.cell("n").value = 9n) },
    {
      file: "xtea.tnt", proc: "xtea_encrypt", setup: (s) => {
        s.cell("v0").value = 0x01234567n;
        s.cell("v1").value = 0x89abcdefn;
        const k = s.cell("key");
        k.values[0] = 0x00010203n; k.values[1] = 0x04050607n;
        k.values[2] = 0x08090a0bn; k.values[3] = 0x0c0d0e0fn;
      },
    },
    { file: "sqrt.tnt", proc: "isqrt", setup: (s) => (s.cell("x").value = 12345n) },
    {
      file: "rle.tnt", proc: "rle_encode", setup: (s) => {
        const b = s.cell("bits");
        [0, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 1, 0, 1].forEach((v, i) => (b.values[i] = BigInt(v)));
      },
    },
    {
      file: "sort.tnt", proc: "sort5", setup: (s) => {
        const a = s.cell("a");
        [4n, 2n, 0n, 3n, 1n].forEach((v, i) => (a.values[i] = v));
      },
    },
  ];

  for (const { file, proc, setup } of cases) {
    const { program, procs } = loadExample(file);

    // Run forward to completion first, to get a real "post" state.
    const storeA = new Store(program);
    setup(storeA);
    callProc(storeA, procs, proc);

    // Path 1: uncall via callProc's built-in uncallProc (invert-then-run).
    const storeB = new Store(program);
    setup(storeB);
    callProc(storeB, procs, proc);
    const invertedBody = invertStmts(procs.get(proc).body);
    execStmts(invertedBody, storeB, procs);

    assert.deepEqual(storeB.snapshot(), (() => {
      const s = new Store(program);
      setup(s);
      return s.snapshot();
    })(), `invert-then-run should restore the pre-call state for ${file}`);
  }
});
