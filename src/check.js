// src/check.js
//
// Static reversibility & scope checks, run once after parsing. These catch
// the mistakes that would make a program's forward step *not* be a bijection
// -- the interpreter still double-checks the dynamic invariants (failed exit
// assertions etc.) at runtime, but "target variable appears on its own RHS"
// is checkable without running anything, so we do it here.

export class CheckError extends Error {
  constructor(message, line, col) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = "CheckError";
    this.line = line;
    this.col = col;
  }
}

// Collects the set of variable/array names referenced anywhere in an
// expression (both plain reads and array reads contribute their base name).
function referencedNames(expr, out = new Set()) {
  switch (expr.kind) {
    case "Literal":
      break;
    case "VarRef":
      out.add(expr.name);
      break;
    case "IndexRef":
      out.add(expr.name);
      referencedNames(expr.index, out);
      break;
    case "Empty":
    case "Top":
      out.add(expr.name);
      break;
    case "Unary":
      referencedNames(expr.operand, out);
      break;
    case "Binary":
      referencedNames(expr.left, out);
      referencedNames(expr.right, out);
      break;
    default:
      throw new Error(`referencedNames: unknown expr kind '${expr.kind}'`);
  }
  return out;
}

function lvalueKey(lv) {
  // A syntactic key used only to reject `x <=> x` / `a[i] <=> a[i]` style
  // self-swaps at parse time. Dynamic aliasing (`a[i] <=> a[j]` when i==j at
  // runtime) is allowed -- it's a no-op, still a bijection.
  if (lv.kind === "Var") return `V:${lv.name}`;
  if (lv.kind === "Index") return null; // can't prove statically; allow.
  throw new Error(`lvalueKey: unknown lvalue kind '${lv.kind}'`);
}

export function check(program) {
  const globals = new Map(); // name -> { kind: 'scalar'|'array'|'stack', type }
  for (const d of program.decls) {
    if (globals.has(d.name)) {
      throw new CheckError(`duplicate declaration of '${d.name}'`, d.line, d.col);
    }
    if (d.kind === "StackDecl") {
      globals.set(d.name, { kind: "stack" });
    } else {
      globals.set(d.name, { kind: d.size != null ? "array" : "scalar", type: d.type, size: d.size });
    }
  }

  const procs = new Map();
  for (const p of program.procs) {
    if (procs.has(p.name)) {
      throw new CheckError(`duplicate procedure '${p.name}'`, p.line, p.col);
    }
    procs.set(p.name, p);
  }

  // scope: array of Maps, innermost last. Globals are the base scope.
  function lookup(scope, name) {
    for (let i = scope.length - 1; i >= 0; i--) {
      if (scope[i].has(name)) return scope[i].get(name);
    }
    return null;
  }

  function checkExpr(expr, scope) {
    switch (expr.kind) {
      case "Literal":
        return;
      case "VarRef": {
        const info = lookup(scope, expr.name);
        if (!info) throw new CheckError(`undeclared variable '${expr.name}'`, expr.line, expr.col);
        if (info.kind === "stack") {
          throw new CheckError(`'${expr.name}' is a stack, use top()/empty()`, expr.line, expr.col);
        }
        if (info.kind === "array") {
          throw new CheckError(`'${expr.name}' is an array, index it with [i]`, expr.line, expr.col);
        }
        return;
      }
      case "IndexRef": {
        const info = lookup(scope, expr.name);
        if (!info) throw new CheckError(`undeclared variable '${expr.name}'`, expr.line, expr.col);
        if (info.kind !== "array") {
          throw new CheckError(`'${expr.name}' is not an array`, expr.line, expr.col);
        }
        checkExpr(expr.index, scope);
        return;
      }
      case "Empty":
      case "Top": {
        const info = lookup(scope, expr.name);
        if (!info) throw new CheckError(`undeclared variable '${expr.name}'`, expr.line, expr.col);
        if (info.kind !== "stack") {
          throw new CheckError(`'${expr.name}' is not a stack`, expr.line, expr.col);
        }
        return;
      }
      case "Unary":
        checkExpr(expr.operand, scope);
        return;
      case "Binary":
        checkExpr(expr.left, scope);
        checkExpr(expr.right, scope);
        return;
      default:
        throw new Error(`checkExpr: unknown expr kind '${expr.kind}'`);
    }
  }

  function checkLvalueScalar(lv, scope) {
    const info = lookup(scope, lv.name);
    if (!info) throw new CheckError(`undeclared variable '${lv.name}'`, lv.line, lv.col);
    if (lv.kind === "Var") {
      if (info.kind !== "scalar") {
        throw new CheckError(`'${lv.name}' is not a scalar variable`, lv.line, lv.col);
      }
    } else {
      if (info.kind !== "array") {
        throw new CheckError(`'${lv.name}' is not an array`, lv.line, lv.col);
      }
      checkExpr(lv.index, scope);
    }
  }

  function checkStmts(stmts, scope, procScope) {
    for (const s of stmts) checkStmt(s, scope, procScope);
  }

  function checkStmt(s, scope, procScope) {
    switch (s.kind) {
      case "Skip":
        return;
      case "Update": {
        checkLvalueScalar(s.target, scope);
        checkExpr(s.value, scope);
        const refs = referencedNames(s.value);
        if (refs.has(s.target.name)) {
          throw new CheckError(
            `target variable '${s.target.name}' cannot appear on the right-hand side of ${s.op} (not reversible)`,
            s.line, s.col,
          );
        }
        if (s.target.kind === "Index") {
          const idxRefs = referencedNames(s.target.index);
          if (idxRefs.has(s.target.name)) {
            throw new CheckError(
              `index expression for '${s.target.name}' cannot reference '${s.target.name}' itself`,
              s.line, s.col,
            );
          }
        }
        return;
      }
      case "Swap": {
        checkLvalueScalar(s.left, scope);
        checkLvalueScalar(s.right, scope);
        const lk = lvalueKey(s.left);
        const rk = lvalueKey(s.right);
        if (lk !== null && lk === rk) {
          throw new CheckError(`swapping a variable with itself is not allowed`, s.line, s.col);
        }
        return;
      }
      case "Push": {
        const varInfo = lookup(scope, s.varName);
        if (!varInfo) throw new CheckError(`undeclared variable '${s.varName}'`, s.line, s.col);
        if (varInfo.kind !== "scalar") throw new CheckError(`'${s.varName}' is not a scalar variable`, s.line, s.col);
        const stackInfo = lookup(scope, s.stackName);
        if (!stackInfo) throw new CheckError(`undeclared stack '${s.stackName}'`, s.line, s.col);
        if (stackInfo.kind !== "stack") throw new CheckError(`'${s.stackName}' is not a stack`, s.line, s.col);
        return;
      }
      case "Pop": {
        const varInfo = lookup(scope, s.varName);
        if (!varInfo) throw new CheckError(`undeclared variable '${s.varName}'`, s.line, s.col);
        if (varInfo.kind !== "scalar") throw new CheckError(`'${s.varName}' is not a scalar variable`, s.line, s.col);
        const stackInfo = lookup(scope, s.stackName);
        if (!stackInfo) throw new CheckError(`undeclared stack '${s.stackName}'`, s.line, s.col);
        if (stackInfo.kind !== "stack") throw new CheckError(`'${s.stackName}' is not a stack`, s.line, s.col);
        return;
      }
      case "If": {
        checkExpr(s.testEntry, scope);
        checkStmts(s.thenBody, scope, procScope);
        checkStmts(s.elseBody, scope, procScope);
        checkExpr(s.testExit, scope);
        return;
      }
      case "From": {
        checkExpr(s.testEntry, scope);
        checkStmts(s.doBody, scope, procScope);
        checkStmts(s.loopBody, scope, procScope);
        checkExpr(s.testExit, scope);
        return;
      }
      case "Local": {
        checkExpr(s.initExpr, scope);
        if (lookup(scope, s.name)) {
          throw new CheckError(`local variable '${s.name}' shadows an existing name`, s.line, s.col);
        }
        const inner = new Map();
        inner.set(s.name, { kind: "scalar", type: s.type });
        scope.push(inner);
        checkStmts(s.body, scope, procScope);
        checkExpr(s.finalExpr, scope);
        scope.pop();
        return;
      }
      case "Call":
      case "Uncall": {
        if (!procs.has(s.name)) {
          throw new CheckError(`call to undefined procedure '${s.name}'`, s.line, s.col);
        }
        return;
      }
      default:
        throw new Error(`checkStmt: unknown statement kind '${s.kind}'`);
    }
  }

  for (const p of program.procs) {
    checkStmts(p.body, [globals], p.name);
  }

  return { globals, procs };
}
