#!/usr/bin/env -S node --experimental-strip-types
// project-status.ts — one plain-English sentence saying where a project stands,
// for the `**Project:**` line of the close report land.ts prints.
//
// WHY. The report carried the project's state only inside next-implement-command's
// `#` comment line, which a renderer can show as an escaped `\#` run-on after
// the bold labels, cut at the README's 60-character `next:` budget, and worded
// for the script ("18 planned rows wait on the watch"). The reader wants the
// project's status in plain words. next-implement-command.ts keeps its output as
// it is, because it is machine-readable: one command, or one `#` line, per row.
//
// It reads the README's derived fields (status, next, blocked-on,
// monitoring-until — the README template's derivation rule, applied by
// roadmap.ts --sync-next) and expands the row ID they name to the row's full
// Sub-feature from roadmap.ts, so the sentence is not cut mid-word. A wait on
// another project's row (`waits on <slug> <ID>`) names that row whole
// too, from listRows' dependency results.
//
// The sentence names the README's own status word (active, blocked, monitor,
// completed), in bold so it stands out in the report. A monitor project used
// to read "on hold" or "built and being watched", neither of which is a
// status, and "built" was false whenever more watched steps followed the
// first: a reader could not tell whether the project was closed, active or in
// monitor, so the word is the status itself, in bold.
//
// Usage:  project-status.ts <project-folder>
// Output: one line on stdout, e.g.
//   checkout-flow is **in monitor** until Fri, Oct 30, watching R1: The beta feedback sets the next changes. 3 planned steps wait on it.
//   portal is **active**. Next is R4: the sales page.
// Exit:   0 always once the folder has a README; 2 on a usage error or no README.
//
// peers:
//   .agents/skills/close/scripts/project-status.test.ts
//   .agents/skills/close/scripts/roadmap.ts   (the table's one parser)
//   .agents/skills/close/scripts/land.ts      (prints the line)

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type DepResult, listRows, releaseDate } from "./roadmap.ts";

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || !argv[0]) {
    process.stderr.write("usage: project-status.ts <project-folder>\n");
    return 2;
  }
  const dir = argv[0].replace(/\/+$/, "");
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) {
    process.stderr.write(`project-status: no README.md in ${dir}\n`);
    return 2;
  }
  const slug = basename(dir).replace(/^\d{4}-\d{2}-\d{2}_/, "");

  // Front matter only: the first `---` block.
  const fm = new Map<string, string>();
  const lines = readFileSync(readme, "utf8").split("\n");
  if (lines[0]?.trim() === "---") {
    for (const l of lines.slice(1)) {
      if (l.trim() === "---") break;
      const m = /^([a-z-]+):\s*(.*)$/.exec(l);
      if (m?.[1]) fm.set(m[1], (m[2] ?? "").trim().replace(/^"(.*)"$/, "$1"));
    }
  }

  // Rows by ID: status and full Sub-feature. No table, or one roadmap.ts
  // cannot read, leaves the sentence to the README's own words.
  // Each row's dependencies come resolved, another project's row whole.
  const rows = new Map<string, { status: string; feature: string; deps: DepResult[] }>();
  if (existsSync(join(dir, "ROADMAP.md"))) {
    const r = listRows(join(dir, "ROADMAP.md"));
    r.rows.forEach(([id = "", status = "", , , feature = ""], i) => {
      if (id) rows.set(id, { status, feature, deps: r.deps[i] ?? [] });
    });
  }

  /** `R1: text cut at 60…` → `R1: the row's full Sub-feature`. */
  const expand = (value: string): string => {
    const m = /^(R\d+):\s*/.exec(value);
    const row = m?.[1] ? rows.get(m[1]) : undefined;
    return m?.[1] && row?.feature ? `${m[1]}: ${row.feature}` : value;
  };
  const day = (iso: string): string => {
    const d = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  };
  const waiting = [...rows.values()].filter((r) => /^(planned|in-progress)$/i.test(r.status)).length;
  const steps = (n: number): string => (n === 1 ? "1 planned step waits on it" : `${n} planned steps wait on it`);
  const watched = (n: number): string =>
    n === 1 ? "1 other step is also being watched" : `${n} other steps are also being watched`;
  const end = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

  const status = fm.get("status") ?? "";
  let out: string;
  switch (status) {
    case "active": {
      const next = fm.get("next") ?? "";
      out = next ? `${slug} is **active**. Next is ${end(expand(next))}` : `${slug} is **active**.`;
      break;
    }
    case "blocked": {
      const on = fm.get("blocked-on") ?? "";
      // `blocked-on:` is `<ID>: <what the row waits on>`, cut at 60; the row
      // gives both halves whole.
      const id = /^(R\d+):/.exec(on)?.[1] ?? "";
      const row = rows.get(id);
      const why = row?.status.replace(/^blocked:\s*/i, "") ?? "";
      // A wait with an end date names the day the row starts again.
      const release = releaseDate(row?.status ?? "");
      const after = why.replace(/^until\s+\S+[\s,;:—-]*/i, "");
      // A wait on another project's row: each open one, named whole.
      const foreign = /^R\d+: waits on /.test(on)
        ? (row?.deps ?? []).filter((x) => x.project !== "" && x.state === "open")
        : [];
      out =
        row && foreign.length > 0
          ? `${slug} is **blocked** on ${id}, ${row.feature.replace(/[.…]$/, "")} — waiting for ${foreign.map((x) => `${x.project} ${x.id}, ${x.feature.replace(/[.…]$/, "")}`).join("; and ")}.`
          : row && release
            ? `${slug} is **blocked** on ${id}, ${row.feature.replace(/[.…]$/, "")}, until ${day(release)}, when it can be unblocked through /project triage blocked.${after ? ` Waiting for: ${end(after)}` : ""}`
            : row && why
              ? `${slug} is **blocked** on ${id}, ${row.feature.replace(/[.…]$/, "")}. Waiting for: ${end(why)}`
              : on
                ? `${slug} is **blocked** on ${end(on)}`
                : `${slug} is **blocked**.`;
      break;
    }
    case "monitor": {
      const until = fm.get("monitoring-until") ?? "";
      const m = /^(\d{4}-\d{2}-\d{2})\s*(?:—|-)?\s*(.*)$/.exec(until);
      const date = m?.[1] ?? "";
      const what = expand(m?.[2] ?? "");
      const watchedId = /^(R\d+):/.exec(what)?.[1] ?? "";
      const otherWatches = [...rows.entries()].filter(
        ([id, r]) => id !== watchedId && /^blocked:/i.test(r.status),
      ).length;
      const head = `${slug} is **in monitor**${date ? ` until ${day(date)}` : ""}${what ? `, watching ${what.replace(/[.…]$/, "")}` : ""}.`;
      const tail = [waiting > 0 ? `${steps(waiting)}.` : "", otherWatches > 0 ? `${watched(otherWatches)}.` : ""];
      out = [head, ...tail].filter(Boolean).join(" ");
      break;
    }
    case "completed":
      out = `${slug} is **complete**.`;
      break;
    default:
      out = `${slug} has status **${status || "none"}**.`;
  }
  process.stdout.write(`${out}\n`);
  return 0;
}

process.exit(main());
