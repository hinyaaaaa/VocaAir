# HANDOFF — VocaAir

このドキュメントは、VocaAir（航空会社モチーフの単語帳アプリ）のUI全面リデザイン作業の引き継ぎメモです。次にこのプロジェクトを触る人（未来のhinya、または別のセッションのClaude）が、方針を再確認せずに続きから作業できることを目的としています。

リポジトリ: `hinyaaaaa/VocaAir`

## 1. 全体像

VocaAirは、Excelから単語をインポートしてSRS（間隔反復）で復習する単語帳アプリ。UIは「航空会社の搭乗体験」を一貫したモチーフにしている。

- 単語帳選択 = 搭乗手続き（チェックイン）
- 学習セッション = フライト中
- 学習を**はじめるたびに**、単語帳ごとにランダムな実在の目的地（都市・国・地域）へ「移動」し、その土地の実写真が学習画面の背景になる
- 結果画面は「到着」と「次はどこへ」のプレビュー

デザイン言語は「暗い背景の上のリキッドグラス（すりガラス）」で統一。旧バージョンにあった、明るい紙質カードとの混在（統一感のなさ）は解消済み。

## 2. ファイル構成

**同じフォルダに全て置くこと。** `<script src>`のみ（`type="module"`なし）。ただしService Worker・通知はHTTPS（GitHub Pages等）でのみ動く（`file://`では景色の取得とオフライン保存以外は無効）。

```
index.html            … 構造のみ
styles.css            … 全スタイル（フォントは明朝体 Zen Old Mincho、太字は最大600）
app.js                … データ層・SRS・インポート・出題エンジン・目的地(current/next)管理
scenery-data.js       … 景色の基準地点248件（名前・飾りコード・緯度経度）。自動生成物
scenery.js            … 景色の取得/絞り込み/オフライン保存/表示（window.Scenery）
notify.js             … 通知（window.Notify）。設定画面と連動
config.js             … vapidPublicKey / pushApi（通知サーバーURL）
sw.js                 … Service Worker（オフライン + Web Push受信）
manifest.webmanifest  … ホーム画面追加用。icons/ にアイコン
worker/               … 通知サーバー(Cloudflare Workers)。setup.ps1 で初回セットアップ。test.mjs あり
```

外部依存: `xlsx.full.min.js`（CDN, Excelインポート用）、Google Fonts（Zen Old Mincho / Space Mono）。いずれもSWが初回取得後にキャッシュする。

## 3. デザインシステム（styles.css）

- 配色トークンは`:root`に集約（`--gold`, `--cream`, `--navy-*`, `--red`, `--indigo`など）
- リキッドグラス専用トークン: `--glass-fill` / `--glass-border` / `--glass-hi` / `--glass-lo` / `--glass-sh` / `--glass-blur`
- `.card`・`.modal`はこのトークンを直接ベイクしてグラス化（HTML側でクラスを足す必要なし）
- `.board-pass` / `.sentence-box` / `.result-card` / `.home-hero` / `.flight-row`は、構造用CSSのみを持ち、HTML側で`class="... glass"`と併記して`.glass`ユーティリティから見た目を得るパターン。新しいグラスパネルを増やす時はこの後者のパターンに揃えるとよい
- ナビバー（`.tabbar`）だけは视认性のため専用の濃いグラス（`rgba(30,14,22,.86)`前後）を使っている。写真背景の上でも文字が読めることを優先した結果なので、薄くする場合は要注意
- 「紙（paper/ink）」トークンは`:root`に定義だけ残っているが、実際のコンポーネントではもう使っていない（過去の名残、実害なし）

## 4. ホーム画面 / ナビゲーション

- サイドバーとハンバーガーメニューは廃止。画面下部に浮かぶ`.tabbar`（リキッドグラスのピル型）に統一し、PC/モバイル共通
- ホーム画面は「今日の復習数」を伝えるヒーローカード（`.home-hero`）＋ タップ可能な行のリスト（`.flight-row`）。行全体がタップで`openBoarding(deckId)`、削除ボタンだけ`event.stopPropagation()`で独立
- 「単語を管理」タブと画面は完全削除（関連JS・CSSも削除済み）
- 設定画面は「データのバックアップ（書き出し/復元）」のみ。背景画像アップロード機能は削除済み

## 5. アイコン

紙飛行機モチーフに統一。favicon / apple-touch-icon は`app/icon180.png`等ではなくbase64データURIとして`index.html`の`<head>`内に直接埋め込み済み（Pillowでプログラム生成）。同じ紙飛行機グリフ（SVG path `M2.01 21L23 12 2.01 3 2 10l15 2-15 2z`）を以下でも再利用している：

- ホーム画面ヒーローのアイコン
- ボーディング画面のルート表示（`NRT ✈ KIX`の部分）
- 「学習をはじめる」ボタンのアイコン

ナビバーのアイコンは自前で描いた3種（一覧＝搭乗券、追加＝＋つき書類、設定＝シンプルな歯車）。新しいアイコンを足す時は`stroke-width="2"` `stroke-linecap="round"` `stroke-linejoin="round"`の線の太さ・丸みに揃えること。

## 6. 景色システム（scenery.js / app.js "DESTINATIONS" セクション）

- **地点**: 基準地点248 × 61区画（中心+周囲4/9/16/25kmの同心円）= **15,128通り**。`Scenery.place(idx)`が{city, code, lat, lon, radius}を返す。`code`は飾り（実在IATAとは無関係）
- **写真**: Wikimedia Commons の `generator=geosearch`（File名前空間、半径≤10km）で位置情報つき写真を取得。旧実装のWikipedia記事サムネイル(pageimages)は**国旗・地図が選ばれる原因だったので廃止**
- **絞り込み**（`acceptPage`）: JPEGのみ／横長(1.25〜2.4)／幅1800px以上／ライセンスがCC・PD系／タイトル・説明に旗・地図・紋章・ロゴ・人物・室内・乗り物・看板などを含まない。それでも混ざる写真は、画面右上の「この写真は表示しない」で恒久的に除外できる（`va_scn_block`）
- **出典表示**: CC-BY(-SA)のため、作者・ライセンス・元ページへのリンクを画面右上に常時表示（削除しないこと）
- **選択方式**: 単語帳ごとに `localStorage['vq_dest_progress_v2'] = { [deckId]: { current, next } }`（値は地点index）。`advanceDeckLap` が「学習をはじめる」時（再開時は除く）に next へ移動。直近60地点は避ける
- **オフライン**: 表示した写真は Cache Storage `va-photos-v1` に保存（上限80枚、古い順に削除）。起動6秒後に保存が12枚未満なら自動で12枚ダウンロード（通信量節約モード時は行わない）。設定画面で20/40/80枚を手動保存・削除。通信できない時は保存済みの景色からランダム表示、何も無ければグラデーション
- 地点→写真の対応は `va_scn_pick` に最大250件キャッシュ（同じ地点は同じ写真・再通信なし）

## 6.5 通知（notify.js / sw.js / worker/）

- 設定画面で ON/OFF と時刻を設定。iPhoneは **iOS 16.4以降 + 「ホーム画面に追加」したアプリ** からのみ許可できる
- **アプリを閉じていても届く通知にはサーバーが必要**（静的サイトだけではiPhoneのPWAは時刻指定の通知を出せない）。`worker/`（Cloudflare Workers + KV + 毎分cron）が、端末の現地時刻が設定時刻になったら空のWeb Pushを送り、`sw.js`が端末内の復習数から本文を作る
- `config.js` の `pushApi` が空の間は「アプリを開いている間だけ通知」にフォールバック（設定画面にもそう表示される）
- VAPID秘密鍵はリポジトリに入れない（`.gitignore`済み。Workerのシークレット `VAPID_PRIVATE_JWK` にのみ置く）

## 6.6 出題の取りこぼし防止（app.js "QUIZ" セクション）

`qCardSeq`（カード通し番号）・`qLockUntil`（表示直後0.45秒は回答不可）・`qNavAt`（次へ連打の無視）・`qDone/qOrigIds`（回答済み台帳）で、前カードの連打やタイマー競合、バックグラウンド復帰で問題が飛ばないようにしている。最後に未回答の単語が残っていれば結果画面の前に出し直す。挙動を変える時は下記テストを必ず通すこと。

テスト（開発用・リポジトリ外 /tmp/t にあった jsdom ベース）の観点: 通常進行／同一カード連打／新カード直後のゴーストタップ／手動+自動の二重送り／未回答で進まない／別カード由来の呼び出し／終端への飛び→出し直し／バックグラウンド／中断再開／入力式。

## 7. 主要な関数マップ（app.js）

| 関心事 | 主な関数 |
|---|---|
| データ層 | `loadDecks/saveDecks`, `loadWords/saveWords`, `LS.get/LS.set` |
| SRS | `ensureSrsFields`, 採点まわり（`checkAnswer`内） |
| 画面遷移 | `showScreen(id)`, `NAV`マップ |
| ホーム | `renderHome()` |
| チェックイン | `openBoarding(deckId)`, `renderBoardScreen(deckId)` |
| 出題エンジン | `startQuizDeck`, `loadCard`, `checkAnswer`, `nextCard` |
| 結果 | `showResult()` |
| 目的地 | `getCurrentDestination`, `getNextDestination`, `advanceDeckLap`, `applyDestinationBackground`, `showDestinationLayer` |
| インポート | `handleImportFile`系, XLSXパース |
| 設定/バックアップ | `exportBackup`, `importBackup` |

## 8. 未検証・要確認事項

- **実機ブラウザでの見た目は未確認**（コード上の整合性とjsdomでのロジックテストのみ）
- **Wikimedia Commons の実APIへの接続は未検証**（開発環境からは到達できず、モック応答でのみ検証）。実機で初回に写真が出ること、旗・地図が出ないことを確認すること。もし特定の写真が合わなければ「この写真は表示しない」で除外される
- **通知の実機・実サーバーでの配信は未検証**。Worker側の署名(VAPID/ES256)・時刻判定・購読管理は `worker/test.mjs` で検証済み
- `worker/setup.ps1` は未実行（PowerShellで書いただけ）

## 9. 次にやるとよさそうなこと（未着手・提案）

- モーダル（新規単語帳作成・削除確認など）や設定/インポート画面カードは、リキッドグラスへの統一はしたが、まだ既存の`.glass`トーンより一段階濃いめの独自チューニング止まり。より一体感を詰めたい場合はここが伸びしろ
- `DESTINATIONS`のタイトル正確性を1件ずつ実機で確認し、外れているものを差し替える
- 目的地の重複防止は「直前と同じにならない」だけ（`randDestIndex(exclude)`）。短期間で同じ場所に戻りやすいと感じたら、直近N件を避けるアルゴリズムに拡張できる
