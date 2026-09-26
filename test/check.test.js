import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { check, CheckError } from "../src/check.js";

function checkSrc(src) {
  return check(parse(src));
}

test("rejects target variable appearing on RHS of update", () => {
  const src = `int x; proc p() { x += x; }`;
  assert.throws(() => checkSrc(src), CheckError);
});

test("rejects target array appearing on RHS via another element", () => {
  const src = `int a[4]; proc p() { a[0] += a[1]; }`;
  assert.throws(() => checkSrc(src), CheckError);
});

test("rejects target array name in its own index expression", () => {
  const src = `int a[4]; int i; proc p() { a[i] += a[i]; }`;
  assert.throws(() => checkSrc(src), CheckError);
});

test("rejects undeclared variables", () => {
  assert.throws(() => checkSrc(`proc p() { x += 1; }`), CheckError);
});

test("rejects self-swap of the same plain variable", () => {
  assert.throws(() => checkSrc(`int x; proc p() { x <=> x; }`), CheckError);
});

test("rejects calls to undefined procedures", () => {
  assert.throws(() => checkSrc(`proc p() { call q; }`), CheckError);
});

test("rejects duplicate declarations and duplicate procs", () => {
  assert.throws(() => checkSrc(`int x; int x; proc p() { skip; }`), CheckError);
  assert.throws(() => checkSrc(`proc p() { skip; } proc p() { skip; }`), CheckError);
});

test("rejects local shadowing an existing name", () => {
  const src = `int x; proc p() { local int x = 0 skip; delocal x = 0; }`;
  assert.throws(() => checkSrc(src), CheckError);
});

test("accepts a well-formed program", () => {
  const src = `
    int n; int x1; int x2;
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
  assert.doesNotThrow(() => checkSrc(src));
});
