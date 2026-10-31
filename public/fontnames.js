// TTF / OTF / TTC の name テーブルからファミリー名などを取り出す（ブラウザ / Node 両対応）
// 戻り値: { families: string[], fullNames: string[], all: {nameId, platform, lang, text}[] }

function u16(b, p) { return (b[p] << 8) | b[p + 1]; }
function u32(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }

function decodeName(bytes, platform, encoding) {
  try {
    if (platform === 0 || platform === 3) {
      // Unicode / Windows: UTF-16BE
      return new TextDecoder("utf-16be").decode(bytes);
    }
    if (platform === 1) {
      // Macintosh: Roman は ASCII 互換。日本語 (encoding 1) は Shift_JIS
      if (encoding === 1) return new TextDecoder("shift_jis").decode(bytes);
      return new TextDecoder("latin1").decode(bytes);
    }
  } catch { /* 非対応エンコーディング */ }
  return "";
}

function parseOneFont(b, offset) {
  const numTables = u16(b, offset + 4);
  let nameOff = 0, nameLen = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = offset + 12 + i * 16;
    const tagStr = String.fromCharCode(b[rec], b[rec + 1], b[rec + 2], b[rec + 3]);
    if (tagStr === "name") { nameOff = u32(b, rec + 8); nameLen = u32(b, rec + 12); break; }
  }
  if (!nameOff || nameOff + 6 > b.length) return [];
  const count = u16(b, nameOff + 2);
  const storage = nameOff + u16(b, nameOff + 4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (r + 12 > b.length) break;
    const platform = u16(b, r), encoding = u16(b, r + 2), lang = u16(b, r + 4), nameId = u16(b, r + 6);
    const len = u16(b, r + 8), off = u16(b, r + 10);
    const s = storage + off;
    if (s + len > b.length) continue;
    const text = decodeName(b.subarray(s, s + len), platform, encoding).replace(/\0/g, "").trim();
    if (text) out.push({ nameId, platform, lang, text });
  }
  return out;
}

export function parseFontNames(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 12) return { families: [], fullNames: [], all: [] };
  const tagStr = String.fromCharCode(b[0], b[1], b[2], b[3]);
  const records = [];
  if (tagStr === "ttcf") {
    const n = u32(b, 8);
    for (let i = 0; i < Math.min(n, 64); i++) {
      const off = u32(b, 12 + i * 4);
      if (off + 12 <= b.length) records.push(...parseOneFont(b, off));
    }
  } else {
    records.push(...parseOneFont(b, 0));
  }
  const uniq = (arr) => [...new Set(arr)];
  // 英語名を先、その他の言語を後ろに
  const byId = (id) => uniq([
    ...records.filter((r) => r.nameId === id && r.platform === 3 && r.lang === 0x409).map((r) => r.text),
    ...records.filter((r) => r.nameId === id && r.platform === 1).map((r) => r.text),
    ...records.filter((r) => r.nameId === id).map((r) => r.text),
  ]);
  const families = uniq([...byId(16), ...byId(1)]);
  const fullNames = uniq([...byId(4)]);
  return { families, fullNames, all: records };
}
