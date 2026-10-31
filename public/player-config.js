// Ruffle のグローバル設定（ruffle.js より先に読み込む）
// 通信・URL オープン・ブラウザ JS 連携を Ruffle のレベルでも無効化する。
window.RufflePlayer = window.RufflePlayer || {};
window.RufflePlayer.config = Object.freeze({
  publicPath: "/ruffle/",
  polyfills: false,            // ページ内の <object>/<embed> を勝手に置き換えない

  // --- セキュリティ ---
  allowNetworking: "none",     // URLLoader / Socket / navigateToURL などの通信 API をすべて無効化
  openUrlMode: "deny",         // getURL / navigateToURL による URL オープンを拒否
  allowScriptAccess: false,    // ExternalInterface（JS 呼び出し）を無効化
  credentialAllowList: [],     // 資格情報を送る先を一切許可しない
  socketProxy: [],             // Socket 用プロキシを設定しない
  upgradeToHttps: true,
  showSwfDownload: false,

  // --- フォント ---
  // "canvas": 埋め込まれていないフォント（デバイスフォント）をブラウザ経由で PC のフォントで描画する。
  // Ruffle 内蔵フォントは日本語を含まないため、既定でこちらを使う。ホストページの設定で切り替え可能。
  deviceFontRenderer: "canvas",
  fontSources: [],
  defaultFonts: {},

  // --- 再生 ---
  autoplay: "on",
  unmuteOverlay: "visible",
  letterbox: "on",
  scale: "showAll",
  wmode: "window",
  allowFullscreen: true,
  contextMenu: "on",
  warnOnUnsupportedContent: true,
  logLevel: "warn",
  playerRuntime: "flashPlayer",
});
