#!/usr/bin/env -S npx tsx
// generate.ts — single owner of project-frontmatter parsing.
//
// One discoverProjects() pass feeds two outputs:
//   1. the human index        — to stdout by default, or to `--out <path>`
//   2. --compact stdout        — slim slug/status/priority view for /project
//
// NOTHING IS COMMITTED. The index is rendered live by `/project`, and the
// default run prints rather than writes: a generated index committed beside the
// projects is a second copy of their frontmatter that drifts.
//
// Frontmatter is the single source of truth for project status. There is NO
// markdown round-trip: the structure is built directly from the in-memory
// ProjectMeta[], not by re-parsing the generated markdown.
//
// Usage:
//   node .agents/generators/project-index.generate.ts            # index to stdout
//   node .agents/generators/project-index.generate.ts --out FILE # index to a file
//   node .agents/generators/project-index.generate.ts --compact  # slim view to stdout

import { readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "node:child_process";
import process from "node:process";

import { parseFrontmatter } from "./parse_frontmatter.ts";
import { oneLineCell } from "./table_cell.ts";
import { validateOutcome } from "./validate_outcome.ts";

// ── Types (relocated from the retired project-index re-parser library) ──────

export type ProjectStatus = "active" | "blocked" | "monitor" | "completed";
export type ProjectPriority = "high" | "medium" | "low";

/** The three statuses that appear in the live index (completed is count-only). */
export type ActiveStatus = Exclude<ProjectStatus, "completed">;

/** One row of the structured index. */
export interface IndexedProject {
  project: string;
  domain: string; // first path segment of linkPath
  status: ActiveStatus;
  priority?: ProjectPriority;
  description: string;
  /** Value from the last column (next / blocked-on / monitoring-until). */
  lastColumnValue: string;
  linkPath: string; // "<domain>/<dir>/README.md"
}

/** The structured index every output is built from. */
export interface ProjectsIndexData {
  active: IndexedProject[];
  blocked: IndexedProject[];
  monitor: IndexedProject[];
  completedCount: number;
  droppedRowCount: {
    active: number;
    blocked: number;
    monitor: number;
    total: number;
  };
  missingRequiredSections: ActiveStatus[];
}

/** Back-compat alias — the old re-parser's name for the same shape. */
export type ParsedProjectIndex = ProjectsIndexData;

export interface ProjectMeta {
  project: string;
  status: string;
  priority?: ProjectPriority;
  created: string;
  description: string;
  next?: string;
  "blocked-on"?: string;
  "monitoring-until"?: string;
  domain: string; // derived from path
  dirName: string; // e.g., "2026-01-10_checkout-flow"
  linkPath: string; // e.g., "web/2026-01-10_checkout-flow/README.md"
  searchText: string; // full README content, lowercased (for a full-text search)
}

// ── Constants (relocated from the retired re-parser library) ────────────────

/** Section-heading text (without the ### prefix) for each active-state status. */
export const STATUS_TO_SECTION: Record<ActiveStatus, string> = {
  active: "Active",
  blocked: "Blocked",
  monitor: "Monitoring",
};

/** Reverse lookup (heading word → status). Kept for back-compat consumers. */
export const SECTION_TO_STATUS: Record<string, ActiveStatus> = {
  Active: "active",
  Blocked: "blocked",
  Monitoring: "monitor",
};

/** Per-domain metadata (emoji + description), one row per domain in
 *  knowledge/README.md § Domains that projects use (`people` holds no projects).
 *  Adding a domain there is followed by one edit here; an unknown domain still
 *  renders, with a ❓. */
export const DOMAIN_MAP: Record<string, { emoji: string; description: string }> = {
  work: { emoji: "💼", description: "The business you run or work in" },
  web: { emoji: "🌐", description: "Websites and web apps" },
  infra: { emoji: "🖥️", description: "Servers, networking, self-hosted services" },
  ai: { emoji: "🤖", description: "AI tools, automations, agents" },
  finance: { emoji: "💰", description: "Budget, investments, tax" },
  health: { emoji: "💚", description: "Health tracking and records" },
  home: { emoji: "🏡", description: "The house, vehicles, family life" },
};

const ACTIVE_STATUSES: readonly ActiveStatus[] = ["active", "blocked", "monitor"] as const;
const VALID_PRIORITIES = new Set<ProjectPriority>(["high", "medium", "low"]);

// ── Per-row validator (manual; zero npm deps) ───────────────────────────────
// generate.ts runs via bare `node` with NO node_modules, so it cannot import a
// schema library; the validation is this hand-rolled safeParse.

export type SafeParseResult<T> = { success: true; data: T } | { success: false; error: string };

const LINK_PATH_REGEX = /^[a-z]+\//;

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Validate one IndexedProject. Non-empty invariants + linkPath domain prefix. */
export const IndexedProjectSchema = {
  safeParse(input: unknown): SafeParseResult<IndexedProject> {
    if (typeof input !== "object" || input === null) {
      return { success: false, error: "row must be an object" };
    }
    const row = input as Record<string, unknown>;
    if (!nonEmpty(row.project)) return { success: false, error: "project: empty" };
    if (!nonEmpty(row.domain)) return { success: false, error: "domain: empty" };
    if (!nonEmpty(row.description)) return { success: false, error: "description: empty" };
    if (!nonEmpty(row.lastColumnValue)) return { success: false, error: "lastColumnValue: empty" };
    if (!nonEmpty(row.linkPath)) return { success: false, error: "linkPath: empty" };
    if (!LINK_PATH_REGEX.test(row.linkPath)) {
      return { success: false, error: "linkPath must start with a domain segment" };
    }
    if (typeof row.status !== "string" || !ACTIVE_STATUSES.includes(row.status as ActiveStatus)) {
      return { success: false, error: "status must be active|blocked|monitor" };
    }
    if (
      row.priority !== undefined &&
      (typeof row.priority !== "string" || !VALID_PRIORITIES.has(row.priority as ProjectPriority))
    ) {
      return { success: false, error: "priority must be high|medium|low" };
    }
    return {
      success: true,
      data: {
        project: row.project,
        domain: row.domain,
        status: row.status as ActiveStatus,
        priority: row.priority as ProjectPriority | undefined,
        description: row.description,
        lastColumnValue: row.lastColumnValue,
        linkPath: row.linkPath,
      },
    };
  },
};

/** Convenience: domain slug → emoji. */
export function domainEmoji(domain: string): string {
  return DOMAIN_MAP[domain]?.emoji ?? "❓";
}

// ── Discover projects ───────────────────────────────────────────────────────

/** A project folder that never became a row, and WHY that has to be counted
 *  rather than only warned about. An unreadable README, absent frontmatter, an
 *  absent status or a status outside the four known ones drops the folder here,
 *  and a line in `warnings` is read by nobody downstream. `buildIndexData` only
 *  counts rows that reach IT, so without this count a tree whose every
 *  frontmatter broke at once would read as an empty index, not a broken one. */
export interface DiscoveryResult {
  projects: ProjectMeta[];
  /** Folders that looked like a project and produced no row. */
  discoveryDrops: number;
  /** The warning behind each drop — what `/project` names on its first line. */
  dropped: string[];
}

function discoverProjects(projectsDir: string): DiscoveryResult {
  const projects: ProjectMeta[] = [];
  const warnings: string[] = [];
  const dropped: string[] = [];
  let discoveryDrops = 0;

  let domains: string[];
  try {
    domains = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== ".git")
      .map((d) => d.name);
  } catch {
    console.error(`Error: cannot read ${projectsDir}`);
    process.exit(1);
  }

  for (const domain of domains) {
    const domainDir = join(projectsDir, domain);
    let entries: string[];
    try {
      entries = readdirSync(domainDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(d.name))
        .map((d) => d.name);
    } catch {
      // A whole DOMAIN that cannot be listed — a permissions change, a broken
      // symlink — used to `continue` in silence, so every project under it
      // vanished from the index and nothing counted the loss. One unreadable
      // domain is indistinguishable from an empty one to the guard unless it is
      // recorded here.
      warnings.push(`${domain}: cannot list domain directory`);
      discoveryDrops += 1;
      dropped.push(`${domain}: cannot list domain directory`);
      continue;
    }

    for (const dirName of entries) {
      const readmePath = join(domainDir, dirName, "README.md");
      let content: string;
      try {
        content = readFileSync(readmePath, "utf-8");
      } catch {
        // An unreadable README is a lost project, not an absent one. This
        // `continue` was silent, so a folder whose README went unreadable
        // dropped out of the index with nothing counting it.
        warnings.push(`${domain}/${dirName}: README unreadable`);
        discoveryDrops += 1;
        dropped.push(`${domain}/${dirName}: README unreadable`);
        continue;
      }

      const fm = parseFrontmatter(content);
      if (!fm) {
        warnings.push(`${domain}/${dirName}: no frontmatter`);
        discoveryDrops += 1;
        dropped.push(`${domain}/${dirName}: no frontmatter`);
        continue;
      }

      const status = fm.status;
      if (!status) {
        warnings.push(`${domain}/${dirName}: missing status`);
        discoveryDrops += 1;
        dropped.push(`${domain}/${dirName}: missing status`);
        continue;
      }

      // Normalize 'complete' → 'completed'
      const normalizedStatus = status === "complete" ? "completed" : status;

      // A status outside the four known ones is a drop, not a silent pass. It
      // used to flow through into `projects` and then vanish: buildIndexData
      // only buckets active/blocked/monitor and only counts `completed`, so an
      // unknown status appeared in no section and in no count.
      if (!["active", "blocked", "monitor", "completed"].includes(normalizedStatus)) {
        warnings.push(`${domain}/${dirName}: unknown status '${status}'`);
        discoveryDrops += 1;
        dropped.push(`${domain}/${dirName}: unknown status '${status}'`);
        continue;
      }

      const project = fm.project || dirName.replace(/^\d{4}-\d{2}-\d{2}_/, "");
      const created = fm.created || dirName.slice(0, 10);
      const description = fm.description || "";
      const next = fm.next;
      const blockedOn = fm["blocked-on"];
      const monitoringUntil = fm["monitoring-until"];
      const priority = fm.priority as ProjectPriority | undefined;

      if (!description && ["active", "blocked", "monitor"].includes(normalizedStatus)) {
        warnings.push(`${domain}/${dirName}: missing description`);
      }
      if (!priority && ["active", "blocked", "monitor"].includes(normalizedStatus)) {
        warnings.push(`${domain}/${dirName}: missing priority (high|medium|low)`);
      }

      projects.push({
        project,
        status: normalizedStatus,
        priority,
        created,
        description,
        next,
        "blocked-on": blockedOn,
        "monitoring-until": monitoringUntil,
        domain,
        dirName,
        linkPath: `${domain}/${dirName}/README.md`,
        searchText: content.toLowerCase(),
      });
    }
  }

  if (warnings.length > 0) {
    console.error(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.error(`  - ${w}`);
  }

  return { projects, discoveryDrops, dropped };
}

// ── Sort: priority desc, then domain alphabetical, then created newest first ──

function priorityRank(p: ProjectMeta["priority"]): number {
  if (p === "high") return 0;
  if (p === "medium") return 1;
  if (p === "low") return 2;
  return 3; // missing priority sinks to the bottom (surfaces warnings)
}

function sortProjects(projects: ProjectMeta[]): ProjectMeta[] {
  return [...projects].sort((a, b) => {
    const pDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (pDiff !== 0) return pDiff;
    const domainCmp = a.domain.localeCompare(b.domain);
    if (domainCmp !== 0) return domainCmp;
    return b.created.localeCompare(a.created); // newest first
  });
}

function priorityDisplay(p: ProjectMeta["priority"]): string {
  if (p === "high") return "🔴 high";
  if (p === "medium") return "🟡 med";
  if (p === "low") return "⚪ low";
  return "";
}

function priorityGlyph(p: ProjectMeta["priority"] | ProjectPriority | undefined): string {
  if (p === "high") return "🔴";
  if (p === "medium") return "🟡";
  if (p === "low") return "⚪";
  return "·";
}

// Render the value as a single table cell with NO length truncation — the full
// field is shown verbatim. The
// `next:` / `blocked-on:` / `monitoring-until:` field is ONE short sentence, so
// there is nothing to clip; the index shows the whole thing. The only transform
// is whitespace collapse: any embedded newline becomes a space so a multi-line
// frontmatter value can't break the markdown table row.

// ── Last-column value per section ───────────────────────────────────────────

function lastColumnFor(p: ProjectMeta, status: ActiveStatus): string {
  if (status === "active") return p.next ?? "";
  if (status === "blocked") return p["blocked-on"] ?? "";
  return p["monitoring-until"] ?? "";
}

// ── Build the structured product (no markdown round-trip) ───────────────────

/** Map the in-memory ProjectMeta[] directly to the published structure.
 *  Mirrors the old parseProjectIndex drop+count semantics so consumers keep
 *  their fail-loud-on-drift behavior: any candidate row that fails the per-row
 *  validator is dropped and counted. missingRequiredSections is always [] —
 *  the generator owns all three sections, so a heading can never go missing. */
export function buildIndexData(projects: ProjectMeta[], discoveryDrops = 0): ProjectsIndexData {
  const result: ProjectsIndexData = {
    active: [],
    blocked: [],
    monitor: [],
    completedCount: projects.filter((p) => p.status === "completed").length,
    // Discovery drops land in `total` only. They cannot be attributed to a
    // status — not having a usable one is what made them drops — and putting
    // them in `active` would make one broken COMPLETED project's frontmatter
    // read as active-row drift to any consumer of the index.
    droppedRowCount: { active: 0, blocked: 0, monitor: 0, total: discoveryDrops },
    missingRequiredSections: [],
  };

  for (const status of ACTIVE_STATUSES) {
    const sectionProjects = sortProjects(projects.filter((p) => p.status === status));
    for (const p of sectionProjects) {
      const candidate: IndexedProject = {
        project: p.project,
        domain: p.domain,
        status,
        priority: p.priority,
        description: p.description,
        lastColumnValue: lastColumnFor(p, status),
        linkPath: p.linkPath,
      };
      const parsed = IndexedProjectSchema.safeParse(candidate);
      if (!parsed.success) {
        result.droppedRowCount[status] += 1;
        result.droppedRowCount.total += 1;
        continue;
      }
      result[status].push(parsed.data);
    }
  }

  return result;
}

// ── Build markdown (human index) ────────────────────────────────────────────

function buildLegend(): string {
  const rows = Object.entries(DOMAIN_MAP)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { emoji, description }]) => `| ${emoji} | \`${name}\` | ${description} |`);

  return ["**Domain Legend:**", "| Emoji | Domain | Description |", "|-------|--------|-------------|", ...rows].join(
    "\n",
  );
}

function buildTable(
  projects: ProjectMeta[],
  lastCol: { header: string; field: "next" | "blocked-on" | "monitoring-until" },
): string {
  if (projects.length === 0) return "*None*";

  const rows = projects.map((p) => {
    const emoji = DOMAIN_MAP[p.domain]?.emoji || "❓";
    const link = `[${oneLineCell(p.project)}](${p.linkPath})`;
    const lastValue = oneLineCell(p[lastCol.field] || "");
    return `| ${priorityDisplay(p.priority)} | ${emoji} | ${link} | ${oneLineCell(p.description)} | ${lastValue} |`;
  });

  return [
    `| Priority | Domain | Project | Description | ${lastCol.header} |`,
    "|----------|--------|---------|-------------|------------|",
    ...rows,
  ].join("\n");
}

export function buildReadme(projects: ProjectMeta[]): string {
  const active = sortProjects(projects.filter((p) => p.status === "active"));
  const blocked = sortProjects(projects.filter((p) => p.status === "blocked"));
  const monitoring = sortProjects(projects.filter((p) => p.status === "monitor"));
  const completedCount = projects.filter((p) => p.status === "completed").length;

  const sections = [
    "# Active Project Status Overview\n",
    "**Priority legend:** 🔴 high · 🟡 medium · ⚪ low — how important the project is right now\n",
    buildLegend(),
    `\n### ${STATUS_TO_SECTION.active} — in motion; work top-down by priority\n`,
    buildTable(active, { header: "Next Steps", field: "next" }),
    `\n### ${STATUS_TO_SECTION.blocked} — external dependency; not actionable until it clears\n`,
    buildTable(blocked, { header: "Blocked On", field: "blocked-on" }),
    `\n### ${STATUS_TO_SECTION.monitor} — shipped; observation window; not actionable unless a signal fires\n`,
    buildTable(monitoring, { header: "Monitoring Until", field: "monitoring-until" }),
    `\n**Completed projects:** ${completedCount}`,
    "",
  ];

  return sections.join("\n");
}

// ── Build the --compact view (slim stdout for /project) ─────────────────────

// This stdout IS the /project reply — step-0.5-render-index pastes it verbatim.
// So the shape is fixed here rather than left to the model to compose per call:
// Active, Blocked and Monitoring all render as tables. The latter two used to
// be one glyph-grouped roster line each; that became unreadable once those
// buckets held dozens of projects. Status words are dropped — the section
// heading already carries status.
//
// THE BLANK LINE BELOW THE HEADING IS LOAD-BEARING. Without it `**Active — N**`
// and the header row are one paragraph, and in some chat renderers (T3 Code's
// among them) a table cannot interrupt a paragraph — every row collapses into
// one unreadable blob of literal pipes. Neither the empty first header cell nor
// the `|---|` delimiter spacing matters to those renderers; the blank line does.

/** Description as one table cell: whitespace-collapsed and pipe-escaped, and
 *  otherwise WHOLE. The cell wraps on its own, so a clip buys nothing a reader
 *  wants and costs the end of every long description; a pathological one
 *  should show up as a tall row somebody fixes in the README, not get silently
 *  cut here. Deliberately NO ceiling.
 *
 *  The length budget lives at the AUTHORING end instead, where it can be hit
 *  rather than enforced: `/project`'s create step and its README template
 *  (`project/SKILL.md`, `project/references/templates/README.md`) cap
 *  `description:`, `blocked-on:` and `monitoring-until:` at 60 characters when
 *  a project is written, and `.agents/skills/close/scripts/roadmap.sh` cuts a
 *  derived `next:` to the same budget. A cut mid-sentence reads as a typo,
 *  which is why a cap does not belong here.
 *
 *  Both transforms stay. The whitespace collapse is what keeps a multi-line
 *  frontmatter value from breaking the row, and the escape is what keeps a `|`
 *  in the prose from ending the cell early. */
function compactDesc(p: IndexedProject): string {
  return oneLineCell(p.description);
}

function compactTable(rows: IndexedProject[]): string[] {
  if (rows.length === 0) return ["(none)", ""];
  return [
    "",
    "| | Project | One-line |",
    "|---|---|---|",
    ...rows.map((p) => `|${priorityGlyph(p.priority)}| \`${oneLineCell(p.project)}\` | ${compactDesc(p)} |`),
    "",
  ];
}

/** `**Active — 28**`. The count is in the heading so the size of each bucket
 *  reads without counting rows. */
function compactHeading(label: string, count: number): string {
  return `**${label} — ${count}**`;
}

export function buildCompact(data: ProjectsIndexData): string {
  return [
    compactHeading(STATUS_TO_SECTION.active, data.active.length),
    ...compactTable(data.active),
    compactHeading(STATUS_TO_SECTION.blocked, data.blocked.length),
    ...compactTable(data.blocked),
    compactHeading(STATUS_TO_SECTION.monitor, data.monitor.length),
    ...compactTable(data.monitor),
    compactHeading("Completed", data.completedCount),
  ].join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// The projects live in the checkout that holds this script: `git rev-parse
// --show-toplevel` from its own folder, so a worktree indexes its own tree
// whether the script sits at .agents/generators/ (installed) or deeper.
//
// RESOLVED LAZILY, not at module scope. This file is IMPORTED for its types,
// `STATUS_TO_SECTION` and `domainEmoji`, and those importers should not pay for
// a git call. Memoized because the answer cannot change mid-run.
let repoRootCache: string | null = null;
export function repoRootPath(): string {
  repoRootCache ??= execFileSync("git", ["-C", __dirname, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  return repoRootCache;
}
function projectsDirPath(): string {
  return join(repoRootPath(), "projects");
}

// Only run the generator when invoked directly (`node generate.ts ...`). When
// imported for its types/constants/domainEmoji the main block stays inert.
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}

/** Why an index must not be written to `outputPath`, or null when it may be.
 *  A file the index replaces is refused while discovery dropped a project —
 *  a bad read would overwrite the last good index with an incomplete one. The
 *  default stdout replaces nothing and is never refused. */
export function refuseOutWithDrops(outputPath: string, discoveryDrops: number): string | null {
  if (outputPath === "-" || discoveryDrops === 0) return null;
  return `--out ${outputPath}: refused, ${discoveryDrops} project(s) could not be read (see the warnings above); the file was left as it was`;
}

/** The first line of the `--compact` view when discovery dropped projects, or
 *  null. The view is what `/project` shows, so a project that could not be read
 *  is named there rather than silently absent; the run then exits non-zero. */
export function compactDropLine(discoveryDrops: number, dropped: string[] = []): string | null {
  if (discoveryDrops === 0) return null;
  const named = dropped.length > 0 ? `: ${dropped.join("; ")}` : " — see the warnings on stderr";
  return `**${discoveryDrops} project(s) could not be read and are missing below${named}.**`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const { projects, discoveryDrops, dropped } = discoverProjects(projectsDirPath());

  // --compact: slim stdout view for the /project skill (working-tree freshness).
  // A drop is named on the view's first line and fails the run.
  if (argv.includes("--compact")) {
    // A project can also be read and still not render: buildIndexData rejects a
    // row that fails the index's schema (an empty next:, say). That is a drop
    // too, named on the same line, or the project vanishes from /project while
    // the run reports success. Rows are matched by linkPath, one per folder:
    // two projects may share a name.
    const data = buildIndexData(projects, discoveryDrops);
    const shown = new Set([...data.active, ...data.blocked, ...data.monitor].map((r) => r.linkPath));
    const rejected = projects
      .filter((p) => (ACTIVE_STATUSES as readonly string[]).includes(p.status) && !shown.has(p.linkPath))
      .map((p) => `${p.linkPath}: its row does not render (check next:, description and priority)`);
    const dropLine = compactDropLine(discoveryDrops + rejected.length, [...dropped, ...rejected]);
    if (dropLine) process.stdout.write(`${dropLine}\n\n`);
    process.stdout.write(buildCompact(data));
    if (dropLine) process.exitCode = 1;
    return;
  }

  // `--out <path>` writes the index to a file; the DEFAULT is stdout — see the
  // header: no generated index is committed, so nothing here writes into
  // projects/ on its own.
  const outFlag = argv.indexOf("--out");
  let outputPath: string;
  if (outFlag === -1) {
    outputPath = "-";
  } else {
    const v = argv[outFlag + 1];
    if (!v) {
      console.error("--out flag requires a path");
      process.exit(1);
    }
    outputPath = v;
  }

  // An empty discovery is not refused here: a new workbench has no projects,
  // and its empty index is a valid one (the outcome check asks only for a
  // rendered header).
  const refusal = refuseOutWithDrops(outputPath, discoveryDrops);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }

  const readme = buildReadme(projects);

  // process.stdout.write() uses the inherited fd 1 directly and works in both
  // shell-redirect and execSync contexts (writeFileSync("/dev/stdout") is
  // unreliable under captured pipes).
  if (outputPath === "-") {
    process.stdout.write(readme);
  } else {
    writeFileSync(outputPath, readme, "utf-8");
  }

  const active = projects.filter((p) => ["active", "blocked", "monitor"].includes(p.status));
  const completed = projects.filter((p) => p.status === "completed");

  // A new workbench has no projects, and an empty index is a valid index, so
  // only the render is asserted; the header always renders.
  validateOutcome("generate_project_index", [{ check: "README content generated", pass: () => readme.length > 0 }]);

  if (outputPath !== "-") {
    console.log(`Wrote the project index to ${outputPath}: ${active.length} active, ${completed.length} completed`);
  }
}

if (invokedDirectly()) {
  main();
}
