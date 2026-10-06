// Static server for the Playwright suite. Serves the site directory the way
// GitHub Pages does — extensionless routes resolve to <route>.html, "/" to
// index.html — and nothing else: it never proxies to any API. The specs answer
// every API call inside the browser (page.route), so the suite cannot reach the
// real Cleaneri API. SITE_ROOT points it at another checkout (e.g. a baseline).
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  process.env.SITE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const port = Number(process.env.PORT || 4791);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function resolveFile(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return null; // no ../ escapes
  if (await isFile(file)) return file;
  if (!path.extname(file) && (await isFile(`${file}.html`))) return `${file}.html`;
  return null;
}

http
  .createServer(async (req, res) => {
    const file = await resolveFile(new URL(req.url, "http://localhost").pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(await readFile(file));
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`static server: ${root} -> http://127.0.0.1:${port}`);
  });
