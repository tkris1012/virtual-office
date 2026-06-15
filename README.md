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
- 「近接 = WebRTC 接続の自然なシャーディング」なので、総人数が多くても同時接続は周囲の数人だけ。SFU（有料サーバー）なしでも成立する。
- グレア（オファー衝突）回避: **ID が小さい方を発信者**に固定。

---

## ファイル構成

```
virtual-office/
├── index.html          画面
├── style.css           スタイル
├── firebase-config.js  ★ Firebase の設定をここに貼る
├── main.js             マップ・移動・位置同期・近接判定
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

### 2. セキュリティルール

Realtime Database → **ルール** タブに、`database.rules.json` の中身を貼って公開。
これは**テスト用の緩いルール**です。本番では下記「本番向けルール」に差し替えてください。

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

## 本番向けルール（次のステップ）

テスト用ルールは誰でも読み書きできて危険です。本番では **Firebase Authentication（匿名ログインで可）** を入れ、
ログイン済みユーザーだけ・自分のデータだけ書ける形にします。例:

```json
{
  "rules": {
    "rooms": {
      "$room": {
        "players": {
          "$uid": {
            ".read": "auth != null",
            ".write": "auth != null && auth.uid === $uid"
          }
        },
        "connections": {
          ".read": "auth != null",
          ".write": "auth != null"
        }
      }
    }
  }
}
```

---

## 無料枠の注意 / 限界

- **RTDB 無料(Spark) の同時接続は約 100**。社内ツールならまず十分だが、これが実質の同時人数上限。
- 位置更新は無料枠を食うので、**動いている時だけ・間引いて**送っている（`main.js` の `flushPosition`）。
- **TURN だけは無料が難しい**。社内・自宅は P2P 直結できるが、厳しい企業ファイアウォール配下の一部は
  中継(TURN)が必要。必要になったら Metered.ca の無料枠などを `rtc.js` の `iceServers` に追加する。

## これからの拡張アイデア

- 距離に応じた**音量フェード**（離れるほど小さく）
- 会議室ゾーン / 画面共有（`getDisplayMedia`）
- マップエディタ、家具・ホワイトボード
- 匿名認証＋本番ルール、入退室ログ
- 多人数クラスタ時の SFU（LiveKit）への切り替え
