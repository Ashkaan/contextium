#!/usr/bin/env -S node --experimental-strip-types
// detect-app.ts — classify a repo (or an app folder in one) into a serveable app type and
// emit the facts serve.ts needs. Detection reads package.json (deps + scripts)
// + on-disk markers ONLY — /qa is zero-config, so there is no per-repo .qa.json.
// Detection NEVER invents a serve/run command for
// Node-server / CLI / render targets — those declare themselves with a
// `qa:serve` / `qa:cmd` / `qa:render` script in their own package.json; only the
// convention-covered web shapes (Astro / Vite / static) get a default. A target
// that matches neither convention nor a qa:* script exits 3 (`unknown`).
//
// peers:
//   .agents/skills/qa/scripts/serve.ts
//   .agents/skills/qa/scripts/discover-routes.ts
//   .agents/skills/qa/scripts/lib.ts
//   .agents/skills/qa/scripts/tests/detect-app.test.ts
//
// Usage:   detect-app.ts <repo-dir>
// Output:  KEY=VALUE lines on stdout, one per line. Parse each with a line-anchored
//          `sed -n 's/^KEY=//p'` (as serve.ts does, line by line) — NOT
//          `eval`/`source`: the command values intentionally contain spaces
//          (`QA_SERVE=npm run qa:serve`), so the stream is not shell-sourceable.
//            TYPE=astro-cf|astro|next|vite|static|node-server|cli|render|unknown
//            QA_SERVE=<`npm run qa:serve`, or empty>
//            QA_CMD=<`npm run qa:cmd`, or empty>
//            QA_RENDER=<`npm run qa:render`, or empty>
//            SERVE_DIR=<static dir basename when TYPE=static, else empty>
//            SIGNALS=<comma list of detected signals>
// Exit:    0 detected; 2 usage; 3 unknown / needs-qa:*-script (signals on stderr)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { qaErr } from "./lib.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const REPO = process.argv[2] ?? "";
  if (REPO === "") {
    qaErr("usage: detect-app.ts <repo-dir>");
    exit(2);
  }
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (!isDir(REPO)) {
    qaErr(`detect-app: not a directory: ${REPO}`);
    exit(2);
  }

  const PKG = `${REPO}/package.json`;

  interface PackageJson {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    bin?: unknown;
  }

  /** package.json parsed, or undefined when it is absent or not JSON. */
  function readPkg(): PackageJson | undefined {
    if (!isFile(PKG)) return undefined;
    try {
      const v: unknown = JSON.parse(readFileSync(PKG, "utf8"));
      return typeof v === "object" && v !== null ? (v as PackageJson) : undefined;
    } catch {
      return undefined;
    }
  }
  const pkg = readPkg();

  // pkgScript KEY — a package.json scripts[KEY] value, or empty. The qa:*
  // scripts are the zero-config escape hatch: a target that can't be served by
  // convention (render output, a CLI, a bespoke server) declares HOW to run in
  // its own package.json instead of a sidecar config file.
  function pkgScript(key: string): string {
    const scripts = pkg?.scripts;
    if (typeof scripts !== "object" || scripts === null) return "";
    const s = scripts[key];
    return s ? String(s) : "";
  }

  const qaRenderS = pkgScript("qa:render");
  const qaCmdS = pkgScript("qa:cmd");
  const qaServeS = pkgScript("qa:serve");

  // Emitted commands are the npm invocation of the declared script.
  const qaRenderCmd = qaRenderS ? "npm run qa:render" : "";
  const qaCmdCmd = qaCmdS ? "npm run qa:cmd" : "";
  const qaServeCmd = qaServeS ? "npm run qa:serve" : "";

  function emit(type: string, serveDir = "", signals = ""): void {
    process.stdout.write(
      `TYPE=${type}\nQA_SERVE=${qaServeCmd}\nQA_CMD=${qaCmdCmd}\nQA_RENDER=${qaRenderCmd}\nSERVE_DIR=${serveDir}\nSIGNALS=${signals}\n`,
    );
  }

  // ── qa:* escape-hatch scripts win over convention ────────────────────
  // A `render` script is the universal hatch: the repo declares how to produce
  // PNG(s) into $QA_OUT for anything that isn't a served web page (TRMNL Liquid,
  // HTML-to-image). It wins over cmd/serve — it IS the visual.
  if (qaRenderS) {
    emit("render", "", "package.json:qa:render");
    exit(0);
  }
  if (qaCmdS) {
    emit("cli", "", "package.json:qa:cmd");
    exit(0);
  }
  if (qaServeS) {
    emit("node-server", "", "package.json:qa:serve");
    exit(0);
  }

  // ── package.json-driven convention detection ─────────────────────────
  let deps: string[] = [];
  let hasBin = "no";
  if (pkg) {
    deps = Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies));
    hasBin = pkg.bin ? "yes" : "no";
  }

  // Case-insensitive and word-exact, as the dependency list was matched before:
  // `next-auth` is not `next`.
  const hasDep = (name: string): boolean => deps.some((d) => d.toLowerCase() === name.toLowerCase());

  const hasAstro = hasDep("astro") ? "yes" : "no";
  let hasNext = "no";
  const nextConfig = (() => {
    try {
      return readdirSync(REPO).some((f) => f.startsWith("next.config."));
    } catch {
      return false;
    }
  })();
  if (hasDep("next") || nextConfig) hasNext = "yes";
  const hasVite = hasDep("vite") ? "yes" : "no";
  let hasWrangler = "no";
  if (
    hasDep("wrangler") ||
    deps.some((d) => d.toLowerCase().includes("@cloudflare")) ||
    isFile(`${REPO}/wrangler.toml`) ||
    isFile(`${REPO}/wrangler.jsonc`) ||
    isFile(`${REPO}/wrangler.json`)
  ) {
    hasWrangler = "yes";
  }

  const signals = `astro=${hasAstro},next=${hasNext},vite=${hasVite},wrangler=${hasWrangler},bin=${hasBin}`;

  if (hasAstro === "yes" && hasWrangler === "yes") {
    emit("astro-cf", "", signals);
    exit(0);
  }
  if (hasAstro === "yes") {
    emit("astro", "", signals);
    exit(0);
  }
  // Next MUST be tested before vite/static: a Next repo ships a `dist`/`public`
  // dir and often bundles vite-family devDeps, so the fallbacks below would
  // misclassify it as `static` and serve prebuilt bytes instead of the app.
  if (hasNext === "yes") {
    emit("next", "", signals);
    exit(0);
  }
  if (hasVite === "yes") {
    emit("vite", "", signals);
    exit(0);
  }

  // Static: a prebuilt output dir, no build toolchain detected.
  if (isDir(`${REPO}/dist`)) {
    emit("static", "dist", `${signals},static=dist`);
    exit(0);
  }
  if (isDir(`${REPO}/public`)) {
    emit("static", "public", `${signals},static=public`);
    exit(0);
  }

  // CLI / library / Node-server without a qa:* script: refuse to guess a command.
  if (hasBin === "yes") {
    qaErr(`detect-app: CLI/library target (${signals}) — add a \`qa:cmd\` script to package.json`);
    emit("unknown", "", `${signals},needs=package.json:qa:cmd`);
    exit(3);
  }

  qaErr(
    `detect-app: unknown app type (${signals}) — add a package.json qa:* script (\`qa:serve\` or \`qa:cmd\` or \`qa:render\`)`,
  );
  emit("unknown", "", signals);
  exit(3);
}

await runToExit(main);
