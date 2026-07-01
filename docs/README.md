# 発表資料（Marp）

`slides.md` は [Marp](https://marp.app/) 形式のスライドです。

## プレビュー / 書き出し

- **VS Code**：拡張「Marp for VS Code」を入れて `slides.md` を開くとプレビュー・PDF/HTML出力できます。
- **CLI**（Node が必要）：
  ```bash
  # PDF に書き出し
  npx @marp-team/marp-cli docs/slides.md -o docs/slides.pdf --allow-local-files
  # HTML に書き出し
  npx @marp-team/marp-cli docs/slides.md -o docs/slides.html
  ```

## 差し替えポイント

- `demo-placeholder.svg` … デモのスクショ/GIFに差し替え（`slides.md` の画像参照も変更）
- タイトル/まとめスライドの **QRコード**（公開URLのQRを貼ると会場でその場に試してもらえる）

## 収録内容

導入（何/なぜ/デモ/機能）→ 技術（構成図 `architecture.svg`・仕組みのキモ・各技術の役割）→ 開発ストーリー（章2〜6：躓き→改善→学び）→ 学び3つ → まとめ。
各スライド末尾の `<!-- ... -->` は発表者ノートです。
