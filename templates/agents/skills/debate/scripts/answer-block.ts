// answer-block.ts — what an agent's answer IS, read out of a raw `.output`
// file: the one normalization parse-agent-output.ts prints and
// dispatch-agents.ts judges a seat by.
//
// The reading: from the round's anchor heading onward (cutting any preamble on
// the heading's own line), or from the top when there is no heading; stop at
// the first codex-style footer line; drop trailing blank lines. Nothing left
// means no answer.
//
// WHY ONE FILE. The dispatcher used to accept any exit-0 output that was not
// blank while the parser cut footer noise, so an output of only
// `[done in 4.2s]` / `total tokens: …` counted as an argued seat at dispatch —
// no stand-in, no .gap — and then vanished at parse, leaving a debate a
// position short that had reported success. Two readings of one file disagree;
// one reading cannot.
//
// peers: parse-agent-output.ts, dispatch-agents.ts
//
// Import:
//   import { hasAnswer, roundAnswer, ROUND_ANCHORS } from "./answer-block.ts";

/** The heading that opens the structured block, per debate round. */
export const ROUND_ANCHORS = { "1": "## Position", "2": "## Rebuttal" } as const;

// POSIX [[:space:]] — space, tab, newline, vertical tab, form feed, carriage return.
const BLANK = /^[ \t\n\v\f\r]*$/;
// Codex-style footer markers: `[done`, `total tokens:`, `tokens-in:`, `tokens-out:`.
const FOOTER = /^\[done|^total tokens:|^tokens-(in|out):/;

/** A file's lines, the way a line tool sees them: a final newline ends the last line rather than opening an empty one. */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * The first line whose text ends in the anchor heading (trailing whitespace
 * allowed), or -1. The heading may follow a preamble on the same line, but it
 * ends the line — a sentence that merely MENTIONS it is not the heading.
 */
export function anchorLine(lines: string[], anchor: string): number {
  return lines.findIndex((l) => {
    // Every occurrence is a candidate, not only the first: the heading may
    // follow a preamble that itself mentions it.
    for (let at = l.indexOf(anchor); at !== -1; at = l.indexOf(anchor, at + 1)) {
      if (BLANK.test(l.slice(at + anchor.length))) return true;
    }
    return false;
  });
}

export interface AnswerBlock {
  /** The answer's lines, empty when there is no answer. */
  lines: string[];
  /** Whether the anchor heading was found; false means the text was read from the top. */
  anchored: boolean;
}

/** The answer in `text` under `anchor`, read as this file's header describes. */
export function answerBlock(text: string, anchor: string): AnswerBlock {
  const all = linesOf(text);
  const at = anchorLine(all, anchor);
  const block = all.slice(at === -1 ? 0 : at);
  const first = block[0];
  if (first !== undefined) {
    const i = first.indexOf(anchor);
    if (i !== -1 && BLANK.test(first.slice(i + anchor.length))) block[0] = first.slice(i);
  }
  const footer = block.findIndex((l) => FOOTER.test(l));
  const kept = footer === -1 ? block : block.slice(0, footer);
  let end = kept.length;
  while (end > 0 && BLANK.test(kept[end - 1] ?? "")) end--;
  return { lines: kept.slice(0, end), anchored: at !== -1 };
}

export type Round = keyof typeof ROUND_ANCHORS;

/**
 * The answer a round's parse prints: the round's own reading, or — when that
 * keeps nothing — the other round's, marked unanchored (off the round's
 * schema). The fallback is what makes the parser print exactly the seats
 * `hasAnswer` accepts: the dispatcher cannot know the round (it serves both,
 * and any other caller's formats), so it accepts a seat any reading keeps, and a
 * parser reading only its own round dropped an answer like
 * `tokens-in: 1\n## Rebuttal\nNo.` that dispatch had called argued — no
 * stand-in, and one position fewer.
 */
export function roundAnswer(text: string, round: Round): AnswerBlock {
  const own = answerBlock(text, ROUND_ANCHORS[round]);
  if (own.lines.length > 0) return own;
  const other = answerBlock(text, ROUND_ANCHORS[round === "1" ? "2" : "1"]);
  return { lines: other.lines, anchored: false };
}

/**
 * Whether `text` holds an answer — the dispatcher's test, true exactly when
 * roundAnswer keeps something for EITHER round (each falls back to the other,
 * so the two agree, and with neither heading present both are the
 * from-the-top reading).
 */
export function hasAnswer(text: string): boolean {
  return roundAnswer(text, "1").lines.length > 0;
}
