// Pins validate_outcome.ts, the end-of-script guard the project-index
// generator runs before returning: no rules is a pass; every
// passing rule is a pass; one failing rule throws an OutcomeValidationError
// that names the script and the failed check; several failures are all named,
// in rule order, joined by `; `; a rule that throws propagates as itself rather
// than being read as a failure; rules are evaluated eagerly and exactly once.
// A library — imported here the way its callers import it.
//
// Run: node --test --experimental-strip-types .agents/generators/validate_outcome.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OutcomeValidationError, validateOutcome } from "./validate_outcome.ts";

describe("passing", () => {
  it("no rules is a pass", () => {
    assert.doesNotThrow(() => validateOutcome("script", []));
  });

  it("all rules passing returns undefined and throws nothing", () => {
    assert.equal(
      validateOutcome("script", [
        { check: "a", pass: () => true },
        { check: "b", pass: () => true },
      ]),
      undefined,
    );
  });
});

describe("failing", () => {
  it("one failing rule throws an OutcomeValidationError naming the script and the check", () => {
    assert.throws(
      () =>
        validateOutcome("generate_project_index", [
          { check: "Projects discovered", pass: () => false },
          { check: "README content generated", pass: () => true },
        ]),
      (e: unknown) => {
        assert.ok(e instanceof OutcomeValidationError);
        assert.ok(e instanceof Error);
        assert.equal(e.name, "OutcomeValidationError");
        assert.equal(e.script, "generate_project_index");
        assert.deepEqual(e.failures, ["Projects discovered"]);
        assert.equal(e.message, "Outcome validation failed [generate_project_index]: Projects discovered");
        return true;
      },
    );
  });

  it("several failures are all listed, in rule order, joined by `; `", () => {
    assert.throws(
      () =>
        validateOutcome("s", [
          { check: "first", pass: () => false },
          { check: "ok", pass: () => true },
          { check: "third", pass: () => false },
        ]),
      (e: unknown) => {
        assert.ok(e instanceof OutcomeValidationError);
        assert.deepEqual(e.failures, ["first", "third"]);
        assert.equal(e.message, "Outcome validation failed [s]: first; third");
        return true;
      },
    );
  });

  it("an empty script name and an empty check still produce a well-formed message", () => {
    assert.throws(() => validateOutcome("", [{ check: "", pass: () => false }]), {
      name: "OutcomeValidationError",
      message: "Outcome validation failed []: ",
    });
  });

  it("a rule that THROWS propagates as itself — it is not read as a failed check", () => {
    assert.throws(
      () =>
        validateOutcome("s", [
          {
            check: "explodes",
            pass: () => {
              throw new TypeError("boom");
            },
          },
        ]),
      (e: unknown) => e instanceof TypeError && !(e instanceof OutcomeValidationError),
    );
  });

  it("every rule is evaluated exactly once, even after an earlier one fails", () => {
    const calls: string[] = [];
    assert.throws(() =>
      validateOutcome("s", [
        {
          check: "a",
          pass: () => {
            calls.push("a");
            return false;
          },
        },
        {
          check: "b",
          pass: () => {
            calls.push("b");
            return true;
          },
        },
      ]),
    );
    assert.deepEqual(calls, ["a", "b"]);
  });
});

describe("OutcomeValidationError on its own", () => {
  it("carries script and failures as public fields and an empty failure list as an empty tail", () => {
    const e = new OutcomeValidationError("x", []);
    assert.equal(e.script, "x");
    assert.deepEqual(e.failures, []);
    assert.equal(e.message, "Outcome validation failed [x]: ");
    assert.equal(String(e), "OutcomeValidationError: Outcome validation failed [x]: ");
  });
});
