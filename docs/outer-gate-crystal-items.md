# 外縁ゲート：水晶のかけらと取得物の仕様

## 目的

外縁ゲートの3つの水晶採取ポイントから、アイテム「水晶のかけら」を取得できるようにする。
取得・再出現・所持数の状態はユーザーごとの `localStorage` に保存する。

この仕様は水晶専用にせず、畑の収穫物、工場の完成品、宝箱などにも使える「状態を持つワールドオブジェクト」と「汎用インベントリ」の基礎とする。

## 前提と制約

- 保存先はブラウザの `localStorage` とし、サーバーや Firebase には保存しない。
- 保存データの編集・削除は許容する。
- ブラウザ・端末・アカウントをまたぐ状態同期は行わない。
- 時刻は UTC の Unix time（`Date.now()` のミリ秒）で保存する。
- 保存データに `version` を持たせ、将来の形式変更に備える。

## アイテム定義

### 水晶のかけら

| 項目 | 値 |
| --- | --- |
| アイテムID | `crystal-shard` |
| 表示名 | 水晶のかけら |
| 種別 | `material` |
| スタック | 可。上限なし |
| 取得量 | 水晶採取ポイント1つにつき1個 |
| アイコン | 背景透過 PNG・ドット絵風。基本サイズ32×32px、必要に応じて16×16px表示用を用意する。 |

アイコンは `assets/items/crystal-shard.png` に配置する。透過は PNG のアルファチャンネルで表現し、透過色による処理は行わない。

## 汎用インベントリ

インベントリはアイテムIDをキーとするスタック形式とする。水晶のかけら以外の素材・種・作物・製品も同じ構造で追加できる。

```js
{
  version: 1,
  inventory: {
    "crystal-shard": {
      quantity: 12,
      updatedAt: 1784012400000
    }
  }
}
```

- `quantity` は0以上の整数。
- 0個になったアイテムは削除する。
- `updatedAt` は最後に個数が変化した時刻。
- 表示名・アイコンパス・種別・スタック上限などのマスタ情報は保存せず、アプリ側のアイテム定義から参照する。

## 保存キーと全体形式

保存キーは `virtual-office.game-state` とする。インベントリとワールド状態を一つのJSONで保存する。

```js
{
  version: 1,
  inventory: {
    "crystal-shard": {
      quantity: 12,
      updatedAt: 1784012400000
    }
  },
  worldObjects: {
    "outer-gate-crystal-1": {
      type: "collectible",
      state: "available",
      itemId: "crystal-shard",
      amount: 1,
      lastCollectedAt: 1784012400000,
      activatedAt: 1784041200000,
      updatedAt: 1784041200000
    }
  },
  crystalRecovery: {
    lastCollectionAt: 1784012400000,
    restoredCount: 1,
    updatedAt: 1784041200000
  }
}
```

### ワールドオブジェクトの共通フィールド

| フィールド | 説明 |
| --- | --- |
| `type` | オブジェクト種別。水晶は `collectible`。 |
| `state` | 現在の状態。水晶は `available` または `collected`。 |
| `itemId` / `amount` | 取得時にインベントリへ加算するアイテムと個数。 |
| `lastCollectedAt` | 最後に取得された時刻。未取得なら `null`。 |
| `activatedAt` | 最後に有効化された時刻。 |
| `updatedAt` | レコードを最後に変更した時刻。 |

水晶固有の再出現サイクルは `crystalRecovery` に保持する。これにより、畑・工場のために水晶用フィールドを流用する必要がない。

## 水晶の初期状態と表示

- 対象IDは `outer-gate-crystal-1`、`outer-gate-crystal-2`、`outer-gate-crystal-3`。
- 初回起動時は3個とも `available`。
- `available` の水晶には、本体と「ぼわーん」とした光エフェクトを表示する。
- `collected` の水晶は、本体・光エフェクトとも非表示とする。
- `available` は保存されるため、一度復活した水晶は退出・再入場後も同じ位置に残る。

## 取得処理

`available` の水晶を取得したとき、次の更新を一つの保存処理で行う。

1. 対象の `state` を `collected` にする。
2. `lastCollectedAt` と `updatedAt` を現在時刻にする。
3. `inventory["crystal-shard"].quantity` を1増やし、`updatedAt` を現在時刻にする。
4. `crystalRecovery.lastCollectionAt` を現在時刻にする。
5. `crystalRecovery.restoredCount` を0にする。
6. 全状態を1回の `localStorage.setItem()` で保存する。
7. マップ上から水晶と光エフェクトを直ちに消す。

## 再出現処理

再出現はゲーム起動時と外縁ゲートへの入場時に判定する。必要ならゲーム起動中に1分間隔で追加判定する。

- 基準は `crystalRecovery.lastCollectionAt`、すなわち最後に水晶を取得した時刻。
- 8時間ごとに1個、最大3個まで復活させる。
- 復活対象は `collected` 状態の水晶からランダムに選ぶ。
- 選んだ水晶を `available` にし、`activatedAt` と `updatedAt` を現在時刻にする。
- `crystalRecovery.restoredCount` を復活個数に更新する。

```js
const intervalMs = 8 * 60 * 60 * 1000;
const elapsed = Date.now() - crystalRecovery.lastCollectionAt;
const shouldRestore = Math.min(3, Math.floor(elapsed / intervalMs));
const additional = Math.max(0, shouldRestore - crystalRecovery.restoredCount);
```

`additional` 回だけ対象を選んで有効化する。3個を同時に取った場合、8時間後に1個、16時間後に2個、24時間後に3個が取得可能になる。途中で復活済みの水晶を取得した場合は、その取得時刻を新しい基準としてサイクルを開始し直す。

## 将来の利用

- 畑: `type: "crop"`、`state: "growing" | "harvestable" | "empty"` とし、植え付け・成長開始・収穫時刻を追加する。
- 工場: `type: "machine"`、`state: "idle" | "processing" | "ready"` とし、投入物・完了予定時刻を追加する。
- 状態と時刻は `worldObjects`、所持品の個数は `inventory` に保存する。

## 実装時の確認項目

- [ ] `localStorage` のJSON破損・未保存時は初期状態へ安全に戻る。
- [ ] `version` を利用して将来の保存形式変更に対応する。
- [ ] 取得操作の連打で個数が二重加算されない。
- [ ] 有効な水晶にのみ光エフェクトが表示される。
- [ ] 8・16・24時間の経過後に起動・入場しても必要な個数だけ復活する。
- [ ] 復活した水晶は再入場後も同じ位置に残る。
