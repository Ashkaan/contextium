#!/usr/bin/env -S node --experimental-strip-types
// Serve prebuilt QA files on loopback; the parent serve.ts owns this process.
// Usage: static-serve.ts <directory> <port>
// peers: .agents/skills/qa/scripts/serve.ts .agents/skills/qa/scripts/tests/serve-lifecycle.test.ts
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";

function main(): void {
  const [directory = "", portText = ""] = process.argv.slice(2);
  const port = Number(portText);
  let root = "";
  try {
    if (!directory || !portText || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid args");
    root = realpathSync(directory);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    process.stderr.write("usage: static-serve.ts <directory> <port 1-65535>\n");
    process.exitCode = 2;
    return;
  }
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8",
  };
  const server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = resolve(root, `.${pathname}`);
    const path = relative(root, file);
    if (path === ".." || path.startsWith("../")) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) {
        if (!pathname.endsWith("/")) {
          const [urlPath, ...query] = (req.url ?? "/").split("?");
          res.writeHead(301, { Location: `${urlPath}/${query.length ? `?${query.join("?")}` : ""}` }).end();
          return;
        }
        file = join(file, "index.html");
      }
      if (!statSync(file).isFile()) throw new Error("not a file");
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => {
      res.destroy();
    });
    stream.pipe(res);
  });
  server.on("error", (error) => {
    process.stderr.write(`qa static server: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1");
}

main();
