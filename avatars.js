// =============================================================
//  アバター用プリセットアイコン（固定イラストセット）
//  - 外部ライブラリ不要。背景色＋絵文字グリフで構成し、Canvas / DOM の
//    どちらでも同じ見た目で描画できるようにする。
//  - 保存するのは iconId のみ（全クライアントが同じ定義を持つため）。
// =============================================================
export const PRESET_ICONS = [
  { id: "fox", emoji: "🦊", bg: "#e67e22" },
  { id: "cat", emoji: "🐱", bg: "#9b59b6" },
  { id: "dog", emoji: "🐶", bg: "#d35400" },
  { id: "bear", emoji: "🐻", bg: "#795548" },
  { id: "panda", emoji: "🐼", bg: "#34495e" },
  { id: "rabbit", emoji: "🐰", bg: "#e84393" },
  { id: "tiger", emoji: "🐯", bg: "#f39c12" },
  { id: "lion", emoji: "🦁", bg: "#c0932b" },
  { id: "frog", emoji: "🐸", bg: "#27ae60" },
  { id: "monkey", emoji: "🐵", bg: "#a0522d" },
  { id: "penguin", emoji: "🐧", bg: "#2c3e50" },
  { id: "chick", emoji: "🐥", bg: "#f1c40f" },
  { id: "owl", emoji: "🦉", bg: "#6d4c41" },
  { id: "octopus", emoji: "🐙", bg: "#e74c3c" },
  { id: "unicorn", emoji: "🦄", bg: "#8e44ad" },
  { id: "bee", emoji: "🐝", bg: "#f5a623" },
  { id: "dragon", emoji: "🐲", bg: "#16a085" },
  { id: "dino", emoji: "🦖", bg: "#2ecc71" },
  { id: "dolphin", emoji: "🐬", bg: "#3498db" },
  { id: "butterfly", emoji: "🦋", bg: "#00cec9" },
  { id: "blossom", emoji: "🌸", bg: "#fd79a8" },
  { id: "clover", emoji: "🍀", bg: "#2d9e5e" },
  { id: "star", emoji: "⭐", bg: "#f6b93b" },
  { id: "fire", emoji: "🔥", bg: "#e55039" },
  { id: "apple", emoji: "🍎", bg: "#eb2f06" },
  { id: "rocket", emoji: "🚀", bg: "#4834d4" },
  { id: "balloon", emoji: "🎈", bg: "#eb4d4b" },
  { id: "rainbow", emoji: "🌈", bg: "#0984e3" },
];

export function presetById(id) {
  return PRESET_ICONS.find((p) => p.id === id) || null;
}

// 既定アイコン（uid から決定的に選ぶ→端末が変わっても同じ初期アイコン）
export function defaultPresetIdFor(uid) {
  let h = 0;
  for (let i = 0; i < (uid || "").length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return PRESET_ICONS[h % PRESET_ICONS.length].id;
}

// 絵文字描画に使うフォント（OS の絵文字フォントを優先）
export const EMOJI_FONT =
  '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
