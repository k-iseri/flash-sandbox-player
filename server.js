// ローカル専用 SWF プレイヤーの静的サーバー（依存パッケージなし）
// - 127.0.0.1 にのみバインド（既定）
// - public/ と node_modules/@ruffle-rs/ruffle/ だけを配信
// - 厳格な CSP / セキュリティヘッダーを付与
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFontNames } from "./public/fontnames.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const RUFFLE_DIR = path.join(__dirname, "node_modules", "@ruffle-rs", "ruffle");
const VENDOR_DIR = path.join(__dirname, "node_modules", "lzma", "src");
// 置き換え用フォント（.ttf / .otf / .ttc）を置くフォルダー。/fonts/ で配信し、/fonts.json で一覧を返す
const FONTS_DIR = path.join(__dirname, "fonts");
const FONT_EXT = new Set([".ttf", ".otf", ".ttc"]);
// /vendor/ から配信してよいファイル（LZMA 圧縮 SWF の検査用デコーダーのみ）
const VENDOR_ALLOW = new Set(["lzma-d-min.js"]);

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);

if (!fs.existsSync(path.join(RUFFLE_DIR, "ruffle.js"))) {
  console.error("Ruffle が見つかりません。先に `npm install` を実行してください。");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
};

// sandbox iframe（opaque origin）から見ても 'self' が解決できるよう、明示的なオリジンも並べる
function selfOrigins() {
  const set = new Set([`http://${HOST}:${PORT}`, `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  return [...set].join(" ");
}

const ORIGINS = selfOrigins();

// ホストページ（D&D 側）: 外部への通信を一切許可しない
const CSP_HOST = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "frame-src 'self'",
  "connect-src 'self'", // fonts.json / fonts/ の取得のみ（外部には出ない）
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

// プレイヤーページ（sandbox iframe 内）: Ruffle の wasm/チャンク取得のみ同一サーバーに許可
const CSP_PLAYER = [
  "default-src 'none'",
  `script-src 'self' 'wasm-unsafe-eval' ${ORIGINS}`,
  `style-src 'self' 'unsafe-inline' ${ORIGINS}`,
  `img-src 'self' data: blob: ${ORIGINS}`,
  `font-src 'self' data: ${ORIGINS}`,
  "media-src blob: data:",
  `connect-src 'self' blob: ${ORIGINS}`, // blob: はドロップされたフォントファイルを Ruffle に渡すため
  "worker-src blob:",
  `frame-ancestors 'self' ${ORIGINS}`,
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

// フォント一覧。ファミリー名はサーバー側で解析して返し、フォント本体は利用者が有効にしたときだけ配信する
// （以前は一覧表示のために全フォントをダウンロードしていた）
const fontCache = new Map(); // file -> { mtimeMs, size, families }
function listFonts() {
  let files = [];
  try {
    files = fs.readdirSync(FONTS_DIR).filter((f) => FONT_EXT.has(path.extname(f).toLowerCase())).sort();
  } catch { return []; }
  const out = [];
  for (const file of files) {
    try {
      const abs = path.join(FONTS_DIR, file);
      const st = fs.statSync(abs);
      let c = fontCache.get(file);
      if (!c || c.mtimeMs !== st.mtimeMs) {
        c = { mtimeMs: st.mtimeMs, size: st.size, families: parseFontNames(fs.readFileSync(abs)).families };
        fontCache.set(file, c);
      }
      out.push({ file, families: c.families, size: c.size });
    } catch { /* 読めないファイルは無視 */ }
  }
  return out;
}

function resolveSafe(root, relPath) {
  // パストラバーサル防止: 正規化後に root 配下であることを確認
  const decoded = decodeURIComponent(relPath).replaceAll("\\", "/");
  if (decoded.includes("\0") || decoded.includes("\x00")) return null;
  const abs = path.normalize(path.join(root, decoded));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "Method Not Allowed");
  }
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    return send(res, 400, "Bad Request");
  }

  let root = PUBLIC_DIR;
  let rel = url.pathname;
  let isRuffleAsset = false;
  let isFont = false;

  if (rel === "/") rel = "/index.html";
  if (rel === "/fonts.json") {
    return send(res, 200, JSON.stringify({ fonts: listFonts() }), { "Content-Type": "application/json; charset=utf-8" });
  }
  if (rel.startsWith("/fonts/")) {
    const file = rel.slice("/fonts/".length);
    if (!FONT_EXT.has(path.extname(file).toLowerCase())) return send(res, 404, "Not Found");
    root = FONTS_DIR;
    rel = "/" + file;
    isFont = true; // ホストページ（同一オリジン）だけが取得する。他サイトからの直リンクは CORP で拒否
  }
  if (rel.startsWith("/ruffle/")) {
    root = RUFFLE_DIR;
    rel = rel.slice("/ruffle".length);
    isRuffleAsset = true;
  } else if (rel.startsWith("/vendor/")) {
    const file = rel.slice("/vendor/".length);
    if (!VENDOR_ALLOW.has(file)) return send(res, 404, "Not Found");
    root = VENDOR_DIR;
    rel = "/" + file;
  }

  const abs = resolveSafe(root, rel);
  if (!abs) return send(res, 403, "Forbidden");

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not Found");

    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "Content-Length": st.size,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cache-Control": isRuffleAsset || isFont ? "public, max-age=3600" : "no-store",
    };

    if (isRuffleAsset) {
      // sandbox iframe は opaque origin（Origin: null）から wasm を fetch する。
      // Safari は Access-Control-Allow-Origin: null を受け付けないことがあるため、公開ライブラリとして * を返す
      headers["Access-Control-Allow-Origin"] = "*";
      headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    } else if (isFont) {
      headers["Cross-Origin-Resource-Policy"] = "same-origin";
    }

    if (ext === ".html") {
      const base = path.basename(abs);
      headers["Content-Security-Policy"] = base === "player.html" ? CSP_PLAYER : CSP_HOST;
      headers["Permissions-Policy"] =
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()";
      if (base !== "player.html") headers["X-Frame-Options"] = "DENY";
    }

    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SWF Sandbox Player: http://${HOST}:${PORT}/`);
  console.log(HOST === "127.0.0.1" || HOST === "localhost" ? "(ローカルのみ待ち受け。公開する場合は HOST=0.0.0.0 を指定し、HTTPS のリバースプロキシ配下で運用してください)" : "(外部からの接続を受け付けています)");
});
