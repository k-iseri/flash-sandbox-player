// 静的ホスティング（Vercel など）向けに dist/ を組み立てる
//   public/            → dist/
//   Ruffle             → dist/ruffle/
//   LZMA デコーダー     → dist/vendor/lzma-d-min.js
//   fonts/*.ttf|otf|ttc → dist/fonts/ と dist/fonts.json（ファミリー名はここで解析）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFontNames } from "../public/fontnames.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const FONT_EXT = new Set([".ttf", ".otf", ".ttc"]);

function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d, filter);
    else if (filter(ent.name)) fs.copyFileSync(s, d);
  }
}

fs.rmSync(DIST, { recursive: true, force: true });
copyDir(path.join(ROOT, "public"), DIST);
copyDir(path.join(ROOT, "node_modules", "@ruffle-rs", "ruffle"), path.join(DIST, "ruffle"), (n) => !n.endsWith(".map") && !/^LICENSE|^README/i.test(n));
fs.mkdirSync(path.join(DIST, "vendor"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "node_modules", "lzma", "src", "lzma-d-min.js"), path.join(DIST, "vendor", "lzma-d-min.js"));

const fonts = [];
const fontsDir = path.join(ROOT, "fonts");
fs.mkdirSync(path.join(DIST, "fonts"), { recursive: true });
if (fs.existsSync(fontsDir)) {
  for (const file of fs.readdirSync(fontsDir).sort()) {
    if (!FONT_EXT.has(path.extname(file).toLowerCase())) continue;
    const buf = fs.readFileSync(path.join(fontsDir, file));
    fs.writeFileSync(path.join(DIST, "fonts", file), buf);
    fonts.push({ file, families: parseFontNames(buf).families, size: buf.length });
  }
}
fs.writeFileSync(path.join(DIST, "fonts.json"), JSON.stringify({ fonts }));

const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`dist/ を作成しました: ${count(DIST)} ファイル, フォント ${fonts.length} 件`);
