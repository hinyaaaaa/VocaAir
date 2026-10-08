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

3ファイルに責務分離済み（単一index.htmlから移行）。**同じフォルダに3つとも置くこと。** `<script src>`のみを使っており`type="module"`は使っていないため、`file://`で直接開いても動く。

```
index.html   … 構造のみ（<style>や<script>の中身は持たない）
styles.css   … 全スタイル
app.js       … 全ロジック（データ層・SRS・インポート・出題エンジン・目的地システム）
```

外部依存: `xlsx.full.min.js`（CDN, Excelインポート用）、Google Fonts（Zen Old Mincho / Zen Kaku Gothic New / Space Mono）。いずれも`<head>`内で読み込み。

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

## 6. 目的地システム（app.js内 "DESTINATIONS" セクション）

- `DESTINATIONS`配列に100件。有名観光地に加えて、ブータン・キルギス・ザンジバル・モンテネグロ・ウユニ塩湖・イースター島など、あまり知られていない国・地域も意図的に多く混ぜている（アジア25 / 中東8 / アフリカ15 / ヨーロッパ25 / 南北アメリカ17 / オセアニア10）
- 各エントリは `{ city, code, title }`
  - `city`: 画面表示用の地名
  - `code`: 3レターの空港コード風の飾り（実在IATAコードに寄せているが厳密な正確性は保証していない。装飾目的でリンク等には使っていないので実害なし）
  - `title`: 写真取得のためのWikipedia記事タイトル

### 選択方式（ランダム・current/nextモデル）

単語帳ごとに `localStorage['vq_dest_progress']` に `{ [deckId]: { current, next } }` を保持。

- `current`: 今いる場所（インデックス）
- `next`: 次に「学習をはじめる」を押した時に実際に移動する場所（あらかじめランダムに1つ確定させてある。ボーディング画面・結果画面での「次は◯◯へ」プレビュー表示に使う）

`advanceDeckLap(deckId)` が「学習をはじめる」ボタン押下時（`startQuizDeck`のフレッシュスタート時のみ。セッション再開時は呼ばない）に呼ばれ、`current = next`、そして新しい`next`をランダムに選び直す。結果画面（`showResult`）ではstate操作はせず、確定済みの値を読んで表示するだけ。

### 写真取得とフォールバック

`fetchDestinationImage(title)` がWikipediaのpageimages APIを叩く（`ja.wikipedia.org` → 見つからなければ `en.wikipedia.org`）。取得成功時は `localStorage['vq_dest_img_cache']` にキャッシュ。

取得できなかった場合（記事名の不一致、オフライン等）は`fallbackGradientFor(city)`が都市名から決定的に選ぶグラデーションを代わりに表示する。**つまり100件のうち多少タイトルが不正確なものがあっても、アプリが壊れて見えることはない。** ここは精度より堅牢性を優先した設計。

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

- **実機ブラウザでの見た目は未確認。** 一通りコード上の整合性（HTMLタグ対応、CSS波括弧対応、JS構文、onclickで参照する全関数の存在）は毎回チェック済みだが、実際にGitHub Pages等で開いての確認はできていない
- `DESTINATIONS`のWikipediaタイトルは一部（特にマイナーな国・地域）が正しい記事名か未検証。ズレていてもフォールバックのグラデーションで代替されるだけなので機能は壊れないが、写真が出ない場所が一定数ある可能性はある
- 3レターの`code`も同様に、実在の主要空港コードに寄せてはいるが厳密検証はしていない（装飾用途のみ）

## 9. 次にやるとよさそうなこと（未着手・提案）

- モーダル（新規単語帳作成・削除確認など）や設定/インポート画面カードは、リキッドグラスへの統一はしたが、まだ既存の`.glass`トーンより一段階濃いめの独自チューニング止まり。より一体感を詰めたい場合はここが伸びしろ
- `DESTINATIONS`のタイトル正確性を1件ずつ実機で確認し、外れているものを差し替える
- 目的地の重複防止は「直前と同じにならない」だけ（`randDestIndex(exclude)`）。短期間で同じ場所に戻りやすいと感じたら、直近N件を避けるアルゴリズムに拡張できる
