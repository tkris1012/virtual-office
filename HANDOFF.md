# 引き継ぎメモ（別セッション/別端末用）

このファイルを読めば、別の端末・別のClaudeセッションでも作業を再開できます。
**最終更新: 2026-06-30（ひとことメッセージ機能を追加）**

## このプロジェクトは何か
Gather風の「近づくと自動でビデオ通話が始まる」社内コミュニケーションツール。
- 公開URL: https://tkris1012.github.io/virtual-office/
- リポジトリ: https://github.com/tkris1012/virtual-office
- 構成: GitHub Pages（静的）+ Firebase Realtime Database（位置同期＆WebRTCシグナリング＆アバター画像）+ Firebase Auth + WebRTC P2P。**全て無料 Spark プランで動く**（Storage は Blaze 必須のため不使用）。
- Firebase プロジェクト: `virtual-office-ec14d`（RTDB は asia-southeast1）。**Google ＋ メール/パスワード認証が必須**。設定は `firebase-config.js`。

## git 作業ルール（必ず守ること）
- **作業前に必ず `git fetch && git log --oneline HEAD..origin/main` を実行**。origin/main が先行していたらリベース or リセットしてから作業。
- **force push 禁止**。複数端末・複数Claudeセッションが並行して開発している。
- デプロイ: `git push origin main` → GitHub Pages が自動反映（1〜2分）。

## 実装済み機能

### 基本機能
- 2Dマップ移動（PC=矢印/WASD、スマホ=左下バーチャルジョイスティック）
- 背景マップは `office3.png`（16:9・`W=960`/`H=540`）。`?debug` で採寸グリッド表示
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

### サインイン認証（2026-06-19 実装済み）
- アプリ起動時に**サインイン画面**を表示（匿名認証は廃止）
- **Googleログイン**（`signInWithPopup`）＋**メール/パスワード**（登録/ログイン切替）
- サインイン後、表示名はロビーに自動入力。uid を ID・設定保存キーに使用
- メールアドレスは Firebase Auth 側にのみ保存。RTDB には書かない
- 実装: `setupSignin()` / `initAuthFlow()`（`onAuthStateChanged` で画面切替）@ `main.js`

### カスタムアバター（2026-06-19 実装済み）
- **歯車ボタン**: ロビー画面（`#lobby-settings`）と ルーム内コントロールバー（`#btn-settings`）の両方
- 押下で**左からコンソールパネルがスライドイン**（`#console`）。プレビュー＋表示名＋アイコン選択＋アップロード＋ログアウト
- **プリセットアイコン**: `avatars.js` の `PRESET_ICONS`（背景色＋絵文字・28種、外部ライブラリ不要）
- **画像アップロード**: PNG/JPG → **円形クロップ**（`openCrop()` @ `main.js`・Canvasのみ／ドラッグ＋ズーム）→ 192px JPEG（約10KB）に圧縮して **data URL** 化
- **Storage は使わない**（Blaze 必須のため）。画像は data URL 文字列として RTDB に保存＝無料 Spark のまま
- **× で閉じると即保存＆反映**（`closeConsole()` → `saveProfile()`）。在席ノードにも書くので他参加者のマップへ即反映
- マップ上のアバター描画は `drawAvatar()` を円形クリップ＋画像/絵文字描画に刷新。アップロード画像は `avatarImgCache` でキャッシュ（data URL もそのまま `Image.src` に使える）
- 保存先: RTDB `users/{uid}/`（displayName, iconType, iconId, iconUrl=data URL）。在席 `rooms/{room}/players/{uid}` にも icon* を複製（onValue は差分転送なので画像は1回だけ送信）
- **プロフィール永続化（2026-06-20 修正）**: クラウド保存失敗に備え `localStorage`（`vo_profile_{uid}`）にも控え、`updatedAt` で「新しい方」を採用。クラウド保存失敗時はトーストで通知。原因はだいたい RTDB ルールの `users` 未公開

### HUD 自動表示/非表示（2026-06-20 実装済み）
- **無操作5秒**で ツールバー(`#controls`)・カメラ映像(`#videos`)・ルームピル(`#roompill`) を **0.2sフェード**で自動非表示
- **アバター移動** ＋ **マップのシングルタップ/クリック**で再表示＆タイマーリセット。表示中のタップで手動非表示（トグル）
- **通話中**（`body.in-call` ＝誰かと rtc 接続中）は `#videos` を隠さない。ジョイスティック・画面共有・バナー・トーストは常に表示
- ポップオーバー/設定コンソールを開いている間は自動非表示しない（`isHudPaused()`）
- タップ判定は 1本指・移動<10px・250ms以内 のみ（ピンチ/ドラッグは無視）
- 実装: `showHud()`/`hideHud()`/`toggleHud()`/`updateHud()` @ `main.js`、CSS は `body.hud-hidden` / `body.in-call`
- 設定値: `HUD_AUTOHIDE_MS = 5000`（無操作時間）

### ひとことメッセージ（2026-06-30 実装済み）
- 操作バーの吹き出しボタンから、アバター上へ最新メッセージを表示
- 15文字まで・改行不可。次の送信で前の内容を上書き
- 削除ボタンで本人が手動削除。チャット履歴やプロフィールへの永続保存はしない
- 保存先は在席ノード `rooms/{room}/players/{uid}/message` のみ。退出時は在席ノードごと削除
- 吹き出し文字は6px。画面上端付近ではアイコンの下側に表示
- `database.rules.json` に15文字上限のバリデーションを追加

### その他
- 全体アナウンス: 全員に向けて発信
- 集合: 指定メンバーを自分の位置にワープ
- トースト通知

## ⚙️ Firebase 側で必要な有効化（未実施なら要対応）
コードは実装済みだが、Firebase コンソールで以下を有効化しないと動かない:
1. **Authentication → Sign-in method**: 「Google」と「メール/パスワード」を有効化
2. **Authentication → Settings → 承認済みドメイン**: `tkris1012.github.io` を追加
3. **Realtime Database → ルール**: `database.rules.json`（`users/{uid}` ルール追加済み）を再公開
   - ※ Storage は不要（Blaze必須のため使わない設計に変更済み。画像は data URL で RTDB 保存）

## 🟡 検証中

### iPhone Safari で映像が黒い（TURN設定済み・実機確認待ち）
- 原因: クライアント分離Wi-Fi/CGNAT環境でP2P直結できず、TURN中継が必要だった。
- **TURN(Metered)を設定済み**（2026-06-20）: `rtc.js` の `METERED` に `subdomain="virtual-office"` ＋ APIキーを記入。起動時に動的取得して relay 候補を含める。
- **残作業（ユーザー確認）**:
  1. `https://tkris1012.github.io/virtual-office/?icetest` をiPhoneで開いて `✅ relay候補あり` を確認
  2. iPhone 2台（または iPhone＋PC）で通話テスト
- ⚠️ APIキーが公開リポジトリに載っているため、Metered ダッシュボードで**利用ドメインを `tkris1012.github.io` に制限**推奨。
- 無料枠は月20GB前後（中継が走るのは直結できない時だけ）。

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
