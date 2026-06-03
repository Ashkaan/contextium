// validate_outcome — Outcome Validation
//
// Shared utility for validating script outcomes before returning. Used by:
//   - apps/{app,integration,project}-index/generate.ts (the index generators)

/** A single validation rule: human-readable check + pass function. */
export interface OutcomeRule {
  /** What is being validated. */
  check: string;
  /** Returns true if the check passes. */
  pass: () => boolean;
}

/** Thrown when outcome validation fails. */
export class OutcomeValidationError extends Error {
  // Explicit field declarations: type-stripping runtimes don't support
  // constructor parameter properties, so the fields are declared and assigned
  // in the body instead.
  public script: string;
  public failures: string[];
  constructor(script: string, failures: string[]) {
    super(`Outcome validation failed [${script}]: ${failures.join("; ")}`);
    this.script = script;
    this.failures = failures;
    this.name = "OutcomeValidationError";
  }
}

/**
 * Validate a script's output before returning it.
 * Call at the end of the script, after building the result but before return.
 * If any rule fails, throws OutcomeValidationError.
 */
export function validateOutcome(script: string, rules: OutcomeRule[]): void {
  const failures = rules.filter((r) => !r.pass()).map((r) => r.check);
  if (failures.length > 0) {
    throw new OutcomeValidationError(script, failures);
  }
}
