// open-decision.test.ts — the test harness for .agents/skills/close/scripts/open-decision.ts
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/open-decision.test.ts
//
// A module, not a program: its callers (check-journal-entry.ts F9 and
// check-roadmap-decisions.ts) are each tested as programs; this pins the words.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { namesUser, openDecisionWord, parkedOnUser, plainText } from "./open-decision.ts";

describe("openDecisionWord", () => {
  it("finds a choice on its own, whoever the line is about", () => {
    assert.equal(openDecisionWord("which vendor?", false), "?");
    assert.equal(openDecisionWord("the user rules whether it ships", false), "whether");
    assert.equal(openDecisionWord("the user's go-ahead for the host", false), "go-ahead");
  });

  it("counts a decision word only when the line is the user's", () => {
    assert.equal(openDecisionWord("the user to decide the colour palette", true), "decide");
    assert.equal(openDecisionWord("the editor's sign-off on the draft", false), null);
    assert.equal(openDecisionWord("the vendor's decision", false), null);
  });

  it("reads past code spans and URLs, and passes an act or a date", () => {
    assert.equal(openDecisionWord("the vendor fixes `GET /x?y=1`", false), null);
    assert.equal(openDecisionWord("see https://example.com/a?b=c", false), null);
    assert.equal(openDecisionWord("the user sends the drafted message", true), null);
    assert.equal(openDecisionWord("2026-11-01", false), null);
    assert.equal(openDecisionWord("", true), null);
  });
});

describe("namesUser and plainText", () => {
  it("names the user, the owner or you, never inside a code span", () => {
    assert.equal(namesUser("the user to answer"), true);
    assert.equal(namesUser("waits on the owner's reply"), true);
    assert.equal(namesUser("waits on your reply"), true);
    assert.equal(namesUser("the vendor's answer"), false);
    assert.equal(namesUser("their answer"), false);
    assert.equal(namesUser("`the user` the field"), false);
    assert.equal(plainText("a `b?` c https://x.y/?z d"), "a  c  d");
  });
});

describe("parkedOnUser", () => {
  it("finds a line that leaves something waiting on the user's answer", () => {
    assert.equal(
      parkedOnUser("Not done, waiting on the user (the decision record clears only this change)"),
      "waiting on the user",
    );
    assert.equal(parkedOnUser("rejected: waiting for the user to decide whether to fix it"), "waiting for the user");
    assert.equal(parkedOnUser("the user to decide the mail quota approach"), "the user to decide");
    assert.equal(parkedOnUser("Nothing runs until you answer the Scheduled question"), "until you answer");
    assert.equal(parkedOnUser("the site's cyan is recoloured, pending the owner's call"), "pending the owner");
  });

  it("passes history, someone else's wait, and code", () => {
    assert.equal(parkedOnUser("the user chose to keep the first vendor"), null);
    assert.equal(parkedOnUser("the editor has until end of day on the draft the user shared"), null);
    assert.equal(parkedOnUser("waiting on the vendor's quote"), null);
    assert.equal(parkedOnUser("the fixture reads `waiting on the user`"), null);
  });

  it("passes a negated or resolved wait", () => {
    assert.equal(parkedOnUser("No longer waiting on the user; they chose option 1"), null);
    assert.equal(parkedOnUser("Nothing is waiting on you."), null);
    assert.equal(parkedOnUser("not pending the user any more"), null);
  });

  it("reads through bold and italic", () => {
    assert.equal(parkedOnUser("waiting on **the user**"), "waiting on the user");
    assert.equal(parkedOnUser("_the user to confirm_ the vendor"), "the user to confirm");
  });
});

describe("parkedOnUser, round 3", () => {
  it("reads every wait in the line, not only the first", () => {
    assert.equal(
      parkedOnUser("No longer waiting on the user for X; pending the user's call on Y"),
      "pending the user",
    );
  });

  it("passes a wait told in the past", () => {
    assert.equal(parkedOnUser("The previous run was waiting on the user; they answered"), null);
    assert.equal(parkedOnUser("it had been pending the user's call until Monday"), null);
  });
});

describe("openDecisionWord, confirm", () => {
  it("reads confirm on the user's line by default, and not when the caller asks not to", () => {
    assert.equal(openDecisionWord("the user confirms the seats left", true), "confirms");
    assert.equal(openDecisionWord("the user confirms the seats left", true, { confirm: false }), null);
    assert.equal(openDecisionWord("the user approves the vendor", true, { confirm: false }), "approves");
  });
});

describe("the owner's first name", () => {
  // The name is read once, where the caller stands, so each case runs in a
  // child whose cwd is a scratch repo with its own user.name.
  const MODULE = join(dirname(fileURLToPath(import.meta.url)), "open-decision.ts");
  function inRepo(name: string | null, expr: string): string {
    const dir = mkdtempSync(join(tmpdir(), "open-decision-"));
    try {
      spawnSync("git", ["init", "-q", dir]);
      if (name !== null) spawnSync("git", ["-C", dir, "config", "user.name", name]);
      const r = spawnSync(
        process.execPath,
        ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", `const m = await import(${JSON.stringify(MODULE)}); console.log(JSON.stringify(${expr}));`],
        { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("names the user by the first word of git's user.name, and parks on it", () => {
    assert.equal(inRepo("Sam Rivera", 'm.namesUser("waits on Sam\'s reply")'), "true");
    assert.equal(inRepo("Sam Rivera", 'm.parkedOnUser("pending Sam\'s call")'), '"pending Sam"');
    assert.equal(inRepo("Sam Rivera", 'm.namesUser("waits on Rivera")'), "false");
  });

  it("reads no name when user.name is unset or not a word", () => {
    assert.equal(inRepo(null, 'm.namesUser("waits on Sam")'), "false");
    assert.equal(inRepo("x", 'm.namesUser("waits on x")'), "false");
  });
});
