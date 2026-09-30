// packages/cli-exit — leave a command-line program with a status, without
// losing what it printed.
//
// WHY. `process.exit()` ends the process at once, and Node writes to a pipe
// asynchronously once the pipe's buffer (64 KiB on Linux) is full: whatever the
// reader has not taken yet is still queued in the process, and is dropped. A
// program that prints a long report and then exits with a status therefore
// loses the tail of it — and the tail is where the verdict is. Measured against
// a reader that sleeps before reading, a check printing 2,500 findings had 619
// arrive and no summary line. The bash originals printed everything: `echo`
// writes synchronously. The loss came with the conversion to TypeScript, in
// every program that printed and then called process.exit.
//
// THE DESIGN. `exit(code)` does not end anything: it throws an `Exit` carrying
// the status. The program's entry point is `await runToExit(main)`, which
// catches it, sets process.exitCode, and calls `drainThenExit()`: that ends the
// process from a write callback, and a stream runs its write callbacks in order,
// only after everything written before them has been flushed. Ending it there,
// rather than leaving it to the event loop, means a stray handle (a timer, an
// unref-less child) cannot keep a finished program alive, which is what the
// old process.exit calls also guaranteed.
//
// Throwing has one consequence a caller must respect: a `catch` that wraps a
// call which may exit has to re-throw an `Exit` rather than handle it
// (`if (e instanceof Exit) throw e;`), or it swallows the program's own status.
//
// An event callback — `child.on("error", …)` — is not on main's await chain,
// so there is nothing for a throw to reach. There, set process.exitCode and
// call `drainThenExit()` directly.
//
// Consumers: the skill programs under .agents/skills/*/scripts/ and the checks
// under .agents/checks/.
//
// Import:
//   import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";  // .agents/skills/<x>/scripts/
//   import { exit, runToExit } from "../packages/cli-exit/cli-exit.ts";        // .agents/checks/

/** The status a program leaves with, thrown by `exit` and caught by `runToExit`. */
export class Exit {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}

/** Leave with `code`: throws to `runToExit`, which ends the process once output has drained. */
export function exit(code: number): never {
  throw new Exit(code);
}

/**
 * End the process with process.exitCode once stdout and stderr have flushed:
 * each write callback runs only after everything written before it.
 */
export function drainThenExit(): void {
  process.stdout.write("", () => process.stderr.write("", () => process.exit()));
}

/**
 * Run a program's `main`, turn an `Exit` into process.exitCode, and end the
 * process after its output has drained. Any other error is re-thrown, and
 * crashes the process as an uncaught error always has.
 */
export async function runToExit(main: () => void | Promise<void>): Promise<void> {
  try {
    await main();
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    process.exitCode = e.code;
  }
  drainThenExit();
}
