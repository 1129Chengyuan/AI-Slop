#!/usr/bin/env node
// bin/tenet.js
//
// Command-line front end for Tenet.
//
//   tenet run    <file> [proc]              run a procedure forward
//   tenet uncall <file> <proc>              run a procedure backward
//   tenet invert <file> [proc]              print the inverse source
//   tenet repl   <file> <proc> [--uncall]   step through it interactively
//   tenet serve  [port]                     open the browser playground
//
// Common flags:
//   --set name=1                 set a scalar (accepts 0x hex too)
//   --set name=1,2,3,4            set every element of an array
//   --set name.i=5                set one element of an array
//
// This file is intentionally the only place that touches process.stdin/out
// or the filesystem -- everything in src/ is plain, dependency-free ES
// modules that also run unmodified in a browser (see web/app.js).

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { parse, ParseError } from "../src/parser.js";
import { check, CheckError } from "../src/check.js";
import { Store, callProc, uncallProc, ReversibilityError } from "../src/interp.js";
import { invertProc } from "../src/invert.js";
import { printProc, printProgram } from "../src/printer.js";
import { Machine } from "../src/machine.js";
import { LexError } from "../src/lexer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

function fail(message) {
  console.error(`tenet: ${message}`);
  process.exit(1);
}

function loadProgram(file) {
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    fail(`cannot read '${file}'`);
  }
  try {
    const program = parse(src);
    const { procs } = check(program);
    return { program, procs };
  } catch (e) {
    if (e instanceof LexError || e instanceof ParseError || e instanceof CheckError) {
      fail(`${e.name} in ${file}: ${e.message}`);
    }
    throw e;
  }
}

function pickProc(program, procs, requested) {
  if (requested) {
    if (!procs.has(requested)) fail(`no such procedure '${requested}'`);
    return requested;
  }
  if (program.procs.length === 0) fail("file declares no procedures");
  return program.procs[program.procs.length - 1].name;
}

// Parses a run of `--set name=value` / `--set name.i=value` flags into a
// list of { path, value } assignments, and returns whatever's left.
function parseSetFlags(args) {
  const sets = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--set") {
      const raw = args[++i];
      if (!raw) fail("--set needs an argument, e.g. --set n=5");
      const eq = raw.indexOf("=");
      if (eq < 0) fail(`--set '${raw}' is missing '='`);
      sets.push({ lhs: raw.slice(0, eq), rhs: raw.slice(eq + 1) });
    } else {
      rest.push(args[i]);
    }
  }
  return { sets, rest };
}

function parseNumberLiteral(s) {
  s = s.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
  if (s.startsWith("-")) return -BigInt(s.slice(1));
  return BigInt(s);
}

function applySets(store, sets) {
  for (const { lhs, rhs } of sets) {
    const dot = lhs.indexOf(".");
    if (dot >= 0) {
      const name = lhs.slice(0, dot);
      const idx = Number(lhs.slice(dot + 1));
      const cell = store.cell(name);
      if (cell.kind !== "array") fail(`'${name}' is not an array`);
      cell.values[idx] = parseNumberLiteral(rhs);
    } else if (rhs.includes(",")) {
      const cell = store.cell(lhs);
      if (cell.kind !== "array") fail(`'${lhs}' is not an array`);
      const parts = rhs.split(",");
      parts.forEach((p, i) => (cell.values[i] = parseNumberLiteral(p)));
    } else {
      const cell = store.cell(lhs);
      if (cell.kind === "array") fail(`'${lhs}' is an array; use ${lhs}=v0,v1,... or ${lhs}.0=v`);
      cell.value = parseNumberLiteral(rhs);
    }
  }
}

function printSnapshot(snapshot) {
  const lines = [];
  for (const [name, value] of Object.entries(snapshot)) {
    if (Array.isArray(value)) {
      lines.push(`  ${name} = [${value.map(fmt).join(", ")}]`);
    } else {
      lines.push(`  ${name} = ${fmt(value)}`);
    }
  }
  console.log(lines.join("\n"));
}

function fmt(v) {
  return v.toString();
}

function runError(e) {
  if (e instanceof ReversibilityError) {
    fail(`ReversibilityError: ${e.message}`);
  }
  throw e;
}

// --- Subcommands ---

function cmdRun(args, { doUncall }) {
  const { sets, rest } = parseSetFlags(args);
  const [file, procName] = rest;
  if (!file) fail(`usage: tenet ${doUncall ? "uncall" : "run"} <file> [proc] [--set ...]`);
  const { program, procs } = loadProgram(file);
  const name = pickProc(program, procs, procName);
  const store = new Store(program);
  applySets(store, sets);
  try {
    if (doUncall) uncallProc(store, procs, name);
    else callProc(store, procs, name);
  } catch (e) {
    runError(e);
  }
  console.log(`${doUncall ? "uncall" : "call"} ${name} ->`);
  printSnapshot(store.snapshot());
}

function cmdInvert(args) {
  const { rest } = parseSetFlags(args);
  const [file, procName] = rest;
  if (!file) fail("usage: tenet invert <file> [proc]");
  const { program, procs } = loadProgram(file);
  if (procName) {
    if (!procs.has(procName)) fail(`no such procedure '${procName}'`);
    console.log(printProc(invertProc(procs.get(procName))));
  } else {
    const inverted = { kind: "Program", decls: program.decls, procs: program.procs.map(invertProc) };
    console.log(printProgram(inverted));
  }
}

function cmdRepl(args) {
  const { sets, rest } = parseSetFlags(args);
  const [file, procName] = rest;
  if (!file) fail("usage: tenet repl <file> <proc> [--uncall] [--set ...]");
  const doUncall = args.includes("--uncall");
  const { program, procs } = loadProgram(file);
  const name = pickProc(program, procs, procName);
  const store = new Store(program);
  applySets(store, sets);
  const machine = new Machine(store, procs, name, { uncall: doUncall });

  console.log(`tenet repl -- ${doUncall ? "uncall" : "call"} ${name}`);
  console.log("commands: s[tep] | b[ack] | r[un] | u[nrun] | p[rint] | d[epth] | q[uit]");
  printSnapshot(machine.snapshot());

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "tenet> " });
  rl.prompt();
  rl.on("line", (line) => {
    const cmd = line.trim().split(/\s+/)[0] || "";
    try {
      switch (cmd) {
        case "s": case "step": case "": {
          const r = machine.step("fwd");
          reportStep(r);
          break;
        }
        case "b": case "back": {
          const r = machine.step("bwd");
          reportStep(r);
          break;
        }
        case "r": case "run": {
          const r = machine.run("fwd");
          console.log(r.status === "halted" ? "halted (end)" : r.status);
          printSnapshot(machine.snapshot());
          break;
        }
        case "u": case "unrun": {
          const r = machine.run("bwd");
          console.log(r.status === "halted" ? "halted (start)" : r.status);
          printSnapshot(machine.snapshot());
          break;
        }
        case "p": case "print":
          printSnapshot(machine.snapshot());
          break;
        case "d": case "depth":
          console.log(`frame depth: ${machine.frameDepth()}`);
          break;
        case "q": case "quit":
          rl.close();
          return;
        default:
          console.log(`unknown command '${cmd}'`);
      }
    } catch (e) {
      if (e instanceof ReversibilityError) console.log(`ReversibilityError: ${e.message}`);
      else throw e;
    }
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));

  function reportStep(r) {
    if (r.status === "halted") {
      console.log(`halted (${r.edge})`);
    } else {
      console.log(`${r.dir === 1 ? "->" : "<-"} ${r.stmt.kind} (line ${r.stmt.line})`);
      printSnapshot(machine.snapshot());
    }
  }
}

function cmdServe(args) {
  const port = Number(args[0]) || 4173;
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".tnt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split("?")[0]);
    if (reqPath === "/") reqPath = "/web/index.html";
    const full = path.normalize(path.join(REPO_ROOT, reqPath));
    if (!full.startsWith(REPO_ROOT)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const ext = path.extname(full);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  });
  server.listen(port, () => {
    console.log(`tenet playground: http://localhost:${port}/`);
  });
}

function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case "run": case "call":
      return cmdRun(args, { doUncall: false });
    case "uncall":
      return cmdRun(args, { doUncall: true });
    case "invert":
      return cmdInvert(args);
    case "repl":
      return cmdRepl(args);
    case "serve":
      return cmdServe(args);
    default:
      console.log(`Tenet -- a reversible programming language

Usage:
  tenet run    <file> [proc] [--set name=val ...]   run forward
  tenet uncall <file> <proc>  [--set name=val ...]   run backward
  tenet invert <file> [proc]                         print the inverse source
  tenet repl   <file> <proc>  [--uncall] [--set ...] step through interactively
  tenet serve  [port]                                open the browser playground
`);
      process.exit(cmd ? 1 : 0);
  }
}

main();
