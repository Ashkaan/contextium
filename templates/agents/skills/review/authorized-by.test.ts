// authorized-by.ts: the owner's words count only quoted with a name and a date.
import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizedBy } from "./authorized-by.ts";

test("the owner's words with an attribution and a date authorize", () => {
  assert.equal(authorizedBy(`"I'm overriding any further reviews" — Robin, 2026-11-19`), true);
  assert.equal(authorizedBy(`"go past the ceiling for this one" - Ana, 2026-01-02`), true);
});

test("words without a name, without a date, or too short do not", () => {
  assert.equal(authorizedBy(`"I'm overriding any further reviews" — 2026-11-19`), false);
  assert.equal(authorizedBy(`"I'm overriding any further reviews" — Robin`), false);
  assert.equal(authorizedBy("— Robin 2026-11-19"), false);
  assert.equal(authorizedBy(""), false);
});
