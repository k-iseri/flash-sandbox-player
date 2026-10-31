// WebKit（Safari 相当）での動作確認。Playwright の WebKit ビルドを使う。
//   npm i --no-save playwright && npx playwright install webkit
//   node test/webkit.test.js [--url http://127.0.0.1:8787/]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { webkit, devices } = require("playwright");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE_URL = argOf("--url", "http://127.0.0.1:8787/");
const sample = (f) => path.join(__dirname, "samples", f);

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await webkit.launch();
try {
  for (const [label, ctxOpts] of [["デスクトップ", { viewport: { width: 1280, height: 900 } }], ["iPhone", { ...devices["iPhone 13"] }]]) {
    const context = await browser.newContext(ctxOpts);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(BASE_URL + (BASE_URL.includes("?") ? "&test" : "?test"));
    await page.waitForFunction(() => window.__swfPlayer, null, { timeout: 15000 });
    await page.evaluate(() => window.__swfPlayer.setLanguage("ja"));

    // 1) 「ファイルを選択」を 1 回クリックしたとき、ファイルピッカーが 1 回だけ開く
    let choosers = 0;
    page.on("filechooser", () => { choosers++; });
    await page.click("#dropzone label.btn");
    await page.waitForTimeout(500);
    check(`[${label}] ファイル選択ボタンでピッカーが 1 回だけ開く`, choosers === 1, `filechooser=${choosers}`);

    // 2) ピッカーからファイルを渡すと検査結果が表示され、Ruffle で再生される
    await page.setInputFiles("#fileInput", sample("ok-red-square-cws.swf"));
    await page.waitForFunction(() => !document.getElementById("result").classList.contains("hidden"), null, { timeout: 5000 }).catch(() => {});
    const resultVisible = await page.evaluate(() => !document.getElementById("result").classList.contains("hidden") && document.getElementById("result").getBoundingClientRect().height > 0);
    check(`[${label}] 検査結果エリアが表示される`, resultVisible);
    let st = "";
    for (let i = 0; i < 80; i++) {
      st = await page.evaluate(() => document.getElementById("status").textContent);
      if (st.startsWith("再生中") || st.includes("エラー") || st.includes("タイムアウト")) break;
      await page.waitForTimeout(250);
    }
    check(`[${label}] WebKit のサンドボックス iframe で Ruffle が再生開始`, st.startsWith("再生中"), st);

    // 2b) 全画面ボタン: 表示され、API が無ければ擬似全画面（画面いっぱい）になり、終了ボタンで戻る
    const fsVisible = await page.evaluate(() => !document.getElementById("fullscreenBtn").classList.contains("hidden"));
    check(`[${label}] 全画面ボタンが表示される`, fsVisible);
    await page.click("#fullscreenBtn");
    await page.waitForTimeout(400);
    const fsState = await page.evaluate(() => {
      // ネイティブ全画面では iframe が、擬似全画面では #stage が画面いっぱいになる
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      const r = (fsEl || document.getElementById("stage")).getBoundingClientRect();
      return { pseudo: document.getElementById("stage").classList.contains("pseudo-full"), native: !!fsEl, w: Math.round(r.width), h: Math.round(r.height), iw: innerWidth, ih: innerHeight };
    });
    check(`[${label}] 全画面（ネイティブまたは擬似）で再生画面が画面いっぱいになる`, (fsState.native || fsState.pseudo) && fsState.w >= fsState.iw - 2 && fsState.h >= fsState.ih - 2, JSON.stringify(fsState));
    if (fsState.pseudo) {
      await page.click("#exitFullBtn");
      await page.waitForTimeout(300);
      const back = await page.evaluate(() => !document.getElementById("stage").classList.contains("pseudo-full"));
      check(`[${label}] 擬似全画面を終了できる`, back);
    } else if (fsState.native) {
      await page.evaluate(() => (document.exitFullscreen || document.webkitExitFullscreen).call(document));
      await page.waitForTimeout(300);
    }

    // 3) 同意フロー
    await page.setInputFiles("#fileInput", sample("consent-geturl.swf"));
    await page.waitForTimeout(500);
    const badge = await page.evaluate(() => document.getElementById("verdictBadge").textContent);
    check(`[${label}] 同意が必要な SWF の判定`, badge === "同意が必要", badge);

    if (errors.length) console.log(`      ブラウザエラー: ${errors.slice(0, 5).join(" | ").slice(0, 400)}`);
    await context.close();
  }

  // iPhone 横向き: 再生画面が表示領域の高さいっぱいになり、音声ヒントはタッチ端末でのみ出る
  {
    const context = await browser.newContext({ ...devices["iPhone 13 landscape"] });
    const page = await context.newPage();
    await page.goto(BASE_URL + (BASE_URL.includes("?") ? "&test" : "?test"));
    await page.waitForFunction(() => window.__swfPlayer, null, { timeout: 15000 });
    await page.evaluate(() => window.__swfPlayer.setLanguage("ja"));
    await page.setInputFiles("#fileInput", sample("ok-red-square-cws.swf"));
    let st = "";
    for (let i = 0; i < 80; i++) { st = await page.evaluate(() => document.getElementById("status").textContent); if (st.startsWith("再生中") || st.includes("エラー")) break; await page.waitForTimeout(250); }
    const r = await page.evaluate(() => { const b = document.getElementById("stage").getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), iw: innerWidth, ih: innerHeight }; });
    check("[iPhone 横向き] 再生画面が表示領域の高さいっぱいになる", st.startsWith("再生中") && r.h >= r.ih - 30 && r.w >= r.iw - 40, JSON.stringify(r));
    await context.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
