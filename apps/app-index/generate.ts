#!/usr/bin/env -S npx tsx
// Generates apps/README.md from app frontmatter
// Usage: node apps/app-index/generate.ts [--out /path/to/output.md]

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseFrontmatter } from "../shared/parse_frontmatter.ts";
import { validateOutcome } from "../shared/validate_outcome.ts";

// ── Domain labels ────────────────────────────────────────────────────
// Apps are grouped by domain — the top-level folder under apps/ (the first
// path segment of dirName, e.g. "media" in "media/my-app"). A flat app at
// apps/<app>/ (no domain folder) has no domain and lands in the ungrouped
// fallback, so this works whether you nest apps under domain folders or keep
// them flat. Domains render alphabetically. Add a DOMAIN_LABELS entry only to
// override display casing (e.g. an acronym); unlisted domains capitalize the
// first letter.
const DOMAIN_LABELS: Record<string, string> = {};

function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain.charAt(0).toUpperCase() + domain.slice(1);
}

// The domain is the first path segment of a nested app; a flat app (dirName
// without "/") has no domain and returns "".
function appDomain(dirName: string): string {
  return dirName.includes("/") ? dirName.split("/")[0] : "";
}

const SKIP_DIRS = new Set(["shared", ".git"]);

// ── Types ────────────────────────────────────────────────────────────

interface AppMeta {
  name: string;
  description: string;
  schedule: string;
  runtime: string;
  dirName: string;
}

// ── Discovery ────────────────────────────────────────────────────────

// A folder marked as a domain bundle is a deploy unit for several member
// apps. The index lists the MEMBERS (one level deeper), not the bundle
// folder, so links read `media/my-app/`.
function isDomainBundle(appsDir: string, dirName: string): boolean {
  try {
    const cfg = readFileSync(join(appsDir, dirName, "trigger.config.ts"), "utf-8");
    return /trigger-domain-bundle:/.test(cfg);
  } catch {
    return false;
  }
}

// Parse one app's README (relDir is repo-relative to appsDir, e.g. "my-app" or
// "media/my-app"). Returns null + a warning on missing/invalid.
function parseAppReadme(appsDir: string, relDir: string, warnings: string[]): AppMeta | null {
  let content: string;
  try {
    content = readFileSync(join(appsDir, relDir, "README.md"), "utf-8");
  } catch {
    warnings.push(`${relDir}: no README.md`);
    return null;
  }

  const fm = parseFrontmatter(content);
  if (!fm) {
    warnings.push(`${relDir}: no frontmatter`);
    return null;
  }

  const name = fm.name;
  const description = fm.description;
  if (!name || !description) {
    const missing = [!name && "name", !description && "description"].filter(Boolean).join(", ");
    warnings.push(`${relDir}: missing ${missing}`);
    return null;
  }

  return {
    name,
    description,
    schedule: fm.schedule || "—",
    runtime: fm.runtime || "—",
    dirName: relDir,
  };
}

function discoverApps(appsDir: string): AppMeta[] {
  const apps: AppMeta[] = [];
  const warnings: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(appsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
      .map((d) => d.name);
  } catch {
    console.error(`Error: cannot read ${appsDir}`);
    process.exit(1);
  }

  for (const dirName of entries) {
    if (isDomainBundle(appsDir, dirName)) {
      // Descend into member apps; the domain folder itself is not an app.
      let members: string[] = [];
      try {
        members = readdirSync(join(appsDir, dirName), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        members = [];
      }
      for (const m of members) {
        const meta = parseAppReadme(appsDir, `${dirName}/${m}`, warnings);
        if (meta) apps.push(meta);
      }
      continue;
    }
    const meta = parseAppReadme(appsDir, dirName, warnings);
    if (meta) apps.push(meta);
  }

  if (warnings.length > 0) {
    console.error(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.error(`  - ${w}`);
  }

  return apps;
}

// ── Truncate description for table ───────────────────────────────────

function truncate(desc: string, max = 90): string {
  if (desc.length <= max) return desc;
  // Try to cut at first sentence
  const dot = desc.indexOf(". ");
  if (dot !== -1 && dot < max) return desc.slice(0, dot + 1);
  return desc.slice(0, max - 1) + "…";
}

// ── Build markdown ───────────────────────────────────────────────────

function buildTable(apps: AppMeta[]): string {
  if (apps.length === 0) return "";

  const sorted = [...apps].sort((a, b) => a.dirName.localeCompare(b.dirName));
  const rows = sorted.map((a) => {
    const link = `[${a.name}](${a.dirName}/)`;
    const purpose = truncate(a.description);
    return `| ${link} | ${purpose} | ${a.schedule} | ${a.runtime} |`;
  });

  return ["| App | Purpose | Schedule | Runtime |", "|-----|---------|----------|---------|", ...rows].join("\n");
}

function buildReadme(apps: AppMeta[]): string {
  const sections: string[] = [
    "# Apps",
    "",
    "Each folder is a self-contained app — a capability with a protocol (README) and optionally automation code.",
    "",
    "**What belongs here:** Non-trivial protocols, SOPs, and the automation scripts that power them.",
    "",
    "**What doesn't:** Data, records, entries, logs. Those live in `knowledge/`.",
    "",
    "**Boundary test:** If you delete everything in `knowledge/{name}/`, the app still makes sense — it just has no data. If",
    "you delete `apps/{name}/`, you have data with no context.",
    "",
    "<!-- Generated by apps/app-index/generate.ts — do not edit manually -->",
    "",
  ];

  const domains = [...new Set(apps.map((a) => appDomain(a.dirName)))].filter(Boolean).sort();
  const flatApps = apps.filter((a) => appDomain(a.dirName) === "");

  if (domains.length === 0) {
    // All apps are flat (no domain folders) — render one untitled table.
    sections.push(buildTable(flatApps));
    sections.push("");
  } else {
    for (const domain of domains) {
      const domainApps = apps.filter((a) => appDomain(a.dirName) === domain);
      sections.push(`## ${domainLabel(domain)}`, "");
      sections.push(buildTable(domainApps));
      sections.push("");
    }
    // Mixed layout: flat apps that aren't under any domain folder.
    if (flatApps.length > 0) {
      sections.push("## Other", "");
      sections.push(buildTable(flatApps));
      sections.push("");
    }
  }

  sections.push(`**Total: ${apps.length} apps**`, "");

  return sections.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────

import { fileURLToPath } from "url";
import { dirname } from "path";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "../..");
const appsDir = join(repoRoot, "apps");

// `--out <path>` requires a non-empty value when the flag is present — a silent
// fallback to the canonical path on a missing/empty value would let a caller
// bug overwrite the live index. `--out -` writes to stdout.
const outFlag = process.argv.indexOf("--out");
let outputPath: string;
if (outFlag === -1) {
  outputPath = join(appsDir, "README.md");
} else {
  const v = process.argv[outFlag + 1];
  if (!v) {
    console.error("--out flag requires a path");
    process.exit(1);
  }
  outputPath = v;
}

const apps = discoverApps(appsDir);
const readme = buildReadme(apps);

if (outputPath === "-") {
  process.stdout.write(readme);
} else {
  writeFileSync(outputPath, readme, "utf-8");
}

// An empty apps/ dir is valid (the template ships empty): the header always
// renders, so readme.length > 0 holds even with zero apps.
validateOutcome("generate_app_index", [
  { check: "README content generated", pass: () => readme.length > 0 },
]);

const byDomain = new Map<string, number>();
for (const a of apps) {
  const domain = appDomain(a.dirName) || "(flat)";
  byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
}
const breakdown = [...byDomain.entries()].sort().map(([k, v]) => `${k}=${v}`).join(", ");
console.log(`Generated apps/README.md: ${apps.length} apps (${breakdown})`);
