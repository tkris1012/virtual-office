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
- 2Dマップ移動（PC=矢印/WASD、スマホ=左下バーチャルジョイスティック）
- 背景マップは `office2.png`（縦長 2:3、キャンバス 640x960）。当たり判定は `WALL_RECTS_N`（正規化座標、現在は空＝全面歩行可）。`?debug` で採寸グリッド表示。
- 近接で自動ビデオ/音声通話・離れると切断（`CALL_RADIUS`/`HANGUP_RADIUS`、ヒステリシス）
- 距離で音量フェード（`FULL_VOLUME_RADIUS`）＋遠いタイルは薄く
- 匿名認証＋厳格ルール（`database.rules.json`：認証必須／自分のアバターのみ書込／通話は当事者のみ）。REST攻撃テスト済み。
- モバイル自動再生対策（`tryPlay`/`flushPlays`/playsinline属性/タップ再生）

## 🔴 いま対応中の課題（最優先・ここから再開）
**iPhone Safari 2台で相手の映像が黒い（自分のカメラは映る）。**
- 診断結果: タイル名ラベルが `connecting/checking rx0KB 0w` ＝ **ICEが接続できていない**。
- 原因確定: プレビューのICE候補テストで **relay候補がゼロ**、`turn:openrelay.metered.ca code=701`。
  → 設定している無料TURN(openrelay)が**死んでいる**。同一Wi-Fiでも端末直結できない環境（クライアント分離/iOSのmDNS不通）なのにTURN中継が無く、`checking` で停止している。

### 次の一手（やること）
1. **動く無料TURNの資格情報を入手**（ユーザー作業）:
   - Metered: https://dashboard.metered.ca/signup （無料50GB/月）→ TURN Server ページの iceServers をコピー
   - もしくは ExpressTurn: https://www.expressturn.com/
2. `rtc.js` の `RTC_CONFIG.iceServers` の **openrelay エントリを削除**し、入手した turn URL / username / credential を差し込む。
3. プレビューで**ICE候補テスト**を実行し relay 候補が出ることを確認（下記スニペット）。
4. iPhone 2台で再検証。タイルラベルが `connected/connected rx>0KB` になり顔が出ればクリア。

### ICE候補テスト用スニペット（プレビューのevalで実行）
```js
(async () => {
  const cfg = { iceServers: [ /* 検証したい iceServers をここに */ ] };
  const pc = new RTCPeerConnection(cfg);
  const types = {}; const errors = [];
  pc.createDataChannel('t');
  pc.onicecandidate = e => { if (e.candidate?.candidate) { const p = e.candidate.candidate.split(' '); const t = p[p.indexOf('typ')+1]; types[t]=(types[t]||0)+1; } };
  pc.onicecandidateerror = e => errors.push((e.url||'')+' code='+e.errorCode);
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise(r => setTimeout(r, 7000));
  console.log({types, errors}); pc.close();
})();
```
→ `types` に `relay` が出れば TURN は正常。

## 診断機能（課題解決後は簡素化してOK）
- タイル名に `conn/ice rxKB 解像度` 表示（`main.js` の `updateDiag` + `getStats`、`rtc.js` の `getDiag`）
- `?debug` で採寸グリッド＋壁を可視化（`drawDebug`）

## ローカル実行 / デプロイ
- ローカル: `python -m http.server 8000` → `http://localhost:8000`（getUserMediaはhttps/localhostのみ）
- デプロイ: `git push origin main` → GitHub Pages が自動反映（1〜2分）。スマホ確認はキャッシュ回避でシークレットタブ推奨。
- push が `Connection was reset` で稀に失敗→単純リトライで成功。

## やってない/今後
- 画面共有（getDisplayMedia）はユーザー指示で「後回し」
- 部屋の壁を office2.png に合わせて配置（ドア位置の採寸が必要、`?debug` 活用）
- マイク/カメラON/OFFボタン、テキストチャット、在席ステータス等
