// 极简静态文件服务器：仅用于 Tauri dev（无任何打包器，前端即为原生 JS/CSS/HTML）。
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(new URL(".", import.meta.url)), "src"));
const port = process.env.PORT || 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (pathname === "/") pathname = "/index.html";
    let file = normalize(join(root, pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const st = statSync(file);
      if (st.isDirectory()) {
        file = join(file, "index.html");
      }
      const data = readFileSync(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("Not Found");
    }
  })
  .listen(port, () => {
    console.log(`dev server: http://localhost:${port}`);
  });