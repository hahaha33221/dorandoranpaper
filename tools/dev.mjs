#!/usr/bin/env node
/*
 * 로컬 개발 서버 (의존성 없음)
 *   npm run dev            → http://localhost:5178
 *   PORT=3000 npm run dev  → 다른 포트
 * public/ 파일이 바뀌면 열려 있는 브라우저가 자동으로 새로고침됩니다.
 */
import { createServer } from "node:http";
import { createReadStream, statSync, watch } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.env.PORT) || 5178;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};
const RELOAD_SNIPPET =
  '<script>new EventSource("/__reload").onmessage=()=>location.reload()</script>';

const clients = new Set();
let timer;
watch(ROOT, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const res of clients) res.write("data: reload\n\n");
  }, 80);
});

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/__reload") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  let file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  if (type.startsWith("text/html")) {
    let html = "";
    createReadStream(file, "utf8")
      .on("data", (c) => (html += c))
      .on("end", () => res.end(html.replace("</body>", RELOAD_SNIPPET + "</body>")));
  } else {
    createReadStream(file).pipe(res);
  }
}).listen(PORT, () => {
  console.log(`도란도란 개발 서버: http://localhost:${PORT}`);
});
