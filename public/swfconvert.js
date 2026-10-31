// 旧バージョン (SWF5 以前) の SWF に含まれる Shift_JIS 文字列を UTF-8 に変換し、SWF バージョン 6 として出力する。
// Ruffle はバージョン 6 未満の文字列を Latin-1 として解釈するため、日本語 Windows 向けの古い SWF は文字化けする。
// メモリ上のコピーに対して行い、元ファイルは変更しない。
//
// 変換対象:
//   - DefineEditText（変数名・初期テキスト）、FrameLabel、ExportAssets、PlaceObject2/3 のインスタンス名・クラス名
//   - DefineFont2 / DefineFontInfo（フォント名と、ShiftJIS フラグ付きコードテーブル → Unicode）
//   - AVM1 バイトコード内の文字列（ConstantPool, Push, GetURL, DefineFunction, SetTarget, GotoLabel, Try）
//     文字列長の変化に合わせて Jump/If/DefineFunction/With/Try のオフセットを再計算する
//   - PlaceObject2/3 の CLIPACTIONS（バージョン 6 ではイベントフラグが 16bit → 32bit になるため拡張）
import { decompressSwf, listTags, BitReader, readRect, skipMatrix, skipCxform, skipFilterList } from "./scanner.js";

const sjis = new TextDecoder("shift_jis", { fatal: true });
const utf8 = new TextEncoder();

function u16(b, p) { return b[p] | (b[p + 1] << 8); }
function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const bytes = (arr) => Uint8Array.from(arr);

function tagHeader(code, len) {
  if (len < 0x3f) return bytes(le16((code << 6) | len));
  return bytes([...le16((code << 6) | 0x3f), ...le32(len)]);
}

// NUL 終端文字列を読む → { str: Uint8Array(NUL を含まない), next }
function cstr(b, p, end) {
  let e = p;
  while (e < end && b[e] !== 0) e++;
  return { str: b.subarray(p, e), next: Math.min(e + 1, end) };
}

class Stats {
  constructor() { this.strings = 0; this.invalid = 0; this.fonts = 0; this.actionBlocks = 0; this.actionBlocksFailed = 0; this.clipActions = 0; this.warnings = []; }
}

// Shift_JIS バイト列 → UTF-8。ASCII のみならそのまま。Shift_JIS として不正なら元のまま
function convStr(s, stats) {
  let high = false;
  for (let i = 0; i < s.length; i++) if (s[i] >= 0x80) { high = true; break; }
  if (!high) return s;
  try {
    const out = utf8.encode(sjis.decode(s));
    stats.strings++;
    return out;
  } catch {
    stats.invalid++;
    return s;
  }
}
const cz = (s, stats) => concat([convStr(s, stats), bytes([0])]); // 変換して NUL 終端

// Shift_JIS のコード値（1 バイトまたは 2 バイト big-endian の値）→ Unicode コードユニット
function convCode(code) {
  if (code < 0x80) return code;
  const raw = code < 0x100 ? [code] : [code >> 8, code & 0xff];
  try {
    const cp = sjis.decode(bytes(raw)).codePointAt(0);
    return cp > 0xffff ? 0xfffd : cp;
  } catch {
    return code;
  }
}

// ---- AVM1 アクション列 -------------------------------------------------------------
function convertActions(b, start, end, stats) {
  stats.actionBlocks++;
  const fail = (why) => { stats.actionBlocksFailed++; stats.warnings.push(`スクリプトの変換をスキップ: ${why}`); return null; };
  const acts = [];
  let p = start;
  while (p < end) {
    const off = p;
    const code = b[p++];
    let len = 0;
    if (code >= 0x80) {
      if (p + 2 > end) return fail("アクションが途中で終わっています");
      len = u16(b, p); p += 2;
    }
    const bs = p, be = Math.min(p + len, end);
    acts.push({ off, code, bs, be, endOff: be, body: b.subarray(bs, be) });
    p = be;
    if (code === 0) break;
  }
  const tail = b.subarray(p, end);

  for (const a of acts) {
    const body = a.body;
    const s = (q) => cstr(body, q, body.length);
    switch (a.code) {
      case 0x83: { // GetURL: url target
        const u = s(0), t = s(u.next);
        a.body = concat([cz(u.str, stats), cz(t.str, stats)]);
        break;
      }
      case 0x88: { // ConstantPool
        const count = u16(body, 0);
        const parts = [bytes(le16(count))];
        let q = 2;
        for (let i = 0; i < count && q < body.length; i++) { const r = s(q); parts.push(cz(r.str, stats)); q = r.next; }
        parts.push(body.subarray(q));
        a.body = concat(parts);
        break;
      }
      case 0x96: { // Push
        const parts = [];
        let q = 0;
        while (q < body.length) {
          const type = body[q];
          if (type === 0) { const r = s(q + 1); parts.push(bytes([0]), cz(r.str, stats)); q = r.next; continue; }
          const size = { 1: 4, 2: 0, 3: 0, 4: 1, 5: 1, 6: 8, 7: 4, 8: 1, 9: 2 }[type];
          if (size === undefined) { parts.push(body.subarray(q)); q = body.length; break; }
          parts.push(body.subarray(q, q + 1 + size)); q += 1 + size;
        }
        a.body = concat(parts);
        break;
      }
      case 0x9b: { // DefineFunction: name, numParams, params, codeSize
        const n = s(0);
        const count = u16(body, n.next);
        const parts = [cz(n.str, stats), bytes(le16(count))];
        let q = n.next + 2;
        for (let i = 0; i < count; i++) { const r = s(q); parts.push(cz(r.str, stats)); q = r.next; }
        parts.push(body.subarray(q));
        a.body = concat(parts);
        break;
      }
      case 0x8e: { // DefineFunction2: name, numParams, regCount, flags, (reg, name)*, codeSize
        const n = s(0);
        const count = u16(body, n.next);
        const parts = [cz(n.str, stats), body.subarray(n.next, n.next + 5)];
        let q = n.next + 5;
        for (let i = 0; i < count; i++) { const r = s(q + 1); parts.push(body.subarray(q, q + 1), cz(r.str, stats)); q = r.next; }
        parts.push(body.subarray(q));
        a.body = concat(parts);
        break;
      }
      case 0x8b: case 0x8c: { // SetTarget / GotoLabel
        const r = s(0);
        a.body = concat([cz(r.str, stats), body.subarray(r.next)]);
        break;
      }
      case 0x8f: { // Try: flags, trySize, catchSize, finallySize, catchName|catchRegister
        if (!(body[0] & 0x04)) { const r = s(7); a.body = concat([body.subarray(0, 7), cz(r.str, stats), body.subarray(r.next)]); }
        break;
      }
      default:
        break;
    }
    if (a.body.length > 0xffff) return fail("アクションが 64KB を超えました");
  }

  // 新しいオフセットを計算し、分岐先を付け替える
  const map = new Map();
  let np = 0;
  for (const a of acts) {
    map.set(a.off, np);
    a.newOff = np;
    a.newEnd = np + (a.code >= 0x80 ? 3 : 1) + a.body.length;
    np = a.newEnd;
  }
  map.set(p, np);
  const remap = (oldTarget) => map.get(oldTarget);

  for (const a of acts) {
    const body = a.body;
    const view = () => new DataView(body.buffer, body.byteOffset, body.byteLength);
    if (a.code === 0x99 || a.code === 0x9d) { // Jump / If
      const rel = view().getInt16(0, true);
      const nt = remap(a.endOff + rel);
      if (nt === undefined) return fail("分岐先が命令境界にありません");
      a.body = new Uint8Array(body); new DataView(a.body.buffer).setInt16(0, nt - a.newEnd, true);
    } else if (a.code === 0x9b || a.code === 0x8e) { // DefineFunction(2): codeSize は末尾 2 バイト
      const size = u16(body, body.length - 2);
      const nt = remap(a.endOff + size);
      if (nt === undefined) return fail("関数本体の終端が命令境界にありません");
      a.body = new Uint8Array(body); a.body.set(le16(nt - a.newEnd), body.length - 2);
    } else if (a.code === 0x94) { // With
      const nt = remap(a.endOff + u16(body, 0));
      if (nt === undefined) return fail("with ブロックの終端が命令境界にありません");
      a.body = new Uint8Array(body); a.body.set(le16(nt - a.newEnd), 0);
    } else if (a.code === 0x8f) { // Try
      const t1 = a.endOff + u16(body, 1), t2 = t1 + u16(body, 3), t3 = t2 + u16(body, 5);
      const n1 = remap(t1), n2 = remap(t2), n3 = remap(t3);
      if (n1 === undefined || n2 === undefined || n3 === undefined) return fail("try ブロックの終端が命令境界にありません");
      a.body = new Uint8Array(body); a.body.set(le16(n1 - a.newEnd), 1); a.body.set(le16(n2 - n1), 3); a.body.set(le16(n3 - n2), 5);
    }
  }

  const parts = [];
  for (const a of acts) {
    parts.push(a.code >= 0x80 ? bytes([a.code, ...le16(a.body.length)]) : bytes([a.code]), a.body);
  }
  parts.push(tail);
  return concat(parts);
}

// ---- 各タグ -----------------------------------------------------------------------
function convertDefineButton(b, t, stats) {
  let p = t.start + 2;
  for (;;) {
    if (p >= t.end) return null;
    const flags = b[p++];
    if (flags === 0) break;
    p += 4;
    const r = new BitReader(b, p); skipMatrix(r); p = r.align();
  }
  const acts = convertActions(b, p, t.end, stats);
  return acts ? concat([b.subarray(t.start, p), acts]) : null;
}

function convertDefineButton2(b, t, stats) {
  const aoPos = t.start + 3;
  const actionOffset = u16(b, aoPos);
  if (!actionOffset) return null;
  const parts = [b.subarray(t.start, aoPos + actionOffset)];
  let p = aoPos + actionOffset;
  for (;;) {
    if (p + 4 > t.end) break;
    const size = u16(b, p);
    const recEnd = size ? Math.min(p + size, t.end) : t.end;
    const acts = convertActions(b, p + 4, recEnd, stats);
    if (!acts) return null;
    parts.push(bytes(le16(size ? 4 + acts.length : 0)), b.subarray(p + 2, p + 4), acts);
    if (!size) break;
    p += size;
  }
  return concat(parts);
}

function convertPlaceObject(b, t, version, stats) {
  const flags = b[t.start];
  const hasClipActions = !!(flags & 0x80), hasClipDepth = !!(flags & 0x40), hasName = !!(flags & 0x20), hasRatio = !!(flags & 0x10);
  const hasCxform = !!(flags & 0x08), hasMatrix = !!(flags & 0x04), hasChar = !!(flags & 0x02);
  if (!hasClipActions && !hasName) return null;
  const parts = [];
  let p = t.start + 1;
  let flags2 = 0;
  if (t.code === 70) flags2 = b[p++];
  const hasFilters = !!(flags2 & 0x01), hasBlend = !!(flags2 & 0x02), hasCache = !!(flags2 & 0x04);
  const hasClassName = !!(flags2 & 0x08), hasImage = !!(flags2 & 0x10), hasVisible = !!(flags2 & 0x20), hasBg = !!(flags2 & 0x40);
  let copyFrom = t.start;
  p += 2; // depth
  if (t.code === 70 && (hasClassName || (hasImage && hasChar))) {
    const r = cstr(b, p, t.end);
    parts.push(b.subarray(copyFrom, p), cz(r.str, stats));
    p = r.next; copyFrom = p;
  }
  if (hasChar) p += 2;
  if (hasMatrix) { const r = new BitReader(b, p); skipMatrix(r); p = r.align(); }
  if (hasCxform) { const r = new BitReader(b, p); skipCxform(r, true); p = r.align(); }
  if (hasRatio) p += 2;
  if (hasName) {
    const r = cstr(b, p, t.end);
    parts.push(b.subarray(copyFrom, p), cz(r.str, stats));
    p = r.next; copyFrom = p;
  }
  if (hasClipDepth) p += 2;
  if (t.code === 70) {
    if (hasFilters) p = skipFilterList(b, p);
    if (hasBlend) p += 1;
    if (hasCache) p += 1;
    if (hasVisible) p += 1;
    if (hasBg) p += 4;
  }
  if (!hasClipActions) {
    parts.push(b.subarray(copyFrom, t.end));
    return concat(parts);
  }
  // CLIPACTIONS: Reserved(2) AllEventFlags(2→4) records(EventFlags(2→4) Size(4) [KeyCode] actions) End(2→4)
  parts.push(b.subarray(copyFrom, p));
  const flagSize = version <= 5 ? 2 : 4;
  const readFlags = (q) => (flagSize === 2 ? u16(b, q) : u32(b, q));
  parts.push(b.subarray(p, p + 2), bytes(le32(readFlags(p + 2))));
  p += 2 + flagSize;
  while (p + flagSize <= t.end) {
    const ev = readFlags(p); p += flagSize;
    if (ev === 0) break;
    const size = u32(b, p); p += 4;
    const recEnd = Math.min(p + size, t.end);
    let as = p;
    let keyCode = null;
    if (flagSize === 4 && (ev & 0x20000)) { keyCode = b[as]; as += 1; }
    const acts = convertActions(b, as, recEnd, stats);
    if (!acts) return null;
    const newSize = acts.length + (keyCode === null ? 0 : 1);
    parts.push(bytes(le32(ev)), bytes(le32(newSize)));
    if (keyCode !== null) parts.push(bytes([keyCode]));
    parts.push(acts);
    p = recEnd;
  }
  parts.push(bytes(le32(0)));
  stats.clipActions++;
  return concat(parts);
}

function convertDefineEditText(b, t, stats) {
  const r = readRect(b, t.start + 2);
  let p = r.next;
  const f1 = b[p], f2 = b[p + 1];
  p += 2;
  if (f1 & 0x01) p += 4;              // FontID + FontHeight
  if (f2 & 0x80) p = cstr(b, p, t.end).next; // FontClass（SWF5 には無いが念のため）
  if (f1 & 0x04) p += 4;              // TextColor
  if (f1 & 0x02) p += 2;              // MaxLength
  if (f2 & 0x20) p += 9;              // Layout
  const vn = cstr(b, p, t.end);
  const parts = [b.subarray(t.start, p), cz(vn.str, stats)];
  p = vn.next;
  if (f1 & 0x80) {
    const txt = cstr(b, p, t.end);
    parts.push(cz(txt.str, stats), b.subarray(txt.next, t.end));
  } else {
    parts.push(b.subarray(p, t.end));
  }
  return concat(parts);
}

function convertDefineFont2(b, t, stats) {
  const flags = b[t.start + 2];
  const nameLen = b[t.start + 4];
  const name = b.subarray(t.start + 5, t.start + 5 + nameLen);
  let nameEnd = name.length;
  while (nameEnd > 0 && name[nameEnd - 1] === 0) nameEnd--;
  const newName = concat([convStr(name.subarray(0, nameEnd), stats), bytes([0])]);
  const isSjis = !!(flags & 0x40);
  const wideOffsets = !!(flags & 0x08), wideCodes = !!(flags & 0x04), hasLayout = !!(flags & 0x80);
  let p = t.start + 5 + nameLen;
  const numGlyphs = u16(b, p); p += 2;
  let newFlags = flags;
  const parts = [b.subarray(t.start, t.start + 2), null /* flags */, b.subarray(t.start + 3, t.start + 4), bytes([newName.length]), newName, bytes(le16(numGlyphs))];
  if (!isSjis || numGlyphs === 0) {
    parts[1] = bytes([isSjis ? (flags & ~0x50) | 0x04 : flags]);
    parts.push(b.subarray(p, t.end));
    return concat(parts);
  }
  // SJIS フラグ付きフォント: コードテーブルを Unicode (2 バイト) にする
  const offSize = wideOffsets ? 4 : 2;
  const tableStart = p;
  const codeTableOffset = wideOffsets ? u32(b, p + numGlyphs * 4) : u16(b, p + numGlyphs * 2);
  const codesStart = tableStart + codeTableOffset;
  parts.push(b.subarray(tableStart, codesStart)); // オフセット表 + 形状はそのまま
  const codeSize = wideCodes ? 2 : 1;
  let q = codesStart;
  const codes = [];
  for (let i = 0; i < numGlyphs; i++) { codes.push(wideCodes ? u16(b, q) : b[q]); q += codeSize; }
  parts.push(bytes(codes.flatMap((c) => le16(convCode(c)))));
  if (hasLayout) {
    const layoutStart = q;
    q += 6 + numGlyphs * 2; // ascent, descent, leading, advance table
    for (let i = 0; i < numGlyphs; i++) q = readRect(b, q).next;
    const kerningCount = u16(b, q);
    parts.push(b.subarray(layoutStart, q + 2));
    q += 2;
    for (let i = 0; i < kerningCount; i++) {
      const c1 = wideCodes ? u16(b, q) : b[q]; q += codeSize;
      const c2 = wideCodes ? u16(b, q) : b[q]; q += codeSize;
      parts.push(bytes([...le16(convCode(c1)), ...le16(convCode(c2))]), b.subarray(q, q + 2)); q += 2;
    }
  }
  parts.push(b.subarray(q, t.end));
  newFlags = (flags & ~0x50) | 0x04; // ShiftJIS/ANSI を落とし WideCodes を立てる
  parts[1] = bytes([newFlags]);
  stats.fonts++;
  return concat(parts);
}

function convertDefineFontInfo(b, t, stats) {
  const nameLen = b[t.start + 2];
  const name = b.subarray(t.start + 3, t.start + 3 + nameLen);
  let nameEnd = name.length;
  while (nameEnd > 0 && name[nameEnd - 1] === 0) nameEnd--;
  const newName = concat([convStr(name.subarray(0, nameEnd), stats), bytes([0])]);
  const fp = t.start + 3 + nameLen;
  const flags = b[fp];
  const isSjis = !!(flags & 0x10), wide = !!(flags & 0x01);
  const parts = [b.subarray(t.start, t.start + 2), bytes([newName.length]), newName];
  if (!isSjis) { parts.push(b.subarray(fp, t.end)); return concat(parts); }
  const codes = [];
  for (let q = fp + 1; q < t.end; q += wide ? 2 : 1) codes.push(wide ? u16(b, q) : b[q]);
  parts.push(bytes([(flags & ~0x18) | 0x01]), bytes(codes.flatMap((c) => le16(convCode(c)))));
  stats.fonts++;
  return concat(parts);
}

function convertExportAssets(b, t, stats) {
  const count = u16(b, t.start);
  const parts = [b.subarray(t.start, t.start + 2)];
  let p = t.start + 2;
  for (let i = 0; i < count && p < t.end; i++) {
    const r = cstr(b, p + 2, t.end);
    parts.push(b.subarray(p, p + 2), cz(r.str, stats));
    p = r.next;
  }
  parts.push(b.subarray(p, t.end));
  return concat(parts);
}

function convertTagBody(b, t, version, stats) {
  switch (t.code) {
    case 12: return convertActions(b, t.start, t.end, stats);
    case 59: { const a = convertActions(b, t.start + 2, t.end, stats); return a ? concat([b.subarray(t.start, t.start + 2), a]) : null; }
    case 7: return convertDefineButton(b, t, stats);
    case 34: return convertDefineButton2(b, t, stats);
    case 26: case 70: return convertPlaceObject(b, t, version, stats);
    case 37: return convertDefineEditText(b, t, stats);
    case 48: return convertDefineFont2(b, t, stats);
    case 13: return convertDefineFontInfo(b, t, stats);
    case 43: { const r = cstr(b, t.start, t.end); return concat([cz(r.str, stats), b.subarray(r.next, t.end)]); }
    case 56: return convertExportAssets(b, t, stats);
    case 39: return concat([b.subarray(t.start, t.start + 4), convertTagStream(b, t.start + 4, t.end, version, stats)]);
    default: return null;
  }
}

function convertTagStream(b, start, end, version, stats) {
  const tags = listTags(b, start, end);
  const parts = [];
  let prevEnd = start;
  for (const t of tags) {
    const hdrStart = prevEnd;
    prevEnd = t.end;
    let body = null;
    try { body = convertTagBody(b, t, version, stats); }
    catch (e) { stats.warnings.push(`タグ ${t.code} の変換に失敗したため元のまま残しました (${e.message})`); body = null; }
    if (body) parts.push(tagHeader(t.code, body.length), body);
    else parts.push(b.subarray(hdrStart, t.end));
  }
  return concat(parts);
}

/**
 * @param {ArrayBuffer|Uint8Array} input SWF（バージョン 5 以前）
 * @param {{lzmaDecompress?: Function}} [opts]
 * @returns {Promise<{bytes: Uint8Array, skipped: boolean, version: number, stats: Stats}>}
 */
export async function convertLegacyEncoding(input, opts = {}) {
  const swf = await decompressSwf(input, opts);
  const stats = new Stats();
  if (swf.version >= 6) return { bytes: swf.body, skipped: true, version: swf.version, stats };
  const content = convertTagStream(swf.body, swf.tagsStart, swf.tagsEnd, swf.version, stats);
  const head = swf.body.subarray(8, swf.tagsStart);
  const total = 8 + head.length + content.length;
  const out = concat([bytes([0x46, 0x57, 0x53, 6, ...le32(total)]), head, content]);
  return { bytes: out, skipped: false, version: 6, stats };
}

export const _internal = { convertActions };
