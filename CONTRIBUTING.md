# コントリビューションガイド

Virtual Office への貢献ありがとうございます。このプロジェクトは **GitHub Pages で公開される静的サイト**で、**`main` にマージされた変更は自動的に本番公開**されます。さらに**ログイン情報を扱う**ため、変更は慎重にレビューします。以下の流れにご協力ください。

## 開発の流れ（外部コントリビューター）

1. このリポジトリを **fork** する
2. fork 上で作業ブランチを作る（例: `feature/xxx`、`fix/yyy`）
3. ローカルで動作確認する（下記）
4. `main` 宛に **Pull Request** を出す（PRテンプレートのチェックリストを埋める）
5. CI（構文/JSON検証）通過 ＆ レビュー承認 後にマージされます

> 直接 `main` に push はできません。必ず fork → PR でお願いします。

## ローカルで動かす

ビルド不要です。`getUserMedia`（カメラ/マイク）は **https か localhost でのみ動作**します。

```bash
python -m http.server 8000
# → http://localhost:8000 を開く
```

2人で試すには別タブ/別端末でもう1つ開き、アバターを近づけてください。

## レビューで重点的に見る点

- **セキュリティ**: `firebase-config.js` / `database.rules.json` / `rtc.js` の変更、外部スクリプト/CDNの追加、外部送信処理、個人情報の取り扱い
- **回帰**: 既存機能（認証・ロビー・アバター・通話・HUD・画面共有）を壊していないか
- **コードの一貫性**: 周辺コードのスタイル/命名に合わせているか（このリポは日本語コメント＋プレーンなES Modules）

## 構成（参考）

| ファイル | 役割 |
|---|---|
| `index.html` | 画面構造 |
| `main.js` | マップ/移動/presence/近接判定/認証/プロフィール/アバター/HUD |
| `rtc.js` | WebRTC接続・ICE/TURN設定 |
| `media.js` | カメラ/マイク/背景/画面共有 |
| `avatars.js` | プリセットアイコン定義 |
| `style.css` | スタイル |
| `database.rules.json` | Realtime Database セキュリティルール |

## CI

PR を出すと GitHub Actions（`.github/workflows/ci.yml`）が走り、JavaScript の構文チェックと JSON の妥当性チェックを行います。認証/ルール/TURN/CI に関わるファイルを変更した PR には警告が付きます。
