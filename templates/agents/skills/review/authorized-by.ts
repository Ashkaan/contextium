// The owner's own words authorizing a step past a review gate, quoted with
// their name and the date ("<words>" — <name>, <YYYY-MM-DD>): the one test every
// such authorization passes — CODE_REVIEW_PAST_CEILING_BY (code-review.ts),
// CODE_REVIEW_REVIEWER_OVERRIDE_BY, and CLOSE_REVIEW_OVERRIDDEN_BY (land.ts).
// An install does not know its owner's name, so the attribution is what counts:
// a dash followed by a name, a date, and enough words to be a quote.
export function authorizedBy(words: string): boolean {
  return /[—-]\s*\p{L}[\p{L}'.-]*/u.test(words) && /\b\d{4}-\d{2}-\d{2}\b/.test(words) && words.length >= 24;
}
