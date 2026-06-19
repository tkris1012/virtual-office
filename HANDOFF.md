# 引き継ぎメモ（別セッション/別端末用）

このファイルを読めば、別の端末・別のClaudeセッションでも作業を再開できます。
**最終更新: 2026-06-19**

## このプロジェクトは何か
Gather風の「近づくと自動でビデオ通話が始まる」社内コミュニケーションツール。
- 公開URL: https://tkris1012.github.io/virtual-office/
- リポジトリ: https://github.com/tkris1012/virtual-office
- 構成: GitHub Pages（静的）+ Firebase Realtime Database（位置同期＆WebRTCシグナリング）+ WebRTC P2P。無料枠中心。
- Firebase プロジェクト: `virtual-office-ec14d`（RTDB は asia-southeast1）。匿名認証必須。設定は `firebase-config.js`。

## git 作業ルール（必ず守ること）
- **作業前に必ず `git fetch && git log --oneline HEAD..origin/main` を実行**。origin/main が先行していたらリベース or リセットしてから作業。
- **force push 禁止**。複数端末・複数Claudeセッションが並行して開発している。
- デプロイ: `git push origin main` → GitHub Pages が自動反映（1〜2分）。

## 実装済み機能

### 基本機能
- 2Dマップ移動（PC=矢印/WASD、スマホ=左下バーチャルジョイスティック）
- 背景マップは `office2.png`（縦長 2:3）。`?debug` で採寸グリッド表示
- 近接で自動ビデオ/音声通話・離れると切断（`CALL_RADIUS=30` / `HANGUP_RADIUS=48`）
- 距離で音量フェード（`FULL_VOLUME_RADIUS=12`）＋遠いタイルは薄く
- エリア通話（会議室/ラウンジ/集中スペース/受付）: 同じ部屋内は距離無関係で全員通話

### メディア
- カメラ ON/OFF・マイク ON/OFF
- 背景ぼかし / バーチャル背景（MediaPipe Selfie Segmentation）
- 画面共有（getDisplayMedia）

### ロビー・ルーム管理（2026-06-19 実装済み）
- 入室ロビー: 表示名 ＋ ルーム名 ＋ 合言葉
- 合言葉アクセス制御: SHA-256ハッシュを `rooms/{room}/meta` に保存。違えば「合言葉が違います」エラーで入室ブロック
- **NCM固定ルーム**: `data-fixed="1"` の部屋は `FIXED_ROOMS` でコード側管理。ルーム名固定・合言葉は空欄で毎回入力（合言葉は `ncm`）。Firebase meta を使わないので「先着者に乗っ取られる」問題なし
- **新規ルーム作成**: 「＋ 新規ルーム作成」ボタン → 入室ボタンが「新規作成」に変わる
- **招待リンク**: `?room=<slug>#k=<passphrase>` 形式。合言葉をフラグメントに埋め込みワンクリック入室
- **退出ボタン**: ロビー画面にリロードで戻る

### その他
- 全体アナウンス: 全員に向けて発信
- 集合: 指定メンバーを自分の位置にワープ
- トースト通知

## 🟡 検討中の機能（実装許可待ち）

### カスタムアバターアイコン
**ユーザーが任意のアイコンでアバター表示されるようにしたい。現状は色付きの丸のみ。**

#### 確定した仕様
- **UIフロー**: 歯車ボタン押下 → 左からコンソールパネルがスライドイン → アイコン選択・表示名変更 → × で閉じると即反映
- **歯車ボタン配置**: ロビー画面 と ルーム内コントロールバーの両方
- **アイコン種類**: 固定イラストセット（SVG数十種）＋ 画像アップロード（JPG/PNG）の両対応
- **画像アップロード時の円形クロップ**: 画像選択後、任意の範囲を丸く切り抜いてから設定できるUIを挟む
  - 画像を選択 → クロップモーダルが開く → ドラッグ＆リサイズで切り抜き範囲を指定 → 確定 → 丸く切り抜かれた画像がアイコンに設定される
  - Canvas で描画するため外部ライブラリ不要（または Cropper.js などの軽量ライブラリ検討）
- **リアルタイム反映**: コンソールを閉じた瞬間に他の参加者のマップにも即反映

#### 確定：認証方式（2026-06-19）
アプリ起動時にサインイン画面を表示する。現在の匿名認証は廃止。

```
アプリを開く
  ↓
【サインイン画面】
  ├─ [Googleでログイン]          → Google OAuth
  └─ [メールアドレスで登録/ログイン]
       ユーザー名（表示名）
       メールアドレス
       パスワード
  ↓
ロビー（表示名は自動入力済み）
  ↓
ルーム
```

- uid が永続化される → 設定（アイコン・表示名）をどの端末からでも引き継ぎ可能
- メールアドレスは Firebase Auth のサーバー内にのみ保存。RTDB には書かない。リポジトリがパブリックでも他ユーザーからは読めない（Admin SDK が必要なため）
- Firebase で有効化が必要: Google OAuth ＋ メール/パスワード認証。承認済みドメインに `tkris1012.github.io` を追加
- ユーザー設定の保存先: Firebase RTDB `users/{uid}/`（displayName, iconType, iconId, iconUrl）
- 画像アップロード: Firebase Storage `avatars/{uid}/icon.jpg`

#### 実装イメージ（決まり次第着手）
```
Firebase Realtime Database
  users/
    {uid}/
      displayName: "田中太郎"
      iconType: "preset"   // "preset" or "upload"
      iconId: "fox"
      iconUrl: ""

Firebase Storage（画像アップロード用・無料5GB）
  avatars/
    {uid}/icon.jpg
```

## 🔴 未解決の技術課題

### iPhone Safari で映像が黒い（ICE接続失敗）
- 原因: クライアント分離Wi-Fi環境でP2P直結できず、TURN中継が必要。現在TURN未設定。
- `rtc.js` の `METERED`（または `STATIC_TURN`）に有効なTURN資格情報を入れれば解決する準備は済み
- **次の手順（ユーザー作業）**:
  1. https://dashboard.metered.ca/ で無料登録 → サブドメインとAPIキーを取得
  2. `rtc.js` 冒頭の `METERED.subdomain` と `METERED.apiKey` に記入
  3. `https://tkris1012.github.io/virtual-office/?icetest` をiPhoneで開いて `✅ relay候補あり` を確認
  4. iPhone 2台で再テスト

## ローカル実行 / デプロイ
- ローカル: `python -m http.server 8000` → `http://localhost:8000`
- デプロイ: `git push origin main` → GitHub Pages が自動反映（1〜2分）。スマホ確認はシークレットタブ推奨。

## 診断機能
- `?icetest`: relay候補が出るか画面表示（TURN設定確認用）
- `?relay`: relay-only強制（TURN効きの切り分け用）
- `?debug`: 採寸グリッド＋壁可視化

## 今後の課題（後回し）
- 壁・ドア当たり判定を office2.png に合わせて配置
- スマホ版の細かい調整
- テキストチャット、在席ステータス
