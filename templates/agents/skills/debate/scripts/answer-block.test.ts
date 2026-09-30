// Tests for answer-block.ts — the one reading of an agent's `.output` that
// parse-agent-output.ts prints and dispatch-agents.ts judges a seat by. A
// LIBRARY, so it is imported; the two programs' suites spawn them end to end.
//
// Run: node --test --experimental-strip-types .agents/skills/debate/scripts/answer-block.test.ts
//
// peers: answer-block.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorLine, answerBlock, hasAnswer, linesOf, ROUND_ANCHORS, roundAnswer } from "./answer-block.ts";

const POSITION = ROUND_ANCHORS["1"];

test("linesOf reads a final newline as the end of the last line, and empty text as no lines", () => {
  assert.deepEqual(linesOf(""), []);
  assert.deepEqual(linesOf("a\nb\n"), ["a", "b"]);
  assert.deepEqual(linesOf("a\nb"), ["a", "b"]);
  assert.deepEqual(linesOf("\n"), [""]);
});

test("anchorLine finds a heading that ends its line, not one merely mentioned", () => {
  assert.equal(anchorLine(["see ## Position below", "## Position  "], POSITION), 1);
  assert.equal(anchorLine(["pre ## Position mention ## Position"], POSITION), 0);
  assert.equal(anchorLine(["no heading"], POSITION), -1);
});

test("an anchored answer starts at the heading, cuts the preamble on its line, and stops at the footer", () => {
  const b = answerBlock("thinking...## Position\nShip it.\n\n[done in 4.2s]\ntotal tokens: 5\n", POSITION);
  assert.deepEqual(b, { lines: ["## Position", "Ship it."], anchored: true });
});

test("an answer with no heading is read from the top, trailing blank lines dropped", () => {
  assert.deepEqual(answerBlock("prose\n\n \n", POSITION), { lines: ["prose"], anchored: false });
});

test("empty, whitespace-only and footer-only outputs are no answer", () => {
  for (const text of ["", "  \n\n", "\t\r\n", "[done in 4.2s]\ntotal tokens: 2255\n", "tokens-out: 3\n"]) {
    assert.deepEqual(answerBlock(text, POSITION).lines, [], JSON.stringify(text));
    assert.equal(hasAnswer(text), false, `called an answer: ${JSON.stringify(text)}`);
  }
});

test("footer-like lines ABOVE a heading do not hide the answer after it", () => {
  const text = "tokens-in: 1843\n\n## Position\nOption B.\n";
  assert.deepEqual(answerBlock(text, POSITION).lines, ["## Position", "Option B."]);
  assert.equal(hasAnswer(text), true);
});

test("hasAnswer accepts a round-2 answer and plain prose, whatever round the dispatcher serves", () => {
  assert.equal(hasAnswer("tokens-in: 1\n## Rebuttal\nNo.\n"), true);
  assert.equal(hasAnswer("### Merge prospects into pipeline\n"), true);
  assert.equal(hasAnswer("NO PROPOSALS\n"), true);
});

// The dispatcher accepts a seat with hasAnswer and the parser prints
// roundAnswer for the round it was given; a seat one accepts and the other
// drops has no stand-in and no gap. They must agree on every text, both rounds.
test("hasAnswer and roundAnswer agree for both rounds on every shape", () => {
  const texts = [
    "",
    "  \n\n",
    "[done in 4.2s]\ntotal tokens: 2255\n",
    "tokens-in: 1\n## Rebuttal\nNo.\n",
    "tokens-in: 1\n## Position\nYes.\n",
    "tokens-in: 1\nprose after a footer\n",
    "prose\n[done]\n",
    "## Position\nA\n## Rebuttal\nB\n",
    "NO PROPOSALS\n",
  ];
  for (const t of texts) {
    for (const round of ["1", "2"] as const) {
      assert.equal(
        roundAnswer(t, round).lines.length > 0,
        hasAnswer(t),
        `round ${round} parse and dispatch disagree on ${JSON.stringify(t)}`,
      );
    }
  }
});

test("a round falls back to the other round's heading, unanchored, only when its own reading is empty", () => {
  assert.deepEqual(roundAnswer("tokens-in: 1\n## Rebuttal\nNo.\n", "1"), {
    lines: ["## Rebuttal", "No."],
    anchored: false,
  });
  assert.deepEqual(roundAnswer("## Position\nA\n", "2"), { lines: ["## Position", "A"], anchored: false });
  assert.deepEqual(roundAnswer("## Position\nA\n", "1"), { lines: ["## Position", "A"], anchored: true });
});
