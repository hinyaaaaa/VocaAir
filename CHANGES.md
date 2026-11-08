# VocaAir v1.10.2 — 起動時エラー「undefined is not iterable（app.js:1295）」の修正

**v1.10.1 の上に重ねる版**です。このフォルダの中身を、VocaAir リポジトリのフォルダ直下に **丸ごと上書きコピー** してください（フォルダ構成はリポジトリと同じです）。

## 原因（特定できました）
リポジトリに **`scenery-data.js`（景色の基準地点248件）が入っていませんでした**。地点が0件のまま、単語帳一覧が「いまの場所」を引こうとして落ちていました。
同じく未登録だった `manifest.webmanifest`・`vendor/xlsx.full.min.js`・`firestore.rules`・`SYNC_SETUP.md` も、あわせて追加しています。

## 変更
- 追加: `scenery-data.js`（248地点）、`manifest.webmanifest`、`vendor/xlsx.full.min.js`（SheetJS 0.18.5）、`firestore.rules`、`SYNC_SETUP.md`
- `scenery.js`: 地点データが読めなかった場合も落ちないよう、5地点のフォールバックを追加
- 版を 1.10.2 に更新（`index.html` / `app.js` / `sw.js`）

## 適用方法（GitHub Desktop）
1. zip を展開し、`VocaAir/` の中身を、リポジトリのフォルダ直下に上書きコピー（`icons/` `vendor/` `tests/` のフォルダごと）
2. GitHub Desktop で差分を確認 → Commit → Push
3. 反映後にアプリを開き、設定の「アプリ」に **VocaAir v1.10.2** と出ていれば更新済み
