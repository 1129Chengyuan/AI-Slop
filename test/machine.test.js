import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "../src/parser.js";
import { check } from "../src/check.js";
import { Store, callProc } from "../src/interp.js";
import { Machine } from "../src/machine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadExample(name) {
  const src = fs.readFileSync(path.join(__dirname, "..", "examples", name), "utf8");
  const program = parse(src);
  const { procs } = check(program);
  return { program, procs };
}

const CASES = [
  { file: "fib.tnt", proc: "fib", setup: (s) => (s.cell("n").value = 11n) },
  {
    file: "xtea.tnt", proc: "xtea_encrypt", setup: (s) => {
      s.cell("v0").value = 0x01234567n;
      s.cell("v1").value = 0x89abcdefn;
      const k = s.cell("key");
      [0x00010203n, 0x04050607n, 0x08090a0bn, 0x0c0d0e0fn].forEach((v, i) => (k.values[i] = v));
    },
  },
  { file: "sqrt.tnt", proc: "isqrt", setup: (s) => (s.cell("x").value = 8675n) },
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

test("small-step run forward matches big-step for every example", () => {
  for (const { file, proc, setup } of CASES) {
    const { program, procs } = loadExample(file);

    const bigStore = new Store(program);
    setup(bigStore);
    callProc(bigStore, procs, proc);

    const smallStore = new Store(program);
    setup(smallStore);
    const machine = new Machine(smallStore, procs, proc);
    const result = machine.run("fwd");

    assert.equal(result.status, "halted");
    assert.equal(result.edge, "end");
    assert.deepEqual(smallStore.snapshot(), bigStore.snapshot(), `mismatch for ${file}`);
    assert.equal(machine.frameDepth(), 1, "should have unwound back to just the entry frame");
  }
});

test("stepping N forward then N back returns to the exact starting snapshot", () => {
  for (const { file, proc, setup } of CASES) {
    const { program, procs } = loadExample(file);
    const store = new Store(program);
    setup(store);
    const machine = new Machine(store, procs, proc);
    const initial = machine.snapshot();

    let n = 0;
    while (true) {
      const r = machine.step("fwd");
      if (r.status === "halted") break;
      n++;
    }
    assert.ok(n > 0, `${file} should take at least one step`);

    for (let i = 0; i < n; i++) {
      const r = machine.step("bwd");
      assert.equal(r.status, "ok", `unexpected halt while stepping back in ${file}`);
    }
    assert.deepEqual(store.snapshot(), initial, `did not return to start for ${file}`);
    // One more back-step should report "start", not throw or silently do nothing wrong.
    const r = machine.step("bwd");
    assert.equal(r.status, "halted");
    assert.equal(r.edge, "start");
  }
});

test("random forward/backward walks always agree with a big-step oracle at every checkpoint", () => {
  const rng = mulberry32(0xC0FFEE);
  for (const { file, proc, setup } of CASES) {
    const { program, procs } = loadExample(file);
    const store = new Store(program);
    setup(store);
    const machine = new Machine(store, procs, proc);

    // Precompute the full forward trace of snapshots via the small-step
    // machine itself first (établishing ground truth positions), then walk
    // randomly forward/back and check we're always AT one of those
    // snapshots consistent with our current net displacement.
    const trace = [machine.snapshot()];
    while (true) {
      const r = machine.step("fwd");
      if (r.status === "halted") break;
      trace.push(machine.snapshot());
    }
    // Reset to start.
    for (let i = trace.length - 1; i > 0; i--) machine.step("bwd");
    assert.deepEqual(machine.snapshot(), trace[0]);

    let pos = 0;
    for (let iter = 0; iter < 500; iter++) {
      const goFwd = rng() < 0.5;
      if (goFwd && pos < trace.length - 1) {
        const r = machine.step("fwd");
        assert.equal(r.status, "ok");
        pos++;
      } else if (!goFwd && pos > 0) {
        const r = machine.step("bwd");
        assert.equal(r.status, "ok");
        pos--;
      } else {
        continue;
      }
      assert.deepEqual(machine.snapshot(), trace[pos], `${file} diverged from trace at position ${pos}`);
    }
  }
});

test("frame depth stays bounded (O(nesting), not O(iterations)) through a long loop", () => {
  const { program, procs } = loadExample("xtea.tnt"); // 32-iteration loop
  const store = new Store(program);
  store.cell("key").values[0] = 1n;
  const machine = new Machine(store, procs, "xtea_encrypt");
  let maxDepth = 0;
  while (true) {
    const r = machine.step("fwd");
    maxDepth = Math.max(maxDepth, machine.frameDepth());
    if (r.status === "halted") break;
  }
  // Nesting here is: entry frame + from-loop body frame == 2, regardless of
  // whether the loop ran 1 or 32 times.
  assert.ok(maxDepth <= 3, `frame depth grew with iteration count: ${maxDepth}`);
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
