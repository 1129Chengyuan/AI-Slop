import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "../src/parser.js";
import { check } from "../src/check.js";
import { Store, callProc, uncallProc, ReversibilityError } from "../src/interp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.join(__dirname, "..", "examples");

function loadExample(name) {
  const src = fs.readFileSync(path.join(examplesDir, name), "utf8");
  const program = parse(src);
  const { procs } = check(program);
  return { program, procs };
}

function fibNums(count) {
  const out = [0n, 1n];
  for (let i = 2; i < count + 2; i++) out.push(out[i - 1] + out[i - 2]);
  return out;
}

test("fib.tnt computes the correct Fibonacci pair for several n", () => {
  const { program, procs } = loadExample("fib.tnt");
  const F = fibNums(20);
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const store = new Store(program);
    store.cell("n").value = BigInt(n);
    callProc(store, procs, "fib");
    assert.equal(store.cell("x1").value, F[n], `F(${n})`);
    assert.equal(store.cell("x2").value, F[n + 1], `F(${n + 1})`);
    assert.equal(store.cell("i").value, BigInt(n));
  }
});

test("fib.tnt: call then uncall returns to all-zero state", () => {
  const { program, procs } = loadExample("fib.tnt");
  const store = new Store(program);
  store.cell("n").value = 12n;
  callProc(store, procs, "fib");
  uncallProc(store, procs, "fib");
  assert.equal(store.cell("x1").value, 0n);
  assert.equal(store.cell("x2").value, 0n);
  assert.equal(store.cell("i").value, 0n);
  assert.equal(store.cell("n").value, 12n); // n is pure input, untouched
});

test("isqrt.tnt computes floor(sqrt(x)) and uncalls cleanly", () => {
  const { program, procs } = loadExample("sqrt.tnt");
  for (const x of [1, 2, 3, 4, 15, 16, 17, 1000, 9999]) {
    const store = new Store(program);
    store.cell("x").value = BigInt(x);
    callProc(store, procs, "isqrt");
    assert.equal(store.cell("s").value, BigInt(Math.floor(Math.sqrt(x))), `sqrt(${x})`);
    uncallProc(store, procs, "isqrt");
    assert.equal(store.cell("s").value, 0n);
  }
});

test("rle.tnt encodes run lengths and uncall reconstructs the original bits", () => {
  const { program, procs } = loadExample("rle.tnt");
  const patterns = [
    [0, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
  ];
  for (const bits of patterns) {
    const store = new Store(program);
    const arr = store.cell("bits");
    bits.forEach((b, i) => (arr.values[i] = BigInt(b)));
    callProc(store, procs, "rle_encode");
    // Encoding destructively erases bits[]; runs stack holds the recovery info.
    assert.ok(arr.values.every((v) => v === 0n), "bits[] fully consumed by encoding");
    assert.ok(store.cell("runs").values.length > 0);

    uncallProc(store, procs, "rle_encode");
    assert.deepEqual(arr.values, bits.map(BigInt), "uncall reconstructs the original bits");
    assert.equal(store.cell("runs").values.length, 0);
    assert.equal(store.cell("pos").value, 0n);
    assert.equal(store.cell("count").value, 0n);
    assert.equal(store.cell("cur").value, 0n);
  }
});

test("sort5.tnt sorts every permutation of 5 distinct values", () => {
  const { program, procs } = loadExample("sort.tnt");
  const values = [0n, 1n, 2n, 3n, 4n];
  const perms = permutations(values);
  for (const perm of perms) {
    const store = new Store(program);
    const arr = store.cell("a");
    perm.forEach((v, i) => (arr.values[i] = v));
    callProc(store, procs, "sort5");
    const sorted = arr.values.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(arr.values, sorted, `sorted(${perm})`);
    assert.equal(store.cell("decisions").values.length, 10);

    uncallProc(store, procs, "sort5");
    assert.deepEqual(arr.values, perm, "uncall restores the original permutation");
    assert.equal(store.cell("decisions").values.length, 0);
    assert.equal(store.cell("d").value, 0n);
  }
});

test("ReversibilityError on a failed exit assertion", () => {
  // A deliberately wrong exit test: entering with x > 0 always keeps x > 0
  // after adding to it, so asserting `x < 0` on exit can never hold.
  const src = `
    int x;
    proc bad() {
      if x > 0 then
        x += 1;
      else
        x -= 1;
      fi x < 0;
    }
  `;
  const program = parse(src);
  const { procs } = check(program);
  const store = new Store(program);
  store.cell("x").value = 5n;
  assert.throws(() => callProc(store, procs, "bad"), ReversibilityError);
});

test("ReversibilityError on pop into a nonzero variable / empty stack", () => {
  const src = `
    int x;
    stack s;
    proc p1() { pop x s; }
  `;
  const program = parse(src);
  const { procs } = check(program);
  const store = new Store(program);
  assert.throws(() => callProc(store, procs, "p1"), /empty stack/);

  const store2 = new Store(program);
  store2.cell("x").value = 1n;
  store2.cell("s").values.push(9n);
  assert.throws(() => callProc(store2, procs, "p1"), /not zero/);
});

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}
