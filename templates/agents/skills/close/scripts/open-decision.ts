// open-decision.ts — does this line park a choice the user has not made?
//
// Nothing a close adds may wait on the user: only a dated wait on someone or
// something else goes with it, and a question is asked and the run halts
// (close/references/auto-close-gate.md precondition (iii)). Two places hold
// what waits, and both refuse an open decision with these words first, so it
// is reported as a question rather than as a wait with no date: a journal
// entry's `**Blocked:**` bullets (check-journal-entry.ts, F9) and a ROADMAP
// row's `blocked:` status (check-roadmap-decisions.ts).
//
// Words that are a choice on their own, and words that are one only when the
// line is the user's: "the vendor's decision" and "the reviewer's answer" wait
// on someone else, "the user's decision" and "your OK" wait on the user. URLs
// and code spans are read out first, so a link's `?` is not a question.
//
// WHO THE USER IS, in a line an agent writes: "the user" or "the owner"
// (possessive too), "you"/"your" when the entry addresses them, or the first
// name in the checkout's `git config user.name`, which is the owner's — the
// same words /project triage reads as the user's (triage.ts `names`). A
// third-person pronoun is not read as the user: "they" and "their" name
// anyone, so counting them would park every other person's wait on the user.
//
// peers:
//   .agents/skills/close/scripts/check-journal-entry.ts
//   .agents/skills/close/scripts/check-roadmap-decisions.ts
//   .agents/skills/project/scripts/triage.ts            (the same owner words)

import { spawnSync } from "node:child_process";

const DECISION_WORDS = /\?|\bwhether\b|\bchoos(e|es|ing)\b|\bchoice\b|go-ahead|\byour call\b|\bthe user's call\b/i;
const USER_WORDS =
  /\bdecid(e|es|ed|ing)\b|\bdecision\b|\bruling\b|\bsign-off\b|\bapprov(e|es|al)\b|\bauthori[sz](e|es|ation)\b|\banswers?\b|\bpermission\b|\bOK\b|\bpick(s|ed|ing)?\b|\bsay-so\b/i;
/** Read with USER_WORDS unless the caller asks not to (check-journal-entry.ts
 *  reads an entry written before the word joined the list without it). */
const CONFIRM = /\bconfirm(?:s|ed|ing)?\b/i;
/** A press of a named control ("click Confirm", "tap Approve") is a deed, not
 *  a decision, so its words are read out before the decision words are. */
const CONTROL_PRESS = /\b(?:click|press|tap|hit|select)\s+(?:the\s+)?["“]?[A-Z][\w-]*["”]?/g;
/** The owner's first name: the first word of `git config user.name` where the
 *  caller stands, when it is a word of two letters or more; else "". */
function ownerName(): string {
  const r = spawnSync("git", ["config", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const first = r.status === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? "") : "";
  return /^\p{L}{2,}$/u.test(first) ? first : "";
}
const OWNER = ownerName();
const WHO = String.raw`(?:the\s+(?:user|owner)|you${OWNER ? `|${OWNER}` : ""})`;
const USER = new RegExp(String.raw`\bthe\s+(?:user|owner)\b|\byour?\b${OWNER ? String.raw`|\b${OWNER}\b` : ""}`, "i");

/** A line that leaves something WAITING on the user: "waiting on the user",
 *  "pending the user's call", "the user to decide", "until you answer". Read
 *  over every line a close writes, not only the two places a question had been
 *  parked before: a report can park a question as "waiting on the user" and
 *  close. History ("the user chose …") and other people's waits do not match. */
const WAITING_ON_USER = String.raw`\b(?:wait(?:s|ing)?\s+(?:on|for)|pending|awaiting|held\s+for)\s+${WHO}\b`;
/** The half that is a ruling, not a deed: true of an `act:` line too, where
 *  "waiting on the user to send it" is fine and "until the user rules" is not. */
const FOR_USER_RULING = String.raw`\b${WHO}\s+to\s+(?:decide|choose|rule\s+on|confirm|approve|pick|answer)\b|\buntil\s+${WHO}\s+(?:decides?|chooses?|answers?|rules?|confirms?|approves?|picks?)\b`;
const PARKED = new RegExp(`${WAITING_ON_USER}|${FOR_USER_RULING}`, "gi");
const RULING = new RegExp(FOR_USER_RULING, "gi");

/** "No longer waiting on the user", "nothing is waiting on you", "was waiting
 *  on the user": a wait that is over, or one told as history. */
const OVER = /\b(?:no\s+longer|not|nothing(?:\s+(?:is|was))?|never|no\s+one|none|was|were|had\s+been)\s*$/i;

/** The words that park `text` on the user, or null. Code spans, URLs and
 *  bold/italic markers are not read, and a negated wait is over. On an `act`
 *  line only a ruling counts: an act is the user's deed, so it may wait on them. */
export function parkedOnUser(text: string, opts: { act?: boolean } = {}): string | null {
  const plain = plainText(text).replace(/[*_]+/g, "");
  for (const m of plain.matchAll(opts.act ? RULING : PARKED)) {
    if (!OVER.test(plain.slice(Math.max(0, m.index - 24), m.index))) return m[0];
  }
  return null;
}

/** Code spans and URLs are not read: a link's `?` is not a question. */
export function plainText(text: string): string {
  // Code spans first: a URL inside one must not take its closing backtick.
  return text.replace(/`[^`]*`/g, "").replace(/https?:\/\/\S+/g, "");
}

/** Whether the line names the user, so their own words count as a choice. */
export function namesUser(text: string): boolean {
  return USER.test(plainText(text));
}

/**
 * The word that makes `text` an open decision, or null. `users` is true when
 * the line is the user's own (an `act:`) or names them.
 */
export function openDecisionWord(text: string, users: boolean, opts: { confirm?: boolean } = {}): string | null {
  const plain = plainText(text).replace(CONTROL_PRESS, "");
  const userWord = users ? (USER_WORDS.exec(plain) ?? (opts.confirm === false ? null : CONFIRM.exec(plain))) : null;
  return (DECISION_WORDS.exec(plain) ?? userWord)?.[0] ?? null;
}
