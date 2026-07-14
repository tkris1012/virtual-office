// 個別の装飾アイテム（パーツ）の定義。
// sprite-characters.js の「完成済みプリセット」とは別に、将来の
// アバター着せ替え・アイテム取得機能で使う想定の部品ライブラリ。
// 現時点ではまだどの画面からも参照されていない（土台のみ）。
//
// 各アイテムは Universal LPC Spritesheet Generator のレイヤーPNG1枚を指す。
// zPrefix は重ね順（小さいほど奥）で、sprite-characters.js の layers 配列に
// 付いているファイル名先頭の数字と同じ意味。
// bodyType は素体との組み合わせ制約（同じ体型のパーツ同士でないと位置がズレる）。
// クレジット/ライセンスは元になったキャラクターフォルダの credits/ を参照。
// 規格の詳細は assets/sprites/SPEC.md を参照。
export const SPRITE_PARTS_BASE = "assets/sprites/parts/";

export const SPRITE_PART_CATEGORIES = Object.freeze([
  { id: "body", label: "体型" },
  { id: "hair", label: "髪型" },
  { id: "tops", label: "トップス" },
  { id: "bottoms", label: "ボトムス" },
  { id: "shoes", label: "靴" },
  { id: "accessories", label: "アクセサリー" },
]);

export const SPRITE_PARTS = Object.freeze([
  // ---- body（体型・素体） ----
  { id: "body_light_male", category: "body", bodyType: "male", label: "体（明るめ肌・男性体型）", file: "body/body_color__light_male.png", zPrefix: 10 },
  { id: "head_light_male", category: "body", bodyType: "male", label: "顔（明るめ肌・男性体型）", file: "body/human_male__light_.png", zPrefix: 100 },
  { id: "body_light_female", category: "body", bodyType: "female", label: "体（明るめ肌・女性体型）", file: "body/body_color__light_female.png", zPrefix: 10 },
  { id: "head_light_female", category: "body", bodyType: "female", label: "顔（明るめ肌・女性体型）", file: "body/human_female_small__light_.png", zPrefix: 100 },
  { id: "body_skeleton_base", category: "body", bodyType: "skeleton", label: "体（スケルトン）", file: "body/skeleton_base__skeleton_.png", zPrefix: 10 },
  { id: "body_skeleton_detail", category: "body", bodyType: "skeleton", label: "骨の重ね（スケルトン）", file: "body/skeleton_detail__skeleton_.png", zPrefix: 100 },
  { id: "body_skeleton_face_neutral", category: "body", bodyType: "skeleton", label: "表情（スケルトン・無表情）", file: "body/neutral__light_.png", zPrefix: 101 },

  // ---- hair（髪型） ----
  { id: "hair_buzzcut_dark_brown", category: "hair", bodyType: "male", label: "バズカット（ダークブラウン）", file: "hair/buzzcut__dark_brown_.png", zPrefix: 120 },
  { id: "hair_cornrows_black", category: "hair", bodyType: "male", label: "コーンロウ（ブラック）", file: "hair/cornrows__black_.png", zPrefix: 120 },
  { id: "hair_bob_dark_brown", category: "hair", bodyType: "female", label: "ボブ（ダークブラウン）", file: "hair/bob__dark_brown_.png", zPrefix: 120 },
  { id: "hair_half_up_chestnut", category: "hair", bodyType: "female", label: "ハーフアップ（チェスナット）", file: "hair/half_up__chestnut_.png", zPrefix: 120 },

  // ---- tops（トップス。シャツ・ブラウス・上着） ----
  { id: "top_shirt_white", category: "tops", bodyType: "male", label: "襟付きシャツ（ホワイト）", file: "tops/collared_formal_longsleeve__white_.png", zPrefix: 35 },
  { id: "top_coat_navy", category: "tops", bodyType: "male", label: "テーラードコート（ネイビー）", file: "tops/collared_coat__navy_.png", zPrefix: 55 },
  { id: "top_coat_charcoal", category: "tops", bodyType: "male", label: "テーラードコート（チャコール）", file: "tops/collared_coat__charcoal_.png", zPrefix: 55 },
  { id: "top_blouse_navy", category: "tops", bodyType: "female", label: "長袖ブラウス（ネイビー）", file: "tops/longsleeve_blouse__navy_.png", zPrefix: 35 },
  { id: "top_blouse_sky", category: "tops", bodyType: "female", label: "ブラウス（スカイブルー）", file: "tops/blouse__sky_.png", zPrefix: 35 },

  // ---- bottoms（ボトムス。ズボン・スカート） ----
  { id: "bottom_pants_charcoal", category: "bottoms", bodyType: "male", label: "スラックス（チャコール）", file: "bottoms/formal_pants__charcoal_.png", zPrefix: 20 },
  { id: "bottom_pants_black", category: "bottoms", bodyType: "male", label: "スラックス（ブラック）", file: "bottoms/formal_pants__black_.png", zPrefix: 20 },
  { id: "bottom_skirt_charcoal", category: "bottoms", bodyType: "female", label: "タイトスカート（チャコール）", file: "bottoms/straight_skirt__charcoal_.png", zPrefix: 20 },
  { id: "bottom_skirt_gray", category: "bottoms", bodyType: "female", label: "タイトスカート（グレー）", file: "bottoms/straight_skirt__gray_.png", zPrefix: 20 },

  // ---- shoes（靴） ----
  { id: "shoes_black_male", category: "shoes", bodyType: "male", label: "革靴（ブラック・男性体型）", file: "shoes/basic_shoes__black_male.png", zPrefix: 15 },
  { id: "shoes_black_female", category: "shoes", bodyType: "female", label: "パンプス（ブラック・女性体型）", file: "shoes/basic_shoes__black_female.png", zPrefix: 15 },
  { id: "shoes_brown_female", category: "shoes", bodyType: "female", label: "パンプス（ブラウン・女性体型）", file: "shoes/basic_shoes__brown_.png", zPrefix: 15 },

  // ---- accessories（アクセサリー・その他装備） ----
  { id: "accessory_necktie_red", category: "accessories", bodyType: "male", label: "ネクタイ（レッド）", file: "accessories/necktie__red_.png", zPrefix: 90 },
  { id: "accessory_necktie_maroon", category: "accessories", bodyType: "male", label: "ネクタイ（マルーン）", file: "accessories/necktie__maroon_.png", zPrefix: 90 },
  { id: "accessory_bauldron_lavender", category: "accessories", bodyType: "skeleton", label: "肩当て（ラベンダー）", file: "accessories/bauldron__lavender_.png", zPrefix: 65 },
  { id: "accessory_axe", category: "accessories", bodyType: "skeleton", label: "斧（スマッシュ）", file: "accessories/smash__axe_.png", zPrefix: 140 },
]);

export function partsByCategory(categoryId) {
  return SPRITE_PARTS.filter((p) => p.category === categoryId);
}

export function partById(id) {
  return SPRITE_PARTS.find((p) => p.id === id) || null;
}
