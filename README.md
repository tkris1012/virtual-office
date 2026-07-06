# Virtual Office — 近づくと話せる仮想オフィス

Gather のように、2D マップ上のアバターに**近づくと自動でビデオ通話が始まる**社内コミュニケーションツール。
完全に静的サイト（GitHub Pages）＋ Firebase Realtime Database ＋ WebRTC P2P で動く、**無料枠中心**の構成です。

## 技術構成

| 役割 | 技術 | 無料 |
|------|------|------|
| ホスティング | GitHub Pages（静的） | ✅ |
| マップ・アバター描画 | Canvas 2D | ✅ |
| 位置同期 (presence) | Firebase Realtime Database | ✅ |
| WebRTC シグナリング | Firebase Realtime Database | ✅ |
| NAT 越え (STUN) | Google 公開 STUN | ✅ |
| 映像・音声本体 | WebRTC P2P メッシュ | ✅（サーバー不要） |
| TURN（企業FW対策） | 任意（Metered 無料枠 等） | ⚠️ 必要時のみ |

### 仕組みのキモ
- 各アバターの座標を Realtime Database で全員に配信（動いている時だけ・約 12fps に間引き）。
- クライアント側で「自分と相手の距離」を毎フレーム計算し、**通話範囲に入った相手とだけ** WebRTC 接続。
- 通話準備済みで表示中のタブをアクティブとして共有し、アバターを緑枠で表示。
- 相手が通話範囲へ入った時、ひとことメッセージやスタンプが送信された時にブラウザ内で短い通知音を再生。
- 「近接 = WebRTC 接続の自然なシャーディング」なので、総人数が多くても同時接続は周囲の数人だけ。SFU（有料サーバー）なしでも成立する。
- グレア（オファー衝突）回避: **ID が小さい方を発信者**に固定。

---

## ファイル構成

```
virtual-office/
├── index.html          画面
├── style.css           スタイル
├── firebase-config.js  ★ Firebase の設定をここに貼る
├── main.js             マップ・移動・位置同期・近接判定・操作バー配線
├── media.js            カメラ/マイク制御・背景ぼかし/バーチャル背景
├── rtc.js              WebRTC マネージャ（接続/切断）
├── database.rules.json RTDB セキュリティルール（テスト用）
└── README.md
```

---

## セットアップ

### 1. Firebase を新規作成

1. [Firebase コンソール](https://console.firebase.google.com/) → **「プロジェクトを追加」**
2. プロジェクト名（例: `virtual-office`）を入力して作成（Google アナリティクスは任意・オフでOK）
3. 左メニュー **構築 → Realtime Database** → **「データベースを作成」**
   - ロケーションは任意（例: `asia-southeast1`）
   - 「**テストモードで開始**」を選択（後で締めます）
4. 左上の歯車 → **プロジェクトの設定** → 「マイアプリ」で **`</>`（ウェブ）** を追加
5. 表示される `firebaseConfig` の値を、本リポジトリの **`firebase-config.js`** に貼り付け
   - 特に `databaseURL`（`https://xxxx-default-rtdb.firebaseio.com`）が入っているか確認

### 2. 認証を有効化（Google ＋ メール/パスワード）

左メニュー **構築 → Authentication** → **「始める」** → **Sign-in method** タブで以下を有効化:

- **Google**（プロバイダを選んで有効化 → プロジェクトの公開名・サポートメールを設定して保存）
- **メール / パスワード**（「メール/パスワード」を有効化して保存）

さらに **Settings → 承認済みドメイン** に公開先ドメイン（例 `tkris1012.github.io`）を追加します。
（このアプリは起動時にサインイン画面を表示し、その uid をアバターID・設定の保存キーに使います）

### 3. アバター画像について（Storage 不要・無料 Spark のまま）

Firebase Storage は現在 **Blaze（従量課金）プランでないと有効化できない**ため、このアプリでは
**Storage を使いません**。アップロードした画像はクロップ時に小さな JPEG（192px・約10KB）へ圧縮し、
**data URL 文字列として RTDB の `users/{uid}/iconUrl` に保存**します。無料の Spark プランのまま動きます。
（プリセットアイコンだけ使う場合は画像保存も発生しません）

### 4. セキュリティルール

Realtime Database → **ルール** タブに、`database.rules.json` の中身を貼って公開。
**ログイン済みユーザーだけ**が読み書きでき、**自分のアバター/プロフィールは自分しか変更できない**ルールです。
（手順 2 の認証を有効化していないと、アプリは起動時のサインインで止まります）

### 5. チャット履歴の自動削除（毎朝 JST 5:00）

チャット機能は `.github/workflows/chat-cleanup.yml`（GitHub Actions cron）で毎朝自動的に全削除されます。動かすには:

1. Firebase コンソール → プロジェクトの設定 → **サービスアカウント** → 「新しい秘密鍵を生成」でJSONを取得
2. GitHub リポジトリの **Settings → Secrets and variables → Actions** → New repository secret
   - 名前 `FIREBASE_SERVICE_ACCOUNT` に、取得したJSONの中身をそのまま貼り付け
3. 手動確認したい場合は Actions タブ → `Chat Cleanup` → **Run workflow** で即時実行可能

（このシークレットが未設定の場合、チャット自体は動きますが自動削除だけが失敗します）

---

## ローカルで動かす

`getUserMedia`（カメラ/マイク）は **https か localhost でのみ動作**します。`file://` で直接開くと動きません。
簡易サーバーを立てて `http://localhost:8000` で開いてください。

```powershell
# Python があれば
python -m http.server 8000
# もしくは Node があれば
npx serve .
```

ブラウザで `http://localhost:8000` を開く。
**2 人いる状態を試す**には、別タブ or 別ウィンドウ（できればシークレットウィンドウ）でもう一つ開き、
両方でアバターを近づけると通話が始まります。

> ※ 同一マシンのカメラは 1 タブが掴むと他タブで映像が出ない場合があります。
> 接続自体の確認は別端末（スマホ等）が確実です。
> 部屋を分けたいときは URL に `?room=team-a` のように付けてください。

---

## GitHub Pages へデプロイ

1. GitHub で**新しいリポジトリ**を作成（例: `virtual-office`）
2. このフォルダを push:

```powershell
git add .
git commit -m "Initial commit: 近接ビデオ通話の仮想オフィス"
git remote add origin https://github.com/<あなたのユーザー名>/virtual-office.git
git push -u origin main
```

3. GitHub の **Settings → Pages** → Source を **`main` / root** にして保存
4. 数十秒後 `https://<ユーザー名>.github.io/virtual-office/` で公開（https なのでカメラもOK）

---

## セキュリティ（適用済み）

`database.rules.json` で以下を担保しています:

- **認証済み（`auth != null`）のみ**読み書き可能 → URLを知っただけの未認証アクセスは拒否。
- **`users/$uid` は本人のみ書き込み可** → 他人のプロフィール（表示名・アイコン）を書き換えられない。
- **`players/$uid` は本人(`auth.uid === $uid`)のみ書き込み可** → 他人のアバターを動かせない。
- **`connections/$connId` は当事者のみ書き込み可**（`$connId` に自分の uid が含まれる場合）→ 無関係な第三者がシグナリングに割り込めない。
- メールアドレスは Firebase Auth 側にのみ保存。RTDB には書かないため、リポジトリが公開でも他ユーザーから読めません。

さらに堅くするなら: 社内ドメインに限定した Google ログイン、room ごとの入室制限、`.validate` による値の形式チェックなど。

---

## 無料枠の注意 / 限界

- **RTDB 無料(Spark) の同時接続は約 100**。社内ツールならまず十分だが、これが実質の同時人数上限。
- 位置更新は無料枠を食うので、**動いている時だけ・間引いて**送っている（`main.js` の `flushPosition`）。
- **TURN だけは無料が難しい**。社内・自宅は P2P 直結できるが、厳しいファイアウォール配下や
  Wi-Fiのクライアント分離環境では中継(TURN)が必要（相手が黒画面になる主因）。
  `rtc.js` 冒頭の `METERED`（Metered 動的取得・無料20GB/月）か `STATIC_TURN`（Twilio/自前coturn 等）に
  資格情報を入れる。設定後 `?icetest` を付けて開くと relay 候補が出るか画面で確認できる。
  （旧 openrelay の固定資格は廃止＝API Key 必須になったため削除済み。）

## 実装済みの主な機能

- アバター移動（PC=キーボード / スマホ=バーチャルジョイスティック）
- 近接トリガーの自動ビデオ/音声通話（WebRTC P2P）
- **距離による音量フェード**（離れるほど小さく＋タイルが薄くなる）
- Google / メール認証＋本番ルール（自分のアバター・プロフィールは自分だけ操作可）
- **カスタムアバター**（プリセットアイコン or 画像アップロード＋円形クロップ／歯車→設定コンソール）
- **カメラ ON/OFF・マイク ON/OFF**（画面上部の操作バー）
- **背景ぼかし / バーチャル背景**（MediaPipe Selfie Segmentation・画像アップロード対応／`media.js`）
- **ひとことメッセージ**（アバター上の小型吹き出し／15文字・改行不可・最新1件のみ・`M`キーで入力）
- **スタンプ**（6種類のリアクション／`E`キーで選択画面を開き`1`〜`6`キーで送信／アバター周辺の短時間アニメーション／連打対応）
- **チャット**（ルーム全体のテキストチャット／`C`キーで開閉／未読バッジ／毎朝JST5:00に自動全削除）
- 入力欄操作中の移動キー抑止と、再接続時の在席・プロフィール表示の自動復旧

## これからの拡張アイデア

- 会議室ゾーン / 画面共有（`getDisplayMedia`）
- マップエディタ、家具・ホワイトボード、入退室ログ
- 社内 Google ログイン連携
- 多人数クラスタ時の SFU（LiveKit）への切り替え
