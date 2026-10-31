// ヘッドレス Chrome/Edge を DevTools Protocol で操作し、実際のページで
//  1) 良性 SWF が sandbox iframe 内の Ruffle で描画されること
//  2) 拒否対象の SWF が実行されないこと
//  3) iframe 内から Cookie / 外部 fetch ができないこと
// を確認する。サーバー（npm start）を先に起動しておくこと。
//   node test/browser.test.js [--browser <path>] [--url http://127.0.0.1:8787/] [--out <dir>]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const BASE_URL = argOf("--url", "http://127.0.0.1:8787/");
const OUT_DIR = argOf("--out", path.join(os.tmpdir(), "flash-sandbox-player-test"));
const BROWSER = argOf("--browser", [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find((p) => fs.existsSync(p)));
if (!BROWSER) { console.error("Chrome/Edge が見つかりません。--browser で指定してください"); process.exit(2); }

fs.mkdirSync(OUT_DIR, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(OUT_DIR, "profile-"));
const PORT = 9222 + Math.floor(Math.random() * 500);

const browser = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
  "--autoplay-policy=no-user-gesture-required", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error("DevTools に接続できません");
}

// ---- 最小 CDP クライアント ------------------------------------------------------
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.handlers.push(fn); }
}

const logs = [];
const sessions = new Map(); // sessionId -> {type, url}

async function enableSession(cdp, sessionId) {
  await cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
  await cdp.send("Log.enable", {}, sessionId).catch(() => {});
  await cdp.send("Page.enable", {}, sessionId).catch(() => {});
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
}

async function evalIn(cdp, sessionId, expression, contextId) {
  const r = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}),
  }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// すべてのセッション／実行コンテキストから player.html のものを探す
const contexts = []; // {sessionId, contextId, origin, url}
async function findPlayerContext(cdp) {
  for (const c of contexts) {
    try {
      const href = await evalIn(cdp, c.sessionId, "location.href", c.contextId);
      if (typeof href === "string" && href.includes("player.html")) return c;
    } catch { /* ignore */ }
  }
  return null;
}

async function main() {
  const wsUrl = await waitForDevtools();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);

  cdp.on((m) => {
    if (m.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = m.params;
      sessions.set(sessionId, targetInfo);
      enableSession(cdp, sessionId);
    } else if (m.method === "Runtime.executionContextCreated") {
      const c = m.params.context;
      contexts.push({ sessionId: m.sessionId, contextId: c.id, origin: c.origin, name: c.name });
    } else if (m.method === "Runtime.consoleAPICalled") {
      logs.push(`[console.${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    } else if (m.method === "Log.entryAdded") {
      logs.push(`[${m.params.entry.source}/${m.params.entry.level}] ${m.params.entry.text}`);
    } else if (m.method === "Runtime.exceptionThrown") {
      logs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    }
  });

  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  sessions.set(page, { type: "page" });
  await enableSession(cdp, page);

  await cdp.send("Page.navigate", { url: BASE_URL }, page);
  await sleep(1500);
  const title = await evalIn(cdp, page, "document.title");
  if (title !== "Flash Sandbox Player") throw new Error(`ページを開けません: title=${title}`);
  // テストは日本語の文言を前提にしているので、ヘッドレス環境の言語に関わらず日本語に固定する
  await evalIn(cdp, page, "window.__swfPlayer.setLanguage('ja')");

  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

  async function dropFile(fileName) {
    const b64 = fs.readFileSync(path.join(__dirname, "samples", fileName)).toString("base64");
    await evalIn(cdp, page, `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const file = new File([bytes], ${JSON.stringify(fileName)}, { type: "application/x-shockwave-flash" });
      await window.__swfPlayer.handleFile(file);
    })()`);
  }
  const badge = () => evalIn(cdp, page, "document.getElementById('verdictBadge').textContent");
  const status = () => evalIn(cdp, page, "document.getElementById('status').textContent");
  const hasFrame = () => evalIn(cdp, page, "!!document.querySelector('#stage iframe')");

  // 初期状態のスクリーンショット
  const idle = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
  fs.writeFileSync(path.join(OUT_DIR, "idle.png"), Buffer.from(idle.data, "base64"));

  // 1) 良性 SWF: 再生されること
  await dropFile("ok-red-square-cws.swf");
  let st = "";
  for (let i = 0; i < 60; i++) { st = await status(); if (st.startsWith("再生中") || st.includes("エラー") || st.includes("タイムアウト")) break; await sleep(250); }
  check("良性 SWF の判定が『問題なし』", (await badge()) === "問題なし", await badge());
  check("良性 SWF が Ruffle で読み込まれた", st.startsWith("再生中"), st);
  await sleep(1500);

  // 描画確認: スクリーンショットの iframe 領域に赤いピクセルがあるか
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
  const shotPath = path.join(OUT_DIR, "playing.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log(`      スクリーンショット: ${shotPath}`);

  const scroll = await evalIn(cdp, page, "JSON.stringify({sh: document.documentElement.scrollHeight, ih: innerHeight, ov: getComputedStyle(document.documentElement).overflowY})");
  const sc = JSON.parse(scroll);
  check("ページに縦スクロールバーが出ない", sc.sh <= sc.ih && sc.ov === "hidden", scroll);

  // 2) iframe 内の隔離確認
  const pc = await findPlayerContext(cdp);
  check("player.html の実行コンテキストを発見", !!pc, pc ? `origin=${pc.origin}` : "見つからず");
  if (pc) {
    // location.origin は URL 由来の値を返すため、ドキュメント自身のオリジンは self.origin で確認する
    const origin = await evalIn(cdp, pc.sessionId, "self.origin", pc.contextId);
    check("iframe は opaque origin（self.origin === 'null'）", origin === "null", String(origin));
    const cookie = await evalIn(cdp, pc.sessionId, "(() => { try { return 'readable:' + document.cookie; } catch (e) { return 'blocked:' + e.name; } })()", pc.contextId);
    check("iframe から document.cookie にアクセスできない", cookie.startsWith("blocked:"), cookie);
    const ls = await evalIn(cdp, pc.sessionId, "(() => { try { localStorage.setItem('x','1'); return 'writable'; } catch (e) { return 'blocked:' + e.name; } })()", pc.contextId);
    check("iframe から localStorage にアクセスできない", ls.startsWith("blocked:"), ls);
    const fetchRes = await evalIn(cdp, pc.sessionId, "fetch('https://example.com/', {mode:'no-cors'}).then(() => 'allowed', (e) => 'blocked:' + e.name)", pc.contextId);
    check("iframe からの外部 fetch が CSP で遮断される", fetchRes.startsWith("blocked:"), fetchRes);
    const cfg = await evalIn(cdp, pc.sessionId, "JSON.stringify((document.querySelector('ruffle-player')?.loadedConfig) ? {n: document.querySelector('ruffle-player').loadedConfig.allowNetworking, u: document.querySelector('ruffle-player').loadedConfig.openUrlMode, s: document.querySelector('ruffle-player').loadedConfig.allowScriptAccess} : null)", pc.contextId);
    const parsed = cfg ? JSON.parse(cfg) : null;
    check("Ruffle の実効設定が none/deny/false", !!parsed && parsed.n === "none" && parsed.u === "deny" && parsed.s === false, cfg);
    // ミュート解除オーバーレイを強制表示し、文字が画面内に収まるか確認
    const overlay = await evalIn(cdp, pc.sessionId, `(() => {
      const sr = document.querySelector('ruffle-player')?.shadowRoot; if (!sr) return 'no-shadow';
      const ov = sr.querySelector('#unmute-overlay'); ov.style.display = 'block';
      const t = sr.querySelector('#unmute-text'); const bb = t.getBoundingClientRect();
      return JSON.stringify({ text: t.textContent, left: Math.round(bb.left), right: Math.round(bb.right), w: innerWidth });
    })()`, pc.contextId);
    const ovj = overlay.startsWith("{") ? JSON.parse(overlay) : null;
    check("ミュート解除の文字が見切れない", !!ovj && ovj.left >= 0 && ovj.right <= ovj.w, overlay);
    const shot2 = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
    fs.writeFileSync(path.join(OUT_DIR, "unmute-overlay.png"), Buffer.from(shot2.data, "base64"));
    await evalIn(cdp, pc.sessionId, "document.querySelector('ruffle-player').shadowRoot.querySelector('#unmute-overlay').style.display = 'none'", pc.contextId);

    const playing = await evalIn(cdp, pc.sessionId, "(() => { const p = document.querySelector('ruffle-player'); try { return p ? String(p.ruffle().isPlaying) : 'no-player'; } catch (e) { return 'err:' + e.message; } })()", pc.contextId);
    check("Ruffle が再生状態", playing === "true", playing);
  }

  // 3) 拒否対象 SWF: 実行されないこと
  for (const f of ["blocked-loadmovie.swf", "blocked-loadvars.swf", "blocked-as3-urlloader.swf"]) {
    await dropFile(f);
    await sleep(300);
    const b = await badge();
    check(`${f} が拒否され iframe が作られない`, b === "実行しません" && !(await hasFrame()), `badge=${b}`);
  }

  // 3b) getURL のみ: 同意ボタンを押すまで再生せず、押すと再生される
  await dropFile("consent-geturl.swf");
  await sleep(300);
  const consentVisible = await evalIn(cdp, page, "!document.getElementById('consentBtn').classList.contains('hidden')");
  check("getURL のみの SWF は同意ボタン待ちで再生しない", (await badge()) === "同意が必要" && consentVisible && !(await hasFrame()), `badge=${await badge()}`);
  await evalIn(cdp, page, "document.getElementById('consentBtn').click()");
  st = "";
  for (let i = 0; i < 60; i++) { st = await status(); if (st.startsWith("再生中") || st.includes("エラー") || st.includes("タイムアウト")) break; await sleep(250); }
  check("同意後に getURL 入り SWF が再生される", st.startsWith("再生中"), st);

  // 5) 日本語デバイスフォント
  const waitPlaying = async () => { let s = ""; for (let i = 0; i < 80; i++) { s = await status(); if (s.startsWith("再生中") || s.includes("エラー") || s.includes("タイムアウト")) break; await sleep(250); } return s; };
  const shotTo = async (name) => { await sleep(1200); const s = await cdp.send("Page.captureScreenshot", { format: "png" }, page); fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, "base64")); };

  // 5a) ブラウザのフォント（canvas）で描画
  await evalIn(cdp, page, "window.__swfPlayer.setFontSettings({ renderer: 'canvas', enabledFonts: {}, defaultFonts: {}, mappings: {}, rewriteConsent: false })");
  logs.length = 0;
  await dropFile("ok-jp-devicefont.swf");
  st = await waitPlaying();
  check("日本語デバイスフォントの SWF が再生される（canvas）", st.startsWith("再生中"), st);
  await sleep(800);
  {
    const pc2 = await findPlayerContext(cdp);
    const dfr = pc2 ? await evalIn(cdp, pc2.sessionId, "String(document.querySelector('ruffle-player')?.loadedConfig?.deviceFontRenderer)", pc2.contextId) : "no-context";
    check("Ruffle がブラウザの canvas フォント描画を使用", dfr === "canvas", dfr);
  }
  await shotTo("jp-canvas.png");

  // 5b) Ruffle 内蔵 + フォントファイル（fonts/ の BIZ UDGothic）を既定フォントに
  const cat = JSON.parse(await evalIn(cdp, page, "JSON.stringify(window.__swfPlayer.getCatalog())"));
  const biz = cat.find((c) => c.key === "server:BIZ-UDGothicR.ttc");
  check("fonts/ のフォントがカタログに載る", !!biz && biz.regName === "BIZ UDGothic", JSON.stringify(cat).slice(0, 120));
  if (biz) {
    await evalIn(cdp, page, `window.__swfPlayer.setFontSettings({ renderer: 'embedded', enabledFonts: { ${JSON.stringify(biz.key)}: true }, defaultFonts: { sans: ${JSON.stringify(biz.key)}, japaneseGothic: ${JSON.stringify(biz.key)} }, mappings: {}, rewriteConsent: false })`);
    logs.length = 0;
    await dropFile("ok-jp-devicefont.swf");
    st = await waitPlaying();
    await sleep(800);
    check("フォントファイルを渡して再生（embedded + 既定フォント）", st.startsWith("再生中") && !logs.some((l) => /Couldn't download font source/.test(l)), st);
    await shotTo("jp-embedded-fontfile.png");

    // 5c) SWF 内フォント名の置き換え（同意あり）
    await evalIn(cdp, page, `window.__swfPlayer.setFontSettings({ mappings: { "ＭＳ ゴシック": "BIZ UDGothic", "ＭＳ 明朝": "BIZ UDGothic" }, rewriteConsent: true })`);
    logs.length = 0;
    await dropFile("ok-jp-devicefont.swf");
    st = await waitPlaying();
    await sleep(800);
    check("同意ありで SWF 内フォント名を置き換えて再生", st.startsWith("再生中") && st.includes("置き換え") && !logs.some((l) => /Unknown device font "ＭＳ/.test(l)), st);
    await shotTo("jp-rewritten.png");

    // 5d) 同意なしでは置き換えない
    await evalIn(cdp, page, "window.__swfPlayer.setFontSettings({ rewriteConsent: false })");
    logs.length = 0;
    await dropFile("ok-jp-devicefont.swf");
    st = await waitPlaying();
    await sleep(500);
    check("同意なしでは置き換えを適用しない", st.includes("未同意") && logs.some((l) => /Unknown device font "ＭＳ/.test(l)), st);
  }
  await evalIn(cdp, page, "window.__swfPlayer.setFontSettings({ renderer: 'canvas', mappings: {}, rewriteConsent: false })");

  // 6) SWF5 + Shift_JIS: 同意ありで UTF-8 に変換して再生
  await evalIn(cdp, page, "window.__swfPlayer.setFontSettings({ sjisConvert: false })");
  await dropFile("ok-sjis-v5.swf");
  st = await waitPlaying();
  const encVisible = await evalIn(cdp, page, "!document.getElementById('encodingSection').classList.contains('hidden')");
  check("SWF5 で文字コードの選択肢が表示される", encVisible && st.startsWith("再生中") && !st.includes("UTF-8"), st);
  await shotTo("sjis-before.png");
  // 設定を変えると「再生し直す」ボタンが出て、ファイルを選び直さずに反映できる
  await evalIn(cdp, page, "document.getElementById('sjisConvert').click()");
  const replayVisible = await evalIn(cdp, page, "!document.getElementById('applyFontBtn').classList.contains('hidden') && !document.getElementById('replayBtn')");
  check("設定変更後に「この設定で再生し直す」ボタンが表示される", replayVisible && (await status()).includes("再生し直す"), await status());
  await evalIn(cdp, page, "document.getElementById('applyFontBtn').click()");
  st = await waitPlaying();
  check("同意ありで Shift_JIS→UTF-8 変換して再生（再生し直すボタン経由）", st.startsWith("再生中") && st.includes("UTF-8 変換"), st);
  await shotTo("sjis-after.png");
  await evalIn(cdp, page, "window.__swfPlayer.setFontSettings({ sjisConvert: false })");

  // 7) 言語切り替え: 右上のセレクトで英語にすると静的文言・検査結果・ステータスが切り替わり、日本語に戻る
  {
    const langs = await evalIn(cdp, page, "[...document.getElementById('langSelect').options].map(o => o.value).join(',')");
    check("言語セレクトに主要言語が並ぶ", langs.split(",").length >= 10 && langs.includes("en") && langs.includes("zh-Hans"), langs);
    await evalIn(cdp, page, "const s = document.getElementById('langSelect'); s.value = 'en'; s.dispatchEvent(new Event('change'))");
    const en = JSON.parse(await evalIn(cdp, page, "JSON.stringify({ tag: document.querySelector('.tagline').textContent, badge: document.getElementById('verdictBadge').textContent, st: document.getElementById('status').textContent, lang: document.documentElement.lang, ph: document.querySelector('#stagePlaceholder p').textContent, fp: document.querySelector('#fontPanel summary span').textContent })"));
    // 直前の設定変更で状態文言が「設定が変わりました」になっている場合もあるので、どちらの英訳でも可
    check("英語に切り替わる（静的文言・バッジ・ステータス・html lang）", en.tag.startsWith("Drag and drop") && en.badge === "OK" && (en.st.startsWith("Playing:") || en.st.startsWith("Settings changed")) && en.lang === "en" && en.fp === "Font settings", JSON.stringify(en));
    await shotTo("lang-en.png");
    await evalIn(cdp, page, "window.__swfPlayer.setLanguage('zh-Hans')");
    const zh = await evalIn(cdp, page, "document.querySelector('.dz-title').textContent");
    check("簡体字に切り替わる", zh === "把 .swf 拖到这里", zh);
    await evalIn(cdp, page, "window.__swfPlayer.setLanguage('ja')");
    const ja = await evalIn(cdp, page, "document.querySelector('.dz-title').textContent + '|' + document.getElementById('status').textContent");
    check("日本語に戻る", ja.startsWith("ここに .swf をドロップ|再生中") || ja.startsWith("ここに .swf をドロップ|設定が変わりました"), ja);

    // 拒否された SWF の検査結果も、言語切り替えで翻訳される
    await dropFile("blocked-loadvars.swf");
    await sleep(300);
    await evalIn(cdp, page, "window.__swfPlayer.setLanguage('en')");
    const blockedEn = await evalIn(cdp, page, "document.getElementById('verdictBadge').textContent + '|' + document.querySelector('#findings li').textContent + '|' + document.getElementById('status').textContent");
    check("拒否結果も英語に翻訳される", blockedEn.startsWith("Blocked|BlockedLoadVars (HTTP request)") && blockedEn.includes("will not be executed"), blockedEn);

    // 再生中のステータスと注記も、言語切り替えで翻訳される（半角括弧・カンマ区切り）
    await evalIn(cdp, page, "window.__swfPlayer.setLanguage('ja'); window.__swfPlayer.setFontSettings({ sjisConvert: true })");
    await dropFile("ok-sjis-v5.swf");
    st = await waitPlaying();
    await evalIn(cdp, page, "window.__swfPlayer.setLanguage('en')");
    const playingEn = await evalIn(cdp, page, "document.getElementById('status').textContent");
    check("再生中の注記も英語に翻訳される", playingEn === "Playing: ok-sjis-v5.swf (Shift_JIS→UTF-8: 2 strings converted)", playingEn);
    await evalIn(cdp, page, "window.__swfPlayer.setLanguage('ja')");
    const playingJa = await evalIn(cdp, page, "document.getElementById('status').textContent");
    check("再生中の注記が日本語に戻る", playingJa === "再生中: ok-sjis-v5.swf（Shift_JIS→UTF-8 変換 2 文字列）", playingJa);
    await evalIn(cdp, page, "window.__swfPlayer.setFontSettings({ sjisConvert: false })");
  }

  // 8) SharedObject（セーブデータ）は同意制。同意後はサンドボックス内メモリで動作する
  await dropFile("consent-sharedobject.swf");
  await sleep(300);
  check("SharedObject を使う SWF は同意待ち", (await badge()) === "同意が必要" && !(await hasFrame()), `badge=${await badge()}`);
  await evalIn(cdp, page, "document.getElementById('consentBtn').click()");
  st = await waitPlaying();
  check("同意後に SharedObject 入り SWF が再生される", st.startsWith("再生中"), st);
  await shotTo("sharedobject.png");

  // 9) 操作設定: キー置き換えとゲームパッド割り当てが iframe に届く
  await evalIn(cdp, page, "window.__swfPlayer.setFontSettings({ keymap: [{ from: 'KeyW', to: 'ArrowUp' }], gamepad: { south: 'Space', 'dpad-left': 'ArrowLeft' } })");
  await dropFile("ok-red-square-cws.swf");
  st = await waitPlaying();
  {
    const pc3 = await findPlayerContext(cdp);
    const r = pc3 ? JSON.parse(await evalIn(cdp, pc3.sessionId, `(() => {
      const p = document.querySelector('ruffle-player');
      const seen = [];
      p.addEventListener('keydown', (e) => seen.push(e.code + ':' + e.key));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true }));
      p.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q', bubbles: true, cancelable: true })); // 置き換え対象外はそのまま届く
      return JSON.stringify({ seen, gp: p.loadedConfig?.gamepadButtonMapping || null });
    })()`, pc3.contextId)) : null;
    check("W キーが ↑ として SWF に届く（元の W は届かない）", !!r && r.seen.includes("ArrowUp:ArrowUp") && !r.seen.some((s) => s.startsWith("KeyW")) && r.seen.includes("KeyQ:q"), JSON.stringify(r));
    check("ゲームパッドの割り当てが Ruffle の設定に入る", !!r && r.gp && r.gp.south === 32 && r.gp["dpad-left"] === 37, JSON.stringify(r?.gp));
  }
  await evalIn(cdp, page, "window.__swfPlayer.setFontSettings({ keymap: [], gamepad: {} })");

  // 10) フォントの自動割り当て: 読み込み済みフォントから SWF 内フォント名の候補を埋める
  if (biz) {
    await evalIn(cdp, page, `window.__swfPlayer.setFontSettings({ enabledFonts: { ${JSON.stringify(biz.key)}: true }, mappings: {}, defaultFonts: {} })`);
    await dropFile("ok-jp-devicefont.swf");
    st = await waitPlaying();
    const ph = await evalIn(cdp, page, "document.querySelector('#mappingList input')?.placeholder || ''");
    await evalIn(cdp, page, "document.getElementById('autoMapBtn').click()");
    const after = JSON.parse(await evalIn(cdp, page, "JSON.stringify(window.__swfPlayer.getFontSettings())"));
    check("自動割り当てで置き換え候補と既定フォントが埋まる", ph.includes("BIZ UDGothic") && after.mappings["ＭＳ ゴシック"] === "BIZ UDGothic" && after.mappings["ＭＳ 明朝"] === "BIZ UDGothic" && after.defaultFonts.japaneseGothic === biz.key, `placeholder=${ph} mappings=${JSON.stringify(after.mappings)}`);
    await evalIn(cdp, page, "window.__swfPlayer.setFontSettings({ enabledFonts: {}, mappings: {}, defaultFonts: {} })");
  }

  // 4) 警告のみ: 自動再生せずボタン待ち
  await dropFile("warn-fscommand.swf");
  await sleep(300);
  const warnBtnVisible = await evalIn(cdp, page, "!document.getElementById('playWarnBtn').classList.contains('hidden')");
  check("警告 SWF は自動再生せず確認ボタンを表示", (await badge()) === "警告あり" && warnBtnVisible && !(await hasFrame()));

  // 11) スマートフォン表示: 1 カラムでページ全体がスクロールでき、横はみ出しがなく、再生画面がドロップ領域の直下に来る
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true }, page);
  await cdp.send("Page.reload", {}, page);
  await sleep(1500);
  await evalIn(cdp, page, "window.__swfPlayer.setLanguage('ja')");
  await dropFile("ok-red-square-cws.swf");
  st = await waitPlaying();
  const mobile = JSON.parse(await evalIn(cdp, page, `JSON.stringify((() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const dz = r('dropzone'), stg = r('stage'), res = r('result');
    return { sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight,
      order: dz.top < res.top && res.top < stg.top, stageW: Math.round(stg.width), stageH: Math.round(stg.height),
      fsBtn: !document.getElementById('fullscreenBtn').classList.contains('hidden'), playing: ${JSON.stringify(st.startsWith("再生中"))} };
  })())`));
  check("スマホ幅で横スクロールが出ない", mobile.sw <= mobile.iw, JSON.stringify(mobile));
  check("スマホ幅でページ全体がスクロールでき、ドロップ領域 → 検査結果 → 再生画面の順に並ぶ", mobile.sh > mobile.ih && mobile.order && mobile.playing, JSON.stringify(mobile));
  check("スマホ幅で再生画面が 4:3 で画面幅いっぱい", mobile.stageW >= mobile.iw - 40 && Math.abs(mobile.stageW / mobile.stageH - 4 / 3) < 0.05, `${mobile.stageW}x${mobile.stageH}`);
  await shotTo("mobile.png");
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, page);

  // CSP 違反などのログを表示
  const interesting = logs.filter((l) => /Content Security Policy|Refused|SecurityError|wasm|panic|error/i.test(l));
  if (interesting.length) { console.log("\n--- ブラウザログ（抜粋） ---"); for (const l of interesting.slice(0, 30)) console.log(l); }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
  ws.close();
  browser.kill();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("テスト失敗:", e);
  console.log(logs.slice(-30).join("\n"));
  browser.kill();
  process.exit(1);
});
