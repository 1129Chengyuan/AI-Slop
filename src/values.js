// src/values.js
//
// Value semantics shared by the interpreter and the small-step machine.
// Everything is a BigInt internally (so `int` is genuinely unbounded);
// `u32` values are wrapped mod 2^32 after every write, which keeps `+=`,
// `-=` and `^=` bijective on the 32-bit ring exactly as they are on the
// unbounded integers.

export const U32_MOD = 1n << 32n;
export const U32_MASK = U32_MOD - 1n;

export function wrap(type, value) {
  if (type === "u32") {
    let v = value & U32_MASK;
    return v;
  }
  return value;
}

export function truthy(v) {
  return v !== 0n;
}

export function boolToBig(b) {
  return b ? 1n : 0n;
}

// Applies a binary operator to two BigInts, producing a BigInt. Division and
// modulo truncate toward zero (matching typical integer-language semantics)
// and both raise on division by zero rather than silently wrapping — that
// keeps `/=` style updates (which Tenet doesn't have, deliberately: division
// isn't bijective) out of the reversible core entirely.
export function binOp(op, a, b) {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/":
      if (b === 0n) throw new RangeError("division by zero");
      return a / b;
    case "%":
      if (b === 0n) throw new RangeError("modulo by zero");
      return a % b;
    case "&": return a & b;
    case "|": return a | b;
    case "^": return a ^ b;
    case "<<": return a << b;
    case ">>": return a >> b;
    case "==": return boolToBig(a === b);
    case "!=": return boolToBig(a !== b);
    case "<": return boolToBig(a < b);
    case "<=": return boolToBig(a <= b);
    case ">": return boolToBig(a > b);
    case ">=": return boolToBig(a >= b);
    case "&&": return boolToBig(truthy(a) && truthy(b));
    case "||": return boolToBig(truthy(a) || truthy(b));
    default:
      throw new Error(`unknown binary operator '${op}'`);
  }
}

export function unaryOp(op, a) {
  switch (op) {
    case "-": return -a;
    case "!": return boolToBig(!truthy(a));
    default:
      throw new Error(`unknown unary operator '${op}'`);
  }
}

// The inverse update for a compound assignment (`+=` <-> `-=`; `^=` is its
// own inverse since XOR-with-the-same-value undoes itself).
export function inverseUpdateOp(op) {
  switch (op) {
    case "+=": return "-=";
    case "-=": return "+=";
    case "^=": return "^=";
    default:
      throw new Error(`update operator '${op}' has no inverse`);
  }
}
