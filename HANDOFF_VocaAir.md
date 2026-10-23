# HANDOFF — VocaAir

このドキュメントは、VocaAir（航空会社モチーフの単語帳アプリ）のUI全面リデザイン作業の引き継ぎメモです。次にこのプロジェクトを触る人（未来のhinya、または別のセッションのClaude）が、方針を再確認せずに続きから作業できることを目的としています。

リポジトリ: `hinyaaaaa/VocaAir`

## 変更履歴

- **v1.9.0** 複数端末の同期を追加（Temper と同じ方式。詳細は §6.7、設定手順は `SYNC_SETUP.md`）
  - 新規: `sync-core.js`（同期エンジン）/ `sync-firebase.js`（Firebase 接続）/ `sync.js`（画面・アプリ連携）/ `firestore.rules` / `SYNC_SETUP.md`
  - `app.js`: 保存関数（`saveDecks` / `saveWords` / `saveSettings`）に同期フック、検証関数 `cleanDeck` / `cleanWord` / `cleanSettings` を切り出し（バックアップ復元と同期で共通利用）
  - 設定画面に「複数端末の同期」カードを追加
  - **不具合修正: 単語IDの重複**。以前の `Date.now()+Math.random()` は小数部が約4千通りしかなく、一括インポートで同じミリ秒に作った語のIDが衝突していた（実データ 1,929語中126個のIDが重複、132語分）。衝突すると、採点が別の語の内容を上書きする・削除が巻き添えになる・同期でクラウドに1語しか残らない、が起きる。`newWordId()`（必ず増えるID）に変更し、起動時と復元時に `repairDuplicateWordIds()` で既存の重複を振り直す（最初の1語は元のID、並び順だけで決まるので端末が違っても同じ結果）
- **v1.8.0**（バージョン管理の開始点。以降は `app.js` の `APP_VERSION` と `sw.js` の `VERSION` を同時に更新する）
  - 通知機能を全廃（`notify.js` / `config.js` / `worker/` を削除、設定画面の通知カードと Service Worker の Push 処理を削除）。Service Worker の登録は `app.js`（`setupServiceWorker`）へ移設。以前の通知設定（`va_notify`）と Push 購読は起動時に自動で片付ける
  - セキュリティ: バックアップ復元時に型を検証（`sanitizeBackup`）／`onclick` への ID 埋め込みを数値化／`xlsx` を既知脆弱性のない 0.20.3 に更新しローカル同梱（外部 CDN 読み込みを廃止）
  - 設定画面に「このアプリについて」（バージョン表示）を追加

## 1. 全体像

VocaAirは、Excelから単語をインポートしてSRS（間隔反復）で復習する単語帳アプリ。UIは「航空会社の搭乗体験」を一貫したモチーフにしている。

- 単語帳選択 = 搭乗手続き（チェックイン）
- 学習セッション = フライト中
- 学習を**はじめるたびに**、単語帳ごとにランダムな実在の目的地（都市・国・地域）へ「移動」し、その土地の実写真が学習画面の背景になる
- 結果画面は「到着」と「次はどこへ」のプレビュー

デザイン言語は「暗い背景の上のリキッドグラス（すりガラス）」で統一。旧バージョンにあった、明るい紙質カードとの混在（統一感のなさ）は解消済み。

## 2. ファイル構成

**同じフォルダに全て置くこと。** `<script src>`のみ（`type="module"`なし）。ただしService WorkerはHTTPS（GitHub Pages等）でのみ動く（`file://`では景色の取得とオフライン保存以外は無効）。

```
index.html            … 構造のみ
styles.css            … 全スタイル（フォントは明朝体 Zen Old Mincho、太字は最大600）
app.js                … データ層・SRS・インポート・出題エンジン・目的地(current/next)管理
sync-core.js          … 同期エンジン（Firebase に依存しない純粋なロジック。window.VaSyncCore）
sync-firebase.js      … Firebase(Auth+Firestore) への接続（SDK は同期設定時だけ gstatic から動的に読み込む。window.VaSyncFirebase）
sync.js               … 同期の画面（設定カード）・ログイン・状態表示・他端末の内容の取り込み後の再描画（window.VaSync）
firestore.rules       … Firestore のセキュリティルール（Temper と同一。Firebase コンソールへ手動で貼る）
SYNC_SETUP.md         … 同期の設定手順（Firebase の画面操作）
scenery-data.js       … 景色の基準地点248件（名前・飾りコード・緯度経度）。自動生成物
scenery.js            … 景色の取得/絞り込み/オフライン保存/表示（window.Scenery）
sw.js                 … Service Worker（オフライン動作）
manifest.webmanifest  … ホーム画面追加用。icons/ にアイコン
```

外部依存: `vendor/xlsx.full.min.js`（SheetJS 0.20.3 を同梱, Excelインポート用。詳細は vendor/README.md）、Firebase SDK 11.0.2（gstatic。同期を設定したときだけ読み込む。Temper と同じ版に揃えること）、Google Fonts（Zen Old Mincho / Space Mono）。いずれもSWが初回取得後にキャッシュする。

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

## 6.6 出題の取りこぼし防止（app.js "QUIZ" セクション）

`qCardSeq`（カード通し番号）・`qLockUntil`（表示直後0.45秒は回答不可）・`qNavAt`（次へ連打の無視）・`qDone/qOrigIds`（回答済み台帳）で、前カードの連打やタイマー競合、バックグラウンド復帰で問題が飛ばないようにしている。最後に未回答の単語が残っていれば結果画面の前に出し直す。挙動を変える時は下記テストを必ず通すこと。

テスト（開発用・リポジトリ外 /tmp/t にあった jsdom ベース）の観点: 通常進行／同一カード連打／新カード直後のゴーストタップ／手動+自動の二重送り／未回答で進まない／別カード由来の呼び出し／終端への飛び→出し直し／バックグラウンド／中断再開／入力式。

## 6.7 複数端末の同期（v1.9.0）

Temper の同期（`sync-core.js` / `sync-firebase.js`）と同じ方式を、VocaAir のデータ向けに移植したもの。Firebase の無料枠（Spark）で動く。

- **方式**: 1件ごと（単語帳1冊・単語1語・設定1つ）を1文書にする。前回送った内容のハッシュ（`va-sync-meta-<uid>`）と比べて、変わった分だけ送る。同じ文書を複数端末で触ったら `updatedAt` が新しい方が残る（後勝ち）。削除は墓標（`deletedAt`）で伝える。手元の未送信の変更は、届いた内容より優先する
- **保存先（Firestore）**: `users/{uid}/va_decks/{id}`、`va_words/{id}`、`va_meta/settings`。接頭辞 `va_` で Temper のコレクションと分かれる。ルールは Temper と同一（`users/{uid}/**` を本人のみ）なので、Temper のルールを公開済みなら追加作業なし
- **Temper との違い**: ①Firebase アプリを別名（`vocaair`）で初期化＝ログイン状態・オフライン用キャッシュも独立（メール・パスワードは同じものを使える）②初回の取り込み（単語帳・単語・設定の3つ）が終わるまで送信しない（新端末の初期値でクラウドの設定を上書きしないため。対照実験で確認済み）③書き込みは 400 件ずつのバッチ
- **単語IDは必ず一意であること**が同期の前提（IDで1文書に対応するため）。新しい語は `newWordId()` で作る。`Date.now()+Math.random()` を直接使わない
- **される**: 単語帳・単語（学習の進み具合＝ef / interval / reps / nextDue / state なども含む）・設定（`vq_settings`）
- **されない**: 自動送り（`va_auto`）、クイズの途中経過（`vq_session`）、目的地の進み（`vq_dest_progress_v2`）、保存した景色（端末ごとの派生値）
- **安全弁**: 手元の単語が空（同期済みが3語以上）、または単語帳が空（同期済みが1冊以上）になっても「全部消えた」とは送らない（読み込み失敗・復元失敗からクラウドを守る）。全削除を同期させたいときは Firebase コンソールで消す
- **取り込み時の検証**: ID は数値のみ（`ID_RE`）、JSON は 20,000 文字まで、`cleanDeck` / `cleanWord` / `cleanSettings` で型・キーを絞る（不正な文書は無視）。画面の `onclick` に入る ID は数値化済み
- **画面更新**: 他端末の内容を取り込んだら、ホーム・単語管理・設定の画面だけ再描画。クイズ中・結果・取り込み画面は更新せず、データだけ保存する
- **初回ログイン**: 同じ ID の文書は、先にクラウドにある内容が採用される（2台目は空か、同じバックアップから始めるのが安全）
- **バックアップ復元**: 同期中に復元すると、他の端末のデータも復元した内容に置き換わる（確認文に表示）
- **テスト**: 同期エンジンは Firestore 相当の共有クラウドを模した2端末のテスト（競合・削除・安全弁・不正な文書など）で確認済み。実機の Firebase でのテストは未実施（§8）
- 無料枠の目安: 書き込みは1日2万件（初回の全送信＝語数ぶん、採点1回＝1件）、読み取りは1日5万件（新しい端末の初回＝語数ぶん）。2026年10月時点。導入前に公式の料金ページで確認

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

- 同期（v1.9.0）: 実機の Firebase（Auth + Firestore）での動作は未確認。SDK の関数の存在（11.0.2）と、同期エンジン・画面連携の模擬テストまで。初回は少ない語数で試し、Firestore コンソールの「データ」で `va_words` が増えるかを確認する
- **実機ブラウザでの見た目は未確認**（コード上の整合性とjsdomでのロジックテストのみ）
- **Wikimedia Commons の実APIへの接続は未検証**（開発環境からは到達できず、モック応答でのみ検証）。実機で初回に写真が出ること、旗・地図が出ないことを確認すること。もし特定の写真が合わなければ「この写真は表示しない」で除外される

## 9. 次にやるとよさそうなこと（未着手・提案）

- モーダル（新規単語帳作成・削除確認など）や設定/インポート画面カードは、リキッドグラスへの統一はしたが、まだ既存の`.glass`トーンより一段階濃いめの独自チューニング止まり。より一体感を詰めたい場合はここが伸びしろ
- `DESTINATIONS`のタイトル正確性を1件ずつ実機で確認し、外れているものを差し替える
- 目的地の重複防止は「直前と同じにならない」だけ（`randDestIndex(exclude)`）。短期間で同じ場所に戻りやすいと感じたら、直近N件を避けるアルゴリズムに拡張できる
