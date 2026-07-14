#!/usr/bin/env -S npx tsx
// Generates projects/README.md from project frontmatter.
// Frontmatter is the single source of truth for project status.
// Usage: node .claude/hooks/generators/project-index.generate.ts [--out /path/to/output.md]

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseFrontmatter } from "./parse_frontmatter.ts";
import { validateOutcome } from "./validate_outcome.ts";
import process from "node:process";

// ── Constants ──

// Section-heading text (without the ### prefix) for each active-state status.
const STATUS_TO_SECTION: Record<string, string> = {
  active: "Active",
  blocked: "Blocked",
  monitor: "Monitoring",
};

// Per-domain metadata (emoji + description). Kept here so the generator has a
// single definition — adding a new domain is one edit. Edit this map to match
// the domains you actually use under projects/.
const DOMAIN_MAP: Record<string, { emoji: string; description: string }> = {
  work: { emoji: "💼", description: "Client / business work" },
  personal: { emoji: "🏠", description: "Personal projects and life admin" },
  infra: { emoji: "🖥️", description: "Servers, networking, self-hosted services" },
  ai: { emoji: "🤖", description: "AI tools, automations, agents" },
  finance: { emoji: "💰", description: "Budgeting, investments, planning" },
  health: { emoji: "💚", description: "Health and wellness tracking" },
  learning: { emoji: "📚", description: "Study, reading, skill-building" },
};

// ── Types ──

interface ProjectMeta {
  project: string;
  status: string;
  priority?: "high" | "medium" | "low";
  created: string;
  description: string;
  next?: string;
  "blocked-on"?: string;
  "monitoring-until"?: string;
  domain: string; // derived from path
  dirName: string; // e.g., "2026-03-06_my-project"
  linkPath: string; // e.g., "work/2026-03-06_my-project/README.md"
}

// ── Discover projects ──

function discoverProjects(projectsDir: string): ProjectMeta[] {
  const projects: ProjectMeta[] = [];
  const warnings: string[] = [];

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
      continue;
    }

    for (const dirName of entries) {
      const readmePath = join(domainDir, dirName, "README.md");
      let content: string;
      try {
        content = readFileSync(readmePath, "utf-8");
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content);
      if (!fm) {
        warnings.push(`${domain}/${dirName}: no frontmatter`);
        continue;
      }

      const status = fm.status;
      if (!status) {
        warnings.push(`${domain}/${dirName}: missing status`);
        continue;
      }

      // Normalize 'complete' → 'completed'
      const normalizedStatus = status === "complete" ? "completed" : status;

      const project = fm.project || dirName.replace(/^\d{4}-\d{2}-\d{2}_/, "");
      const created = fm.created || dirName.slice(0, 10);
      const description = fm.description || "";
      const next = fm.next;
      const blockedOn = fm["blocked-on"];
      const monitoringUntil = fm["monitoring-until"];
      const priority = fm.priority as "high" | "medium" | "low" | undefined;

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
      });
    }
  }

  if (warnings.length > 0) {
    console.error(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.error(`  - ${w}`);
  }

  return projects;
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

// ── Build markdown ──

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
    const link = `[${p.project}](${p.linkPath})`;
    const lastValue = p[lastCol.field] || "";
    return `| ${priorityDisplay(p.priority)} | ${emoji} | ${link} | ${p.description} | ${lastValue} |`;
  });

  return [
    `| Priority | Domain | Project | Description | ${lastCol.header} |`,
    "|----------|--------|---------|-------------|------------|",
    ...rows,
  ].join("\n");
}

function buildReadme(projects: ProjectMeta[]): string {
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

// ── Main ──

import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "../../..");
const projectsDir = join(repoRoot, "projects");

// `--out <path>` regenerates the index to a chosen file for byte-comparison
// without overwriting the live index. Default to writing the canonical
// projects/README.md when no flag is passed. `--out -` writes to stdout.
// The flag requires a non-empty value when present — a silent fallback to the
// canonical path on a missing/empty value would let a caller bug overwrite the
// live index.
const outFlag = process.argv.indexOf("--out");
let outputPath: string;
if (outFlag === -1) {
  outputPath = join(projectsDir, "README.md");
} else {
  const v = process.argv[outFlag + 1];
  if (!v) {
    console.error("--out flag requires a path");
    process.exit(1);
  }
  outputPath = v;
}

const projects = discoverProjects(projectsDir);
const readme = buildReadme(projects);

// `--out -` writes to stdout. writeFileSync("/dev/stdout") is unreliable when
// stdout is a captured pipe, so use process.stdout.write() on the inherited fd.
if (outputPath === "-") {
  process.stdout.write(readme);
} else {
  writeFileSync(outputPath, readme, "utf-8");
}

const active = projects.filter((p) => ["active", "blocked", "monitor"].includes(p.status));
const completed = projects.filter((p) => p.status === "completed");

// An empty projects/ dir is valid (the template ships empty): the header
// always renders, so readme.length > 0 holds even with zero projects.
validateOutcome("generate_project_index", [
  { check: "README content generated", pass: () => readme.length > 0 },
]);

console.log(`Generated projects/README.md: ${active.length} active, ${completed.length} completed`);
