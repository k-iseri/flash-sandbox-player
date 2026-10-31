// スキャナーのテスト: 合成した SWF に対する判定を確認する
//   node test/scanner.test.js
import { createRequire } from "node:module";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSwf } from "../public/scanner.js";
import { rewriteFontNames } from "../public/swfpatch.js";
import { convertLegacyEncoding, _internal as conv } from "../public/swfconvert.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- バイト列ヘルパー -----------------------------------------------------------
const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const cstr = (s) => [...Buffer.from(s, "latin1"), 0];

class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  ub(v, n) { for (let i = n - 1; i >= 0; i--) { this.cur = (this.cur << 1) | ((v >> i) & 1); if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } } }
  sb(v, n) { this.ub(v < 0 ? (v + 2 ** n) : v, n); }
  align() { if (this.n) { this.cur <<= (8 - this.n); this.bytes.push(this.cur); this.cur = 0; this.n = 0; } return this.bytes; }
}

function tag(code, body) {
  const b = Array.from(body);
  if (b.length < 0x3f) return [...u16((code << 6) | b.length), ...b];
  return [...u16((code << 6) | 0x3f), ...u32(b.length), ...b];
}

const RECT_550x400 = [0x78, 0x00, 0x05, 0x5f, 0x00, 0x00, 0x0f, 0xa0, 0x00];

function buildSwf(tags, { version = 8, compress = "none" } = {}) {
  const body = [...RECT_550x400, ...u16(12 << 8), ...u16(1), ...tags.flat(), ...tag(0, [])];
  const total = 8 + body.length;
  if (compress === "none") return Uint8Array.from([...Buffer.from("FWS"), version, ...u32(total), ...body]);
  if (compress === "zlib") {
    const z = zlib.deflateSync(Buffer.from(body));
    return Uint8Array.from([...Buffer.from("CWS"), version, ...u32(total), ...z]);
  }
  if (compress === "lzma") {
    const { LZMA } = require("lzma/src/lzma-c-min.js");
    const out = LZMA.compress(body, 1); // .lzma 形式: props(5) + size(8) + data
    const props = out.slice(0, 5), data = out.slice(13);
    return Uint8Array.from([...Buffer.from("ZWS"), version, ...u32(total), ...u32(data.length + 5), ...props, ...data.map((x) => x & 0xff)]);
  }
  throw new Error("unknown compress");
}

// ---- 各種タグ ---------------------------------------------------------------------
const setBg = (r, g, b) => tag(9, [r, g, b]);
const showFrame = () => tag(1, []);
const fileAttrs = (flags) => tag(69, u32(flags));

function defineShapeRect(id = 1) {
  const w = new BitWriter();
  // fill styles
  const head = [...u16(id), ...RECT_550x400, 1, 0x00, 255, 0, 0, 0];
  w.ub(1, 4); w.ub(0, 4);                       // NumFillBits=1, NumLineBits=0
  w.ub(0, 1); w.ub(0b00011, 5);                 // StyleChange: FillStyle0 + MoveTo
  w.ub(1, 5); w.sb(0, 1); w.sb(0, 1);           // MoveBits=1, (0,0)
  w.ub(1, 1);                                   // FillStyle0 = 1
  for (const [dx, dy] of [[11000, 0], [0, 8000], [-11000, 0], [0, -8000]]) {
    w.ub(1, 1); w.ub(1, 1); w.ub(13, 4); w.ub(1, 1); w.sb(dx, 15); w.sb(dy, 15);
  }
  w.ub(0, 6);                                   // EndShapeRecord
  return tag(2, [...head, ...w.align()]);
}

const placeObject2 = (depth, charId) => tag(26, [0x02, ...u16(depth), ...u16(charId)]);

const actionsGetUrl = (url, target = "") => [0x83, ...u16(url.length + 1 + target.length + 1), ...cstr(url), ...cstr(target), 0x00];
const actionsGetUrl2 = (flags = 0x00) => [0x9a, ...u16(1), flags, 0x00];
const actionsTrace = (s) => [0x96, ...u16(s.length + 2), 0x00, ...cstr(s), 0x26, 0x00];
function actionsConstantPool(strs, tail = []) {
  const body = [...u16(strs.length), ...strs.flatMap(cstr)];
  return [0x88, ...u16(body.length), ...body, ...tail, 0x00];
}
const doAction = (actions) => tag(12, actions);

function placeObject2WithClipActions(depth, charId, actions) {
  const record = [...u32(0x1), ...u32(actions.length), ...actions]; // ClipEventLoad
  return tag(26, [0x82, ...u16(depth), ...u16(charId), ...u16(0), ...u32(0x1), ...record, ...u32(0)]);
}

function placeObject3WithFilterAndClipActions(depth, charId, actions) {
  const filters = [1, 1, ...u32(0), ...u32(0), 0]; // 1 filter: Blur (9 bytes)
  const record = [...u32(0x1), ...u32(actions.length), ...actions];
  return tag(70, [0x82, 0x01, ...u16(depth), ...u16(charId), ...filters, ...u16(0), ...u32(0x1), ...record, ...u32(0)]);
}

function defineButton2(id, actions) {
  const record = [0x08, ...u16(1), ...u16(1), 0x00, 0x00]; // flags, charId, depth, matrix(1B), cxform(1B)
  const actionOffset = 2 + record.length + 1;
  return tag(34, [...u16(id), 0x00, ...u16(actionOffset), ...record, 0x00, ...u16(0), ...u16(0x0008), ...actions]);
}

function defineSprite(id, innerTags) {
  return tag(39, [...u16(id), ...u16(1), ...innerTags.flat(), ...tag(0, [])]);
}

const defineBinaryData = (id, data) => tag(87, [...u16(id), ...u32(0), ...data]);

// デバイスフォント（グリフなし）の DefineFont3 と、それを使う DefineEditText
function defineFont3Device(id, name) {
  const nameBytes = [...Buffer.from(name, "utf8"), 0];
  return tag(75, [...u16(id), 0x04, 0x02, nameBytes.length, ...nameBytes, ...u16(0)]);
}
function defineEditText(id, fontId, text, { fontClass, varName = "" } = {}) {
  const w = new BitWriter();
  w.ub(15, 5); w.sb(0, 15); w.sb(10000, 15); w.sb(0, 15); w.sb(2000, 15);
  const rect = w.align();
  const flags1 = 0x80 | 0x08 | 0x04 | (fontClass ? 0 : 0x01); // HasText ReadOnly HasTextColor [HasFont]
  const flags2 = fontClass ? 0x80 : 0x00;                      // [HasFontClass]
  const body = [...u16(id), ...rect, flags1, flags2];
  if (fontClass) body.push(...Buffer.from(fontClass, "utf8"), 0, ...u16(600)); else body.push(...u16(fontId), ...u16(600));
  body.push(0, 0, 0, 255, ...cstr(varName), ...Buffer.from(text, "utf8"), 0);
  return tag(37, body);
}

// AVM1: SharedObject に書いて読み戻し、テキスト変数 msg に表示する（so = SharedObject.getLocal("x"); so.data.n = 42; msg = so.data.n）
function actionsSharedObjectDemo() {
  const pushStr = (s) => [0x96, ...u16(s.length + 2), 0x00, ...cstr(s)];
  const pushInt = (v) => [0x96, ...u16(5), 0x07, ...u32(v)];
  const GET_VAR = 0x1c, SET_VAR = 0x1d, GET_MEMBER = 0x4e, SET_MEMBER = 0x4f, CALL_METHOD = 0x52;
  return [
    ...pushStr("so"), ...pushStr("x"), ...pushInt(1), ...pushStr("SharedObject"), GET_VAR, ...pushStr("getLocal"), CALL_METHOD, SET_VAR,
    ...pushStr("so"), GET_VAR, ...pushStr("data"), GET_MEMBER, ...pushStr("n"), ...pushInt(42), SET_MEMBER,
    ...pushStr("msg"), ...pushStr("so"), GET_VAR, ...pushStr("data"), GET_MEMBER, ...pushStr("n"), GET_MEMBER, SET_VAR,
    0x00,
  ];
}

// 最小限の ABC（定数プールのみ）: strings / namespaces / multinames を指定
function abc({ strings = [], namespaces = [], multinames = [] }) {
  const u30 = (v) => { const out = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); return out; };
  const out = [16, 0, 46, 0, 0, 0, 0];                 // minor, major, int/uint/double pools empty
  out.push(...u30(strings.length + 1));
  for (const s of strings) { const b = Buffer.from(s, "utf8"); out.push(...u30(b.length), ...b); }
  out.push(...u30(namespaces.length + 1));
  for (const nameIdx of namespaces) out.push(0x16, ...u30(nameIdx));
  out.push(...u30(0));                                 // ns_sets
  out.push(...u30(multinames.length + 1));
  for (const [ns, name] of multinames) out.push(0x07, ...u30(ns), ...u30(name));
  out.push(0, 0, 0, 0, 0, 0);
  return out;
}
const doAbc = (abcBytes, name = "frame1") => tag(82, [...u32(1), ...cstr(name), ...abcBytes]);

// ---- LZMA デコーダー（ブラウザ側 app.js と同じ組み立て） ------------------------------
async function lzmaDecompress(props, data, size) {
  const { LZMA } = require("lzma/src/lzma-d-min.js");
  const buf = new Uint8Array(13 + data.length);
  buf.set(props, 0);
  let s = size;
  for (let i = 0; i < 8; i++) { buf[5 + i] = s & 0xff; s = Math.floor(s / 256); }
  buf.set(data, 13);
  const out = await new Promise((resolve, reject) => LZMA.decompress(buf, (r, e) => (e ? reject(e) : resolve(r))));
  if (typeof out === "string") return new TextEncoder().encode(out);
  return Uint8Array.from(out, (x) => x & 0xff);
}

// ---- テストケース ------------------------------------------------------------------
const benign = [setBg(0x33, 0x66, 0x99), defineShapeRect(1), placeObject2(1, 1), showFrame()];

const cases = [
  ["良性: 図形のみ (FWS)", buildSwf(benign), "allow"],
  ["良性: 図形のみ (CWS zlib)", buildSwf(benign, { compress: "zlib" }), "allow"],
  ["良性: 図形のみ (ZWS LZMA)", buildSwf(benign, { compress: "lzma" }), "allow"],
  ["良性: trace のみの AVM1", buildSwf([...benign, doAction(actionsTrace("hello"))]), "allow"],
  ["良性: AS3 flash.display.Sprite", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.display", "Sprite"], namespaces: [1], multinames: [[1, 2]] }))]), "allow"],
  ["要同意: getURL (DoAction)", buildSwf([...benign, doAction(actionsGetUrl("http://example.com", "_blank"))]), "consent"],
  ["要同意: getURL (GetURL2 in clip actions)", buildSwf([setBg(0, 0, 0), defineShapeRect(1), placeObject2WithClipActions(1, 1, actionsGetUrl2(0x00)), showFrame()]), "consent"],
  ["要同意: getURL 識別子 (AVM1 定数プール)", buildSwf([...benign, doAction(actionsConstantPool(["getURL", "http://x.test/"]))]), "consent"],
  ["拒否: getURL で _level1 に読み込み", buildSwf([...benign, doAction(actionsGetUrl("next.swf", "_level1"))]), "block"],
  ["拒否: loadMovie (GetURL2 LoadTarget)", buildSwf([setBg(0, 0, 0), defineShapeRect(1), placeObject2WithClipActions(1, 1, actionsGetUrl2(0x02)), showFrame()]), "block"],
  ["拒否: loadVariables (GetURL2 LoadVariables)", buildSwf([...benign, doAction(actionsGetUrl2(0x41))]), "block"],
  ["要同意: getURL in PlaceObject3 (filters付き)", buildSwf([setBg(0, 0, 0), defineShapeRect(1), placeObject3WithFilterAndClipActions(1, 1, actionsGetUrl("http://x.test/")), showFrame()]), "consent"],
  ["要同意: getURL in DefineButton2", buildSwf([defineShapeRect(1), defineButton2(2, actionsGetUrl("http://x.test/")), placeObject2(1, 2), showFrame()]), "consent"],
  ["要同意: getURL + SharedObject", buildSwf([...benign, doAction(actionsGetUrl("http://x.test/")), doAction(actionsConstantPool(["SharedObject"]))]), "consent"],
  ["拒否: getURL + LoadVars は同意不可", buildSwf([...benign, doAction(actionsGetUrl("http://x.test/")), doAction(actionsConstantPool(["LoadVars"]))]), "block"],
  ["要同意: SharedObject (AVM1 定数プール)", buildSwf([...benign, doAction(actionsConstantPool(["SharedObject", "getLocal", "save"]))]), "consent"],
  ["要同意: SharedObject を実際に使う AVM1", buildSwf([...benign, doAction(actionsSharedObjectDemo())]), "consent"],
  ["拒否: SharedObject + LoadVars", buildSwf([...benign, doAction(actionsConstantPool(["SharedObject", "LoadVars"]))]), "block"],
  ["拒否: LoadVars (AVM1 定数プール)", buildSwf([...benign, doAction(actionsConstantPool(["LoadVars", "onLoad"]))]), "block"],
  ["要同意: getURL inside DefineSprite", buildSwf([defineSprite(1, [doAction(actionsGetUrl("http://x.test/")), showFrame()]), placeObject2(1, 1), showFrame()]), "consent"],
  ["拒否: loadMovie inside DefineSprite", buildSwf([defineSprite(1, [doAction(actionsGetUrl2(0x02)), showFrame()]), placeObject2(1, 1), showFrame()]), "block"],
  ["拒否: AS3 flash.net.URLLoader", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.net", "URLLoader"], namespaces: [1], multinames: [[1, 2]] }))]), "block"],
  ["要同意: AS3 flash.net.SharedObject", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.net", "SharedObject"], namespaces: [1], multinames: [[1, 2]] }))]), "consent"],
  ["拒否: AS3 flash.external.ExternalInterface", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.external", "ExternalInterface"], namespaces: [1], multinames: [[1, 2]] }))]), "block"],
  ["要同意: AS3 navigateToURL (文字列プールのみ)", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["navigateToURL"] }))]), "consent"],
  ["要同意: AS3 flash.net.navigateToURL + URLRequest", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.net", "navigateToURL", "URLRequest"], namespaces: [1], multinames: [[1, 2], [1, 3]] }))]), "consent"],
  ["拒否: AS3 URLRequest のみ（navigateToURL なし）", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.net", "URLRequest"], namespaces: [1], multinames: [[1, 2]] }))]), "block"],
  ["拒否: AS3 navigateToURL + URLRequest + Loader（外部 SWF 読み込み）", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.net", "navigateToURL", "URLRequest", "flash.display", "Loader"], namespaces: [1, 4], multinames: [[1, 2], [1, 3], [2, 5]] }))]), "block"],
  ["拒否: AS3 navigateToURL + URLLoader", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.net", "navigateToURL", "URLRequest", "URLLoader"], namespaces: [1], multinames: [[1, 2], [1, 3], [1, 4]] }))]), "block"],
  ["許可: AS3 flash.net.registerClassAlias", buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.net", "registerClassAlias"], namespaces: [1], multinames: [[1, 2]] }))]), "allow"],
  ["拒否: ImportAssets2", buildSwf([tag(71, [...cstr("http://evil.test/lib.swf"), 1, 0, ...u16(1), ...cstr("sym")]), ...benign]), "block"],
  ["要同意: 埋め込み SWF に getURL", buildSwf([...benign, defineBinaryData(5, buildSwf([doAction(actionsGetUrl("http://x.test/"))]))]), "consent"],
  ["拒否: 埋め込み SWF に loadMovie", buildSwf([...benign, defineBinaryData(5, buildSwf([doAction(actionsGetUrl2(0x02))]))]), "block"],
  ["許可: 埋め込み SWF が良性 (CWS)", buildSwf([...benign, defineBinaryData(5, buildSwf(benign, { compress: "zlib" }))]), "allow"],
  ["警告: fscommand のみ", buildSwf([...benign, doAction(actionsConstantPool(["fscommand", "fullscreen"]))]), "warn"],
  ["警告: XML + load", buildSwf([...benign, doAction(actionsConstantPool(["XML", "load", "onLoad"]))]), "warn"],
  ["警告: UseNetwork フラグ", buildSwf([fileAttrs(0x09), ...benign]), "warn"],
  ["警告: URL 文字列のみ (AVM1)", buildSwf([...benign, doAction(actionsConstantPool(["https://example.com/page"]))]), "warn"],
  ["拒否: SWF でないファイル", Uint8Array.from(Buffer.from("GIF89a....................")), "block"],
  ["拒否: 壊れた zlib", Uint8Array.from([...Buffer.from("CWS"), 8, ...u32(100), 1, 2, 3, 4, 5, 6, 7, 8, 9]), "block"],
  ["拒否: ZWS だがデコーダーなし", buildSwf(benign, { compress: "lzma" }), "block", { noLzma: true }],
];

let failed = 0;
for (const [name, bytes, expected, opt = {}] of cases) {
  const report = await scanSwf(bytes, opt.noLzma ? {} : { lzmaDecompress });
  const ok = report.verdict === expected;
  if (!ok) failed++;
  const reasons = report.findings.filter((f) => f.level !== "info").map((f) => `${f.level}:${f.message}`).join(" | ");
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  → ${report.verdict}${ok ? "" : ` (期待: ${expected})`}${reasons ? `\n        ${reasons}` : ""}`);
}

// ---- フォント情報の抽出と置き換え ------------------------------------------------------
function placeObject2At(depth, charId, tx, ty) {
  const w = new BitWriter();
  w.ub(0, 1); w.ub(0, 1); w.ub(15, 5); w.sb(tx, 15); w.sb(ty, 15); // MATRIX: 平行移動のみ
  return tag(26, [0x06, ...u16(depth), ...u16(charId), ...w.align()]);
}
const jpSwf = buildSwf([setBg(230, 240, 255), defineFont3Device(1, "ＭＳ ゴシック"), defineEditText(2, 1, "日本語テキスト ABC"),
  defineEditText(3, 0, "明朝のテキスト", { fontClass: "ＭＳ 明朝" }), placeObject2(1, 2), placeObject2At(2, 3, 0, 1600), showFrame()]);
{
  const rep = await scanSwf(jpSwf);
  const names = rep.info.fonts.map((f) => `${f.tag}:${f.name}:${f.device}`);
  const ok1 = rep.verdict === "allow" && names.includes("DefineFont3:ＭＳ ゴシック:true") && names.includes("DefineEditText(FontClass):ＭＳ 明朝:true");
  if (!ok1) failed++;
  console.log(`${ok1 ? "PASS" : "FAIL"}  フォント情報の抽出  → ${names.join(" | ")}`);

  const rw = await rewriteFontNames(buildSwf([setBg(0, 0, 0), defineFont3Device(1, "ＭＳ ゴシック"), defineEditText(2, 1, "x"), defineEditText(3, 0, "y", { fontClass: "ＭＳ 明朝" }), showFrame()], { compress: "zlib" }),
    { "ＭＳ ゴシック": "BIZ UDGothic", "ＭＳ 明朝": "BIZ UDMincho" });
  const rep2 = await scanSwf(rw.bytes);
  const names2 = rep2.info.fonts.map((f) => f.name);
  const ok2 = rw.replaced === 2 && rep2.verdict === "allow" && names2.includes("BIZ UDGothic") && names2.includes("BIZ UDMincho")
    && rep2.info.signature === "FWS" && rep2.info.fileLength === rw.bytes.length && rep2.info.tagCount === rep.info.tagCount - 2;
  if (!ok2) failed++;
  console.log(`${ok2 ? "PASS" : "FAIL"}  フォント名の置き換え  → replaced=${rw.replaced} fonts=${names2.join(",")} sig=${rep2.info.signature} len=${rep2.info.fileLength}/${rw.bytes.length}`);

  const rw3 = await rewriteFontNames(jpSwf, { "存在しない": "X" });
  const ok3 = rw3.replaced === 0;
  if (!ok3) failed++;
  console.log(`${ok3 ? "PASS" : "FAIL"}  該当なしの置き換えは無変更  → replaced=${rw3.replaced}`);
}

// ---- Shift_JIS (SWF5) → UTF-8 変換 -----------------------------------------------------
const SJIS = { "ＭＳ Ｐゴシック": [0x82, 0x6c, 0x82, 0x72, 0x20, 0x82, 0x6f, 0x83, 0x53, 0x83, 0x56, 0x83, 0x62, 0x83, 0x4e], "日本": [0x93, 0xfa, 0x96, 0x7b], "あ": [0x82, 0xa0], "い": [0x82, 0xa2], "う": [0x82, 0xa4] };
// SWF5 向け: ShiftJIS フラグ付きデバイスフォント / 1 グリフの埋め込みフォント / Shift_JIS テキスト
function defineFont2Sjis(id, nameBytes, { glyphs = 0, wide = false, code = 0 } = {}) {
  const flags = 0x40 | (wide ? 0x04 : 0);
  const body = [...u16(id), flags, 0x00, nameBytes.length + 1, ...nameBytes, 0, ...u16(glyphs)];
  if (glyphs === 1) body.push(...u16(4), ...u16(6), 0x00, 0x00, ...(wide ? u16(code) : [code])); // offset, codeTableOffset, shape(empty), code
  return tag(48, body);
}
function defineEditTextSjis(id, fontId, textBytes) {
  const w = new BitWriter();
  w.ub(15, 5); w.sb(0, 15); w.sb(10000, 15); w.sb(0, 15); w.sb(2000, 15);
  return tag(37, [...u16(id), ...w.align(), 0x8d, 0x00, ...u16(fontId), ...u16(600), 0, 0, 0, 255, 0, ...textBytes, 0]);
}
const sjisV5 = buildSwf([setBg(230, 240, 255), defineFont2Sjis(1, SJIS["ＭＳ Ｐゴシック"]), defineEditTextSjis(2, 1, [...SJIS["日本"], 0x20, 0x41, 0x42, 0x43]), placeObject2(1, 2), showFrame()], { version: 5 });
{
  const r = await convertLegacyEncoding(sjisV5);
  const rep = await scanSwf(r.bytes);
  const hex = Buffer.from(r.bytes).toString("hex");
  const ok1 = !r.skipped && rep.info.version === 6 && rep.verdict === "allow" && rep.info.fonts[0]?.name === "ＭＳ Ｐゴシック"
    && hex.includes(Buffer.from("日本 ABC", "utf8").toString("hex")) && r.stats.strings === 2 && rep.info.fileLength === r.bytes.length;
  if (!ok1) failed++;
  console.log(`${ok1 ? "PASS" : "FAIL"}  SJIS→UTF-8: テキストとフォント名  → v${rep.info.version} font=${rep.info.fonts[0]?.name} strings=${r.stats.strings}`);

  // 埋め込みフォントのコードテーブル: 0x82A0 (あ, SJIS) → 0x3042 (Unicode), WideCodes 化
  const narrowFont = buildSwf([defineFont2Sjis(1, [0x41], { glyphs: 1, wide: false, code: 0xb1 }), showFrame()], { version: 5 }); // 0xB1 = 半角ｱ
  const wideFont = buildSwf([defineFont2Sjis(1, [0x41], { glyphs: 1, wide: true, code: 0x82a0 }), showFrame()], { version: 5 });
  const [n2, w2] = await Promise.all([convertLegacyEncoding(narrowFont), convertLegacyEncoding(wideFont)]);
  const hexN = Buffer.from(n2.bytes).toString("hex"), hexW = Buffer.from(w2.bytes).toString("hex");
  // 0xB1 (半角ｱ) → U+FF71、0x82A0 (あ) → U+3042。どちらも 2 バイト LE で格納され、フラグは WideCodes(0x04) のみ
  const ok2 = hexN.includes("71ff") && hexW.includes("4230") && n2.stats.fonts === 1 && w2.stats.fonts === 1
    && n2.bytes[n2.bytes.indexOf(0x30, 21) + 1] !== undefined;
  if (!ok2) failed++;
  console.log(`${ok2 ? "PASS" : "FAIL"}  SJIS→UTF-8: フォントのコードテーブル  → narrow=${hexN.slice(-24)} wide=${hexW.slice(-24)}`);

  // AVM1: 文字列長が変わっても Jump の飛び先が保たれる
  // [Push "あ"] [Jump → Push "う"] [Push "い"] [Push "う"] [End]
  const pushS = (b) => [0x96, ...u16(b.length + 2), 0x00, ...b, 0x00];
  const pI = pushS(SJIS["い"]), pU = pushS(SJIS["う"]);
  const actions = [...pushS(SJIS["あ"]), 0x99, ...u16(2), ...u16(pI.length), ...pI, ...pU, 0x00];
  const out = conv.convertActions(Uint8Array.from(actions), 0, actions.length, { actionBlocks: 0, actionBlocksFailed: 0, strings: 0, invalid: 0, warnings: [] });
  let ok3 = false, detail = "変換失敗";
  if (out) {
    // 変換後を線形に読み、Jump の飛び先にある Push の文字列を確認
    let p = 0; const acts = [];
    while (p < out.length) { const off = p, code = out[p++]; let len = 0; if (code >= 0x80) { len = out[p] | (out[p + 1] << 8); p += 2; } acts.push({ off, code, bs: p, be: p + len, end: p + len }); p += len; if (code === 0) break; }
    const jump = acts.find((a) => a.code === 0x99);
    const rel = new DataView(out.buffer, out.byteOffset + jump.bs, 2).getInt16(0, true);
    const target = acts.find((a) => a.off === jump.end + rel);
    const str = target ? Buffer.from(out.subarray(target.bs + 1, target.be - 1)).toString("utf8") : null;
    ok3 = str === "う";
    detail = `target=${str}`;
  }
  if (!ok3) failed++;
  console.log(`${ok3 ? "PASS" : "FAIL"}  SJIS→UTF-8: AVM1 の分岐オフセット再計算  → ${detail}`);

  // SWF5 のクリップアクション（16bit フラグ）が 32bit に拡張され、中の getURL を v6 として読める
  const clipV5 = buildSwf([setBg(0, 0, 0), defineShapeRect(1), tag(26, [0x82, ...u16(1), ...u16(1), ...u16(0), ...u16(1), ...u16(1), ...u32(4), 0x9a, ...u16(1), 0x00, 0x00, ...u16(0)]), showFrame()], { version: 5 });
  const c5 = await convertLegacyEncoding(clipV5);
  const rep5 = await scanSwf(c5.bytes);
  const ok4 = rep5.info.version === 6 && rep5.verdict === "consent" && c5.stats.clipActions === 1 && rep5.findings.some((f) => f.code === "getURL2");
  if (!ok4) failed++;
  console.log(`${ok4 ? "PASS" : "FAIL"}  SJIS→UTF-8: クリップアクションのフラグ拡張  → ${rep5.verdict} ${rep5.findings.map((f) => f.code).join(",")}`);

  const v8 = await convertLegacyEncoding(buildSwf(benign));
  const ok5 = v8.skipped === true;
  if (!ok5) failed++;
  console.log(`${ok5 ? "PASS" : "FAIL"}  SJIS→UTF-8: バージョン 6 以上は変換しない  → skipped=${v8.skipped}`);
}

// ブラウザ手動テスト用のサンプルを書き出す
const outDir = path.join(__dirname, "samples");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "ok-red-square.swf"), buildSwf(benign));
fs.writeFileSync(path.join(outDir, "ok-red-square-cws.swf"), buildSwf(benign, { compress: "zlib" }));
fs.writeFileSync(path.join(outDir, "ok-red-square-zws.swf"), buildSwf(benign, { compress: "lzma" }));
fs.writeFileSync(path.join(outDir, "consent-geturl.swf"), buildSwf([...benign, doAction(actionsGetUrl("http://example.com", "_blank"))]));
fs.writeFileSync(path.join(outDir, "blocked-loadmovie.swf"), buildSwf([...benign, doAction(actionsGetUrl2(0x02))]));
fs.writeFileSync(path.join(outDir, "blocked-loadvars.swf"), buildSwf([...benign, doAction(actionsConstantPool(["LoadVars", "onLoad"]))]));
// SharedObject に 42 を保存して読み戻し、テキストに表示する（同意後に再生すると「42」が見える）
fs.writeFileSync(path.join(outDir, "consent-sharedobject.swf"), buildSwf([setBg(230, 240, 255), defineFont3Device(1, "ＭＳ ゴシック"),
  defineEditText(2, 1, "fail", { varName: "msg" }), placeObject2(1, 2), doAction(actionsSharedObjectDemo()), showFrame()]));
try { fs.unlinkSync(path.join(outDir, "blocked-sharedobject.swf")); } catch { /* none */ }
fs.writeFileSync(path.join(outDir, "blocked-as3-urlloader.swf"), buildSwf([fileAttrs(0x08), ...benign, doAbc(abc({ strings: ["flash.net", "URLLoader"], namespaces: [1], multinames: [[1, 2]] }))]));
fs.writeFileSync(path.join(outDir, "ok-jp-devicefont.swf"), jpSwf);
// 音付きサンプル: 440Hz の正弦波 1.5 秒（DefineSound: 非圧縮 16bit mono 11025Hz）+ StartSound
{
  const rate = 11025, secs = 1.5, n = Math.floor(rate * secs);
  const pcm = [];
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000 * Math.min(1, (n - i) / 2000)); pcm.push(v & 0xff, (v >> 8) & 0xff); }
  const defineSound = tag(14, [...u16(2), 0x3a /* format 3 (LE PCM), rate 1 (11kHz), 16bit, mono */, ...u32(n), ...pcm]);
  const startSound = tag(15, [...u16(2), 0x00]);
  fs.writeFileSync(path.join(outDir, "ok-sound.swf"), buildSwf([setBg(230, 240, 255), defineShapeRect(1), placeObject2(1, 1), startSound, showFrame()].map((x, i) => i === 1 ? [defineSound, x].flat() : x)));
}
fs.writeFileSync(path.join(outDir, "ok-sjis-v5.swf"), sjisV5);
fs.writeFileSync(path.join(outDir, "warn-fscommand.swf"), buildSwf([...benign, doAction(actionsConstantPool(["fscommand", "fullscreen"]))]));
console.log(`\nサンプル SWF を ${outDir} に書き出しました`);

console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
