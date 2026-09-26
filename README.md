# Tenet

*A reversible programming language, and a time-travel debugger that remembers nothing.*

## The idea, and why I picked it

I wanted to build something where "it actually works" is a claim you can
*check*, not just eyeball. Physics engines drift. Procedural generators are
one bad seed away from looking fine. So I went looking for a project with a
built-in oracle — a place where "correct" has a precise, mechanical
definition I could write a test for and then just... satisfy it.

Reversible computing turned out to be exactly that. It's the corner of
programming-language theory that grew out of a real physics result —
Landauer's principle, which says erasing a bit of information costs energy
(`kT ln 2`, if you're counting), and Bennett's observation that a computer
which never erases anything can, in principle, compute for free. The
programming-language version of that idea (Lutz & Derby's Janus, from 1982,
later formalized by Yokoyama and Glück) is a language where *every
statement is its own inverse function*. `x += 5` is trivially undone by
`x -= 5`. A conditional remembers enough about which branch ran that you can
find your way back out of it. A loop remembers enough about why it stopped
that you can walk it backward.

Once a language has that property, two things fall out almost for free,
and both are the kind of "hard to fake" I was after:

1. **Write an encoder, get a decoder for free.** If forward execution is a
   bijection, its precise, statement-by-statement inverse is *computable
   from the source code alone*. No hand-written decrypt function, no
   separate decode logic to keep in sync — `uncall` runs the same code
   backward. I test this by running Tenet's implementation of **XTEA** (a
   real 32-round Feistel cipher, not a toy) forward and checking the output
   against an independently-written reference implementation, then running
   it backward and checking I get the plaintext back.

2. **A time-travel debugger with zero history.** Every normal "step back"
   debugger works by recording a trace and replaying it. If the language
   itself is reversible, you don't need a trace — you can *compute* the
   previous state from the current one, on demand, the same way you'd
   compute the next one. Stepping backward through a loop that's run a
   million times costs exactly the same small, constant amount of memory as
   stepping backward through one that's run twice. That's `src/machine.js`,
   and it's the part of this project I'm most pleased with.

This is not a toy language wearing a physics metaphor as a costume. The
static checker actually rejects code that isn't reversible (a variable
can't appear on the right-hand side of its own update), the runtime
actually verifies the invariants that make reversal safe (a loop's exit
condition, a branch's entry condition), and there's a **250-program random
fuzzer** that generates fresh reversible programs every run and checks four
independent properties hold across all of them. More on that below.

## Language tour

```tenet
int n;   // which pair to compute; read-only from fib's point of view
int i;   // loop counter, counts 0 -> n
int x1;  // ends at F(i) == F(n)
int x2;  // ends at F(i+1) == F(n+1)

proc fib() {
  x2 += 1;              // seed (x1, x2) = (F(0), F(1)) = (0, 1)
  from i == 0 do
    x1 += x2;
    x1 <=> x2;
    i += 1;
  loop
    skip;
  until i == n;
}
```

- **Types:** `int` (arbitrary-precision, backed by `BigInt`), `u32`
  (wraps mod 2³², so it behaves like real machine words — see XTEA below),
  fixed-size arrays of either, and `stack`.
- **The reversible core:** `x += e`, `x -= e`, `x ^= e` (also on array
  elements), and `x <=> y` (swap). The static checker rejects `x += x` and
  friends — the variable you're updating can never appear on the right of
  its own assignment, because if it did, the update wouldn't be invertible.
- **`push x s` / `pop x s`:** push moves `x`'s value onto stack `s` and
  zeroes `x`; pop does the reverse, but only if `x` is currently zero (so
  you can't silently clobber a live value). This is how Tenet expresses
  "throw a value away for now, get it back later" without ever really
  discarding it — `examples/rle.tnt` and `examples/sort.tnt` both lean on
  this.
- **`if e1 then S1 else S2 fi e2`:** `e1` picks the branch, like normal. The
  twist is `e2`, evaluated *after* the branch runs, and it's asserted to be
  true iff `S1` ran. That's the whole trick: going backward, you read `e2`
  to figure out which branch you're undoing, run its inverse, and land back
  on a state where `e1` is asserted to hold. Get `e2` wrong (make it
  ambiguous between branches) and the program simply won't check out — see
  `examples/sort.tnt`'s long comment for a worked example of exactly this
  failure.
- **`from e1 do S1 loop S2 until e2`:** `e1` must hold on the very first
  entry (checked once), `S1` always runs, then `e2` is checked — if true,
  the loop is done; if false, `S2` runs and control returns to `S1`, at
  which point `e1` is asserted to be **false** (this is what lets you tell
  "just started" apart from "still going" when running backward). One
  practical consequence that cost me a very confusing hour: `e2` is only
  ever checked right after `S1`, never after `S2` — so if you (like I
  originally did) put an identical copy of the loop's step in both `S1` and
  `S2`, you only get checked on every *other* step, and an even-length loop
  never terminates. `examples/fib.tnt`'s comment walks through it. The fix
  is the idiom above: the real work goes in `S1`, and `S2` is just `skip`.
- **`local T x = e1 S delocal x = e1'`:** introduces a scratch variable
  scoped to `S`, seeded from `e1`, and asserts its value equals `e1'` when
  `S` finishes (usually a literal, so the scratch variable can't leak
  information out of its scope — that's how you're allowed to use
  temporaries at all in a language where nothing is supposed to disappear).
- **`call p` / `uncall p`:** runs a zero-argument procedure forward or
  backward. Procedures share the global variable set (there are no
  parameters) — this is classic Janus, not an oversight.

## The examples

Each one is chosen to exercise a different corner of the reversibility
story, and each has a `uncall` demonstration in its own test:

| File | What it is | What `uncall` proves |
|---|---|---|
| `fib.tnt` | Builds `(F(n), F(n+1))` by counting a loop variable up | Running the loop backward drives everything back to `(0, 1, 0)` — an inverse Fibonacci, for free |
| `xtea.tnt` | A real 32-round XTEA block cipher over `u32` words | `uncall` *is* the decryption function; checked against an independent reference implementation |
| `sqrt.tnt` | Integer `floor(sqrt(x))` via a counted loop with a genuine arithmetic exit test | The exit test isn't a simple counter comparison, which is exactly the case that breaks a naive entry/exit-swap |
| `rle.tnt` | Run-length encodes a 16-bit array — **destructively**, XORing each bit out of the array as it's folded into a run | `uncall` doesn't just rewind bookkeeping, it *reconstructs the original array* from the `runs` stack alone |
| `sort.tnt` | An odd-even transposition sort (5 elements, 10 fixed compare-swaps) | Its own long comment explains why "just swap if out of order" **cannot** be made reversible without a decisions stack — Landauer's bound, made countable |

Run any of them:

```sh
node bin/tenet.js run examples/fib.tnt fib --set n=10
node bin/tenet.js uncall examples/xtea.tnt xtea_encrypt \
  --set v0=0x01234567 --set v1=0x89abcdef \
  --set key=0x00010203,0x04050607,0x08090a0b,0x0c0d0e0f
node bin/tenet.js invert examples/xtea.tnt        # prints the decoder as real Tenet source
node bin/tenet.js repl examples/fib.tnt fib --set n=5   # step through it by hand
```

## How the machine works (the part I like most)

`src/interp.js` is the boring, obviously-correct implementation: a
recursive big-step evaluator. It's the reference semantics and the oracle
the test suite checks everything else against.

`src/machine.js` is the interesting one. It's a *small-step* evaluator that
executes exactly one atomic statement per call and can run in either
direction — that's the actual engine behind `tenet repl` and the browser
playground's step buttons. The control state is a stack of frames, one per
currently-open `if`/`from`/`local`/`call`, and here's the property that
makes it a genuine "zero-history" debugger:

> **The size of that stack is bounded by nesting depth, never by how many
> statements have executed.** Stepping backward out of a loop that ran a
> million times and stepping backward out of one that ran twice cost
> exactly the same, small, constant amount of extra memory.

That's only possible because "what should happen if I go backward from
here" is *recomputed from the current variable values*, every single time,
using the same entry/exit assertions the language already requires — never
looked up in a log of past states. Concretely: when the machine needs to
step backward across a `from`-loop it re-enters (rather than a trace
telling it "this is iteration 40,000 of 100,000"), it asks the live store
"is the loop's entry condition true right now?" If yes, it's back at
iteration zero and pops out to the caller. If no, it must be mid-loop, so
it switches to un-executing the *other* half of the loop body and asks
again next time. Same question, every time, however many iterations away
the true beginning is.

Getting the direction bookkeeping right was the single hardest part of
this project — a frame that was pushed while undoing something needs to
resume that undo (not flip back to redoing it) the next time you ask it to
keep going in the same direction, and the two ways a frame can reach its
own boundary (finishing normally vs. having been fully reversed back to its
start) turn out to need genuinely different exit assertions. `src/
machine.js`'s file comment and the comment on `resolveFrame` walk through
both bugs I hit and how the fix works, in more detail than I'll repeat
here.

## The fuzzer

`test/fuzz.test.js` generates 250 syntactically-varied, randomly-seeded
Tenet programs (nested `if`/`from`/`local`, random expressions, a fixed
PRNG so failures are reproducible) and checks four things hold for every
single one:

1. it passes the static reversibility checker;
2. `call` then `uncall` restores the exact starting store;
3. `invert(invert(p))` is structurally identical to `p`;
4. the small-step machine and the big-step interpreter agree, both forward
   *and* after stepping all the way back.

Writing this generator surfaced two real bugs that the five hand-written
examples hadn't (both are explained in comments at the point they're
avoided): a global counter/flag used to drive an `if`/`from`'s exit test
will silently corrupt itself if that construct sits inside a body that can
run more than once (a nested loop, say) — the fix is banking the finished
value on a stack before the next activation, the same "throw it away
reversibly" trick `push`/`pop` already provides. That's a nice small
proof, in itself, that this project's central claim is being taken
seriously rather than asserted.

## Project layout

```
src/lexer.js      tokenizer with line/col tracking
src/parser.js     recursive-descent parser -> AST
src/check.js      static reversibility & scope checks
src/values.js     BigInt / u32-wrapping value semantics
src/interp.js     big-step interpreter (the reference semantics)
src/invert.js     the AST inverter -- swap tests, reverse order, flip ops
src/printer.js    AST -> Tenet source (for `tenet invert` and round-trip tests)
src/machine.js    small-step, bidirectional, zero-history debugger engine
src/index.js      public API, re-exporting all of the above
bin/tenet.js      CLI: run | uncall | invert | repl | serve
web/              browser playground (imports src/*.js directly, no bundler)
examples/         the five programs described above
test/             unit tests, an XTEA cross-check, and the fuzzer
```

## Running it

```sh
npm test                 # 38 tests: lexer/parser, checker, interpreter,
                          # inverter, small-step machine, XTEA cross-check,
                          # and the 250-program fuzzer
node bin/tenet.js serve   # opens the playground at http://localhost:4173
```

## Known limits

- `from`/`until` always runs its body at least once, so `sqrt.tnt` needs
  `x >= 1` and `fib.tnt` needs `n >= 1` — documented in each file.
- Procedures take no parameters (classic Janus); all state is global or
  `local`-scoped.
- The array-bounds and stack-empty/nonzero checks are dynamic, not static —
  by design: catching them at parse time in general would mean solving
  arithmetic on arbitrary index expressions, which Tenet doesn't attempt.
