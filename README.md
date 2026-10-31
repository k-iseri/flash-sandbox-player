# SWF Sandbox Player

サポートの終了した Adobe Flash の SWF ファイルを、ブラウザにドラッグ＆ドロップするだけで再生できるプレイヤーです。手元の PC でもサーバー上でも動かせます。
再生エンジンには [Ruffle](https://ruffle.rs) を使い、**外部サイトへの通信や Cookie（SharedObject）へのアクセスを行う SWF は実行しません**。

## 使い方

```bash
npm install     # Ruffle と LZMA デコーダーを取得
npm start       # http://127.0.0.1:8787/ で起動
```

ブラウザで `http://127.0.0.1:8787/` を開き、`.swf` をドロップ（またはファイル選択）してください。
ポートは `PORT=9000 npm start` のように変更できます。

対応ブラウザ: Chrome / Edge 113+, Firefox 113+, Safari 16.4+（`DecompressionStream` が必要）。

表示言語は右上のセレクトで切り替えられます（日本語・英語・簡体字・繁体字・韓国語・スペイン語・フランス語・ドイツ語・ポルトガル語・ロシア語）。初回はブラウザの言語設定から自動選択され、選択はブラウザに記憶されます。文言は `public/i18n.js` にまとめてあり、言語を追加する場合はそこに辞書を足すだけです。

### Vercel へのデプロイ

静的サイトとしてデプロイします。`vercel.json` にビルド設定と CSP などのヘッダーを定義済みです。

1. GitHub にこのリポジトリを push する。
2. Vercel のダッシュボードで **Add New → Project** からリポジトリを取り込む（Framework Preset は Other のまま）。`vercel.json` の `buildCommand`（`npm run build`）と `outputDirectory`（`dist`）が自動で使われる。
3. Deploy を押す。以降は `main` への push ごとに自動デプロイされる。

独自ドメインで公開する場合は、`vercel.json` の `/player.html` の CSP に書かれている `https://flash-sandbox-player.vercel.app` をそのドメインに置き換えてください（Safari はサンドボックス iframe 内で CSP の `'self'` を解決できないことがあるため、オリジンを明示しています）。

CLI を使う場合は `npx vercel`（初回はログインとプロジェクト作成の対話）→ `npx vercel --prod`。

手元で Vercel と同じヘッダーで確認するには次を実行します。

```bash
npm run build          # dist/ を生成（public + Ruffle + LZMA + fonts + fonts.json）
npm run serve:dist     # http://127.0.0.1:8787/ で vercel.json のヘッダーを適用して配信
```

### 自前サーバーへのデプロイ

既定では 127.0.0.1 にしかバインドしません。公開する場合は次のようにします。

```bash
HOST=0.0.0.0 PORT=8787 node server.js
```

- HTTPS を終端するリバースプロキシ（nginx, Caddy など）の背後に置いてください。CSP は `'self'` ベースなので、プロキシ経由のオリジンでもそのまま動作します。
- 依存は Ruffle と LZMA-JS だけで、データベースや外部 API は使いません。SWF もフォントもブラウザ内で処理され、サーバーには送信されません。
- `fonts/` に置いたフォントファイルは静的ファイルとして配信されます（他サイトからの直リンクは `Cross-Origin-Resource-Policy: same-origin` で拒否）。一覧表示にはサーバーが解析したファミリー名だけを使い、フォント本体は利用者が有効にして再生するときに初めてダウンロードされます。再配布可能なライセンスのフォントだけを置いてください。
- 同じ内容は Node.js なしでも配信できます。`public/` と `node_modules/@ruffle-rs/ruffle`（`/ruffle/` として）、`node_modules/lzma/src/lzma-d-min.js`（`/vendor/` として）を静的ホスティングに置き、`server.js` と同じ CSP ヘッダーを設定してください。`/fonts.json` は `{"fonts":[...]}` 形式の静的ファイルで代用できます。

## セキュリティ設計（多層防御）

| 層 | 内容 |
| --- | --- |
| 1. 静的スキャン | 再生前に SWF を解凍・解析し、AVM1（AS1/2）のバイトコードと AVM2（AS3）の ABC 定数プールを調べます。通信・Cookie・外部連携 API への参照があれば **実行しません**。 |
| 2. Ruffle の設定 | `allowNetworking: "none"`（通信 API を無効化）、`openUrlMode: "deny"`（URL を開かない）、`allowScriptAccess: false`（ExternalInterface 無効）。 |
| 3. sandbox iframe | プレイヤーは `sandbox="allow-scripts"` の iframe で動作します。`allow-same-origin` を付けないため opaque origin となり、Cookie / localStorage / 親ページの DOM に触れません。 |
| 4. CSP | ホストページは `connect-src 'none'`、プレイヤーページは同一サーバーへの接続のみ許可。外部への fetch / XHR / WebSocket はブラウザが遮断します。 |
| 5. サーバー | 既定では 127.0.0.1 のみで待ち受け（`HOST` で変更可）。`public/` と Ruffle 本体・フォント以外は配信せず、パストラバーサルを防止。`X-Frame-Options`, `nosniff`, `Referrer-Policy: no-referrer` などを付与。 |

SWF ファイルはブラウザ内だけで処理され、サーバーにも外部にも送信されません。

### 判定ルール

**実行しない（block）**

- AVM1: `loadMovie` / `loadVariables`（ActionGetURL2 の読み込みフラグ、または `_levelN` 宛ての getURL）、`LoadVars`, `XMLSocket`, `LocalConnection`, `ExternalInterface`, `MovieClipLoader`, `NetConnection`, `NetStream`, `FileReference`, `Sound.loadSound`, `Security.allowDomain` / `loadPolicyFile`, `sendAndLoad`
- AVM2: `flash.net.*`（`registerClassAlias` 等の非通信 API を除く）、`flash.external.*`、`navigateToURL`, `sendToURL`, `URLLoader`, `URLStream`, `ExternalInterface`, `LocalConnection`, `Socket` 系, `NetConnection`, `NetStream`, `FileReference`, `Security.allowDomain` / `loadPolicyFile`
- `ImportAssets` / `ImportAssets2` タグ（外部 SWF からのインポート）
- `DefineBinaryData` に埋め込まれた SWF も再帰的に検査（入れ子 3 段まで）
- 検査できないもの（破損、LZMA を解凍できない、入れ子が深すぎる）

**同意があれば実行（consent）** — 「同意する」ボタンを押したときだけ再生

- URL を開くだけの処理（AVM1 の `getURL`、AS3 の `navigateToURL` とその引数の `URLRequest`）や、Flash Cookie（`SharedObject`）のみを含む SWF。SharedObject の保存先はサンドボックス iframe 内のメモリだけで（Ruffle は localStorage に触れないためメモリに退避する）、再生を閉じると消えます。ホストの Cookie には届きません。再生時は Ruffle の `openUrlMode: "deny"` により何も起きません。`Loader` / `Sound` / `URLLoader` など読み込みを伴うものが一緒にあれば block のままで、同意しても実行できません。

**警告付きで実行（warn）** — 自動再生せず、確認ボタンを押したときだけ再生

- `fscommand`、`URLVariables`、`XML` + `load`/`send` の組み合わせ、URL 文字列のみ、`FileAttributes.UseNetwork` フラグ

**問題なし（allow）** — 自動再生

検査でスクリプトのすべての経路を追えるわけではないため、静的スキャンは「入口」であり、実行時の保護（Ruffle 設定 + sandbox + CSP）が最後の砦です。

### 制限事項

- 外部 SWF / 画像 / XML を読み込んで動くコンテンツ（複数ファイル構成のゲームなど）は、性質上「通信」と判定され実行できません。
- セーブデータ（SharedObject）を使うゲームも実行できません（要件どおり Cookie 相当を遮断するため）。
- 判定は保守的です。独自クラスに `Socket` のような名前を付けていると誤検知することがあります。

## フォント（文字化け・文字が出ない場合）

Ruffle 内蔵のフォントには日本語が含まれないため、SWF に埋め込まれていないフォント（デバイスフォント）で書かれた
日本語テキストは、そのままでは表示されません。画面左の **フォント設定** で対処できます。

| 方法 | 内容 |
| --- | --- |
| ブラウザのフォントを使う（既定） | Ruffle の `deviceFontRenderer: "canvas"`。PC にインストール済みのフォント（MS ゴシック等）で描画します。SWF が指定するフォントがなければブラウザの既定フォントになります。 |
| フォントファイルを読み込む | `.ttf` / `.otf` / `.ttc` を画面にドロップするか `fonts/` フォルダーに置くと一覧に出ます。チェックしたフォントが Ruffle に渡されます（`fontSources`）。「既定フォント」で `_sans` / `_ゴシック` などの種別ごとにどのフォントを使うか指定できます（`defaultFonts`）。 |
| SWF 内のフォント名を置き換える | 検査結果に出た SWF 内のフォント名ごとに、置き換え先の名前を指定できます。**同意のチェック** を入れたときだけ、メモリ上のコピーで DefineFont2/3・DefineFontInfo・DefineFont4・DefineEditText のフォント名を書き換えて再生します。元のファイルは変更しません。 |

Ruffle はフォントファイルを **英語のファミリー名**（例: `MS Gothic`, `BIZ UDGothic`）で登録するため、置き換え先にはその名前を使います（一覧に表示されます）。

### SWF バージョン 5 以前の文字化け（Shift_JIS）

古い SWF（バージョン 5 以前）は文字列を OS の文字コード（日本語 Windows では Shift_JIS）で持っていますが、
Ruffle は Latin-1 として解釈するため「uƒqƒbƒgv‚Í…」のように化けます。これはフォントでは直りません。

フォント設定の **文字コード** にある同意チェックを入れると、メモリ上のコピーで次の変換を行ってから再生します（元ファイルは変更しません）。

- DefineEditText の文字列、フレームラベル、ExportAssets、インスタンス名を Shift_JIS → UTF-8 に変換
- DefineFont2 / DefineFontInfo のフォント名と、ShiftJIS フラグ付きコードテーブルを Unicode に変換
- AVM1 バイトコード内の文字列を変換し、長さの変化に合わせて Jump / If / DefineFunction / With / Try のオフセットを再計算
- PlaceObject2 のクリップアクションをバージョン 6 形式（32bit イベントフラグ）に拡張
- SWF バージョンを 6 として出力

スクリプトの分岐先が命令境界にないなど安全に変換できない箇所は元のまま残し、件数を表示します。
バージョンが 6 に上がることで挙動が変わる可能性はありますが、ほとんどの SWF5 コンテンツは問題なく動作します。

## 操作設定

- **キーボードの置き換え**: 押したキーを別のキーとして SWF に伝えます（例: WASD を矢印キーに、Z / X を Space / Enter に）。プレイヤー iframe 内で元のキーイベントを止め、置き換えたイベントを Ruffle に投げ直します。
- **ゲームパッド**: 各ボタンに SWF へ伝えるキーを割り当てます（Ruffle の `gamepadButtonMapping`）。ブラウザが Gamepad API で認識するパッドが対象です。

## フォントの自動割り当て

「この SWF のフォント名の置き換え」の **自動で割り当て** を押すと、読み込み済みフォントの中から候補を選んで空欄を埋めます。SWF 内のフォント名が読み込み済みフォントの別名（例: `ＭＳ ゴシック` → msgothic.ttc の `MS Gothic`）に一致すればそれを、なければ名前から種別（ゴシック / 明朝 / 等幅）を推定して選びます。未設定の既定フォントも同時に埋めます。候補は入力欄のプレースホルダーにも表示されます。

## テスト

```bash
npm test                     # スキャナーの単体テスト（合成 SWF 44 ケース）
npm start &                  # サーバーを起動しておいてから
node test/browser.test.js    # ヘッドレス Chrome/Edge による E2E（再生・隔離・拒否を確認）
npm i --no-save playwright && npx playwright install webkit
node test/webkit.test.js     # WebKit（Safari 相当）でファイル選択・再生・同意フローを確認（--url で本番も可）
```

`npm test` を実行すると `test/samples/` に動作確認用の SWF（良性 / 拒否 / 警告）が生成されます。

## 構成

```
server.js              依存なしの静的サーバー（CSP・セキュリティヘッダー付き）
public/index.html      ホストページ（D&D、検査結果の表示）
public/app.js          ファイル受け取り → scanner → sandbox iframe へ postMessage
public/scanner.js      SWF 静的スキャナー（ブラウザ / Node 両対応）
public/player.html     sandbox iframe 内のプレイヤーページ
public/player-config.js  Ruffle の制限付き設定
public/player.js       Ruffle の生成と SWF バイト列の読み込み
test/scanner.test.js   スキャナーの単体テスト
test/browser.test.js   ヘッドレスブラウザによる E2E テスト
```

## ライセンス

このリポジトリのコードは MIT。Ruffle は MIT / Apache-2.0、LZMA-JS は MIT で配布されています。
