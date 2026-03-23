#!/usr/bin/env -S npx tsx
// Generates projects/README.md from project frontmatter.
// Frontmatter is the single source of truth for project status.
// Usage: npx tsx apps/project-index/generate.ts

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

// ── Types ──

interface ProjectMeta {
  project: string;
  status: string;
  created: string;
  description: string;
  next?: string;
  "blocked-on"?: string;
  domain: string;
  dirName: string;
  linkPath: string;
}

// ── Frontmatter parser ──

function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = content.slice(4, end);
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^(\S+):\s*(.+)$/);
    if (match) {
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[match[1]] = value;
    }
  }
  return result;
}

// ── Discover projects ──

function discoverProjects(projectsDir: string): ProjectMeta[] {
  const projects: ProjectMeta[] = [];
  const warnings: string[] = [];

  let domains: string[];
  try {
    domains = readdirSync(projectsDir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() && d.name !== ".git" && d.name !== "setup"
      )
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

      const normalizedStatus = status === "complete" ? "completed" : status;
      const project =
        fm.project || dirName.replace(/^\d{4}-\d{2}-\d{2}_/, "");
      const created = fm.created || dirName.slice(0, 10);
      const description = fm.description || "";

      projects.push({
        project,
        status: normalizedStatus,
        created,
        description,
        next: fm.next,
        "blocked-on": fm["blocked-on"],
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

// ── Sort: domain alphabetical, then created date newest first ──

function sortProjects(projects: ProjectMeta[]): ProjectMeta[] {
  return [...projects].sort((a, b) => {
    const domainCmp = a.domain.localeCompare(b.domain);
    if (domainCmp !== 0) return domainCmp;
    return b.created.localeCompare(a.created);
  });
}

// ── Build markdown ──

function buildTable(
  projects: ProjectMeta[],
  lastCol: { header: string; field: "next" | "blocked-on" }
): string {
  if (projects.length === 0) return "*None*";

  const rows = projects.map((p) => {
    const link = `[${p.project}](${p.linkPath})`;
    const lastValue = p[lastCol.field] || "";
    return `| ${p.domain} | ${link} | ${p.description} | ${lastValue} |`;
  });

  return [
    `| Domain | Project | Description | ${lastCol.header} |`,
    "|--------|---------|-------------|------------|",
    ...rows,
  ].join("\n");
}

function buildReadme(projects: ProjectMeta[]): string {
  const inProgress = sortProjects(
    projects.filter((p) => p.status === "in-progress")
  );
  const upNext = sortProjects(
    projects.filter((p) => p.status === "planning")
  );
  const onHold = sortProjects(
    projects.filter((p) => p.status === "waiting")
  );
  const completedCount = projects.filter(
    (p) => p.status === "completed"
  ).length;

  const sections = [
    "# Projects\n",
    "Time-boxed work items organized by domain.\n",
    "## In Progress\n",
    buildTable(inProgress, { header: "Next Steps", field: "next" }),
    "\n## Up Next\n",
    buildTable(upNext, { header: "Next Steps", field: "next" }),
    "\n## On Hold\n",
    buildTable(onHold, { header: "Blocked On", field: "blocked-on" }),
    `\n**Completed projects:** ${completedCount}`,
    "",
  ];

  return sections.join("\n");
}

// ── Main ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "../..");
const projectsDir = join(repoRoot, "projects");
const outputPath = join(projectsDir, "README.md");

const projects = discoverProjects(projectsDir);
const readme = buildReadme(projects);

writeFileSync(outputPath, readme, "utf-8");

const active = projects.filter((p) =>
  ["in-progress", "planning", "waiting"].includes(p.status)
);
const completed = projects.filter((p) => p.status === "completed");
console.log(
  `Generated projects/README.md: ${active.length} active, ${completed.length} completed`
);
