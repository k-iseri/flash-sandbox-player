// sandbox iframe 内で動くプレイヤー制御スクリプト
// 親ページから postMessage で受け取った SWF バイト列を Ruffle で再生する。
(() => {
  "use strict";

  // sandbox 属性により自身の origin は opaque（"null"）だが、URL 上のオリジンは分かるので
  // 親（同じサーバーから配信されたホストページ）からのメッセージだけを受け付ける。
  const EXPECTED_PARENT_ORIGIN = new URL(location.href).origin;
  const CONFIG = window.RufflePlayer?.config ?? {};

  const container = document.getElementById("container");
  const message = document.getElementById("message");
  let player = null;

  // iOS 17+ / Safari: Web Audio をサイレントスイッチの影響を受けない「再生」カテゴリにする（Ruffle も同じ設定をするが先に行う）
  try { if ("audioSession" in navigator) navigator.audioSession.type = "playback"; } catch { /* ignore */ }

  // iOS では、ユーザー操作中に HTML の <audio> を一度再生すると音声セッションが「再生」に切り替わり、
  // サイレントスイッチが入っていても Web Audio が鳴るようになる（audioSession API が無い iOS 16 以前の対策）。
  // Ruffle は audioSession がある環境ではこの処理を省くが、iframe 内では効かない可能性があるため自前でも行う。
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try { if ("audioSession" in navigator) navigator.audioSession.type = "playback"; } catch { /* ignore */ }
    try {
      // 16bit / 44.1kHz の完全な無音を 20ms だけ。短く・デコード精度の高い形式にして「ブッ」という音が出にくくする
      const rate = 44100, n = Math.round(rate * 0.02);
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
      // サンプルはすべて 0（ArrayBuffer の初期値）
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      const el = new Audio(url);
      el.setAttribute("playsinline", "");
      el.volume = 0.01; // iOS では無視されるが、他ブラウザでの保険
      const done = () => { URL.revokeObjectURL(url); };
      el.play().then(done, done);
    } catch { /* ignore */ }
  }
  for (const ev of ["touchend", "click", "keydown"]) document.addEventListener(ev, unlockAudio, { capture: true, passive: true });

  // Ruffle のミュート解除オーバーレイ（音声コンテキストが suspended の間だけ表示される）を監視し、親に状態を知らせる
  let audioTimer = null;
  function watchAudio() {
    if (audioTimer) clearInterval(audioTimer);
    let last = null, ticks = 0;
    audioTimer = setInterval(() => {
      const ov = player?.shadowRoot?.querySelector("#unmute-overlay");
      const suspended = !!ov && ov.style.display === "block";
      if (suspended !== last) { last = suspended; post({ type: "audio", suspended }); }
      if (!suspended && ticks > 2) { clearInterval(audioTimer); audioTimer = null; }
      if (++ticks > 600) { clearInterval(audioTimer); audioTimer = null; }
    }, 500);
  }

  // 表示言語（親ページが ?lang= で渡す。文言は 3 つだけなのでここに持つ）
  const MSG = {
    ja: { loading: "読み込み中…", failed: "再生に失敗しました: {msg}", ruffle: "Ruffle の読み込みに失敗しました", init: "プレイヤーを初期化しています…" },
    en: { loading: "Loading…", failed: "Playback failed: {msg}", ruffle: "Failed to load Ruffle", init: "Initializing the player…" },
    "zh-Hans": { loading: "加载中…", failed: "播放失败: {msg}", ruffle: "Ruffle 加载失败", init: "正在初始化播放器…" },
    "zh-Hant": { loading: "載入中…", failed: "播放失敗: {msg}", ruffle: "Ruffle 載入失敗", init: "正在初始化播放器…" },
    ko: { loading: "불러오는 중…", failed: "재생 실패: {msg}", ruffle: "Ruffle을 불러오지 못했습니다", init: "플레이어 초기화 중…" },
    es: { loading: "Cargando…", failed: "Falló la reproducción: {msg}", ruffle: "No se pudo cargar Ruffle", init: "Inicializando el reproductor…" },
    fr: { loading: "Chargement…", failed: "Échec de la lecture : {msg}", ruffle: "Impossible de charger Ruffle", init: "Initialisation du lecteur…" },
    de: { loading: "Wird geladen…", failed: "Wiedergabe fehlgeschlagen: {msg}", ruffle: "Ruffle konnte nicht geladen werden", init: "Player wird initialisiert…" },
    pt: { loading: "Carregando…", failed: "Falha na reprodução: {msg}", ruffle: "Não foi possível carregar o Ruffle", init: "Inicializando o player…" },
    ru: { loading: "Загрузка…", failed: "Сбой воспроизведения: {msg}", ruffle: "Не удалось загрузить Ruffle", init: "Инициализация плеера…" },
  };
  let lang = new URLSearchParams(location.search).get("lang") || "en";
  if (!MSG[lang]) lang = "en";
  const m = (k, p) => { let s = (MSG[lang] || MSG.en)[k] || MSG.en[k]; if (p) for (const [a, b] of Object.entries(p)) s = s.split(`{${a}}`).join(String(b)); return s; };
  message.textContent = m("init");

  function post(msg) {
    // 親の origin は分かっているので明示する
    window.parent.postMessage(msg, EXPECTED_PARENT_ORIGIN);
  }

  function showMessage(text, isError) {
    message.textContent = text;
    message.classList.toggle("error", !!isError);
    message.classList.toggle("hidden", !text);
  }

  // Ruffle の「クリックでミュートを解除」は幅 512 の SVG に 60px の文字で描かれるため、
  // 日本語だと左右が見切れる。shadow DOM にスタイルを足して文字を小さくし、はみ出しも許可する。
  function fixOverlayText(el) {
    const root = el.shadowRoot;
    if (!root) return;
    const style = document.createElement("style");
    style.textContent = [
      "#unmute-overlay-svg { overflow: visible; }",
      "#unmute-text { font-size: 34px; font-family: system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif; stroke: none; }",
    ].join("\n");
    root.appendChild(style);
  }

  let fontUrls = [];
  const FONT_SLOTS = new Set(["sans", "serif", "typewriter", "japaneseGothic", "japaneseGothicMono", "japaneseMincho"]);
  const GAMEPAD_BUTTONS = new Set(["south", "east", "north", "west", "left-trigger", "left-trigger-2", "right-trigger", "right-trigger-2", "select", "start", "dpad-up", "dpad-down", "dpad-left", "dpad-right"]);

  // ---- キーボードの置き換え -------------------------------------------------------
  // 親から渡された表に従い、押されたキーを別のキーとして Ruffle に届ける。
  // window の capture 段階で元のイベントを止め、置き換えたイベントをプレイヤー要素に投げ直す。
  const keymap = new Map(); // code -> { code, key }
  let remapInstalled = false;
  function remapKey(e) {
    if (e.__remapped || !player) return;
    const m = keymap.get(e.code);
    if (!m) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const ev = new KeyboardEvent(e.type, {
      key: m.key, code: m.code, bubbles: true, cancelable: true, repeat: e.repeat,
      shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
    });
    ev.__remapped = true;
    player.dispatchEvent(ev);
  }
  function setKeymap(rows) {
    keymap.clear();
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (r && typeof r.from === "string" && typeof r.toCode === "string" && typeof r.toKey === "string" && r.from !== r.toCode) {
          keymap.set(r.from, { code: r.toCode, key: r.toKey });
        }
      }
    }
    if (keymap.size && !remapInstalled) {
      window.addEventListener("keydown", remapKey, true);
      window.addEventListener("keyup", remapKey, true);
      remapInstalled = true;
    }
  }

  // 親から受け取ったフォント設定を Ruffle の設定に変換する（フォント本体は blob: URL で渡す）
  function buildFontOptions(fc) {
    for (const u of fontUrls) URL.revokeObjectURL(u);
    fontUrls = [];
    const out = { deviceFontRenderer: "canvas", fontSources: [], defaultFonts: {}, gamepadButtonMapping: {} };
    setKeymap(fc && fc.keymap);
    if (!fc || typeof fc !== "object") return out;
    if (fc.renderer === "embedded") out.deviceFontRenderer = "embedded";
    if (fc.gamepadButtonMapping && typeof fc.gamepadButtonMapping === "object") {
      for (const [btn, code] of Object.entries(fc.gamepadButtonMapping)) {
        if (GAMEPAD_BUTTONS.has(btn) && Number.isInteger(code) && code > 0 && code < 256) out.gamepadButtonMapping[btn] = code;
      }
    }
    if (Array.isArray(fc.fonts)) {
      for (const f of fc.fonts) {
        if (f && f.data instanceof ArrayBuffer && f.data.byteLength > 0) {
          const url = URL.createObjectURL(new Blob([f.data], { type: "font/ttf" }));
          fontUrls.push(url);
        }
      }
      out.fontSources = [...fontUrls];
    }
    if (fc.defaultFonts && typeof fc.defaultFonts === "object") {
      for (const [slot, names] of Object.entries(fc.defaultFonts)) {
        if (!FONT_SLOTS.has(slot) || !Array.isArray(names)) continue;
        const list = names.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim());
        if (list.length) out.defaultFonts[slot] = list;
      }
    }
    return out;
  }

  async function playBytes(data, name, fontConfig) {
    if (player) {
      try { player.remove(); } catch { /* ignore */ }
      player = null;
    }
    const ruffle = window.RufflePlayer?.newest?.();
    if (!ruffle) throw new Error("Ruffle を初期化できませんでした");

    player = ruffle.createPlayer();
    player.id = "ruffle";
    container.replaceChildren(player);
    fixOverlayText(player);

    const api = player.ruffle();
    api.config = { ...CONFIG };

    await api.load({
      data,
      swfFileName: name || "movie.swf",
      // load() のオプションは設定としても解釈されるため、ここでも明示する
      allowNetworking: "none",
      openUrlMode: "deny",
      allowScriptAccess: false,
      credentialAllowList: [],
      socketProxy: [],
      autoplay: "on",
      ...buildFontOptions(fontConfig),
    });
    return api;
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window.parent) return;
    if (e.origin !== EXPECTED_PARENT_ORIGIN) return;
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "play") {
      if (!(msg.data instanceof ArrayBuffer)) return;
      showMessage(m("loading"));
      try {
        await playBytes(msg.data, typeof msg.name === "string" ? msg.name : "movie.swf", msg.fontConfig);
        showMessage("");
        post({ type: "loaded" });
        watchAudio();
      } catch (err) {
        showMessage(m("failed", { msg: err?.message ?? err }), true);
        post({ type: "error", message: String(err?.message ?? err) });
      }
    } else if (msg.type === "lang") {
      if (typeof msg.lang === "string" && MSG[msg.lang]) lang = msg.lang;
    } else if (msg.type === "stop") {
      if (player) { player.remove(); player = null; }
      showMessage("");
    }
  });

  // Ruffle のパニック（致命的エラー）も親へ伝える
  window.addEventListener("error", (ev) => {
    post({ type: "error", message: String(ev.message || "unknown error") });
  });

  if (window.RufflePlayer?.newest) {
    showMessage("");
    post({ type: "ready" });
  } else {
    showMessage(m("ruffle"), true);
    post({ type: "error", message: m("ruffle") });
  }
})();
