// キャラクター(スプライトシート)のプリセット定義。
// 各キャラクターは Universal LPC Spritesheet Generator の書き出しを利用しており、
// 複数枚のレイヤーPNG（体・服・髪など）を番号の昇順に重ねて1体分の見た目を合成する。
// クレジット/ライセンスは各フォルダの credits/credits.txt を参照。
// 規格の詳細は assets/sprites/SPEC.md を参照。
export const SPRITE_CHARACTER_BASE = "assets/sprites/";

export const SPRITE_CHARACTERS = Object.freeze([
  {
    id: "male_suit_navy",
    label: "男性・ネイビースーツ",
    folder: "lpc_男性・ネイビーの管理職スーツ_20260714/standard/walk",
    layers: [
      "010 body_color__light_.png",
      "015 basic_shoes__black_.png",
      "020 formal_pants__charcoal_.png",
      "035 collared_formal_longsleeve__white_.png",
      "055 collared_coat__navy_.png",
      "090 necktie__red_.png",
      "100 human_male__light_.png",
      "120 buzzcut__dark_brown_.png",
    ],
  },
  {
    id: "male_suit_charcoal",
    label: "男性・チャコールジャケット",
    folder: "lpc_男性・チャコールジャケットの役員風_20260714/standard/walk",
    layers: [
      "010 body_color__light_.png",
      "015 basic_shoes__black_.png",
      "020 formal_pants__black_.png",
      "035 collared_formal_longsleeve__white_.png",
      "055 collared_coat__charcoal_.png",
      "090 necktie__maroon_.png",
      "100 human_male__light_.png",
      "120 cornrows__black_.png",
    ],
  },
  {
    id: "female_blouse_navy",
    label: "女性・ネイビーブラウス",
    folder: "lpc_女性・ネイビーブラウスの企画職_20260714/standard/walk",
    layers: [
      "010 body_color__light_.png",
      "015 basic_shoes__black_.png",
      "020 straight_skirt__charcoal_.png",
      "035 longsleeve_blouse__navy_.png",
      "100 human_female_small__light_.png",
      "120 bob__dark_brown_.png",
    ],
  },
  {
    id: "female_office_casual",
    label: "女性・オフィスカジュアル",
    folder: "lpc_女性・オフィスカジュアルの若手社員風_20260714/standard/walk",
    layers: [
      "010 body_color__light_.png",
      "015 basic_shoes__brown_.png",
      "020 straight_skirt__gray_.png",
      "035 blouse__sky_.png",
      "100 human_female_small__light_.png",
      "120 half_up__chestnut_.png",
    ],
  },
  {
    id: "male_casual",
    label: "男性・カジュアル",
    folder: "lpc_male_animations_walk_20260714/standard",
    layers: ["walk.png"], // こちらは単一の合成済みシート
  },
  {
    id: "skeleton",
    label: "スケルトン",
    folder: "lpc_スケルトン_20260714/standard/walk",
    layers: [
      "010 skeleton__skeleton_.png",
      "065 bauldron__lavender_.png",
      "100 skeleton__skeleton_.png",
      "101 neutral__light_.png",
      "140 smash__axe_.png",
    ],
  },
]);

export const DEFAULT_SPRITE_CHARACTER_ID = SPRITE_CHARACTERS[0].id;

export function spriteCharacterById(id) {
  return SPRITE_CHARACTERS.find((c) => c.id === id) || null;
}
