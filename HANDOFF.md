# 引き継ぎメモ（別セッション/別端末用）

このファイルを読めば、別の端末・別のClaudeセッションでも作業を再開できます。
**最終更新: 2026-07-07（操作バーのショートカットを追加）**

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
- カメラ ON/OFF・マイク ON/OFF（`V`/`B` キーでも切り替え）
- 操作バーのショートカット: `Q` 退出確認、`T` 集合ダイアログ、`R` アナウンス切り替え、`M` ひとこと、`E` スタンプ、`C` チャット
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
- マップ操作中は `M` キーで入力欄を開ける。ボタンにもショートカットを表示
- 入力欄やプロフィール設定などの編集可能要素にフォーカス中は、WASD・矢印キーでアバターを移動させない
- 15文字まで・改行不可。次の送信で前の内容を上書き
- 投稿・更新時は、同じルームにいる全員のブラウザで短い通知音を再生（全体トーストや通知履歴は作らない）
- 削除ボタンで本人が手動削除。チャット履歴やプロフィールへの永続保存はしない
- 保存先は在席ノード `rooms/{room}/players/{uid}/message`。重複通知防止用の `messageEventId` も同じノードに保存し、退出時は在席ノードごと削除
- 吹き出し文字は6px。画面上端付近ではアイコンの下側に表示
- `database.rules.json` に15文字上限のバリデーションを追加

### アクティブ表示・接近通知音（2026-06-30 実装済み）
- メディア/WebRTC初期化済みで、Virtual Officeのタブが表示・フォーカス中なら在席ノードの `active` を `true` にする
- アクティブなアバターは緑枠、WebRTCが実接続済みのアバターは外側の青枠で表示
- 相手が屋外の近接通話範囲または同じ会議室へ入った瞬間に「ピコン」と通知。相手の `active` 状態には依存しない
- 初回の在席一覧では鳴らさず、退出距離 `HANGUP_RADIUS` と5秒クールダウンで境界付近の連続再生を防止
- 通知音は外部ファイルを使わず Web Audio API で生成。ブラウザの自動再生制限対策として入室操作時に音声コンテキストを有効化
- タブ再表示・再フォーカス・Firebase再接続時は、アプリ全体を再初期化せず在席情報を再送する
- 受信した表示名・アイコン・座標を正規化し、不完全なデータから `undefined` が表示されることを防止

### スタンプ（2026-07-02 実装済み）
- 操作バーのスマイルボタンまたは `E` キーで選択画面を開き、クリックまたは `1`〜`6` キーで👍・👏・🎉・❤️・😂・😢 の6種類を送信
- アバター周辺のランダムな位置で約1.2秒表示し、拡大・上昇・フェードアウトする
- 各押下を `rooms/{room}/players/{uid}/stampEvents/{eventId}` の一時イベントとして保存し、連打時も個別に処理
- イベントは約10秒後に送信側が削除し、退出時は在席ノードと一緒に削除。初回同期の既存イベントは再生しない
- 専用のWeb Audio効果音を送信者と受信者で再生。過剰書き込み防止の上限は1ユーザー8回/秒
- `database.rules.json` でスタンプ種類と時刻を検証

### チャット（2026-07-03 実装済み・Issue #14）
- ルーム全体のテキストチャット。右からスライドインするパネル、操作バーの `ti-messages`（吹き出し2つ）アイコン、ショートカット `C`
- 本文は200文字まで。直近10秒で10件まで（連投防止）。保存先は `rooms/{room}/chat/{msgId}`（`uid`/`name`（投稿時点スナップショット）/`text`/`serverTimestamp()`のみ。アイコンは持たせず、表示時に在席情報から解決）
- **毎朝 JST 5:00 に全ルームのチャットを自動削除**（`.github/workflows/chat-cleanup.yml` の GitHub Actions cron、UTC 20:00指定）。実行スクリプトは `scripts/cleanup-chat.js`（Firebaseサービスアカウント/Admin SDKで削除。Admin SDKはルールを迂回するため、クライアント向けの「作成のみ・削除不可」制限とは独立して動作する）
- 未読は件数バッジ表示。パネルを開くとリセット
- 初回は `get()` で直近200件をまとめて取得 → その後 `onChildAdded`/`onChildRemoved` で追随（初回リプレイと新着の混同を避けるため `get()` を先に await してから listener を張る設計）
- 入力中は移動キー無効・HUD自動非表示を一時停止（`isHudPaused`/`isBlockingOverlayOpen` に `chat-panel` を追加）。通知音は既存の `playNotificationChime` に `"chat"` 種別を追加
- `database.rules.json` の `chat/$msgId` に `.validate`（本人uid・文字数上限・`serverTimestamp` 必須）を追加。編集・削除はクライアントからは不可（作成のみ）

#### ⚙️ チャット自動削除に必要な設定（未実施なら要対応・あなた作業）
1. Firebase コンソール → プロジェクトの設定 → **サービスアカウント** → 「新しい秘密鍵を生成」でJSONを取得
2. GitHub リポジトリ → Settings → Secrets and variables → Actions → **New repository secret**
   - 名前: `FIREBASE_SERVICE_ACCOUNT` / 値: 取得したJSONの中身をそのまま貼り付け
3. `database.rules.json`（`chat` ルール追加済み）を Firebase に再公開
4. 動作確認: Actions タブから `Chat Cleanup` を **workflow_dispatch で手動実行**してみる

### 下部コントロールのツールチップ（2026-06-30 実装済み・PR #2）
- 各コントロールに `data-help` を付与し、共通要素 `#control-tooltip` で名称＋説明を表示
- PCはホバー300ms/キーボードはTabフォーカスで表示。Escで非表示。**タッチでは表示しない**（操作は従来どおり）
- 画面端では位置補正。ツールチップ表示/フォーカス中は HUD 自動非表示を一時停止（`isControlTooltipInteractionActive()`）
- 実装: `setupControlTooltips()`/`showControlTooltip()`/`positionControlTooltip()` @ `main.js`

### ゲームコーナー「スライムたたき」（2026-06-30 実装済み・PR #3）
- マップ右下の `GAME_AREA`（正規化座標 x0.59/y0.54/w0.24/h0.3）に入ると、下部に「🎮 スライムたたき」のプレイ案内が出る（`?debug` で枠を可視化）
- プレイ案内の「プレイ」ボタン or **Gキー**で開始。20秒間、出現スライムをクリック/タップで得点（通常1点・★ゴールド3点）
- ゲーム本体は `slime-game.js`（`SlimeGame` クラス）に分離。盤面は専用 Canvas
- **ゲーム中も通話・カメラ・マイク・距離音量は継続**（カメラ映像タイルは前面表示）。一方で移動入力（矢印/WASD/ジョイスティック/集合ワープ）は停止し位置をロック
- 自己ベストは端末内 `localStorage`（`vo_slime_game_high_score`）に保存。RTDB やサーバーには送らない
- 終了/閉じる/Escで RAF・イベントリスナーを破棄。状態は `OUTSIDE/READY/PLAYING/COOLDOWN` のステートマシン（`gameState`）で管理
- 実装: `setupSlimeGame()`/`startSlimeGame()`/`updateGameArea()`/`finishSlimeGameSession()` @ `main.js`、HUD連携は `isHudPaused()` に `slimeGame.isPlaying()` を追加

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
- 壁・ドア当たり判定を office3.png に合わせて配置
- スマホ版の細かい調整
- テキストチャット、在席ステータス
