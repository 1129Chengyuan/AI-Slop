import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "../src/parser.js";
import { check } from "../src/check.js";
import { Store, callProc, uncallProc } from "../src/interp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MASK32 = (1n << 32n) - 1n;

// An independent reference XTEA implementation, transcribed directly from
// Wheeler & Needham's reference C (not from src/*.js), used only to check
// examples/xtea.tnt against ground truth. If this and the Tenet program
// ever disagree, the Tenet program is wrong.
function xteaEncryptRef(v0, v1, key, rounds = 32) {
  let sum = 0n;
  const delta = 0x9e3779b9n;
  for (let i = 0; i < rounds; i++) {
    const t0 = (((v1 << 4n) ^ (v1 >> 5n)) + v1) ^ (sum + key[Number(sum & 3n)]);
    v0 = (v0 + t0) & MASK32;
    sum = (sum + delta) & MASK32;
    const t1 = (((v0 << 4n) ^ (v0 >> 5n)) + v0) ^ (sum + key[Number((sum >> 11n) & 3n)]);
    v1 = (v1 + t1) & MASK32;
  }
  return [v0, v1];
}

function loadXtea() {
  const src = fs.readFileSync(path.join(__dirname, "..", "examples", "xtea.tnt"), "utf8");
  const program = parse(src);
  const { procs } = check(program);
  return { program, procs };
}

function makeStore(program, v0, v1, key) {
  const store = new Store(program);
  store.cell("v0").value = v0;
  store.cell("v1").value = v1;
  const k = store.cell("key");
  key.forEach((v, i) => (k.values[i] = v));
  return store;
}

const CASES = [
  { v0: 0x01234567n, v1: 0x89abcdefn, key: [0x00010203n, 0x04050607n, 0x08090a0bn, 0x0c0d0e0fn] },
  { v0: 0x00000000n, v1: 0x00000000n, key: [0x00000000n, 0x00000000n, 0x00000000n, 0x00000000n] },
  { v0: 0xffffffffn, v1: 0xffffffffn, key: [0xffffffffn, 0xffffffffn, 0xffffffffn, 0xffffffffn] },
  { v0: 0xdeadbeefn, v1: 0xcafef00dn, key: [0x12345678n, 0x9abcdef0n, 0x0fedcba9n, 0x87654321n] },
];

test("xtea.tnt matches an independent reference XTEA implementation", () => {
  const { program, procs } = loadXtea();
  for (const { v0, v1, key } of CASES) {
    const store = makeStore(program, v0, v1, key);
    callProc(store, procs, "xtea_encrypt");
    const [refV0, refV1] = xteaEncryptRef(v0, v1, key);
    assert.equal(store.cell("v0").value, refV0, `v0 for input ${v0.toString(16)}`);
    assert.equal(store.cell("v1").value, refV1, `v1 for input ${v1.toString(16)}`);
    assert.equal(store.cell("round").value, 32n);
    assert.equal(store.cell("sum").value, (0x9e3779b9n * 32n) & MASK32);
  }
});

test("uncall xtea_encrypt decrypts back to the original plaintext", () => {
  const { program, procs } = loadXtea();
  for (const { v0, v1, key } of CASES) {
    const store = makeStore(program, v0, v1, key);
    callProc(store, procs, "xtea_encrypt");
    uncallProc(store, procs, "xtea_encrypt");
    assert.equal(store.cell("v0").value, v0);
    assert.equal(store.cell("v1").value, v1);
    assert.equal(store.cell("round").value, 0n);
    assert.equal(store.cell("sum").value, 0n);
  }
});

test("encryption is not the identity (sanity check against a trivial bug)", () => {
  const { program, procs } = loadXtea();
  const store = makeStore(program, 0x01234567n, 0x89abcdefn, [1n, 2n, 3n, 4n]);
  callProc(store, procs, "xtea_encrypt");
  assert.notEqual(store.cell("v0").value, 0x01234567n);
  assert.notEqual(store.cell("v1").value, 0x89abcdefn);
});
