// ホストページ: D&D → 静的スキャン → sandbox iframe 内の Ruffle へ受け渡し
import { scanSwf } from "./scanner.js";
import { rewriteFontNames } from "./swfpatch.js";
import { convertLegacyEncoding } from "./swfconvert.js";
import { parseFontNames } from "./fontnames.js";
import { LANGS, t, has, detectLang, setLang, getLang, applyTranslations } from "./i18n.js";

const MAX_SIZE = 256 * 1024 * 1024;
const FONT_EXT_RE = /\.(ttf|otf|ttc)$/i;
const SETTINGS_KEY = "lfp.fontSettings.v1";
const FONT_SLOTS = ["sans", "serif", "typewriter", "japaneseGothic", "japaneseGothicMono", "japaneseMincho"];

const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("fileInput");
const result = $("result");
const verdictBadge = $("verdictBadge");
const fileNameEl = $("fileName");
const infoTable = $("infoTable");
const findingsEl = $("findings");
const playWarnBtn = $("playWarnBtn");
const consentBtn = $("consentBtn");
const stopBtn = $("stopBtn");
const stage = $("stage");
const placeholder = $("stagePlaceholder");
const statusEl = $("status");
const fullscreenBtn = $("fullscreenBtn");
const exitFullBtn = $("exitFullBtn");
const audioHint = $("audioHint");
const langSelect = $("langSelect");
// フォント設定 UI
const fontPanel = $("fontPanel");
const fontSummary = $("fontSummary");
const fontListEl = $("fontList");
const fontInput = $("fontInput");
const fontSlotsEl = $("fontSlots");
const mappingSection = $("mappingSection");
const mappingListEl = $("mappingList");
const rewriteConsent = $("rewriteConsent");
const fontNameOptions = $("fontNameOptions");
const applyFontBtn = $("applyFontBtn");
const applyHint = $("applyHint");
const encodingSection = $("encodingSection");
const encodingHint = $("encodingHint");
const sjisConvert = $("sjisConvert");
const autoMapBtn = $("autoMapBtn");
// 操作設定 UI
const controlSummary = $("controlSummary");
const keymapList = $("keymapList");
const gamepadList = $("gamepadList");

// ---- キー情報（code → 送出する key / Flash のキーコード） ---------------------------
const KEY_INFO = {
  ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40],
  Space: [" ", 32], Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9], Backspace: ["Backspace", 8],
  ShiftLeft: ["Shift", 16], ShiftRight: ["Shift", 16], ControlLeft: ["Control", 17], ControlRight: ["Control", 17],
  AltLeft: ["Alt", 18], AltRight: ["Alt", 18], Insert: ["Insert", 45], Delete: ["Delete", 46], Home: ["Home", 36], End: ["End", 35],
  PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], Comma: [",", 188], Period: [".", 190], Slash: ["/", 191],
  Semicolon: [";", 186], Quote: ["'", 222], BracketLeft: ["[", 219], BracketRight: ["]", 221], Backslash: ["\\", 220],
  Minus: ["-", 189], Equal: ["=", 187], Backquote: ["`", 192],
};
for (let i = 0; i < 26; i++) KEY_INFO[`Key${String.fromCharCode(65 + i)}`] = [String.fromCharCode(97 + i), 65 + i];
for (let i = 0; i < 10; i++) { KEY_INFO[`Digit${i}`] = [String(i), 48 + i]; KEY_INFO[`Numpad${i}`] = [String(i), 96 + i]; }
for (let i = 1; i <= 12; i++) KEY_INFO[`F${i}`] = [`F${i}`, 111 + i];
const KEY_LABEL = { ArrowLeft: "←", ArrowUp: "↑", ArrowRight: "→", ArrowDown: "↓", Space: "Space", ShiftLeft: "Shift (L)", ShiftRight: "Shift (R)", ControlLeft: "Ctrl (L)", ControlRight: "Ctrl (R)", AltLeft: "Alt (L)", AltRight: "Alt (R)" };
const keyLabel = (code) => KEY_LABEL[code] || code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
const GAMEPAD_BUTTONS = ["dpad-up", "dpad-down", "dpad-left", "dpad-right", "south", "east", "west", "north", "left-trigger", "right-trigger", "left-trigger-2", "right-trigger-2", "select", "start"];
const PRESET_WASD = [["KeyW", "ArrowUp"], ["KeyA", "ArrowLeft"], ["KeyS", "ArrowDown"], ["KeyD", "ArrowRight"]];
const PRESET_ZX = [["KeyZ", "Space"], ["KeyX", "Enter"]];
const PRESET_PAD = { "dpad-up": "ArrowUp", "dpad-down": "ArrowDown", "dpad-left": "ArrowLeft", "dpad-right": "ArrowRight", south: "Space", east: "Enter", west: "KeyZ", north: "KeyX", "left-trigger": "ShiftLeft", "right-trigger": "ControlLeft", start: "Enter", select: "Escape" };

let current = null;    // { name, bytes, fonts, version, legacyHighBytes, notes, played, size }
let frame = null;      // 現在の sandbox iframe
let frameReady = null; // iframe の ready を待つ Promise の resolve
let lastStatus = null; // 言語切り替え時に再描画するため { key, params, isError, withNotes }
let lastBadge = null;  // { kind, key }
let lastReport = null; // 直前の検査結果（拒否で current を捨てた後も言語切り替えで再描画できるように）
let lastSize = 0;
let lastNotes = [];    // 再生時の注記 [{ key, params }]（表示時に翻訳する）

// 句読点や区切りは言語に合わせる（CJK は全角、それ以外は半角）
const isCjk = () => /^(ja|zh|ko)/.test(getLang());
const paren = (text) => (isCjk() ? `（${text}）` : ` (${text})`);
const listSep = () => (isCjk() ? "、" : ", ");
const dotSep = () => (isCjk() ? "・" : " · ");
const notesText = () => (lastNotes.length ? paren(lastNotes.map((n) => t(n.key, n.params)).join(listSep())) : "");

// ---- LZMA (ZWS) 用デコーダーの遅延読み込み ---------------------------------
let lzmaPromise = null;
function loadLzma() {
  if (!lzmaPromise) {
    lzmaPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/vendor/lzma-d-min.js";
      s.onload = () => (window.LZMA ? resolve(window.LZMA) : reject(new Error("LZMA init failed")));
      s.onerror = () => reject(new Error("failed to load LZMA decoder"));
      document.head.appendChild(s);
    });
  }
  return lzmaPromise;
}

async function lzmaDecompress(props, data, size) {
  const LZMA = await loadLzma();
  // .lzma 形式（props 5 バイト + 非圧縮サイズ 8 バイト LE + データ）に組み立てる
  const buf = new Uint8Array(13 + data.length);
  buf.set(props, 0);
  let s = size;
  for (let i = 0; i < 8; i++) { buf[5 + i] = s & 0xff; s = Math.floor(s / 256); }
  buf.set(data, 13);
  const out = await new Promise((resolve, reject) => {
    LZMA.decompress(buf, (res, err) => (err ? reject(err) : resolve(res)));
  });
  if (typeof out === "string") return new TextEncoder().encode(out);
  const u8 = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) u8[i] = out[i] & 0xff;
  return u8;
}

// ---- 設定（localStorage） -----------------------------------------------------
const defaultSettings = () => ({
  renderer: "canvas",          // "canvas" | "embedded"
  enabledFonts: {},            // { fontKey: true }
  defaultFonts: {},            // { slot: fontKey }
  mappings: {},                // { SWF 内のフォント名: 置き換え先の名前 }
  rewriteConsent: false,
  sjisConvert: false,          // SWF5 以前の Shift_JIS 文字列を UTF-8 に変換する（同意）
  keymap: [],                  // [{ from: "KeyW", to: "ArrowUp" }] 物理キー(code)の置き換え
  gamepad: {},                 // { "south": "Space", ... } ゲームパッドのボタン → キー(code)
});
let settings = defaultSettings();
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...defaultSettings(), ...JSON.parse(raw) };
  } catch { settings = defaultSettings(); }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

// ---- フォント保存（IndexedDB：ドロップされたフォント） ----------------------------
function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("lfp", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("fonts", { keyPath: "fileName" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbAll() {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const rq = db.transaction("fonts").objectStore("fonts").getAll();
      rq.onsuccess = () => resolve(rq.result || []);
      rq.onerror = () => reject(rq.error);
    });
  } catch { return []; }
}
async function idbPut(rec) {
  const db = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("fonts", "readwrite");
    tx.objectStore("fonts").put(rec);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDelete(fileName) {
  const db = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("fonts", "readwrite");
    tx.objectStore("fonts").delete(fileName);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---- フォントカタログ ------------------------------------------------------------
// { key, source: "server"|"user", fileName, bytes: ArrayBuffer, families: string[], regName: string }
let catalog = [];

async function refreshCatalog() {
  const entries = [];
  try {
    const res = await fetch("/fonts.json", { cache: "no-store" });
    const { fonts } = await res.json();
    for (const item of fonts) {
      // サーバーはファミリー名を解析済みで返す。フォント本体は有効にして再生するときに初めて取得する
      if (item && typeof item === "object" && Array.isArray(item.families)) {
        entries.push({ key: `server:${item.file}`, source: "server", fileName: item.file, bytes: null, families: item.families, regName: item.families[0] || "" });
      } else if (typeof item === "string") {
        // 旧形式（ファイル名のみ）への互換
        try {
          const r = await fetch(`/fonts/${encodeURIComponent(item)}`);
          if (r.ok) entries.push(makeEntry("server", item, await r.arrayBuffer()));
        } catch { /* skip */ }
      }
    }
  } catch { /* サーバー一覧なし */ }
  for (const rec of await idbAll()) {
    if (rec?.bytes instanceof ArrayBuffer) entries.push(makeEntry("user", rec.fileName, rec.bytes));
  }
  catalog = entries;
  renderFontPanel();
}

function makeEntry(source, fileName, bytes) {
  const names = parseFontNames(bytes);
  return { key: `${source}:${fileName}`, source, fileName, bytes, families: names.families, regName: names.families[0] || "" };
}

function enabledEntries() { return catalog.filter((e) => settings.enabledFonts[e.key] && e.regName); }

// サーバーのフォント本体を必要になったときだけ取得する（取得後はメモリに保持）
async function ensureFontBytes(e) {
  if (e.bytes) return e.bytes;
  const r = await fetch(`/fonts/${encodeURIComponent(e.fileName)}`);
  if (!r.ok) throw new Error(`font ${e.fileName}: HTTP ${r.status}`);
  e.bytes = await r.arrayBuffer();
  return e.bytes;
}

async function addUserFont(file) {
  const bytes = await file.arrayBuffer();
  const names = parseFontNames(bytes);
  if (!names.families.length) { setStatus("st.fontBad", { name: file.name }, true); return; }
  await idbPut({ fileName: file.name, bytes, added: Date.now() });
  catalog = catalog.filter((e) => e.key !== `user:${file.name}`);
  catalog.push(makeEntry("user", file.name, bytes));
  settings.enabledFonts[`user:${file.name}`] = true;
  saveSettings();
  renderFontPanel();
  setStatus("st.fontAdded", { name: names.families[0] });
}

async function removeUserFont(entry) {
  await idbDelete(entry.fileName);
  catalog = catalog.filter((e) => e.key !== entry.key);
  delete settings.enabledFonts[entry.key];
  for (const [slot, key] of Object.entries(settings.defaultFonts)) if (key === entry.key) delete settings.defaultFonts[slot];
  saveSettings();
  renderFontPanel();
}

// 再生時に iframe へ渡すフォント設定
async function buildFontConfig() {
  const fonts = [];
  for (const e of enabledEntries()) {
    try {
      const bytes = await ensureFontBytes(e);
      fonts.push({ name: e.regName, data: bytes.slice(0) });
    } catch (err) {
      console.warn("font unavailable:", err);
    }
  }
  const defaultFonts = {};
  for (const slot of FONT_SLOTS) {
    const key = settings.defaultFonts[slot];
    const e = key && catalog.find((x) => x.key === key && settings.enabledFonts[x.key]);
    if (e) defaultFonts[slot] = e.families;
  }
  // キー置き換え / ゲームパッド（iframe 側で適用）
  const keymap = (settings.keymap || [])
    .filter((r) => r && KEY_INFO[r.from] && KEY_INFO[r.to] && r.from !== r.to)
    .map((r) => ({ from: r.from, toCode: r.to, toKey: KEY_INFO[r.to][0] }));
  const gamepadButtonMapping = {};
  for (const [btn, code] of Object.entries(settings.gamepad || {})) {
    if (GAMEPAD_BUTTONS.includes(btn) && KEY_INFO[code]) gamepadButtonMapping[btn] = KEY_INFO[code][1];
  }
  return { renderer: settings.renderer === "embedded" ? "embedded" : "canvas", fonts, defaultFonts, keymap, gamepadButtonMapping };
}

// ---- フォントの自動割り当て ------------------------------------------------------
const RE_MONO = /等幅|monospace|\bmono\b|courier|consolas|typewriter|gothic mono|ゴシック等幅/i;
const RE_MINCHO = /明朝|mincho|serif|times|georgia|宋体|宋體|\bming\b|batang|바탕/i;
const RE_GOTHIC = /ゴシック|ｺﾞｼｯｸ|gothic|黒体|黑体|meiryo|メイリオ|arial|helvetica|verdana|tahoma|segoe|dotum|돋움|gulim|굴림|sans/i;
const normalizeName = (s) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
function fontCategory(name) {
  if (RE_MONO.test(name)) return "mono";
  if (RE_MINCHO.test(name)) return "mincho";
  if (RE_GOTHIC.test(name)) return "gothic";
  return "sans";
}
function fontForCategory(cat) {
  const enabled = enabledEntries();
  const re = cat === "mincho" ? RE_MINCHO : cat === "mono" ? RE_MONO : RE_GOTHIC;
  return enabled.find((e) => e.families.some((f) => re.test(f)))
    || (cat === "mincho" ? null : enabled.find((e) => !e.families.some((f) => RE_MINCHO.test(f))))
    || enabled[0] || null;
}
// SWF 内のフォント名に対する置き換え候補（読み込み済みフォントの別名に一致すればそれ、なければ種別で選ぶ）
function suggestMapping(name) {
  const n = normalizeName(name);
  const exact = enabledEntries().find((e) => e.families.some((f) => normalizeName(f) === n));
  if (exact) return exact.regName;
  const e = fontForCategory(fontCategory(name));
  return e ? e.regName : null;
}
function autoAssignFonts() {
  if (!enabledEntries().length) { setStatus("fp.autoMapNone"); return; }
  let n = 0;
  for (const name of deviceFontNames(current?.fonts || [])) {
    if (settings.mappings[name]) continue;
    const s = suggestMapping(name);
    if (s && s !== name) { settings.mappings[name] = s; n++; }
  }
  const slotCat = { sans: "gothic", serif: "mincho", typewriter: "mono", japaneseGothic: "gothic", japaneseGothicMono: "mono", japaneseMincho: "mincho" };
  for (const [slot, cat] of Object.entries(slotCat)) {
    if (settings.defaultFonts[slot]) continue;
    const e = fontForCategory(cat);
    if (e) { settings.defaultFonts[slot] = e.key; n++; }
  }
  saveSettings();
  renderFontPanel();
  setStatus("fp.autoMapDone", { n });
  markSettingsChanged();
}

// ---- 操作設定 UI（キー置き換え / ゲームパッド） --------------------------------------
// キーを押して割り当てる入力欄
function keyCaptureInput(value, onSet) {
  const input = el("input", { type: "text", class: "keycap", readonly: "", value: value ? keyLabel(value) : "", placeholder: t("ctl.unassigned") });
  input.addEventListener("focus", () => { input.placeholder = t("ctl.pressKey"); input.value = ""; });
  input.addEventListener("blur", () => { input.placeholder = t("ctl.unassigned"); input.value = value ? keyLabel(value) : ""; });
  input.addEventListener("keydown", (e) => {
    e.preventDefault();
    if (!KEY_INFO[e.code]) return;
    value = e.code;
    input.value = keyLabel(value);
    input.blur();
    onSet(value);
  });
  return input;
}

function renderControlPanel() {
  const rows = settings.keymap || [];
  keymapList.replaceChildren(
    el("div", { class: "keyhead" }, el("span", {}, t("ctl.from")), el("span", {}, t("ctl.to")), el("span", {})),
    ...rows.map((row, i) => el("div", { class: "keyrow" },
      keyCaptureInput(row.from, (v) => { settings.keymap[i].from = v; saveSettings(); updateControlSummary(); markSettingsChanged(); }),
      keyCaptureInput(row.to, (v) => { settings.keymap[i].to = v; saveSettings(); updateControlSummary(); markSettingsChanged(); }),
      el("button", { class: "linkbtn", type: "button", onclick: () => { settings.keymap.splice(i, 1); saveSettings(); renderControlPanel(); markSettingsChanged(); } }, t("ctl.remove")),
    )),
  );
  gamepadList.replaceChildren(...GAMEPAD_BUTTONS.map((btn) => el("label", { class: "slot" },
    el("span", {}, t(`gp.${btn}`)),
    keyCaptureInput(settings.gamepad?.[btn] || "", (v) => { settings.gamepad[btn] = v; saveSettings(); updateControlSummary(); markSettingsChanged(); }),
  )));
  updateControlSummary();
}

function updateControlSummary() {
  const keys = (settings.keymap || []).filter((r) => r.from && r.to).length;
  const pad = Object.values(settings.gamepad || {}).filter(Boolean).length;
  controlSummary.textContent = [t("ctl.summaryKeys", { n: keys }), t("ctl.summaryPad", { n: pad })].join(dotSep());
}

// 現在の SWF に適用する置き換え表
function currentMapping() {
  const out = {};
  if (!current?.fonts) return out;
  for (const name of deviceFontNames(current.fonts)) {
    const to = settings.mappings[name];
    if (to && to.trim() && to.trim() !== name) out[name] = to.trim();
  }
  return out;
}

function deviceFontNames(fonts) {
  return [...new Set(fonts.filter((f) => f.device && f.name).map((f) => f.name))];
}

// ---- フォント設定 UI -----------------------------------------------------------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled") n[k] = !!v;
    else n.setAttribute(k, v);
  }
  n.append(...children);
  return n;
}

function renderFontPanel() {
  // 描画方法
  for (const r of document.querySelectorAll("input[name=renderer]")) r.checked = r.value === settings.renderer;

  // フォントファイル一覧
  fontListEl.replaceChildren(...catalog.map((e) => {
    const cb = el("input", { type: "checkbox", checked: !!settings.enabledFonts[e.key], onchange: () => {
      if (cb.checked) settings.enabledFonts[e.key] = true; else delete settings.enabledFonts[e.key];
      saveSettings(); renderFontPanel(); markSettingsChanged();
    } });
    const li = el("li", {},
      el("label", {}, cb, " ", el("b", {}, e.regName || t("fp.unknownName")),
        el("span", { class: "muted" }, ` ${e.fileName}${e.source === "server" ? t("fp.serverTag") : ""}`),
        e.families.length > 1 ? el("span", { class: "muted small" }, ` ${t("fp.aliases", { names: e.families.slice(1).join(", ") })}`) : ""),
    );
    if (e.source === "user") li.append(el("button", { class: "linkbtn", type: "button", onclick: () => removeUserFont(e) }, t("btn.delete")));
    return li;
  }));
  if (!catalog.length) fontListEl.append(el("li", { class: "muted" }, t("fp.noFonts")));

  // 既定フォント
  const enabled = enabledEntries();
  fontSlotsEl.replaceChildren(...FONT_SLOTS.map((slot) => {
    const sel = el("select", { onchange: () => {
      if (sel.value) settings.defaultFonts[slot] = sel.value; else delete settings.defaultFonts[slot];
      saveSettings(); markSettingsChanged();
    } }, el("option", { value: "" }, t("fp.unset")));
    for (const e of enabled) sel.append(el("option", { value: e.key }, e.regName));
    sel.value = settings.defaultFonts[slot] && enabled.some((e) => e.key === settings.defaultFonts[slot]) ? settings.defaultFonts[slot] : "";
    return el("label", { class: "slot" }, el("span", {}, t(`slot.${slot}`)), sel);
  }));

  // 置き換え候補（datalist）
  fontNameOptions.replaceChildren(
    ...enabled.map((e) => el("option", { value: e.regName })),
    ...["_sans", "_serif", "_typewriter", "_ゴシック", "_等幅", "_明朝"].map((v) => el("option", { value: v })),
  );

  // この SWF のフォント置き換え
  const names = current?.fonts ? deviceFontNames(current.fonts) : [];
  mappingSection.classList.toggle("hidden", !names.length);
  mappingListEl.replaceChildren(...names.map((name) => {
    const suggestion = enabledEntries().length ? suggestMapping(name) : null;
    const placeholder = suggestion && suggestion !== name ? t("fp.suggest", { name: suggestion }) : t("fp.mappingPlaceholder");
    const input = el("input", { type: "text", list: "fontNameOptions", placeholder, value: settings.mappings[name] || "", onchange: () => {
      if (input.value.trim()) settings.mappings[name] = input.value.trim(); else delete settings.mappings[name];
      saveSettings(); markSettingsChanged();
    } });
    return el("label", { class: "slot" }, el("span", { title: name }, name), input);
  }));
  rewriteConsent.checked = !!settings.rewriteConsent;

  // 文字コード（SWF5 以前のみ）
  const legacy = current && current.version < 6;
  encodingSection.classList.toggle("hidden", !legacy);
  if (legacy) {
    encodingHint.textContent = current.legacyHighBytes > 0
      ? t("fp.encodingSjis", { version: current.version, bytes: current.legacyHighBytes })
      : t("fp.encodingNone", { version: current.version });
    if (current.legacyHighBytes > 0) fontPanel.open = true;
  }
  sjisConvert.checked = !!settings.sjisConvert;
  updateFontSummary();
}

// 再生に影響する設定が変わったら「再生し直す」導線を出す（同じファイルを選び直さなくて済むように）
function markSettingsChanged() {
  updateFontSummary();
  if (!current || !current.played) return;
  applyFontBtn.classList.remove("hidden");
  applyFontBtn.classList.add("attention");
  applyHint.textContent = t("fp.applyHint");
  setStatus("st.changed");
}

function updateReplayButtons() {
  const show = !!(current && current.played);
  applyFontBtn.classList.toggle("hidden", !show);
  applyFontBtn.classList.remove("attention");
  applyHint.textContent = "";
}

function updateFontSummary() {
  const parts = [t(settings.renderer === "canvas" ? "fp.rendererCanvasShort" : "fp.rendererEmbeddedShort"), t("fp.loaded", { n: enabledEntries().length })];
  const m = Object.keys(currentMapping()).length;
  if (m) parts.push(t("fp.mapped", { n: m }));
  if (current && current.version < 6 && settings.sjisConvert) parts.push(t("fp.sjisShort"));
  fontSummary.textContent = parts.join(dotSep());
}

// ---- UI ヘルパー -------------------------------------------------------------
// setStatus(key, params, isError, withNotes) — withNotes のとき再生時の注記を後ろに付ける
function setStatus(key, params = null, isError = false, withNotes = false) {
  lastStatus = { key, params, isError, withNotes };
  statusEl.textContent = key ? t(key, params) + (withNotes ? notesText() : "") : "";
  statusEl.title = statusEl.textContent;
  statusEl.classList.toggle("error", isError);
}

function setBadge(kind, key) {
  lastBadge = { kind, key };
  verdictBadge.className = `badge ${kind}`;
  verdictBadge.textContent = t(key);
}

function renderInfo(info, size) {
  const device = deviceFontNames(info.fonts || []);
  const embedded = (info.fonts || []).filter((f) => !f.device).length;
  const compression = info.compression === "none" ? t("val.none") : info.compression === "zlib" ? "zlib" : info.compression === "lzma" ? "LZMA" : "-";
  const rows = [
    ["info.size", `${(size / 1024).toFixed(1)} KB`],
    ["info.compression", compression],
    ["info.version", info.version ?? "-"],
    ["info.stage", info.width != null ? `${info.width} × ${info.height} px` : "-"],
    ["info.frames", info.frameCount != null ? `${info.frameCount} @ ${Number(info.frameRate).toFixed(2)} fps` : "-"],
    ["info.script", [info.avm1 && "AVM1 (AS1/2)", info.avm2 && "AVM2 (AS3)"].filter(Boolean).join(", ") || t("val.scriptNone")],
    ["info.fonts", `${device.length ? t("val.device", { names: device.join(", ") }) : t("val.noDeviceFonts")}${embedded ? t("val.embedded", { n: embedded }) : ""}`],
    ["info.tags", info.tagCount ?? "-"],
  ];
  infoTable.replaceChildren(...rows.map(([k, v]) => {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td"); td1.textContent = t(k);
    const td2 = document.createElement("td"); td2.textContent = String(v);
    tr.append(td1, td2);
    return tr;
  }));
}

// 検出結果の文言を現在の言語で組み立てる（キーがなければスキャナーの日本語メッセージ）
function findingText(f) {
  if (f.key && has(f.key)) {
    const params = { ...(f.params || {}) };
    if (params.cat) params.cat = t(`cat.${params.cat}`);
    return t(f.key, params);
  }
  return f.message;
}

function renderFindings(findings) {
  const order = { block: 0, consent: 1, warn: 2, info: 3 };
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
  findingsEl.replaceChildren(...sorted.map((f) => {
    const li = document.createElement("li");
    li.className = f.level;
    const lvl = document.createElement("span");
    lvl.className = "lvl";
    lvl.textContent = t(`level.${f.level}`);
    const msg = document.createElement("span");
    msg.textContent = findingText(f) + (f.count > 1 ? t("findings.count", { n: f.count }) : "");
    const where = document.createElement("span");
    where.className = "where";
    where.textContent = f.where;
    li.append(lvl, msg, where);
    return li;
  }));
  if (!findings.length) {
    const li = document.createElement("li");
    li.className = "info";
    li.textContent = t("findings.none");
    findingsEl.append(li);
  }
}

// 言語切り替え時に、表示中の内容をすべて描き直す
function rerenderAll() {
  applyTranslations();
  if (lastReport) {
    if (lastReport.info) renderInfo(lastReport.info, lastSize);
    renderFindings(lastReport.findings);
  }
  if (lastBadge) setBadge(lastBadge.kind, lastBadge.key);
  if (lastStatus) setStatus(lastStatus.key, lastStatus.params, lastStatus.isError, lastStatus.withNotes);
  renderFontPanel();
  renderControlPanel();
  if (applyFontBtn.classList.contains("attention")) applyHint.textContent = t("fp.applyHint");
  if (frame) frame.contentWindow?.postMessage({ type: "lang", lang: getLang() }, "*");
}

// ---- プレイヤー iframe ------------------------------------------------------
function destroyFrame() {
  if (frame) {
    frame.remove();
    frame = null;
  }
  frameReady = null;
  placeholder.classList.remove("hidden");
  stopBtn.classList.add("hidden");
  fullscreenBtn.classList.add("hidden");
  audioHint.classList.add("hidden");
  setPseudoFullscreen(false);
}

// 擬似全画面（再生画面を fixed で画面いっぱいに。Fullscreen API 非対応の iPhone Safari などで使う）
function setPseudoFullscreen(on) {
  stage.classList.toggle("pseudo-full", on);
  document.body.classList.toggle("pseudo-full", on);
}

function createFrame() {
  destroyFrame();
  const f = document.createElement("iframe");
  // allow-same-origin を付けないことで opaque origin になり、Cookie / localStorage に触れない
  f.setAttribute("sandbox", "allow-scripts");
  f.setAttribute("allow", "autoplay; fullscreen");
  f.setAttribute("referrerpolicy", "no-referrer");
  f.setAttribute("title", "Flash player (sandboxed)");
  f.src = `/player.html?lang=${encodeURIComponent(getLang())}`;
  const ready = new Promise((resolve) => { frameReady = resolve; });
  stage.append(f);
  frame = f;
  placeholder.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  fullscreenBtn.classList.remove("hidden"); // API が無い環境では擬似全画面にフォールバックする
  return ready;
}

window.addEventListener("message", (e) => {
  if (!frame || e.source !== frame.contentWindow) return; // 自分の iframe 以外は無視
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "ready":
      frameReady?.();
      break;
    case "loaded":
      setStatus("st.playing", { name: current?.name ?? "" }, false, true);
      if (layoutMode === "mobile") stage.scrollIntoView({ block: "nearest", behavior: "smooth" });
      break;
    case "error":
      setStatus("st.playError", { msg: String(msg.message).slice(0, 300) }, true);
      break;
    case "audio":
      // 音声コンテキストが suspended の間は、再生画面をタップするよう案内する
      audioHint.textContent = t(navigator.maxTouchPoints > 0 ? "st.audioSuspendedTouch" : "st.audioSuspended");
      audioHint.classList.toggle("hidden", !msg.suspended);
      break;
    default:
      break;
  }
});

async function play() {
  if (!current) return;
  setStatus("st.preparing");

  let data = current.bytes;
  const notes = []; // [{ key, params }]（表示時に現在の言語で翻訳）

  // 文字コード変換（SWF5 以前 + 同意がある場合のみ。メモリ上のコピーに対して行う）
  if (current.version < 6 && settings.sjisConvert) {
    try {
      const r = await convertLegacyEncoding(data, { lzmaDecompress });
      data = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
      notes.push({ key: "note.sjis", params: { n: r.stats.strings } });
      if (r.stats.actionBlocksFailed) notes.push({ key: "note.sjisFailed", params: { n: r.stats.actionBlocksFailed } });
    } catch (e) {
      setStatus("st.convertFailed", { msg: e.message }, true);
      return;
    }
  }

  // フォント名の置き換え（同意がある場合のみ）
  const mapping = currentMapping();
  if (Object.keys(mapping).length) {
    if (settings.rewriteConsent) {
      try {
        const r = await rewriteFontNames(data, mapping, { lzmaDecompress });
        data = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
        notes.push({ key: "note.rewrite", params: { n: r.replaced } });
      } catch (e) {
        setStatus("st.rewriteFailed", { msg: e.message }, true);
        return;
      }
    } else {
      notes.push({ key: "note.rewriteNoConsent", params: {} });
    }
  }
  lastNotes = notes;
  current.played = true;
  updateReplayButtons();

  const ready = createFrame();
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000));
  try {
    await Promise.race([ready, timeout]);
  } catch {
    setStatus("st.timeout", null, true);
    return;
  }
  const copy = data.slice(0);
  const fontConfig = await buildFontConfig();
  if (!frame) return; // 取得中に停止された
  const transfer = [copy, ...fontConfig.fonts.map((f) => f.data)];
  frame.contentWindow.postMessage({ type: "play", name: current.name, data: copy, fontConfig }, "*", transfer);
  setStatus("st.loading");
}

// ---- ファイル処理 -------------------------------------------------------------
async function handleFile(file) {
  if (!file) return;
  destroyFrame();
  playWarnBtn.classList.add("hidden");
  consentBtn.classList.add("hidden");
  current = null;
  updateReplayButtons();
  result.classList.remove("hidden");
  fileNameEl.textContent = file.name;
  setBadge("busy", "badge.scanning");
  infoTable.replaceChildren();
  findingsEl.replaceChildren();
  setStatus(null);

  lastNotes = [];
  if (file.size > MAX_SIZE) {
    setBadge("block", "badge.block");
    lastReport = { info: null, findings: [{ level: "block", message: "", key: "f.tooLarge", params: {}, where: "main", count: 1 }] };
    lastSize = file.size;
    renderFindings(lastReport.findings);
    return;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const report = await scanSwf(bytes, { lzmaDecompress });
  lastReport = report;
  lastSize = file.size;
  renderInfo(report.info, file.size);
  renderFindings(report.findings);
  current = { name: file.name, bytes: bytes.buffer, fonts: report.info.fonts || [], size: file.size,
    version: report.info.version ?? 99, legacyHighBytes: report.info.legacyHighBytes || 0 };
  renderFontPanel();

  if (report.verdict === "block") {
    setBadge("block", "badge.block");
    setStatus("st.blocked");
    current = null;
    renderFontPanel();
    return;
  }
  if (report.verdict === "consent") {
    setBadge("consent", "badge.consent");
    consentBtn.classList.remove("hidden");
    setStatus("st.consent");
    return;
  }
  if (report.verdict === "warn") {
    setBadge("warn", "badge.warn");
    playWarnBtn.classList.remove("hidden");
    setStatus("st.warn");
    return;
  }
  setBadge("allow", "badge.allow");
  await play();
}

async function handleDroppedFiles(files) {
  const list = [...(files ?? [])];
  const fonts = list.filter((f) => FONT_EXT_RE.test(f.name));
  for (const f of fonts) await addUserFont(f);
  const swf = list.find((f) => /\.swf$/i.test(f.name)) || list.find((f) => !FONT_EXT_RE.test(f.name));
  if (swf) await handleFile(swf);
}

// ---- レイアウト（PC は 2 カラム、スマホは 1 カラム） -----------------------------------
// スマホでは「ファイルを選択」の直下に検査結果、その下に再生画面が来るよう DOM を並べ替える。
// （display: contents + order は Safari で挙動が不安定なため使わない）
const layoutEl = document.querySelector(".layout");
const leftEl = document.querySelector(".left");
const rightEl = document.querySelector(".right");
const mobileMq = window.matchMedia("(max-width: 900px)");
let layoutMode = null;
function applyLayout() {
  const mode = mobileMq.matches ? "mobile" : "desktop";
  if (mode === layoutMode) return;
  layoutMode = mode;
  const g = (id) => $(id);
  if (mode === "mobile") {
    layoutEl.append(g("dropzone"), g("result"), g("stage"), g("stagebar"), g("audioHint"), g("fontPanel"), g("controlPanel"), g("policyPanel"));
    leftEl.hidden = true; rightEl.hidden = true;
  } else {
    leftEl.append(g("dropzone"), g("result"), g("fontPanel"), g("controlPanel"), g("policyPanel"));
    rightEl.append(g("stage"), g("stagebar"), g("audioHint"));
    leftEl.hidden = false; rightEl.hidden = false;
  }
}
mobileMq.addEventListener("change", applyLayout);
applyLayout();

// ---- 言語 -----------------------------------------------------------------------
function initLanguage() {
  langSelect.replaceChildren(...LANGS.map(([code, label]) => el("option", { value: code }, label)));
  setLang(detectLang());
  langSelect.value = getLang();
  applyTranslations();
  document.documentElement.classList.remove("i18n-pending"); // 翻訳が終わってから表示（日本語が一瞬見えるのを防ぐ）
  langSelect.addEventListener("change", () => { setLang(langSelect.value); rerenderAll(); });
}

// ---- イベント -----------------------------------------------------------------
["dragenter", "dragover"].forEach((ev) => {
  document.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); });
});
["dragleave", "drop"].forEach((ev) => {
  document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) dropzone.classList.remove("over"); });
});
document.addEventListener("drop", (e) => {
  handleDroppedFiles(e.dataTransfer?.files).catch((err) => setStatus("st.error", { msg: err.message }, true));
});
// 「ファイルを選択」ラベル（中に input がある）のクリックはブラウザが自動でピッカーを開く。
// そのクリックはここにもバブルしてくるので、二重に fileInput.click() しない（Safari ではピッカーがキャンセルされる）
dropzone.addEventListener("click", (e) => { if (e.target.closest("label, input")) return; fileInput.click(); });
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) handleFile(file).catch((err) => setStatus("st.error", { msg: err.message }, true));
});
fontInput.addEventListener("change", async () => {
  const files = [...(fontInput.files ?? [])];
  fontInput.value = "";
  for (const f of files) await addUserFont(f).catch((err) => setStatus("st.error", { msg: err.message }, true));
});
for (const r of document.querySelectorAll("input[name=renderer]")) {
  r.addEventListener("change", () => { if (r.checked) { settings.renderer = r.value; saveSettings(); markSettingsChanged(); } });
}
rewriteConsent.addEventListener("change", () => { settings.rewriteConsent = rewriteConsent.checked; saveSettings(); markSettingsChanged(); });
sjisConvert.addEventListener("change", () => { settings.sjisConvert = sjisConvert.checked; saveSettings(); markSettingsChanged(); });
const replay = () => { if (current && current.played) play().catch((err) => setStatus("st.error", { msg: err.message }, true)); };
applyFontBtn.addEventListener("click", replay);
autoMapBtn.addEventListener("click", autoAssignFonts);
$("keymapAdd").addEventListener("click", () => { settings.keymap.push({ from: "", to: "" }); saveSettings(); renderControlPanel(); });
const applyKeyPreset = (preset) => {
  for (const [from, to] of preset) {
    const existing = settings.keymap.find((r) => r.from === from);
    if (existing) existing.to = to; else settings.keymap.push({ from, to });
  }
  saveSettings(); renderControlPanel(); markSettingsChanged();
};
$("presetWasd").addEventListener("click", () => applyKeyPreset(PRESET_WASD));
$("presetZx").addEventListener("click", () => applyKeyPreset(PRESET_ZX));
$("clearKeys").addEventListener("click", () => { settings.keymap = []; saveSettings(); renderControlPanel(); markSettingsChanged(); });
$("presetPad").addEventListener("click", () => { settings.gamepad = { ...PRESET_PAD }; saveSettings(); renderControlPanel(); markSettingsChanged(); });
$("clearPad").addEventListener("click", () => { settings.gamepad = {}; saveSettings(); renderControlPanel(); markSettingsChanged(); });
playWarnBtn.addEventListener("click", () => { playWarnBtn.classList.add("hidden"); play(); });
consentBtn.addEventListener("click", () => { consentBtn.classList.add("hidden"); play(); });
stopBtn.addEventListener("click", () => { destroyFrame(); setStatus("st.stopped"); });
fullscreenBtn.addEventListener("click", () => {
  if (!frame) return;
  const canNative = (document.fullscreenEnabled || document.webkitFullscreenEnabled) && (frame.requestFullscreen || frame.webkitRequestFullscreen);
  if (canNative) {
    const req = frame.requestFullscreen || frame.webkitRequestFullscreen;
    let p = null;
    try { p = req.call(frame); } catch { p = Promise.reject(); }
    Promise.resolve(p).catch(() => setPseudoFullscreen(true));
  } else {
    setPseudoFullscreen(true);
  }
});
exitFullBtn.addEventListener("click", () => setPseudoFullscreen(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && stage.classList.contains("pseudo-full")) setPseudoFullscreen(false); });

// iOS Safari は accept の拡張子指定（.swf / .ttf など）を解釈できず、該当ファイルがグレーアウトして選べない。
// iOS ではフィルターを外し、中身はスキャナー（シグネチャ検査）とフォント名の解析で判定する
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (isIOS) { fileInput.removeAttribute("accept"); fontInput.removeAttribute("accept"); }

// iOS 17+ / Safari 17+: ページの音声セッションを「再生」にして、サイレントスイッチの影響を受けないようにする
try { if ("audioSession" in navigator) navigator.audioSession.type = "playback"; } catch { /* ignore */ }

initLanguage();
loadSettings();
if (!Array.isArray(settings.keymap)) settings.keymap = [];
if (!settings.gamepad || typeof settings.gamepad !== "object") settings.gamepad = {};
renderControlPanel();
refreshCatalog();

// テスト用フック（ブラウザ自動テストから利用）。ローカルで動かしているときだけ公開する
const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
if (isLocalHost || new URLSearchParams(location.search).has("test")) window.__swfPlayer = {
  handleFile, scanSwf, play, replay,
  getFontSettings: () => JSON.parse(JSON.stringify(settings)),
  setFontSettings: (partial) => { settings = { ...settings, ...partial }; saveSettings(); renderFontPanel(); renderControlPanel(); markSettingsChanged(); },
  autoAssignFonts,
  getCatalog: () => catalog.map((e) => ({ key: e.key, regName: e.regName, families: e.families })),
  refreshCatalog,
  setLanguage: (code) => { setLang(code); langSelect.value = getLang(); rerenderAll(); },
  getLanguage: getLang,
};
