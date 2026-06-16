# 引き継ぎメモ（別セッション/別端末用）

このファイルを読めば、別の端末・別のClaudeセッションでも作業を再開できます。
**最終更新: 2026-06-16**

## このプロジェクトは何か
Gather風の「近づくと自動でビデオ通話が始まる」社内コミュニケーションツール。
- 公開URL: https://tkris1012.github.io/virtual-office/
- リポジトリ: https://github.com/tkris1012/virtual-office
- 構成: GitHub Pages（静的）+ Firebase Realtime Database（位置同期＆WebRTCシグナリング）+ WebRTC P2P。無料枠中心。
- Firebase プロジェクト: `virtual-office-ec14d`（RTDB は asia-southeast1）。匿名認証必須。設定は `firebase-config.js`。

## 実装済み
- **カメラ ON/OFF・マイク ON/OFF ボタン**（`#controls`。OFF時は赤表示。カメラOFFは canvas にプレースホルダ描画＝相手にもオフ表示）
- **背景ぼかし / バーチャル背景**（`media.js`・MediaPipe Selfie Segmentation。なし/ぼかし(強さ調整)/画像アップロード。既定背景はグラデーション）
  - 仕組み: 生カメラ→隠し`<video>`→毎フレーム`<canvas>`合成→`captureStream()`を送出。効果切替で再ネゴ不要。
  - 自分タイルのみ鏡像（`.tile.local.mirror`）。相手タイルは反転しない（従来の全反転バグも修正）。
- 2Dマップ移動（PC=矢印/WASD、スマホ=左下バーチャルジョイスティック）
- 背景マップは `office2.png`（縦長 2:3、キャンバス 640x960）。当たり判定は `WALL_RECTS_N`（正規化座標、現在は空＝全面歩行可）。`?debug` で採寸グリッド表示。
- 近接で自動ビデオ/音声通話・離れると切断（`CALL_RADIUS`/`HANGUP_RADIUS`、ヒステリシス）
- 距離で音量フェード（`FULL_VOLUME_RADIUS`）＋遠いタイルは薄く
- 匿名認証＋厳格ルール（`database.rules.json`：認証必須／自分のアバターのみ書込／通話は当事者のみ）。REST攻撃テスト済み。
- モバイル自動再生対策（`tryPlay`/`flushPlays`/playsinline属性/タップ再生）

## 🔴 いま対応中の課題（最優先・ここから再開）
**iPhone Safari 2台で相手の映像が黒い（自分のカメラは映る）。**
- 診断結果: タイル名ラベルが `connecting/checking rx0KB 0w` ＝ **ICEが接続できていない**。
- 原因確定: ICE候補テストで **relay候補がゼロ**、`turn:openrelay.metered.ca code=701`。
  → 同一Wi-Fiでも端末直結できない環境（クライアント分離/iOSのmDNS不通）なのにTURN中継が無く、`checking` で停止している。
- 2026-06-16 追記: 旧 openrelay の固定資格 `openrelayproject` は **公式に廃止 → API Key 必須**（無料20GB/月）になったことを確認。固定資格では動かない。

### この回でやったこと（コード側の準備は完了）
- `rtc.js`: 死んでいる openrelay を削除。TURN を **2通りで差せる**ように整理（下記）。
  - 方法A: **Metered 動的取得**（推奨・無料20GB/月）= `METERED.subdomain` と `METERED.apiKey` を埋めるだけ。起動時に最新 iceServers を自動 fetch。
  - 方法B: **静的TURN**（Twilio / 自前coturn 等）= `STATIC_TURN` に `{urls,username,credential}` を追記。
  - 両方空なら STUN のみ（＝従来動作、relay 無し）。
- `?icetest`: ブラウザで開くだけで **設定中の iceServers で relay 候補が出るか画面表示**する診断ページを追加（iPhoneで開発者ツール不要）。✅/❌ と候補内訳・エラーを表示。
- `?relay`: relay-only（TURN経由のみ）を強制して TURN の効きを切り分け。
- ローカル検証済み: モジュール読込・匿名認証・presence・STUN（host/srflx 取得）OK。TURN 未設定なので `?icetest` は想定どおり ❌（relay なし）表示。

### 次の一手（残るは資格情報の入手＝ユーザー作業のみ）
1. **動くTURNの資格情報を入手**:
   - Metered（推奨）: https://dashboard.metered.ca/ で無料登録 → アプリのサブドメインと API Key を取得
   - もしくは Twilio / ExpressTurn(https://www.expressturn.com/) などの turn URL/username/credential
2. `rtc.js` 冒頭の `METERED`（方法A）か `STATIC_TURN`（方法B）に記入。**コミット前にgit管理から外すか要検討**（API Keyが公開リポジトリに乗るため。下記メモ参照）。
3. `https://.../virtual-office/?icetest` を**iPhoneで開いて** `✅ relay 候補あり` を確認。
4. iPhone 2台で再検証。タイルラベルが `connected/connected rx>0KB` になり顔が出ればクリア。

> 🔑 鍵の公開について: GitHub Pages は静的配信なので、JSに書いた API Key はブラウザから丸見え＝公開リポジトリに乗る。Metered の無料枠キーなら割り切る運用も可だが、気になる場合は Metered ダッシュボードでドメイン制限をかける／別の限定キーを使う等で緩和する。

## 診断機能（課題解決後は簡素化してOK）
- `?icetest`: 設定中の iceServers で relay 候補が出るか画面表示（`main.js` の `runIceTestUI`、`rtc.js` の `runIceTest`）
- `?relay`: relay-only 強制（`rtc.js` の `ICE_TRANSPORT_POLICY`）
- タイル名に `conn/ice rxKB 解像度` 表示（`main.js` の `updateDiag` + `getStats`、`rtc.js` の `getDiag`）
- `?debug` で採寸グリッド＋壁を可視化（`drawDebug`）

## ローカル実行 / デプロイ
- ローカル: `python -m http.server 8000` → `http://localhost:8000`（getUserMediaはhttps/localhostのみ）
- デプロイ: `git push origin main` → GitHub Pages が自動反映（1〜2分）。スマホ確認はキャッシュ回避でシークレットタブ推奨。
- push が `Connection was reset` で稀に失敗→単純リトライで成功。

## やってない/今後
- **スマホ版の調整は後回し**（ユーザー指示・2026-06-16）。当面 PC 版を作り込む方針。
  - メモ: `media.js` の canvas/captureStream パイプラインはモバイルでは負荷・自動再生に注意が必要（未検証）。
- 画面共有（getDisplayMedia）はユーザー指示で「後回し」
- 部屋の壁を office2.png に合わせて配置（ドア位置の採寸が必要、`?debug` 活用）
- テキストチャット、在席ステータス等
- TURN 資格情報の投入（上記「🔴 いま対応中」）— PC 同士・同一LANで直結できる環境では不要
