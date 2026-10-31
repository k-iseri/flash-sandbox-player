// SWF 内のフォント名を置き換える（メモリ上のコピーに対して行い、元ファイルは変更しない）
// 対象タグ: DefineFont2/3（名前）、DefineFontInfo/2（名前）、DefineFont4（名前）、DefineEditText（FontClass）
import { decompressSwf, listTags, decodeSwfString, encodeSwfString } from "./scanner.js";

function u16(b, p) { return b[p] | (b[p + 1] << 8); }
function u32le(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; }

function readRectEnd(b, pos) {
  const nbits = b[pos] >> 3;
  return pos + Math.ceil((5 + 4 * nbits) / 8);
}

function cstrEnd(b, p, end) { let e = p; while (e < end && b[e] !== 0) e++; return e; }

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function tagHeader(code, len) {
  if (len < 0x3f) { const v = (code << 6) | len; return Uint8Array.from([v & 0xff, v >> 8]); }
  const v = (code << 6) | 0x3f;
  return Uint8Array.from([v & 0xff, v >> 8, ...u32le(len)]);
}

// 長さ付き名前（UI8 len + bytes）。Flash と同様に末尾の NUL を含めて数える
function lengthPrefixedName(str, version) {
  let bytes = encodeSwfString(str, version);
  if (bytes.length > 254) bytes = bytes.subarray(0, 254);
  return concat([Uint8Array.from([bytes.length + 1]), bytes, Uint8Array.from([0])]);
}

function patchTag(b, t, version, mapping, changes) {
  switch (t.code) {
    case 48: case 75: { // DefineFont2/3: FontID(2) Flags(1) Lang(1) NameLen(1) Name ...
      const nameLen = b[t.start + 4];
      const old = decodeSwfString(b, t.start + 5, t.start + 5 + nameLen, version);
      const target = mapping[old];
      if (!target) return null;
      changes.push({ tag: t.code === 48 ? "DefineFont2" : "DefineFont3", from: old, to: target });
      return concat([b.subarray(t.start, t.start + 4), lengthPrefixedName(target, version), b.subarray(t.start + 5 + nameLen, t.end)]);
    }
    case 13: case 62: { // DefineFontInfo/2: FontID(2) NameLen(1) Name ...
      const nameLen = b[t.start + 2];
      const old = decodeSwfString(b, t.start + 3, t.start + 3 + nameLen, version);
      const target = mapping[old];
      if (!target) return null;
      changes.push({ tag: t.code === 13 ? "DefineFontInfo" : "DefineFontInfo2", from: old, to: target });
      return concat([b.subarray(t.start, t.start + 2), lengthPrefixedName(target, version), b.subarray(t.start + 3 + nameLen, t.end)]);
    }
    case 91: { // DefineFont4: FontID(2) Flags(1) Name(cstr) ...
      const s = t.start + 3, e = cstrEnd(b, s, t.end);
      const old = decodeSwfString(b, s, e, version);
      const target = mapping[old];
      if (!target) return null;
      changes.push({ tag: "DefineFont4", from: old, to: target });
      return concat([b.subarray(t.start, s), encodeSwfString(target, version), Uint8Array.from([0]), b.subarray(Math.min(e + 1, t.end), t.end)]);
    }
    case 37: { // DefineEditText: ID(2) RECT Flags(2) [FontID(2)] [FontClass(cstr)] ...
      let p = readRectEnd(b, t.start + 2);
      const f1 = b[p], f2 = b[p + 1];
      p += 2;
      if (f1 & 0x01) p += 2;
      if (!(f2 & 0x80)) return null;
      const e = cstrEnd(b, p, t.end);
      const old = decodeSwfString(b, p, e, version);
      const target = mapping[old];
      if (!target) return null;
      changes.push({ tag: "DefineEditText", from: old, to: target });
      return concat([b.subarray(t.start, p), encodeSwfString(target, version), Uint8Array.from([0]), b.subarray(Math.min(e + 1, t.end), t.end)]);
    }
    default:
      return null;
  }
}

/**
 * @param {ArrayBuffer|Uint8Array} input 元の SWF
 * @param {Record<string,string>} mapping { 元のフォント名: 新しいフォント名 }
 * @param {{lzmaDecompress?: Function}} [opts]
 * @returns {Promise<{bytes: Uint8Array, replaced: number, changes: {tag:string, from:string, to:string}[]}>}
 */
export async function rewriteFontNames(input, mapping, opts = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(mapping || {})) {
    if (typeof k === "string" && typeof v === "string" && v.trim() && v !== k) clean[k] = v.trim();
  }
  const swf = await decompressSwf(input, opts);
  const { body, version, tagsStart, tagsEnd } = swf;
  if (!Object.keys(clean).length) return { bytes: body, replaced: 0, changes: [] };

  const tags = listTags(body, tagsStart, tagsEnd);
  const parts = [body.subarray(8, tagsStart)];
  const changes = [];
  let prevEnd = tagsStart;
  for (const t of tags) {
    const hdrStart = prevEnd;
    prevEnd = t.end;
    const patched = patchTag(body, t, version, clean, changes);
    if (patched) parts.push(tagHeader(t.code, patched.length), patched);
    else parts.push(body.subarray(hdrStart, t.end));
  }
  const content = concat(parts);
  const total = 8 + content.length;
  const out = concat([Uint8Array.from([0x46, 0x57, 0x53, version, ...u32le(total)]), content]);
  return { bytes: out, replaced: changes.length, changes };
}
