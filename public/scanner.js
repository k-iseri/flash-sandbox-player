// SWF 静的スキャナー
// SWF を解凍・解析し、ネットワーク通信 / Cookie(SharedObject) / 外部 JS 連携などを行う
// API を参照しているかを調べる。ブラウザと Node.js の両方で動作する ES モジュール。
//
// 判定: "block" = 実行しない / "consent" = ユーザーの明示的な同意があれば実行可
//       / "warn" = 警告付きで実行可 / "allow" = 問題なし
//
// "consent" は AVM1 の getURL（URL を開くだけで、データの読み込みは伴わない）専用。
// 実行時は Ruffle の openUrlMode="deny" により getURL は何もしない。

const TAG_NAMES = {
  0: "End", 1: "ShowFrame", 2: "DefineShape", 7: "DefineButton", 9: "SetBackgroundColor",
  10: "DefineFont", 12: "DoAction", 13: "DefineFontInfo", 26: "PlaceObject2", 34: "DefineButton2",
  37: "DefineEditText", 39: "DefineSprite", 48: "DefineFont2",
  57: "ImportAssets", 59: "DoInitAction", 62: "DefineFontInfo2", 69: "FileAttributes", 70: "PlaceObject3",
  71: "ImportAssets2", 72: "DoABC1", 75: "DefineFont3", 77: "Metadata", 82: "DoABC", 87: "DefineBinaryData",
  91: "DefineFont4",
};
const name_ = (code) => TAG_NAMES[code] || `Tag${code}`;

// 検出カテゴリ（キー）と日本語の説明。UI 側は i18n.js の cat.* で翻訳する
const CAT_JA = {
  http: "HTTP 通信", httpsend: "HTTP 送信", socket: "ソケット通信", tls: "TLS ソケット通信", udp: "UDP 通信",
  serversocket: "待ち受けソケット", p2p: "P2P 通信", cookie: "Flash Cookie", localconn: "他 SWF との通信",
  external: "ブラウザ JS 呼び出し", loader: "外部 SWF/画像の読み込み", rtmp: "RTMP/HTTP 通信", stream: "ストリーミング",
  fileref: "ファイルのアップロード/ダウンロード", upload: "ファイルのアップロード", sound: "外部音声の読み込み",
  policy: "クロスドメインポリシー", crossdomain: "クロスドメイン許可", openurl: "URL を開く",
  openurlDisabled: "URL を開く。再生時は無効化されます", fscommand: "ホストへのコマンド送信",
  urlrequest: "外部リソースの要求", urlvars: "通信用パラメータ",
  cookieSandbox: "Flash Cookie（セーブデータ）。再生中のメモリにだけ保持され、閉じると消えます",
  netpkg: "flash.net パッケージ（通信 / SharedObject）", externalpkg: "flash.external パッケージ（ブラウザ JS 呼び出し）",
};
const apiMsg = (name, cat) => `${name}（${CAT_JA[cat] || cat}）`;
const apiI18n = (name, cat, key = "f.api") => ({ key, params: { name, cat } });

// ---- AVM1 (ActionScript 1/2) -------------------------------------------------
// 強い指標: これらが現れたら実行しない（値はカテゴリキー）
const AVM1_BLOCK = new Map([
  ["LoadVars", "http"], ["XMLSocket", "socket"], ["LocalConnection", "localconn"],
  ["ExternalInterface", "external"], ["MovieClipLoader", "loader"], ["NetConnection", "rtmp"], ["NetStream", "stream"],
  ["FileReference", "fileref"], ["FileReferenceList", "upload"], ["loadSound", "sound"], ["loadPolicyFile", "policy"],
  ["allowDomain", "crossdomain"], ["allowInsecureDomain", "crossdomain"], ["sendAndLoad", "http"],
  ["loadVariables", "http"], ["loadVariablesNum", "http"], ["loadMovie", "loader"], ["loadMovieNum", "loader"],
]);

// ---- AVM2 (ActionScript 3) ---------------------------------------------------
const AVM2_BLOCK_NAMESPACES = new Map([["flash.net", "netpkg"], ["flash.external", "externalpkg"]]);
// flash.net の中で通信を伴わないもの
const AVM2_NET_ALLOW = new Set([
  "registerClassAlias", "getClassByAlias", "ObjectEncoding",
  "IDynamicPropertyOutput", "IDynamicPropertyWriter",
]);
const AVM2_BLOCK_NAMES = new Map([
  ["navigateToURL", "openurl"], ["sendToURL", "httpsend"], ["URLLoader", "http"], ["URLStream", "http"],
  ["URLRequest", "urlrequest"], ["SharedObject", "cookie"], ["ExternalInterface", "external"],
  ["LocalConnection", "localconn"], ["XMLSocket", "socket"], ["SecureSocket", "tls"], ["DatagramSocket", "udp"],
  ["ServerSocket", "serversocket"], ["NetConnection", "rtmp"], ["NetStream", "stream"], ["NetGroup", "p2p"],
  ["FileReference", "fileref"], ["FileReferenceList", "upload"], ["loadPolicyFile", "policy"],
  ["allowDomain", "crossdomain"], ["allowInsecureDomain", "crossdomain"],
]);
const AVM2_WARN_NAMES = new Map([["fscommand", "fscommand"], ["URLVariables", "urlvars"]]);

const URL_SCHEME_RE = /^(https?|ftp|file|javascript|vbscript|mailto|wss?|rtmp[a-z]*):/i;
const BENIGN_URL_RE = /^https?:\/\/(www\.w3\.org|ns\.adobe\.com|www\.adobe\.com|purl\.org|xml\.org)\//i;
const MAX_NESTED_DEPTH = 3;

// ---- ユーティリティ -----------------------------------------------------------

function u16(b, p) { return b[p] | (b[p + 1] << 8); }
function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

function readCString(b, p, end) {
  let e = p;
  while (e < end && b[e] !== 0) e++;
  return { str: latin1(b, p, e), next: Math.min(e + 1, end) };
}

function latin1(b, s, e) {
  let out = "";
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
  return out;
}

function utf8(b, s, e) {
  try { return new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(s, e)); }
  catch { return latin1(b, s, e); }
}

class BitReader {
  constructor(b, pos) { this.b = b; this.pos = pos; this.bit = 0; }
  readUB(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.b.length) throw new Error("bit overrun");
      const bitv = (this.b[this.pos] >> (7 - this.bit)) & 1;
      v = (v * 2) + bitv;
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v;
  }
  readSB(n) {
    if (n === 0) return 0;
    const v = this.readUB(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }
  align() { if (this.bit) { this.bit = 0; this.pos++; } return this.pos; }
}

function readRect(b, pos) {
  const r = new BitReader(b, pos);
  const nbits = r.readUB(5);
  const xmin = r.readSB(nbits), xmax = r.readSB(nbits), ymin = r.readSB(nbits), ymax = r.readSB(nbits);
  return { xmin, xmax, ymin, ymax, next: r.align() };
}

function skipMatrix(r) {
  if (r.readUB(1)) { const n = r.readUB(5); r.readSB(n); r.readSB(n); }
  if (r.readUB(1)) { const n = r.readUB(5); r.readSB(n); r.readSB(n); }
  const n = r.readUB(5); r.readSB(n); r.readSB(n);
}

function skipCxform(r, withAlpha) {
  const hasAdd = r.readUB(1), hasMult = r.readUB(1), n = r.readUB(4);
  const terms = withAlpha ? 4 : 3;
  if (hasMult) for (let i = 0; i < terms; i++) r.readSB(n);
  if (hasAdd) for (let i = 0; i < terms; i++) r.readSB(n);
}

// 解凍（zlib）。末尾にゴミがある SWF でも、必要なバイト数に達したら打ち切って成功扱いにする
async function inflateZlib(data, expectedLen) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("このブラウザは DecompressionStream に対応していないため、圧縮 SWF を検査できません");
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (expectedLen > 0 && total >= expectedLen) { reader.cancel().catch(() => {}); break; }
    }
  } catch (e) {
    if (!(expectedLen > 0 && total >= expectedLen)) throw e;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---- 本体 -------------------------------------------------------------------

class ScanContext {
  constructor(opts) {
    this.findings = [];
    this.opts = opts;
    this.avm1 = false;
    this.avm2 = false;
    this.tagCount = 0;
    this.nested = 0;
    this.fonts = []; // {id, name, tag, device, bold, italic, where}
    this.legacyHighBytes = 0; // バージョン 6 未満の SWF で、文字列タグ内に見つかった非 ASCII バイト数（Shift_JIS の疑い）
  }
  // i18n: { key, params } — UI 側で翻訳するためのキー（message は日本語の既定表示）
  add(level, code, message, where, detail, i18n) {
    // 同じ理由の重複は 1 件にまとめる
    const dedupe = `${level}|${code}|${message}`;
    const existing = this.findings.find((f) => f.dedupe === dedupe);
    if (existing) { existing.count++; return; }
    this.findings.push({ dedupe, level, code, message, where, detail: detail || "", count: 1, key: i18n?.key || "", params: i18n?.params || {} });
  }
  block(code, message, where, detail, i18n) { this.add("block", code, message, where, detail, i18n); }
  consent(code, message, where, detail, i18n) { this.add("consent", code, message, where, detail, i18n); }
  warn(code, message, where, detail, i18n) { this.add("warn", code, message, where, detail, i18n); }
  info(code, message, where, detail, i18n) { this.add("info", code, message, where, detail, i18n); }
}

/**
 * @param {ArrayBuffer|Uint8Array} input SWF ファイル
 * @param {{lzmaDecompress?: (props: Uint8Array, data: Uint8Array, size: number) => Promise<Uint8Array>}} [opts]
 */
export async function scanSwf(input, opts = {}) {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  const ctx = new ScanContext(opts);
  const info = {};
  try {
    await scanSwfBytes(raw, ctx, info, "main", 0);
  } catch (e) {
    const reason = (e && (e.message || e.name)) || String(e) || "不明なエラー";
    ctx.block("parse-error", `SWF の解析に失敗しました: ${reason}`, "main", "", { key: "f.parseError", params: { reason } });
  }
  const levels = ctx.findings.map((f) => f.level);
  const verdict = levels.includes("block") ? "block"
    : levels.includes("consent") ? "consent"
    : levels.includes("warn") ? "warn" : "allow";
  return {
    verdict,
    findings: ctx.findings.map(({ dedupe, ...f }) => f),
    info: { ...info, avm1: ctx.avm1, avm2: ctx.avm2, tagCount: ctx.tagCount, fonts: ctx.fonts, legacyHighBytes: ctx.legacyHighBytes },
  };
}

/**
 * SWF を解凍してヘッダーを読む（スキャンと書き換えの両方で使う）
 * @returns {Promise<{signature:string, version:number, fileLength:number, body:Uint8Array,
 *   rect:object, frameRate:number, frameCount:number, tagsStart:number, tagsEnd:number}>}
 */
export async function decompressSwf(input, opts = {}) {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (raw.length < 8) throw new Error("ファイルが小さすぎます");
  const sig = latin1(raw, 0, 3);
  if (sig !== "FWS" && sig !== "CWS" && sig !== "ZWS") throw new Error("SWF のシグネチャではありません");
  const version = raw[3];
  const fileLength = u32(raw, 4);
  if (fileLength > 512 * 1024 * 1024) throw new Error("宣言されたファイルサイズが大きすぎます");

  let body;
  if (sig === "FWS") {
    body = raw;
  } else if (sig === "CWS") {
    const inflated = await inflateZlib(raw.subarray(8), fileLength - 8);
    body = new Uint8Array(8 + inflated.length);
    body.set(raw.subarray(0, 8), 0);
    body.set(inflated, 8);
  } else {
    if (typeof opts.lzmaDecompress !== "function") {
      const e = new Error("LZMA 圧縮 (ZWS) の SWF を解凍できないため検査できません");
      e.code = "lzma-unsupported";
      throw e;
    }
    if (raw.length < 17) throw new Error("ZWS ヘッダーが不正です");
    const props = raw.subarray(12, 17);
    const inflated = await opts.lzmaDecompress(props, raw.subarray(17), fileLength - 8);
    body = new Uint8Array(8 + inflated.length);
    body.set(raw.subarray(0, 8), 0);
    body.set(inflated, 8);
  }

  const rect = readRect(body, 8);
  const p = rect.next;
  return {
    signature: sig, version, fileLength, body, rect,
    frameRate: u16(body, p) / 256,
    frameCount: u16(body, p + 2),
    tagsStart: p + 4,
    tagsEnd: Math.min(body.length, fileLength || body.length),
  };
}

// SWF 内の文字列（フォント名など）の文字コード: バージョン 6 以降は UTF-8、それ以前は Shift_JIS / Latin-1
export function decodeSwfString(b, s, e, version) {
  while (e > s && b[e - 1] === 0) e--;
  const bytes = b.subarray(s, e);
  if (version >= 6) return utf8(b, s, e);
  let hasHigh = false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) { hasHigh = true; break; }
  if (hasHigh) {
    try { return new TextDecoder("shift_jis", { fatal: true }).decode(bytes); } catch { /* fall through */ }
  }
  return latin1(b, s, e);
}

export function encodeSwfString(str, version) {
  if (version >= 6) return new TextEncoder().encode(str);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); out[i] = c < 256 ? c : 0x3f; }
  return out;
}

// トップレベル / スプライト内のタグ一覧（{code, start, end}）。警告は捨てる
export function listTags(b, start, end) {
  return readTags(b, start, end, { warn() {} }, "");
}

async function scanSwfBytes(raw, ctx, info, where, depth) {
  let swf;
  try {
    swf = await decompressSwf(raw, ctx.opts);
  } catch (e) {
    if (e && e.code === "lzma-unsupported") { ctx.block("lzma-unsupported", e.message, where, "", { key: "f.lzma" }); return; }
    throw e;
  }
  const { signature: sig, version, fileLength, body, rect } = swf;
  info.signature = sig;
  info.version = version;
  info.fileLength = fileLength;
  info.compression = sig === "FWS" ? "none" : sig === "CWS" ? "zlib" : "lzma";

  if (body.length < fileLength) {
    ctx.warn("truncated", `ファイルが宣言サイズより短いです（${body.length} / ${fileLength} バイト）`, where, "",
      { key: "f.truncated", params: { actual: body.length, declared: fileLength } });
  }

  info.width = (rect.xmax - rect.xmin) / 20;
  info.height = (rect.ymax - rect.ymin) / 20;
  info.frameRate = swf.frameRate;
  info.frameCount = swf.frameCount;

  await scanTagStream(body, swf.tagsStart, swf.tagsEnd, ctx, version, where, depth);
}

function readTags(b, start, end, ctx, where) {
  const tags = [];
  let p = start;
  while (p + 2 <= end) {
    const v = u16(b, p); p += 2;
    const code = v >> 6;
    let len = v & 0x3f;
    if (len === 0x3f) {
      if (p + 4 > end) { ctx.warn("bad-tag", "タグヘッダーが途中で終わっています", where, "", { key: "f.badTagHeader" }); break; }
      len = u32(b, p); p += 4;
    }
    if (p + len > end) {
      ctx.warn("bad-tag", `タグ ${TAG_NAMES[code] || code} が宣言長より短いです`, where, "", { key: "f.badTagLength", params: { tag: TAG_NAMES[code] || code } });
      len = end - p;
    }
    tags.push({ code, start: p, end: p + len });
    p += len;
    if (code === 0) break;
  }
  return tags;
}

async function scanTagStream(b, start, end, ctx, version, where, depth) {
  const tags = readTags(b, start, end, ctx, where);
  for (const t of tags) {
    ctx.tagCount++;
    const name = TAG_NAMES[t.code] || `Tag${t.code}`;
    const here = `${where}/${name}`;
    // 旧バージョン (SWF5 以前) の文字列タグに非 ASCII バイトがあれば Shift_JIS の可能性として数える
    if (version < 6 && (t.code === 37 || t.code === 12 || t.code === 59 || t.code === 13 || t.code === 48 || t.code === 43 || t.code === 56)) {
      for (let i = t.start; i < t.end; i++) { const c = b[i]; if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) ctx.legacyHighBytes++; }
    }
    try {
      switch (t.code) {
        case 69: { // FileAttributes
          const flags = b[t.start];
          if (flags & 0x08) ctx.avm2 = true;
          if (flags & 0x01) ctx.warn("use-network", "FileAttributes.UseNetwork が設定されています（ネットワークサンドボックスを要求）", here, "", { key: "f.useNetwork" });
          break;
        }
        case 12: // DoAction
          ctx.avm1 = true;
          scanAvm1Actions(b, t.start, t.end, ctx, here);
          break;
        case 59: // DoInitAction: SpriteID(2) + actions
          ctx.avm1 = true;
          scanAvm1Actions(b, t.start + 2, t.end, ctx, here);
          break;
        case 7: // DefineButton
          ctx.avm1 = true;
          scanDefineButton(b, t, ctx, here);
          break;
        case 34: // DefineButton2
          ctx.avm1 = true;
          scanDefineButton2(b, t, ctx, here);
          break;
        case 26: // PlaceObject2
        case 70: // PlaceObject3
          scanPlaceObject(b, t, ctx, version, here);
          break;
        case 39: // DefineSprite: ID(2) FrameCount(2) tags...
          await scanTagStream(b, t.start + 4, t.end, ctx, version, here, depth);
          break;
        case 82: { // DoABC: Flags(4) Name(cstring) ABC
          ctx.avm2 = true;
          const { str, next } = readCString(b, t.start + 4, t.end);
          scanAbc(b, next, t.end, ctx, str ? `${here}(${str})` : here);
          break;
        }
        case 72: // DoABC1 (DoABCDefine)
          ctx.avm2 = true;
          scanAbc(b, t.start, t.end, ctx, here);
          break;
        case 57: // ImportAssets: URL(cstring) ...
        case 71: { // ImportAssets2: URL(cstring) Reserved(2) ...
          const { str } = readCString(b, t.start, t.end);
          ctx.block("import-assets", `外部 SWF からアセットをインポートします: ${str}`, here, str, { key: "f.importAssets", params: { url: str } });
          break;
        }
        // ---- フォント情報（置き換え用に名前を収集） ----
        case 48: // DefineFont2: FontID(2) Flags(1) Lang(1) NameLen(1) Name NumGlyphs(2)
        case 75: { // DefineFont3
          const flags = b[t.start + 2];
          const nameLen = b[t.start + 4];
          const name = decodeSwfString(b, t.start + 5, t.start + 5 + nameLen, version);
          const numGlyphs = u16(b, t.start + 5 + nameLen);
          ctx.fonts.push({ id: u16(b, t.start), name, tag: name_(t.code), device: numGlyphs === 0, bold: !!(flags & 1), italic: !!(flags & 2), where: here });
          break;
        }
        case 13: // DefineFontInfo: FontID(2) NameLen(1) Name Flags(1)
        case 62: { // DefineFontInfo2: ... + Lang(1)
          const nameLen = b[t.start + 2];
          const name = decodeSwfString(b, t.start + 3, t.start + 3 + nameLen, version);
          const flags = b[t.start + 3 + nameLen];
          ctx.fonts.push({ id: u16(b, t.start), name, tag: name_(t.code), device: false, bold: !!(flags & 2), italic: !!(flags & 4), where: here });
          break;
        }
        case 91: { // DefineFont4: FontID(2) Flags(1) Name(cstr) [FontData]
          const flags = b[t.start + 2];
          const { str: raw } = readCString(b, t.start + 3, t.end);
          const name = decodeSwfString(b, t.start + 3, t.start + 3 + raw.length, version);
          ctx.fonts.push({ id: u16(b, t.start), name, tag: "DefineFont4", device: !(flags & 4), bold: !!(flags & 1), italic: !!(flags & 2), where: here });
          break;
        }
        case 37: { // DefineEditText: ID(2) RECT Flags(2) [FontID(2)] [FontClass(cstr)] ...
          const r = readRect(b, t.start + 2);
          let p = r.next;
          const f1 = b[p], f2 = b[p + 1];
          p += 2;
          if (f1 & 0x01) p += 2;
          if (f2 & 0x80) {
            const { str: raw } = readCString(b, p, t.end);
            const name = decodeSwfString(b, p, p + raw.length, version);
            ctx.fonts.push({ id: u16(b, t.start), name, tag: "DefineEditText(FontClass)", device: true, bold: false, italic: false, where: here });
          }
          break;
        }
        case 87: { // DefineBinaryData: Tag(2) Reserved(4) Data
          const ds = t.start + 6;
          const head = latin1(b, ds, Math.min(ds + 3, t.end));
          if (head === "FWS" || head === "CWS" || head === "ZWS") {
            if (depth + 1 > MAX_NESTED_DEPTH) {
              ctx.block("nested-too-deep", "埋め込み SWF の入れ子が深すぎるため検査できません", here, "", { key: "f.nestedTooDeep" });
            } else {
              ctx.nested++;
              ctx.info("nested-swf", "埋め込み SWF（DefineBinaryData）を検出し、再帰的に検査しました", here, "", { key: "f.nestedSwf" });
              const sub = {};
              await scanSwfBytes(b.slice(ds, t.end), ctx, sub, `${here}#${ctx.nested}`, depth + 1);
            }
          }
          break;
        }
        default:
          break;
      }
    } catch (e) {
      // 構造解析に失敗したタグは、生バイト列に対する文字列スキャンで補う
      ctx.warn("tag-parse-error", `${name} の構造解析に失敗したため簡易スキャンに切り替えました (${e.message})`, here, "", { key: "f.tagParseError", params: { tag: name, reason: e.message } });
      rawIdentifierScan(b, t.start, t.end, ctx, here);
    }
  }
}

// ---- AVM1 ------------------------------------------------------------------

function scanAvm1Actions(b, start, end, ctx, where) {
  let p = start;
  const strings = [];
  while (p < end) {
    const code = b[p++];
    if (code === 0) break;
    let len = 0;
    if (code >= 0x80) {
      if (p + 2 > end) break;
      len = u16(b, p); p += 2;
    }
    const bs = p, be = Math.min(p + len, end);
    switch (code) {
      case 0x83: { // ActionGetURL: UrlString TargetString
        const { str: url, next } = readCString(b, bs, be);
        const { str: target } = readCString(b, next, be);
        const tgt = target ? `, "${target}"` : "";
        const label = `getURL("${url}"${tgt})`;
        if (/^_level\d+$/i.test(target)) {
          // ターゲットが _levelN の getURL は外部 SWF の読み込み（loadMovieNum 相当）
          ctx.block("getURL-load", `${label}（外部 SWF の読み込み）`, where, url, { key: "f.getURLLoad", params: { url, target: tgt } });
        } else {
          ctx.consent("getURL", `${label}（URL を開く。再生時は無効化されます）`, where, url, { key: "f.getURL", params: { url, target: tgt } });
        }
        break;
      }
      case 0x9a: { // ActionGetURL2
        const flags = b[bs] ?? 0;
        const method = ["なし", "GET", "POST"][flags >> 6] || "?";
        const loadVars = flags & 1, loadTarget = (flags >> 1) & 1;
        if (loadVars || loadTarget) {
          ctx.block("getURL2", `${loadVars ? "loadVariables" : "loadMovie"}（ActionGetURL2, method=${method}）`, where, "",
            { key: loadVars ? "f.loadVariables" : "f.loadMovie", params: { method } });
        } else {
          ctx.consent("getURL2", `getURL（ActionGetURL2, method=${method}。再生時は無効化されます）`, where, "", { key: "f.getURL2", params: { method } });
        }
        break;
      }
      case 0x88: { // ActionConstantPool
        const count = u16(b, bs);
        let q = bs + 2;
        for (let i = 0; i < count && q < be; i++) {
          const { str, next } = readCString(b, q, be);
          strings.push(str); q = next;
        }
        break;
      }
      case 0x96: { // ActionPush
        let q = bs;
        while (q < be) {
          const type = b[q++];
          if (type === 0) { const { str, next } = readCString(b, q, be); strings.push(str); q = next; }
          else if (type === 1 || type === 7) q += 4;
          else if (type === 4 || type === 5 || type === 8) q += 1;
          else if (type === 6) q += 8;
          else if (type === 9) q += 2;
          else if (type === 2 || type === 3) { /* null / undefined */ }
          else break;
        }
        break;
      }
      case 0x8e: // DefineFunction2
      case 0x9b: { // DefineFunction: 関数名のみ収集（本体は後続のアクションとして線形に走査される）
        const { str } = readCString(b, bs, be);
        if (str) strings.push(str);
        break;
      }
      default:
        break;
    }
    p = bs + len;
  }
  checkAvm1Strings(strings, ctx, where);
}

function checkAvm1Strings(strings, ctx, where) {
  const set = new Set(strings);
  for (const s of set) {
    if (AVM1_BLOCK.has(s)) ctx.block("avm1-api", apiMsg(s, AVM1_BLOCK.get(s)), where, s, apiI18n(s, AVM1_BLOCK.get(s)));
    else if (s === "getURL") ctx.consent("avm1-api", apiMsg(s, "openurlDisabled"), where, s, apiI18n(s, "openurlDisabled"));
    // SharedObject（Flash Cookie）: サンドボックス内のメモリにしか保存されないため、同意があれば実行できる
    else if (s === "SharedObject") ctx.consent("avm1-api", apiMsg(s, "cookieSandbox"), where, s, apiI18n(s, "cookieSandbox"));
    else if (s === "fscommand") ctx.warn("avm1-api", apiMsg(s, "fscommand"), where, s, apiI18n(s, "fscommand"));
    else if (URL_SCHEME_RE.test(s) && !BENIGN_URL_RE.test(s)) ctx.warn("url-literal", `URL 文字列を含みます: ${s.slice(0, 80)}`, where, s, { key: "f.urlLiteral", params: { url: s.slice(0, 80) } });
  }
  if (set.has("XML") && (set.has("load") || set.has("send"))) {
    ctx.warn("avm1-xml-load", "XML.load / XML.send（HTTP 通信）の可能性があります", where, "", { key: "f.xmlLoad" });
  }
}

// DefineButton: ButtonId(2) BUTTONRECORD* (0 終端) ACTIONRECORD*
function scanDefineButton(b, t, ctx, where) {
  let p = t.start + 2;
  for (;;) {
    if (p >= t.end) return;
    const flags = b[p++];
    if (flags === 0) break;
    p += 4; // CharacterID(2) PlaceDepth(2)
    const r = new BitReader(b, p);
    skipMatrix(r);
    p = r.align();
  }
  scanAvm1Actions(b, p, t.end, ctx, where);
}

// DefineButton2: ButtonId(2) Flags(1) ActionOffset(2) BUTTONRECORD* BUTTONCONDACTION*
function scanDefineButton2(b, t, ctx, where) {
  const aoPos = t.start + 3;
  const actionOffset = u16(b, aoPos);
  if (!actionOffset) return;
  let p = aoPos + actionOffset;
  for (;;) {
    if (p + 4 > t.end) break;
    const size = u16(b, p);
    const recEnd = size ? Math.min(p + size, t.end) : t.end;
    scanAvm1Actions(b, p + 4, recEnd, ctx, where);
    if (!size) break;
    p += size;
  }
}

// PlaceObject2/3 の CLIPACTIONS を解析する
function scanPlaceObject(b, t, ctx, version, where) {
  const flags = b[t.start];
  const hasClipActions = !!(flags & 0x80);
  const hasClipDepth = !!(flags & 0x40), hasName = !!(flags & 0x20), hasRatio = !!(flags & 0x10);
  const hasCxform = !!(flags & 0x08), hasMatrix = !!(flags & 0x04), hasChar = !!(flags & 0x02);
  if (!hasClipActions) return;
  ctx.avm1 = true;

  let p = t.start + 1;
  let flags2 = 0;
  if (t.code === 70) flags2 = b[p++];
  const hasFilters = !!(flags2 & 0x01), hasBlend = !!(flags2 & 0x02), hasCache = !!(flags2 & 0x04);
  const hasClassName = !!(flags2 & 0x08), hasImage = !!(flags2 & 0x10), hasVisible = !!(flags2 & 0x20);
  const hasBg = !!(flags2 & 0x40);

  p += 2; // Depth
  if (t.code === 70 && (hasClassName || (hasImage && hasChar))) p = readCString(b, p, t.end).next;
  if (hasChar) p += 2;
  if (hasMatrix) { const r = new BitReader(b, p); skipMatrix(r); p = r.align(); }
  if (hasCxform) { const r = new BitReader(b, p); skipCxform(r, true); p = r.align(); }
  if (hasRatio) p += 2;
  if (hasName) p = readCString(b, p, t.end).next;
  if (hasClipDepth) p += 2;
  if (t.code === 70) {
    if (hasFilters) p = skipFilterList(b, p);
    if (hasBlend) p += 1;
    if (hasCache) p += 1;
    if (hasVisible) p += 1;
    if (hasBg) p += 4;
  }

  // CLIPACTIONS: Reserved(2) AllEventFlags(2|4) CLIPACTIONRECORD* EndFlag(2|4)
  const flagSize = version <= 5 ? 2 : 4;
  p += 2 + flagSize;
  while (p + flagSize <= t.end) {
    const evFlags = flagSize === 2 ? u16(b, p) : u32(b, p);
    p += flagSize;
    if (evFlags === 0) break;
    const size = u32(b, p); p += 4;
    let as = p;
    if (flagSize === 4 && (evFlags & 0x20000)) as += 1; // ClipEventKeyPress → KeyCode(1)
    scanAvm1Actions(b, as, Math.min(p + size, t.end), ctx, where);
    p += size;
  }
}

function skipFilterList(b, p) {
  const n = b[p++];
  for (let i = 0; i < n; i++) {
    const id = b[p++];
    switch (id) {
      case 0: p += 23; break;           // DropShadow
      case 1: p += 9; break;            // Blur
      case 2: p += 15; break;           // Glow
      case 3: p += 27; break;           // Bevel
      case 4: case 7: {                 // GradientGlow / GradientBevel
        const c = b[p++]; p += c * 5 + 19; break;
      }
      case 5: {                         // Convolution
        const mx = b[p], my = b[p + 1]; p += 2 + 4 + 4 + mx * my * 4 + 4 + 1; break;
      }
      case 6: p += 80; break;           // ColorMatrix
      default: throw new Error(`未知のフィルター ID ${id}`);
    }
  }
  return p;
}

// 構造解析できなかったタグ向けの簡易スキャン（識別子を生バイト列から探す）
function rawIdentifierScan(b, start, end, ctx, where) {
  const text = latin1(b, start, end);
  const ids = [...AVM1_BLOCK.keys(), ...AVM2_BLOCK_NAMES.keys(), ...AVM2_BLOCK_NAMESPACES.keys()];
  for (const id of ids) {
    const re = new RegExp(`(^|[^A-Za-z0-9_$.])${id.replace(".", "\\.")}(?![A-Za-z0-9_$])`);
    if (re.test(text)) {
      const cat = AVM1_BLOCK.get(id) || AVM2_BLOCK_NAMES.get(id) || AVM2_BLOCK_NAMESPACES.get(id) || id;
      ctx.block("raw-scan", `${apiMsg(id, cat)}（簡易スキャン）`, where, id, apiI18n(id, cat, "f.rawScan"));
    }
  }
  if (/(^|[^A-Za-z0-9_$.])getURL(?![A-Za-z0-9_$])/.test(text)) {
    ctx.consent("raw-scan", `${apiMsg("getURL", "openurlDisabled")}（簡易スキャン）`, where, "getURL", apiI18n("getURL", "openurlDisabled", "f.rawScan"));
  }
  if (/(^|[^A-Za-z0-9_$.])SharedObject(?![A-Za-z0-9_$])/.test(text)) {
    ctx.consent("raw-scan", `${apiMsg("SharedObject", "cookieSandbox")}（簡易スキャン）`, where, "SharedObject", apiI18n("SharedObject", "cookieSandbox", "f.rawScan"));
  }
}

// ---- AVM2 (ABC) ------------------------------------------------------------

class AbcReader {
  constructor(b, pos, end) { this.b = b; this.pos = pos; this.end = end; }
  u8() { if (this.pos >= this.end) throw new Error("ABC overrun"); return this.b[this.pos++]; }
  u30() {
    let result = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    return result >>> 0;
  }
  skip(n) { this.pos += n; if (this.pos > this.end) throw new Error("ABC overrun"); }
}

function scanAbc(b, start, end, ctx, where) {
  const r = new AbcReader(b, start, end);
  r.u8(); r.u8(); r.u8(); r.u8(); // minor, major

  let n = r.u30(); for (let i = 1; i < n; i++) r.u30(); // int pool
  n = r.u30(); for (let i = 1; i < n; i++) r.u30();     // uint pool
  n = r.u30(); if (n > 1) r.skip((n - 1) * 8);          // double pool

  n = r.u30();
  const strings = [""];
  for (let i = 1; i < n; i++) {
    const len = r.u30();
    const s = r.pos;
    r.skip(len);
    strings.push(utf8(b, s, s + len));
  }

  n = r.u30();
  const namespaces = [""];
  for (let i = 1; i < n; i++) { r.u8(); namespaces.push(strings[r.u30()] ?? ""); }

  n = r.u30();
  const nsSets = [[]];
  for (let i = 1; i < n; i++) {
    const c = r.u30();
    const set = [];
    for (let j = 0; j < c; j++) set.push(namespaces[r.u30()] ?? "");
    nsSets.push(set);
  }

  n = r.u30();
  const refs = []; // {ns, name}
  for (let i = 1; i < n; i++) {
    const kind = r.u8();
    switch (kind) {
      case 0x07: case 0x0d: { const ns = namespaces[r.u30()] ?? ""; const name = strings[r.u30()] ?? ""; refs.push({ ns, name }); break; }
      case 0x0f: case 0x10: refs.push({ ns: "", name: strings[r.u30()] ?? "" }); break;
      case 0x11: case 0x12: break;
      case 0x09: case 0x0e: {
        const name = strings[r.u30()] ?? "";
        const set = nsSets[r.u30()] ?? [];
        for (const ns of set) refs.push({ ns, name });
        if (!set.length) refs.push({ ns: "", name });
        break;
      }
      case 0x1b: case 0x1c: r.u30(); break;
      case 0x1d: { r.u30(); const c = r.u30(); for (let j = 0; j < c; j++) r.u30(); break; }
      default: throw new Error(`未知の multiname 種別 0x${kind.toString(16)}`);
    }
  }

  // navigateToURL は「URL を開くだけ」なので AVM1 の getURL と同じく同意制。
  // その引数に使う URLRequest も、navigateToURL があり読み込み系（Loader / Sound）が無ければ同意制にする
  const strSet = new Set(strings);
  const hasNav = strSet.has("navigateToURL");
  const hasLoaderOrSound = refs.some((r) => (r.ns === "flash.display" && r.name === "Loader") || (r.ns === "flash.media" && r.name === "Sound"));
  const consentFor = (name) => {
    if (name === "navigateToURL") return "openurlDisabled";
    if (name === "URLRequest" && hasNav && !hasLoaderOrSound) return "urlrequest";
    if (name === "SharedObject") return "cookieSandbox"; // サンドボックス内メモリのみに保存される
    return null;
  };

  // 1) 名前空間 + 名前で判定
  for (const { ns, name } of refs) {
    if (AVM2_BLOCK_NAMESPACES.has(ns)) {
      if (ns === "flash.net" && AVM2_NET_ALLOW.has(name)) continue;
      const full = `${ns}.${name}`;
      const cc = ns === "flash.net" ? consentFor(name) : null;
      if (cc) { ctx.consent("avm2-api", apiMsg(full, cc), where, full, apiI18n(full, cc)); continue; }
      const cat = AVM2_BLOCK_NAMES.get(name) || AVM2_BLOCK_NAMESPACES.get(ns);
      ctx.block("avm2-api", apiMsg(full, cat), where, full, apiI18n(full, cat));
    } else if (AVM2_BLOCK_NAMES.has(name) && (ns === "" || ns.startsWith("flash."))) {
      const cc = consentFor(name);
      if (cc) ctx.consent("avm2-api", apiMsg(name, cc), where, name, apiI18n(name, cc));
      else ctx.block("avm2-api", apiMsg(name, AVM2_BLOCK_NAMES.get(name)), where, name, apiI18n(name, AVM2_BLOCK_NAMES.get(name)));
    } else if (ns === "flash.system" && AVM2_WARN_NAMES.has(name)) {
      ctx.warn("avm2-api", apiMsg(name, AVM2_WARN_NAMES.get(name)), where, name, apiI18n(name, AVM2_WARN_NAMES.get(name)));
    }
  }
  // 2) 文字列プール単体でも判定（名前空間解決を迂回する書き方への保険）
  for (const [ns, cat] of AVM2_BLOCK_NAMESPACES) {
    if (strSet.has(ns) && !refs.some((x) => x.ns === ns)) ctx.block("avm2-api", `${apiMsg(ns, cat)}（文字列プール）`, where, ns, apiI18n(ns, cat, "f.apiPool"));
  }
  for (const [name, cat] of AVM2_BLOCK_NAMES) {
    if (name === "URLRequest") continue; // 単体では一般的すぎるため名前空間付きのみ
    if (!strSet.has(name)) continue;
    if (name === "navigateToURL") ctx.consent("avm2-api", apiMsg(name, "openurlDisabled"), where, name, apiI18n(name, "openurlDisabled"));
    else if (name === "SharedObject") ctx.consent("avm2-api", apiMsg(name, "cookieSandbox"), where, name, apiI18n(name, "cookieSandbox"));
    else ctx.block("avm2-api", apiMsg(name, cat), where, name, apiI18n(name, cat));
  }
  for (const [name, cat] of AVM2_WARN_NAMES) if (strSet.has(name)) ctx.warn("avm2-api", apiMsg(name, cat), where, name, apiI18n(name, cat));
  for (const s of strSet) {
    if (URL_SCHEME_RE.test(s) && !BENIGN_URL_RE.test(s)) {
      ctx.warn("url-literal", `URL 文字列を含みます: ${s.slice(0, 80)}`, where, s, { key: "f.urlLiteral", params: { url: s.slice(0, 80) } });
    }
  }
}

export const _internal = { readTags, scanAvm1Actions, scanAbc, inflateZlib };
// 変換モジュール（swfconvert.js など）が使う低レベル部品
export { BitReader, readRect, skipMatrix, skipCxform, skipFilterList, readCString };
