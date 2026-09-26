// src/lexer.js
//
// Hand-written lexer for Tenet. Nothing fancy: a linear scan producing a flat
// token stream, each token carrying its (line, col) so parse errors and
// runtime "ReversibilityError"s can point at real source locations.

const KEYWORDS = new Set([
  "int", "u32", "stack", "proc",
  "if", "then", "else", "fi",
  "from", "do", "loop", "until",
  "local", "delocal",
  "call", "uncall", "skip",
  "push", "pop",
  "empty", "top",
]);

// Longest-match-first ordering matters here (e.g. "<=>" before "<=").
const OPERATORS = [
  "<=>", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||",
  "+=", "-=", "^=",
  "+", "-", "*", "/", "%", "&", "|", "^", "!", "<", ">", "=",
  "(", ")", "{", "}", "[", "]", ",", ";",
];

export class LexError extends Error {
  constructor(message, line, col) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = "LexError";
    this.line = line;
    this.col = col;
  }
}

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;

  function advance(k = 1) {
    for (let j = 0; j < k; j++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  }

  function peekAt(off) {
    return source[i + off];
  }

  while (i < n) {
    const c = source[i];

    // Whitespace
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }

    // Line comments: // ... and # ...
    if (c === "/" && peekAt(1) === "/") {
      while (i < n && source[i] !== "\n") advance();
      continue;
    }
    if (c === "#") {
      while (i < n && source[i] !== "\n") advance();
      continue;
    }

    // Block comments: /* ... */
    if (c === "/" && peekAt(1) === "*") {
      const startLine = line, startCol = col;
      advance(2);
      let closed = false;
      while (i < n) {
        if (source[i] === "*" && peekAt(1) === "/") {
          advance(2);
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) throw new LexError("unterminated block comment", startLine, startCol);
      continue;
    }

    const startLine = line;
    const startCol = col;

    // Numbers: decimal or 0x hex
    if (/[0-9]/.test(c)) {
      let s = "";
      if (c === "0" && (peekAt(1) === "x" || peekAt(1) === "X")) {
        s += source[i] + source[i + 1];
        advance(2);
        while (i < n && /[0-9a-fA-F]/.test(source[i])) {
          s += source[i];
          advance();
        }
        tokens.push({ type: "NUMBER", value: BigInt(s), line: startLine, col: startCol });
      } else {
        while (i < n && /[0-9]/.test(source[i])) {
          s += source[i];
          advance();
        }
        tokens.push({ type: "NUMBER", value: BigInt(s), line: startLine, col: startCol });
      }
      continue;
    }

    // Identifiers / keywords
    if (/[a-zA-Z_]/.test(c)) {
      let s = "";
      while (i < n && /[a-zA-Z0-9_]/.test(source[i])) {
        s += source[i];
        advance();
      }
      if (KEYWORDS.has(s)) {
        tokens.push({ type: s.toUpperCase(), value: s, line: startLine, col: startCol });
      } else {
        tokens.push({ type: "IDENT", value: s, line: startLine, col: startCol });
      }
      continue;
    }

    // Operators / punctuation
    let matched = null;
    for (const op of OPERATORS) {
      if (source.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      tokens.push({ type: matched, value: matched, line: startLine, col: startCol });
      advance(matched.length);
      continue;
    }

    throw new LexError(`unexpected character '${c}'`, startLine, startCol);
  }

  tokens.push({ type: "EOF", value: null, line, col });
  return tokens;
}
