# Meet Caption Sender

Google Meet の字幕を監視し、字幕が安定して「確定」とみなせるタイミングで `http://localhost:3000` に送信する拡張機能です。
同梱のローカルアプリ（Hono + TypeScript）は、その JSON を受け取って Markdown に追記します。

## ディレクトリ構成

- `extension/`: Chrome 拡張機能
- `app/`: `localhost:3000` で待ち受ける受け側アプリ（Hono + TypeScript）

## 仕様

- 監視対象: `https://meet.google.com/*`
- 送信先: `http://localhost:3000`
- 送信方式: `POST` JSON
  - 送信は `content.js` から直接ではなく、`background.js` 経由
- 送信単位:
  - `ygicle` の最新状態を1イベントで送信（`lines` 配列）
  - 話者表示が `あなた / You` の場合は、Meet上の自分の表示名へ置き換えて送信
- 字幕確定条件:
  - DOM変化が `1500ms` 止まったら確定とみなす
- Meet起動時:
  - 「字幕をオンにする」ボタンを自動クリックして字幕をONにする
- 拡張UI:
  - 右下にステータスパネルを表示（字幕状態、送信OK/NG件数、直近エラー）
- 補正イベント:
  - 送らない（`eventType: "final"` のみ）
  - 同一話者の同一字幕ブロックに追記があった場合は、追記分を別 `captionId`（`..._2`, `..._3`）で送信

## 送信JSON例

```json
{
  "source": "google_meet",
  "eventType": "final",
  "captionId": "cap_1772340000000_7",
  "speaker": "Alice",
  "lines": [
    "今日はよろしくお願いします",
    "資料を開いてください"
  ],
  "text": "今日はよろしくお願いします\n資料を開いてください",
  "lineCount": 2,
  "finalizedAt": "2026-03-01T04:00:00.000Z",
  "meetingUrl": "https://meet.google.com/abc-defg-hij"
}
```

`eventType` は `final` 固定です。

## Chromeへの読み込み

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」から `extension/` を選択

## ローカル受け側アプリ（Markdown追記）

```bash
cd app
npm start
```

起動すると `http://localhost:3000` で待ち受け、受信した字幕を `captions.md` に追記します。

- デフォルト待受ポート: `3000`
- デフォルト出力先: `./captions.md`
- 環境変数:
  - `PORT`: 待受ポートを変更
  - `OUTPUT_FILE`: 追記先 Markdown ファイルを変更

例:

```bash
cd app
PORT=3000 OUTPUT_FILE=./my-captions.md npm start
```

追記イメージ:

~~~md
## 2026-03-01T04:00:00.000Z - Alice

- source: google_meet
- eventType: final
- captionId: cap_1772340000000_7
- meetingUrl: https://meet.google.com/abc-defg-hij

```text
今日はよろしくお願いします
資料を開いてください
```
~~~

## 送信失敗時の確認

- 右下ステータスに `error: Failed to fetch` や `No response from background` が出る場合:
  - `chrome://extensions` で拡張を再読み込み
  - Meet タブも再読み込み（古い content script を更新するため）
  - `cd app && npm start` でローカル受信アプリが起動していることを確認

## 注意

- Meet 側の DOM 変更でセレクタが変わると動かなくなる可能性があります。
- 必要に応じて `extension/content.js` の `rowSelectors` / `speakerSelectors` / `textSelectors` を調整してください。
