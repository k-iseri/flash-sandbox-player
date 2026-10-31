// dist/ を vercel.json のヘッダー設定どおりに配信する確認用サーバー（Vercel での動作を手元で再現する）
//   node scripts/serve-dist.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".ttf": "font/ttf", ".otf": "font/otf", ".ttc": "font/collection",
};

// vercel.json の source（path-to-regexp 風）を正規表現にする。":param" と "(.*)" だけ対応
function toRegExp(source) {
  const re = source
    .split("(.*)").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:([A-Za-z0-9_]+)/g, "([^/]+)")).join("(.*)");
  return new RegExp(`^${re}$`);
}
const rules = vercel.headers.map((h) => ({ re: toRegExp(h.source), headers: h.headers }));

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const abs = path.normalize(path.join(DIST, rel));
  if (!abs.startsWith(DIST + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404); return res.end("Not Found");
  }
  const headers = { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream" };
  for (const r of rules) if (r.re.test(url.pathname)) for (const h of r.headers) headers[h.key] = h.value;
  res.writeHead(200, headers);
  fs.createReadStream(abs).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`dist/ を配信中: http://127.0.0.1:${PORT}/ （vercel.json のヘッダーを適用）`));
