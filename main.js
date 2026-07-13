// =============================================================
//  メイン: マップ描画 / 移動 / 位置同期(presence) / 近接判定
// =============================================================
import { db, auth } from "./firebase-config.js";
import {
  ref,
  get,
  set,
  update,
  push,
  query,
  limitToLast,
  onValue,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
  remove,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { RTCManager, getIceServers, runIceTest } from "./rtc.js";
import { MediaController } from "./media.js";
import { PRESET_ICONS, presetById, defaultPresetIdFor, EMOJI_FONT } from "./avatars.js";
import { SlimeGame } from "./slime-game.js";
import { VirtualQuestGate } from "./virtual-quest-gate.js";

// ---- 設定 ----
const params = new URLSearchParams(location.search);
const urlRoom = params.get("room"); // 共有リンク経由の確定ルームキー
const urlName = params.get("name");
const ICETEST = params.has("icetest"); // 診断画面ではロビーを出さない
let ROOM = null; // ロビーで確定（ルーム名＋合言葉から生成）
// 近接通話（屋外）の範囲。従来比 約1/4 = より近づかないと通話が始まらない。
// ※会議室などゾーン通話(ZONES)はこの半径に影響されない。
const CALL_RADIUS = 30; // この距離以内で通話開始（旧120）
const HANGUP_RADIUS = 48; // この距離を超えたら切断（ヒステリシスでバタつき防止・旧175）
const FULL_VOLUME_RADIUS = 12; // この距離以内なら最大音量（以遠は離れるほど小さく・旧45）
const PROXIMITY_CHIME_COOLDOWN_MS = 5000; // 境界付近の往復による連続通知を防ぐ
const PRESENCE_HEARTBEAT_INTERVAL_MS = 45_000;
const PRESENCE_STALE_AFTER_MS = 3 * 60_000;
const PRESENCE_SWEEP_INTERVAL_MS = 15_000;
const PRESENCE_FUTURE_TOLERANCE_MS = 60_000;
const SPEED = 3.2;

// ---- 自分 ----
let myId = null; // サインイン後の uid をセット
let currentUser = null; // Firebase Auth のユーザー
let meRef = null;
const rand4 = Math.random().toString(36).slice(2, 6);
const defaultName = "user-" + rand4;
let myName = null; // ロビーで確定
const myColor = `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`;

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");

// ---- ワールド（マップ）座標。RTDBで共有する座標系。office3.png の基準サイズ。----
// 既存コード(ゾーン/壁/描画)はワールド座標で書かれているため、名前は W/H のまま固定値にする。
const W = 960; // WORLD_W（office3.png は 16:9）
const H = 540; // WORLD_H
const AREAS = Object.freeze({
  OFFICE: "office",
  OUTER_EDGE: "outer-edge",
  OFFICE_EXTENSION: "office-extension",
});
const AREA_LABELS = Object.freeze({
  [AREAS.OFFICE]: "社内",
  [AREAS.OUTER_EDGE]: "外縁エリア",
  [AREAS.OFFICE_EXTENSION]: "拡張部屋",
});
const OUTER_EDGE_ENTRY = { x: W * 0.5, y: H * 0.18 };
const OUTER_EDGE_RETURN_GATE = Object.freeze({
  x: W * 0.41,
  y: H * 0.03,
  w: W * 0.18,
  h: H * 0.19,
});
const OUTER_EDGE_COMING_SOON_RANGE = 54;
const OUTER_EDGE_COMING_SOON_SPOTS = Object.freeze([
  {
    id: "left-stone-device",
    x: W * 0.14,
    y: H * 0.35,
    title: "COMING SOON",
    message: "石像のようなものがある。古い装置にも見えるが、まだ何もできなそうだ。",
  },
  {
    id: "left-bench",
    x: W * 0.18,
    y: H * 0.48,
    title: "COMING SOON",
    message: "ベンチのようなものがある。ひと休みできそうだが、まだ何もできなそうだ。",
  },
  {
    id: "left-crystal",
    x: W * 0.25,
    y: H * 0.46,
    title: "COMING SOON",
    message: "水晶のようなものがある。まだ何もできなそうだ。（今後機能追加で使えるようになります。）",
  },
  {
    id: "center-crystal",
    x: W * 0.5,
    y: H * 0.53,
    title: "COMING SOON",
    message: "水晶のようなものがある。淡く反応しているが、まだ何もできなそうだ。",
  },
  {
    id: "right-crystal",
    x: W * 0.72,
    y: H * 0.34,
    title: "COMING SOON",
    message: "水晶のようなものがある。何かを記録していそうだが、まだ何もできなそうだ。",
  },
  {
    id: "lower-left-dock",
    x: W * 0.1,
    y: H * 0.76,
    title: "COMING SOON",
    message: "船着き場のようなところがある。外へ向かえそうだが、まだ何もできなそうだ。",
  },
  {
    id: "lower-portal",
    x: W * 0.5,
    y: H * 0.76,
    title: "COMING SOON",
    message: "ポータルのような場所がある。どこかへつながりそうだが、まだ何もできなそうだ。",
  },
  {
    id: "right-ruin-gate",
    x: W * 0.85,
    y: H * 0.45,
    title: "COMING SOON",
    message: "石像のような門柱がある。奥に進めそうだが、まだ何もできなそうだ。",
  },
]);
let currentArea = AREAS.OFFICE;
let officeReturnPosition = { x: W * 0.475, y: H * 0.9 };
let extensionReturnPosition = { x: W * 0.545, y: H * 0.24 };
const OFFICE_EXTENSION_SOURCE_ASPECT = 2173 / 724;
const OFFICE_EXTENSION_ENTRY_N = Object.freeze({ x: 0.5, y: 0.78 });
const OFFICE_EXTENSION_DOOR = Object.freeze({
  x: W * 0.505,
  y: H * 0.0,
  w: W * 0.08,
  h: H * 0.13,
});
const OFFICE_EXTENSION_RETURN_DOOR_N = Object.freeze({
  x: 0.46,
  y: 0.68,
  w: 0.09,
  h: 0.23,
});
const OFFICE_EXTENSION_LOCKED_DOOR_N = Object.freeze({
  x: 0.56,
  y: 0.1,
  w: 0.08,
  h: 0.17,
});
const OFFICE_EXTENSION_MESSAGE_SPOTS = Object.freeze([
  {
    id: "my-room",
    title: "マイルーム",
    message: "まだ入れません。",
    rect: { x: 0.02, y: 0.06, w: 0.24, h: 0.56 },
  },
  {
    id: "alchemy-device",
    title: "錬成装置",
    message: "まだ使えません。",
    rect: { x: 0.66, y: 0.08, w: 0.3, h: 0.5 },
  },
]);

// ---- カメラ（各端末ローカル・通信しない）。アバターを追従しズームしてスクロール表示 ----
const MOBILE = matchMedia("(pointer: coarse)").matches || window.innerWidth < 700;
// ワールドが画面を覆う最小ズーム（これ未満だと黒余白が出る＝全画面表示の下限）
function fitZoom() {
  return Math.max(window.innerWidth / W, window.innerHeight / H);
}
function minZoom() {
  return fitZoom();
}
const camera = { x: W / 2, y: H / 2, zoom: fitZoom() }; // 既定は全画面フィット。ピンチ/ホイールで拡大可
let dpr = 1;
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  setZoom(camera.zoom); // 画面サイズ変化に合わせて最小ズーム（全画面）を再適用
}
// 表示サイズの変化（回転/リサイズ/タイル増減）に追従
new ResizeObserver(resizeCanvas).observe(canvas);

function visibleElementRect(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return rect;
}

function cameraOverlayInsetsPx() {
  const margin = 14;
  const videosRect = visibleElementRect("videos");
  const controlsRect = visibleElementRect("controls");
  return {
    top: videosRect ? Math.max(0, videosRect.bottom + margin) : 0,
    bottom: controlsRect ? Math.max(0, window.innerHeight - controlsRect.top + margin) : 0,
  };
}

function updateCamera() {
  camera.x += (me.x - camera.x) * 0.15;

  const s = camera.zoom * dpr;
  const halfW = canvas.width / 2 / s;
  const halfH = canvas.height / 2 / s;
  camera.x = halfW * 2 >= W ? W / 2 : Math.max(halfW, Math.min(W - halfW, camera.x));

  const insets = cameraOverlayInsetsPx();
  const topOverscroll = Math.max(0, insets.top / camera.zoom - R);
  const bottomOverscroll = Math.max(0, insets.bottom / camera.zoom - R);
  const minY = halfH - topOverscroll;
  const maxY = H - halfH + bottomOverscroll;
  camera.y = Math.max(minY, Math.min(maxY, me.y));
}

// ---- 手動ズーム（PC=ホイール / スマホ=ピンチ）----
function setZoom(z) {
  camera.zoom = Math.max(minZoom(), Math.min(6, z)); // 下限＝全画面フィット
}
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    setZoom(camera.zoom * Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false }
);
let pinchPrev = 0;
function pinchDist(e) {
  const a = e.touches[0];
  const b = e.touches[1];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
canvas.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length === 2) pinchPrev = pinchDist(e);
  },
  { passive: false }
);
canvas.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const d = pinchDist(e);
      if (pinchPrev) setZoom(camera.zoom * (d / pinchPrev));
      pinchPrev = d;
    }
  },
  { passive: false }
);
canvas.addEventListener("touchend", () => {
  pinchPrev = 0;
});

// ---- オフィスのマップ（背景画像 office.png ＋ 壁の当たり判定） ----
const R = 16; // アバター半径（衝突マージン）
const DEBUG = new URLSearchParams(location.search).has("debug"); // ?debug で採寸グリッド表示

// 背景のオフィス画像
const officeImg = new Image();
let officeImgReady = false;
officeImg.onload = () => (officeImgReady = true);
officeImg.src = "office3-door.png";

const officeExtensionImg = new Image();
let officeExtensionImgReady = false;
officeExtensionImg.onload = () => (officeExtensionImgReady = true);
officeExtensionImg.src = "office-extension-design.png";

const outerEdgeImg = new Image();
let outerEdgeImgReady = false;
outerEdgeImg.onload = () => (outerEdgeImgReady = true);
outerEdgeImg.src = "assets/virtual-quest-outer-edge.png";

// 壁(通行不可)を正規化座標(0..1)で定義 → 実ピクセルへ変換。
// ?debug のグリッドを見ながら office.png のレイアウトに合わせて調整する。
const WALL_RECTS_N = [
  // 例: { x: 0.45, y: 0.05, w: 0.012, h: 0.4 }
];
const WALLS = WALL_RECTS_N.map((r) => ({
  x: r.x * W,
  y: r.y * H,
  w: r.w * W,
  h: r.h * H,
}));

function officeExtensionDrawRect() {
  const aspect =
    officeExtensionImgReady && officeExtensionImg.naturalWidth && officeExtensionImg.naturalHeight
      ? officeExtensionImg.naturalWidth / officeExtensionImg.naturalHeight
      : OFFICE_EXTENSION_SOURCE_ASPECT;
  const worldAspect = W / H;
  if (aspect >= worldAspect) {
    const h = W / aspect;
    return { x: 0, y: (H - h) / 2, w: W, h };
  }
  const w = H * aspect;
  return { x: (W - w) / 2, y: 0, w, h: H };
}

function officeExtensionPointFromNormalized(point) {
  const rect = officeExtensionDrawRect();
  return { x: rect.x + point.x * rect.w, y: rect.y + point.y * rect.h };
}

function officeExtensionRectFromNormalized(rect) {
  const drawRect = officeExtensionDrawRect();
  return {
    x: drawRect.x + rect.x * drawRect.w,
    y: drawRect.y + rect.y * drawRect.h,
    w: rect.w * drawRect.w,
    h: rect.h * drawRect.h,
  };
}

function isInOfficeExtensionImageBounds(x, y) {
  const rect = officeExtensionDrawRect();
  return x >= rect.x + R && x <= rect.x + rect.w - R && y >= rect.y + R && y <= rect.y + rect.h - R;
}

// その座標にアバター中心を置けるか（壁・画面外なら false）
function canBeAt(x, y) {
  if (x < R || x > W - R || y < R || y > H - R) return false;
  if (currentArea === AREAS.OFFICE_EXTENSION && !isInOfficeExtensionImageBounds(x, y)) return false;
  for (const wll of WALLS) {
    if (
      x > wll.x - R &&
      x < wll.x + wll.w + R &&
      y > wll.y - R &&
      y < wll.y + wll.h + R
    ) {
      return false;
    }
  }
  return true;
}

// ---- エリア（部屋）: 同じエリアにいる人同士は距離に関係なく通話 ----
// 座標は office3.png に合わせた正規化(0..1)。?debug で枠を見ながら調整可。
// エリア通話は会議室だけ。それ以外の部屋は通常の近接通話（青い円）にする。
const ZONES = [
  { id: "meeting", label: "会議室", x: 0.04, y: 0.07, w: 0.23, h: 0.39, rgb: "52,152,219" },
];
const GAME_AREA = { id: "slime-game", x: 0.59, y: 0.54, w: 0.24, h: 0.3 };
function zoneOf(p) {
  if (currentArea !== AREAS.OFFICE) return null;
  for (const z of ZONES) {
    const zx = z.x * W,
      zy = z.y * H,
      zw = z.w * W,
      zh = z.h * H;
    if (p.x >= zx && p.x <= zx + zw && p.y >= zy && p.y <= zy + zh) return z.id;
  }
  return null;
}
function isInGameArea(p) {
  if (currentArea !== AREAS.OFFICE) return false;
  const x = GAME_AREA.x * W;
  const y = GAME_AREA.y * H;
  const width = GAME_AREA.w * W;
  const height = GAME_AREA.h * H;
  return p.x >= x && p.x <= x + width && p.y >= y && p.y <= y + height;
}

function normalizeArea(value) {
  return Object.values(AREAS).includes(value) ? value : AREAS.OFFICE;
}

function areaOfPlayer(player) {
  if (player === me) return currentArea;
  return normalizeArea(player && player.area);
}

function isPlayerInCurrentArea(player) {
  return areaOfPlayer(player) === currentArea;
}

const me = {
  x: W * 0.45, // 中央の島デスクあたり
  y: H * 0.5,
  name: "", // ロビー入室時に設定
  color: myColor,
  iconType: "preset", // "preset" | "upload"
  iconId: "", // プリセットID（iconType==="preset"）
  iconUrl: "", // アップロード画像URL（iconType==="upload"）
  message: "", // 在席中だけ表示する最新のひとこと（履歴・永続保存なし）
  messageEventId: "",
  active: false, // このタブが表示中かつ通話準備済み
};
camera.x = me.x; // 開始時のカメラを自分に合わせる（追従の初期ジャンプ防止）
camera.y = me.y;
const others = {}; // id -> {x, y, name, color, active?, message?, messageEventId?, announcing?, summon?}
let announcing = false; // 全体アナウンス中か（自分）
let lastSummonTs = Date.now(); // 自分が処理済みの最新の集合ts（join前の古い集合は無視）
let media = null; // MediaController（カメラ/マイク/背景/画面共有）
let currentRoomName = ""; // 入室中ルームの表示名（招待リンク生成に使う）
let currentPassphrase = ""; // 入室中ルームの合言葉（招待リンクに埋め込む）
const GAME_STATES = Object.freeze({
  OUTSIDE: "OUTSIDE",
  READY: "READY",
  PLAYING: "PLAYING",
  COOLDOWN: "COOLDOWN",
});
let gameState = GAME_STATES.OUTSIDE;
let gameCooldownUntil = 0;
let lockedGamePosition = null;
let slimeGame = null;
let virtualQuestGate = null;

// ---- 通知音 / アクティブ状態 ----
let notificationAudioContext = null;
let outputVolume = 1;
let lastAudibleOutputVolume = 1;
let communicationReady = false;
let lastPublishedActive = null;
let presenceInitialized = false;
let presenceConnectionUnsubscribe = null;
let presencePlayersUnsubscribe = null;
let presenceServerTimeOffsetUnsubscribe = null;
let presenceHeartbeatTimer = null;
let presenceSweepTimer = null;
let presenceServerTimeOffset = 0;
const seenMessageEventIds = new Map();
const seenStampEventIds = new Map();
const peersInChimeRange = new Set();
const lastProximityChimeAt = new Map();
const activeStamps = [];
const STAMP_DURATION_MS = 1200;
const STAMP_TYPES = Object.freeze({
  like: "👍",
  clap: "👏",
  party: "🎉",
  heart: "❤️",
  laugh: "😂",
  sad: "😢",
});

function outputVolumeStorageKey(uid) {
  return `vo_output_volume_${uid || "guest"}`;
}

function lastOutputVolumeStorageKey(uid) {
  return `vo_output_volume_last_${uid || "guest"}`;
}

function loadStoredVolume(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  } catch (_) {
    return fallback;
  }
}

function loadOutputVolume(uid) {
  return loadStoredVolume(outputVolumeStorageKey(uid), 1);
}

function loadLastAudibleOutputVolume(uid) {
  const value = loadStoredVolume(lastOutputVolumeStorageKey(uid), 1);
  return value > 0 ? value : 1;
}

function saveOutputVolume(uid) {
  try {
    localStorage.setItem(outputVolumeStorageKey(uid), String(outputVolume));
    localStorage.setItem(lastOutputVolumeStorageKey(uid), String(lastAudibleOutputVolume));
  } catch (_) {}
}

// ---- チャット（ルーム全体・毎朝5時にGitHub Actionsで全削除）----
const CHAT_HISTORY_LIMIT = 200; // 表示・購読する最大件数（無料枠を圧迫しないよう間引く）
const CHAT_MAX_LEN = 200; // 本文の最大文字数
const CHAT_RATE_LIMIT_WINDOW_MS = 10000;
const CHAT_RATE_LIMIT_MAX = 10; // 直近10秒で送れる上限（連投防止）
let chatRef = null;
let chatPanelOpen = false;
let unreadChatCount = 0;
const sentChatTimes = [];
let lastChatRateLimitToastAt = 0;

function ensureNotificationAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!notificationAudioContext) notificationAudioContext = new AudioContextClass();
  return notificationAudioContext;
}

// ブラウザの自動再生制限を満たすため、入室操作のユーザージェスチャー内で呼ぶ。
function unlockNotificationAudio() {
  const audio = ensureNotificationAudio();
  if (!audio) return;
  const prime = () => {
    const source = audio.createBufferSource();
    source.buffer = audio.createBuffer(1, 1, audio.sampleRate);
    source.connect(audio.destination);
    source.start();
  };
  if (audio.state === "suspended") audio.resume().then(prime).catch(() => {});
  else prime();
}

function scheduleChime(audio, kind) {
  const start = audio.currentTime + 0.015;
  let tones;
  if (kind === "message") {
    tones = [
      { frequency: 659, offset: 0, duration: 0.09 },
      { frequency: 988, offset: 0.11, duration: 0.14 },
    ];
  } else if (kind === "stamp") {
    tones = [
      { frequency: 784, offset: 0, duration: 0.06, type: "triangle", gain: 0.06 },
      { frequency: 1047, offset: 0.07, duration: 0.1, type: "triangle", gain: 0.06 },
    ];
  } else if (kind === "chat") {
    tones = [
      { frequency: 523, offset: 0, duration: 0.08, type: "sine", gain: 0.07 },
      { frequency: 784, offset: 0.09, duration: 0.12, type: "sine", gain: 0.07 },
    ];
  } else {
    tones = [
      { frequency: 880, offset: 0, duration: 0.08 },
      { frequency: 1175, offset: 0.1, duration: 0.13 },
    ];
  }
  for (const tone of tones) {
    const at = start + tone.offset;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = tone.type || "sine";
    oscillator.frequency.setValueAtTime(tone.frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, (tone.gain || 0.08) * outputVolume),
      at + 0.01
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.duration);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + tone.duration + 0.02);
  }
}

function playNotificationChime(kind) {
  if (outputVolume <= 0) return;
  const audio = ensureNotificationAudio();
  if (!audio) return;
  if (audio.state === "suspended") {
    audio.resume().then(() => scheduleChime(audio, kind)).catch(() => {});
  } else {
    scheduleChime(audio, kind);
  }
}

function createEventId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function safeDisplayName(value, fallback = "ゲスト") {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.toLowerCase() === "undefined" || name.toLowerCase() === "null") {
    return fallback;
  }
  return Array.from(name).slice(0, 16).join("");
}

function normalizePlayer(id, value) {
  if (!value || typeof value !== "object") return null;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  const iconUrl = typeof value.iconUrl === "string" ? value.iconUrl : "";
  const useUpload = value.iconType === "upload" && !!iconUrl;
  const requestedIconId = typeof value.iconId === "string" ? value.iconId : "";
  const iconId = presetById(requestedIconId) ? requestedIconId : defaultPresetIdFor(id);
  const area = normalizeArea(value.area);
  return {
    ...value,
    x: Math.max(0, Math.min(W, value.x)),
    y: Math.max(0, Math.min(H, value.y)),
    name: safeDisplayName(value.name),
    color: typeof value.color === "string" && value.color ? value.color : "#888",
    iconType: useUpload ? "upload" : "preset",
    iconId,
    iconUrl: useUpload ? iconUrl : "",
    area,
    questAreaName: area !== AREAS.OFFICE ? safeDisplayName(value.questAreaName, AREA_LABELS[area]) : "",
    message:
      typeof value.message === "string"
        ? Array.from(value.message.replace(/[\r\n\u2028\u2029]+/g, " ")).slice(0, 15).join("")
        : "",
  };
}

function presenceServerNow() {
  return Date.now() + presenceServerTimeOffset;
}

function lastPresenceAt(player) {
  return Math.max(
    Number.isFinite(player && player.heartbeatAt) ? player.heartbeatAt : 0,
    Number.isFinite(player && player.ts) ? player.ts : 0,
    Number.isFinite(player && player.activeAt) ? player.activeAt : 0
  );
}

function isPresenceFresh(player, now = presenceServerNow()) {
  const lastSeenAt = lastPresenceAt(player);
  if (!lastSeenAt || lastSeenAt > now + PRESENCE_FUTURE_TOLERANCE_MS) return false;
  return now - lastSeenAt <= PRESENCE_STALE_AFTER_MS;
}

function isAppActive() {
  return communicationReady && document.visibilityState === "visible" && document.hasFocus();
}

function currentPresencePayload() {
  const active = isAppActive();
  const questAreaName = currentArea !== AREAS.OFFICE ? AREA_LABELS[currentArea] : null;
  return {
    x: Math.round(me.x),
    y: Math.round(me.y),
    name: safeDisplayName(me.name, defaultName),
    color: typeof me.color === "string" && me.color ? me.color : myColor,
    iconType: me.iconType === "upload" && me.iconUrl ? "upload" : "preset",
    iconId: me.iconId || defaultPresetIdFor(myId || ""),
    iconUrl: me.iconType === "upload" ? me.iconUrl || "" : "",
    announcing: !!announcing,
    sharing: !!(media && media.screenOn),
    message: me.message || null,
    messageEventId: me.message ? me.messageEventId || null : null,
    area: currentArea,
    questAreaName,
    active,
    activeAt: serverTimestamp(),
    heartbeatAt: serverTimestamp(),
    ts: serverTimestamp(),
  };
}

function restorePresence() {
  if (!meRef) return Promise.resolve();
  const payload = currentPresencePayload();
  me.active = payload.active;
  lastPublishedActive = payload.active;
  return update(meRef, payload).catch((error) => {
    lastPublishedActive = null;
    console.warn("在席情報の復元失敗:", error);
  });
}

function syncActivePresence() {
  const active = isAppActive();
  me.active = active;
  if (!meRef || lastPublishedActive === active) return;
  lastPublishedActive = active;
  update(meRef, {
    active,
    activeAt: serverTimestamp(),
    heartbeatAt: serverTimestamp(),
  }).catch(() => {
    if (lastPublishedActive === active) lastPublishedActive = null;
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") restorePresence();
  else syncActivePresence();
});
window.addEventListener("focus", restorePresence);
window.addEventListener("blur", syncActivePresence);

// ---- 映像タイル ----
const videosEl = document.getElementById("videos");
const videoTiles = new Map(); // id -> wrapper element

// 画面共有の大画面表示
const shareStage = document.getElementById("share-stage");
const shareVideo = document.getElementById("share-video");
const shareLabel = document.getElementById("share-label");
let currentShareId = null;

// モバイルの自動再生対策：再生を試み、ブロックされたら次のユーザー操作で再試行
const pendingPlays = new Set();
function tryPlay(v) {
  const p = v.play();
  if (p && p.catch) p.catch(() => pendingPlays.add(v));
}
function flushPlays() {
  pendingPlays.forEach((v) => {
    v.play()
      .then(() => pendingPlays.delete(v))
      .catch(() => {});
  });
}
["pointerdown", "touchstart", "keydown"].forEach((ev) =>
  document.addEventListener(ev, flushPlays, true)
);

function makeTile(id, label, stream, muted, local) {
  const wrap = document.createElement("div");
  wrap.className = "tile" + (local ? " local mirror" : "");
  const v = document.createElement("video");
  v.autoplay = true;
  v.playsInline = true;
  v.setAttribute("playsinline", ""); // iOS Safari 用に属性でも指定
  v.setAttribute("webkit-playsinline", "");
  v.muted = !!muted;
  v.srcObject = stream;
  const cap = document.createElement("span");
  cap.className = "cap";
  cap.textContent = label;
  wrap.appendChild(v);
  wrap.appendChild(cap);
  // タップで強制再生（iOSの自動再生ブロックの最終手段）
  wrap.addEventListener("click", () => tryPlay(v));
  videosEl.appendChild(wrap);
  videoTiles.set(id, wrap);
  tryPlay(v);
}
function addRemoteVideo(peerId, stream) {
  const existing = videoTiles.get(peerId);
  if (existing) {
    const v = existing.querySelector("video");
    v.srcObject = stream;
    tryPlay(v);
    return;
  }
  const name = (others[peerId] && others[peerId].name) || peerId;
  makeTile(peerId, name, stream, false);
}
function removeVideo(peerId) {
  const el = videoTiles.get(peerId);
  if (el) {
    el.remove();
    videoTiles.delete(peerId);
  }
}

// ---- メディア操作バー（カメラ/マイク/背景）の配線 ----
function setupControls(media) {
  const camBtn = document.getElementById("btn-cam");
  const micBtn = document.getElementById("btn-mic");
  const volumeBtn = document.getElementById("btn-volume");
  const screenBtn = document.getElementById("btn-screen");
  const bgBtn = document.getElementById("btn-bg");
  const annBtn = document.getElementById("btn-announce");
  const summonBtn = document.getElementById("btn-summon");
  const messageBtn = document.getElementById("btn-message");
  const stampBtn = document.getElementById("btn-stamp");
  const chatBtn = document.getElementById("btn-chat");

  const bgPopover = document.getElementById("bg-popover");
  const outputVolumePopover = document.getElementById("output-volume-popover");
  const outputVolumeRange = document.getElementById("output-volume-range");
  const outputVolumeValue = document.getElementById("output-volume-value");
  const summonPanel = document.getElementById("summon-panel");
  const summonList = document.getElementById("summon-list");
  const messagePopover = document.getElementById("message-popover");
  const messageInput = document.getElementById("message-input");
  const messageCount = document.getElementById("message-count");
  const messageSend = document.getElementById("message-send");
  const messageClear = document.getElementById("message-clear");
  const stampPopover = document.getElementById("stamp-popover");
  const stampOptions = [...stampPopover.querySelectorAll("[data-stamp]")];
  const chatBackdrop = document.getElementById("chat-backdrop");
  const chatClose = document.getElementById("chat-close");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");

  const bgMode = document.getElementById("bg-mode");
  const blurRange = document.getElementById("blur-range");
  const blurRow = document.getElementById("blur-row");
  const bgImageBtn = document.getElementById("btn-bg-image");
  const bgFile = document.getElementById("bg-file");
  const bgNote = document.getElementById("bg-note");

  const setIcon = (btn, cls) => {
    const i = btn.querySelector("i");
    if (i) i.className = "ti " + cls;
  };
  const closePopovers = () => {
    bgPopover.hidden = true;
    outputVolumePopover.hidden = true;
    volumeBtn.setAttribute("aria-expanded", "false");
    summonPanel.hidden = true;
    messagePopover.hidden = true;
    stampPopover.hidden = true;
  };

  // 改行を空白へ変換し、最新の15文字だけを扱う。履歴やプロフィールには保存しない。
  const sanitizeMessage = (value) =>
    Array.from(String(value || "").replace(/[\r\n\u2028\u2029]+/g, " "))
      .slice(0, 15)
      .join("");
  const normalizeMessage = (value) => sanitizeMessage(value).trim();
  const syncMessageUI = () => {
    const value = sanitizeMessage(messageInput.value);
    if (messageInput.value !== value) messageInput.value = value;
    messageCount.textContent = `${Array.from(value).length} / 15`;
    messageClear.disabled = !me.message;
    messageBtn.classList.toggle("active", !!me.message);
    messageBtn.setAttribute(
      "aria-label",
      me.message
        ? "ひとことメッセージ（表示中、ショートカット: M）"
        : "ひとことメッセージ（ショートカット: M）"
    );
  };
  const publishMessage = async () => {
    const value = normalizeMessage(messageInput.value);
    if (!value) {
      toast("メッセージを入力してください");
      messageInput.focus();
      return;
    }
    try {
      const messageEventId = createEventId();
      await update(meRef, { message: value, messageEventId });
      me.message = value;
      me.messageEventId = messageEventId;
      messageInput.value = value;
      syncMessageUI();
      messagePopover.hidden = true;
      playNotificationChime("message");
      toast("ひとことメッセージを表示しました");
    } catch (e) {
      console.warn("メッセージ送信失敗:", e);
      toast("メッセージを表示できませんでした");
    }
  };
  const clearMessage = async () => {
    if (!me.message) return;
    try {
      await update(meRef, { message: null, messageEventId: null });
      me.message = "";
      me.messageEventId = "";
      messageInput.value = "";
      syncMessageUI();
      messagePopover.hidden = true;
      toast("ひとことメッセージを削除しました");
    } catch (e) {
      console.warn("メッセージ削除失敗:", e);
      toast("メッセージを削除できませんでした");
    }
  };
  const openMessagePopover = () => {
    closePopovers();
    messageInput.value = me.message || "";
    syncMessageUI();
    messagePopover.hidden = false;
    messageInput.focus();
    messageInput.select();
  };
  const openStampPopover = () => {
    closePopovers();
    stampPopover.hidden = false;
    const firstOption = stampOptions[0];
    if (firstOption) firstOption.focus();
  };
  const sentStampTimes = [];
  let lastStampRateLimitToastAt = 0;
  const publishStamp = async (type) => {
    if (!Object.prototype.hasOwnProperty.call(STAMP_TYPES, type) || !meRef) return;
    const now = Date.now();
    while (sentStampTimes.length && now - sentStampTimes[0] >= 1000) sentStampTimes.shift();
    if (sentStampTimes.length >= 8) {
      if (now - lastStampRateLimitToastAt >= 1000) {
        lastStampRateLimitToastAt = now;
        toast("スタンプは1秒に8回まで送信できます");
      }
      return;
    }
    sentStampTimes.push(now);
    const eventId = createEventId();
    const eventRef = ref(
      db,
      `rooms/${ROOM}/players/${myId}/stampEvents/${eventId}`
    );
    try {
      await set(eventRef, { type, ts: serverTimestamp() });
      addStampAnimation(myId, type);
      playNotificationChime("stamp");
      setTimeout(() => {
        remove(eventRef).catch((error) => console.warn("スタンプ削除失敗:", error));
      }, 10000);
    } catch (error) {
      console.warn("スタンプ送信失敗:", error);
      toast("スタンプを送信できませんでした");
    }
  };

  function syncCamUI() {
    const on = media.cameraOn;
    setIcon(camBtn, on ? "ti-video" : "ti-video-off");
    camBtn.classList.toggle("off", !on);
    camBtn.setAttribute(
      "aria-label",
      on ? "カメラ オン（ショートカット: V）" : "カメラ オフ（ショートカット: V）"
    );
    // 自分タイルはカメラON時のみ鏡像（OFF/画面共有中はそのまま表示）
    const myTile = videoTiles.get("__me__");
    if (myTile) myTile.classList.toggle("mirror", on && !media.screenOn);
  }
  function syncMicUI() {
    const on = media.micOn;
    setIcon(micBtn, on ? "ti-microphone" : "ti-microphone-off");
    micBtn.classList.toggle("off", !on);
    micBtn.setAttribute(
      "aria-label",
      on ? "マイク オン（ショートカット: B）" : "マイク オフ（ショートカット: B）"
    );
  }
  function syncOutputVolumeUI() {
    const percent = Math.round(outputVolume * 100);
    outputVolumeRange.value = String(percent);
    outputVolumeValue.textContent = `${percent}%`;
    outputVolumeRange.setAttribute("aria-valuetext", `${percent}%`);
    const icon =
      percent === 0
        ? "ti-volume-off"
        : percent <= 50
          ? "ti-volume-2"
          : "ti-volume";
    setIcon(volumeBtn, icon);
    volumeBtn.classList.toggle("off", percent === 0);
    volumeBtn.setAttribute("aria-label", `出力音量 ${percent}%（ショートカット: U）`);
  }
  function setOutputVolume(value, persist = false) {
    const normalized = Math.max(0, Math.min(1, Number(value) || 0));
    outputVolume = normalized;
    if (normalized > 0) lastAudibleOutputVolume = normalized;
    syncOutputVolumeUI();
    updateSpatialAudio();
    if (persist) saveOutputVolume(myId);
    noteHudActivity();
  }
  function toggleOutputMute() {
    if (outputVolume > 0) {
      lastAudibleOutputVolume = outputVolume;
      setOutputVolume(0, true);
      toast("こちらで聞こえる音をミュートしました");
    } else {
      setOutputVolume(lastAudibleOutputVolume || 1, true);
      toast(`出力音量を${Math.round(outputVolume * 100)}%に戻しました`);
    }
  }
  function syncScreenUI() {
    const on = media.screenOn;
    screenBtn.classList.toggle("active", on);
    screenBtn.setAttribute("aria-label", on ? "画面共有 中（停止）" : "画面共有");
    const myTile = videoTiles.get("__me__");
    if (myTile) myTile.classList.toggle("mirror", media.cameraOn && !on);
    if (meRef) update(meRef, { sharing: on }); // 全員に共有状態を知らせる
  }
  function syncBgUI() {
    blurRow.style.display = bgMode.value === "blur" ? "" : "none";
    bgImageBtn.style.display = bgMode.value === "image" ? "" : "none";
    bgBtn.classList.toggle("active", bgMode.value !== "none");
  }

  const toggleCamera = () => {
    media.toggleCamera();
    syncCamUI();
    noteHudActivity();
  };
  const toggleMic = () => {
    media.toggleMic();
    syncMicUI();
    noteHudActivity();
  };
  const toggleAnnounce = () => {
    announcing = !announcing;
    annBtn.classList.toggle("active", announcing);
    annBtn.setAttribute("aria-pressed", announcing ? "true" : "false");
    annBtn.setAttribute(
      "aria-label",
      announcing
        ? "アナウンス 中（ショートカット: R）"
        : "アナウンス（ショートカット: R）"
    );
    if (meRef) update(meRef, { announcing });
    toast(announcing ? "アナウンスを開始（現在のエリアに配信）" : "アナウンスを終了しました");
    noteHudActivity();
  };
  const openSummonPanel = () => {
    closePopovers();
    renderSummonList(summonList);
    summonPanel.hidden = false;
    summonList.querySelector("input, button")?.focus();
    noteHudActivity();
  };

  camBtn.addEventListener("click", toggleCamera);
  micBtn.addEventListener("click", toggleMic);
  volumeBtn.addEventListener("click", () => {
    const show = outputVolumePopover.hidden;
    closePopovers();
    outputVolumePopover.hidden = !show;
    volumeBtn.setAttribute("aria-expanded", show ? "true" : "false");
    if (show) outputVolumeRange.focus();
    noteHudActivity();
  });
  outputVolumeRange.addEventListener("input", () => {
    setOutputVolume(Number(outputVolumeRange.value) / 100);
  });
  outputVolumeRange.addEventListener("change", () => saveOutputVolume(myId));

  // --- 画面共有 ---
  media.onScreenEnd = syncScreenUI; // ブラウザ側「共有を停止」にも追従
  screenBtn.addEventListener("click", async () => {
    if (media.screenOn) {
      media.stopScreenShare();
    } else {
      const r = await media.startScreenShare();
      if (r && r.error) {
        toast("画面共有を開始できませんでした");
        return;
      }
    }
    syncScreenUI();
  });

  // --- 全体アナウンス ---
  annBtn.addEventListener("click", toggleAnnounce);

  // --- 背景（ポップオーバー）---
  bgBtn.addEventListener("click", () => {
    const show = bgPopover.hidden;
    closePopovers();
    bgPopover.hidden = !show;
  });
  bgMode.addEventListener("change", async () => {
    const want = bgMode.value;
    bgNote.textContent = want === "none" ? "" : "背景処理を準備中…";
    const res = await media.setBackground(want);
    if (res.error === "segmentation_unavailable") {
      bgMode.value = "none";
      bgNote.textContent = "⚠ 背景処理を読み込めませんでした";
    } else {
      bgNote.textContent = "";
    }
    syncBgUI();
    saveBackgroundPreference();
  });
  blurRange.addEventListener("input", () => media.setBlurAmount(blurRange.value));
  blurRange.addEventListener("change", () => saveBackgroundPreference()); // ドラッグ終了時だけ保存（連続書き込み防止）
  bgImageBtn.addEventListener("click", () => bgFile.click());
  bgFile.addEventListener("change", () => {
    const file = bgFile.files && bgFile.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = async () => {
      const res = await media.setBackground("image", img);
      if (res.error) {
        bgMode.value = "none";
        bgNote.textContent = "⚠ 背景処理を読み込めませんでした";
      } else {
        bgMode.value = "image";
        bgNote.textContent = "バーチャル背景: 画像を設定しました";
        bgImageDataUrl = compressBackgroundImage(img);
      }
      syncBgUI();
      saveBackgroundPreference();
    };
    img.onerror = () => (bgNote.textContent = "⚠ 画像の読み込みに失敗しました");
    img.src = URL.createObjectURL(file);
  });

  // 前回の背景設定を復元（Issue #7）。カメラ初期化後・非同期で行い起動を遅らせない。
  (async () => {
    const pref = await loadBackgroundPreference(myId);
    if (!pref || pref.mode === "none") return;
    if (Number.isFinite(pref.blurAmount)) {
      blurRange.value = pref.blurAmount;
      media.setBlurAmount(pref.blurAmount);
    }
    if (pref.mode === "image" && pref.imageUrl) {
      const img = new Image();
      img.onload = async () => {
        bgImageDataUrl = pref.imageUrl;
        const res = await media.setBackground("image", img);
        if (res.error) {
          toast("⚠ 前回のバーチャル背景を復元できませんでした");
        } else {
          bgMode.value = "image";
        }
        syncBgUI();
      };
      img.onerror = () => {
        toast("⚠ 前回の背景画像を復元できませんでした");
        syncBgUI();
      };
      img.src = pref.imageUrl;
    } else if (pref.mode === "blur") {
      const res = await media.setBackground("blur");
      if (res.error) {
        toast("⚠ 前回の背景設定を復元できませんでした");
      } else {
        bgMode.value = "blur";
      }
      syncBgUI();
    }
  })();

  // --- 集合（特定の人を呼ぶ・ポップオーバー）---
  summonBtn.addEventListener("click", () => {
    const show = summonPanel.hidden;
    closePopovers();
    if (show) openSummonPanel();
  });
  document.getElementById("summon-cancel").addEventListener("click", () => (summonPanel.hidden = true));
  document.getElementById("summon-go").addEventListener("click", () => {
    const targets = [...summonList.querySelectorAll("input:checked")].map((i) => i.value);
    if (!targets.length) {
      toast("集合させる人を選んでください");
      return;
    }
    if (meRef) {
      update(meRef, {
        summon: { targets, x: Math.round(me.x), y: Math.round(me.y), ts: Date.now() },
      });
    }
    summonPanel.hidden = true;
    toast(`${targets.length}人を自分の場所に集合させました`);
  });

  // --- ひとことメッセージ（プレイヤーごとに最新1件だけ上書き）---
  messageBtn.addEventListener("click", () => {
    const show = messagePopover.hidden;
    closePopovers();
    if (show) openMessagePopover();
  });
  messageInput.addEventListener("input", syncMessageUI);
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      if (normalizeMessage(messageInput.value)) {
        publishMessage();
      } else if (me.message) {
        clearMessage();
      } else {
        messagePopover.hidden = true;
      }
    }
  });
  messageSend.addEventListener("click", publishMessage);
  messageClear.addEventListener("click", clearMessage);
  stampBtn.addEventListener("click", () => {
    const show = stampPopover.hidden;
    closePopovers();
    if (show) openStampPopover();
  });
  stampOptions.forEach((option) => {
    option.addEventListener("click", () => {
      publishStamp(option.dataset.stamp);
      noteHudActivity();
    });
  });

  // --- チャット（ルーム全体・毎朝5時に自動削除）---
  chatBtn.addEventListener("click", () => {
    closePopovers();
    toggleChatPanel();
    noteHudActivity();
  });
  chatClose.addEventListener("click", closeChatPanel);
  chatBackdrop.addEventListener("click", closeChatPanel);
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = chatInput.value;
    if (!sanitizeChatText(text)) return;
    chatInput.value = "";
    noteHudActivity();
    const ok = await sendChatMessage(text);
    if (!ok) chatInput.value = text; // 失敗時は入力内容を復元
    chatInput.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!outputVolumePopover.hidden) {
        closePopovers();
        volumeBtn.focus();
        event.preventDefault();
        return;
      }
      if (!messagePopover.hidden || !stampPopover.hidden) {
        const returnFocus = !messagePopover.hidden ? messageBtn : stampBtn;
        closePopovers();
        returnFocus.focus();
        event.preventDefault();
        return;
      }
      if (chatPanelOpen) {
        closeChatPanel();
        chatBtn.focus();
        event.preventDefault();
      }
      return;
    }
    const shortcutKey = event.key.toLowerCase();
    const canUseControlShortcut =
      !event.repeat &&
      !event.isComposing &&
      !isEditableTarget(event.target) &&
      !isBlockingOverlayOpen();
    if (canUseControlShortcut) {
      if (shortcutKey === "v") {
        event.preventDefault();
        toggleCamera();
        return;
      }
      if (shortcutKey === "b") {
        event.preventDefault();
        toggleMic();
        return;
      }
      if (shortcutKey === "u") {
        event.preventDefault();
        toggleOutputMute();
        return;
      }
      if (shortcutKey === "r") {
        event.preventDefault();
        toggleAnnounce();
        return;
      }
      if (shortcutKey === "t") {
        event.preventDefault();
        openSummonPanel();
        return;
      }
      if (shortcutKey === "q") {
        event.preventDefault();
        showLeaveConfirmDialog();
        return;
      }
    }
    if (
      !stampPopover.hidden &&
      !event.repeat &&
      !event.isComposing &&
      !isEditableTarget(event.target) &&
      !isBlockingOverlayOpen()
    ) {
      const stampOption = stampOptions.find(
        (option) => option.dataset.shortcut === shortcutKey
      );
      if (stampOption) {
        event.preventDefault();
        stampOption.focus();
        stampOption.click();
        return;
      }
    }
    if (
      shortcutKey === "e" &&
      !event.repeat &&
      !event.isComposing &&
      !isEditableTarget(event.target) &&
      !isBlockingOverlayOpen()
    ) {
      event.preventDefault();
      openStampPopover();
      noteHudActivity();
      return;
    }
    if (
      shortcutKey === "m" &&
      !event.repeat &&
      !event.isComposing &&
      !isEditableTarget(event.target) &&
      !isBlockingOverlayOpen()
    ) {
      event.preventDefault();
      openMessagePopover();
      noteHudActivity();
    }
    if (
      shortcutKey === "c" &&
      !event.repeat &&
      !event.isComposing &&
      !isEditableTarget(event.target) &&
      !isBlockingOverlayOpen(["chat-panel"])
    ) {
      event.preventDefault();
      toggleChatPanel();
      noteHudActivity();
    }
  });

  outputVolume = loadOutputVolume(myId);
  lastAudibleOutputVolume =
    outputVolume > 0 ? outputVolume : loadLastAudibleOutputVolume(myId);
  syncCamUI();
  syncMicUI();
  syncOutputVolumeUI();
  syncScreenUI();
  syncBgUI();
  syncMessageUI();
}

// ---- presence (Realtime Database) ----
// 匿名サインインで uid が確定してから呼ぶ
function removeOtherPlayer(id) {
  delete others[id];
  seenMessageEventIds.delete(id);
  seenStampEventIds.delete(id);
  peersInChimeRange.delete(id);
  lastProximityChimeAt.delete(id);
  if (rtc) rtc.disconnectFrom(id);
  removeVideo(id);
}

function ownPresenceSnapshot() {
  return {
    ...me,
    area: currentArea,
    questAreaName: currentArea !== AREAS.OFFICE ? AREA_LABELS[currentArea] : "",
  };
}

function allPresentPlayers() {
  return meRef ? [ownPresenceSnapshot(), ...Object.values(others)] : Object.values(others);
}

function countPlayersInArea(area) {
  return allPresentPlayers().filter((player) => (player.area || AREAS.OFFICE) === area).length;
}

function virtualQuestParticipantFromPlayer(player) {
  const preset = player.iconType === "preset" ? presetById(player.iconId) : null;
  return {
    name: safeDisplayName(player.name, "ゲスト"),
    iconType: player.iconType === "upload" && player.iconUrl ? "upload" : "preset",
    iconUrl: player.iconType === "upload" ? player.iconUrl || "" : "",
    emoji: preset ? preset.emoji : "👤",
    bg: preset ? preset.bg : "#60758a",
  };
}

function getVirtualQuestDestinationParticipants() {
  return {
    [AREAS.OUTER_EDGE]: allPresentPlayers()
      .filter((player) => areaOfPlayer(player) === AREAS.OUTER_EDGE)
      .map(virtualQuestParticipantFromPlayer),
  };
}

function renderQuestAreaParticipants() {
  const panel = document.getElementById("virtual-quest-area-participants");
  if (!panel) return;

  const participants = getVirtualQuestDestinationParticipants()[AREAS.OUTER_EDGE] || [];
  panel.hidden = currentArea !== AREAS.OUTER_EDGE;
  panel.replaceChildren();
  for (const participant of participants) {
    const row = document.createElement("div");
    row.className = "virtual-quest-area-participant";

    const icon = document.createElement("div");
    icon.className = "virtual-quest-area-participant-icon";
    if (participant.iconType === "upload" && participant.iconUrl) {
      const image = document.createElement("img");
      image.src = participant.iconUrl;
      image.alt = "";
      icon.appendChild(image);
    } else {
      const emoji = document.createElement("span");
      emoji.style.background = participant.bg;
      emoji.textContent = participant.emoji;
      icon.appendChild(emoji);
    }

    const name = document.createElement("div");
    name.className = "virtual-quest-area-participant-name";
    name.textContent = participant.name;

    row.appendChild(icon);
    row.appendChild(name);
    panel.appendChild(row);
  }
}

function updateOnlineStatus() {
  const officeCount = countPlayersInArea(AREAS.OFFICE);
  const questCount = countPlayersInArea(AREAS.OUTER_EDGE);
  const extensionCount = countPlayersInArea(AREAS.OFFICE_EXTENSION);
  document.getElementById("status").textContent = `社内: ${officeCount}人 / 拡張部屋: ${extensionCount}人 / バーチャルクエスト: ${questCount}人`;
  if (virtualQuestGate) virtualQuestGate.setDestinationParticipants(getVirtualQuestDestinationParticipants());
  renderQuestAreaParticipants();
}

function pruneStalePlayers() {
  const now = presenceServerNow();
  let removed = false;
  for (const id in others) {
    if (isPresenceFresh(others[id], now)) continue;
    removeOtherPlayer(id);
    removed = true;
  }
  if (removed) updateOnlineStatus();
}

function publishPresenceHeartbeat() {
  if (!meRef) return;
  update(meRef, { heartbeatAt: serverTimestamp() }).catch(() => {});
}

function startPresenceTimers() {
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);
  if (presenceSweepTimer) clearInterval(presenceSweepTimer);
  presenceHeartbeatTimer = setInterval(
    publishPresenceHeartbeat,
    PRESENCE_HEARTBEAT_INTERVAL_MS
  );
  presenceSweepTimer = setInterval(pruneStalePlayers, PRESENCE_SWEEP_INTERVAL_MS);
}

function stopPresenceTimers() {
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);
  if (presenceSweepTimer) clearInterval(presenceSweepTimer);
  presenceHeartbeatTimer = null;
  presenceSweepTimer = null;
}

function processStampEvents(id, stampEvents) {
  const previousEventIds = seenStampEventIds.get(id);
  const currentEventIds = new Set();
  if (stampEvents && typeof stampEvents === "object") {
    const events = Object.entries(stampEvents).sort(
      ([, a], [, b]) => Number(a && a.ts) - Number(b && b.ts)
    );
    for (const [eventId, event] of events) {
      if (!event || !Object.prototype.hasOwnProperty.call(STAMP_TYPES, event.type)) continue;
      currentEventIds.add(eventId);
      // プレイヤーを初めて観測した時は既存イベントを再生せず、次回以降の追加だけを扱う。
      if (previousEventIds && !previousEventIds.has(eventId)) {
        addStampAnimation(id, event.type);
        playNotificationChime("stamp");
      }
    }
  }
  seenStampEventIds.set(id, currentEventIds);
}

// ---- チャットの送受信・描画 ----
function sanitizeChatText(value) {
  return String(value || "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .trim()
    .slice(0, CHAT_MAX_LEN);
}

function formatChatTime(ts) {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 送信者のアイコンは現在の在席情報から解決する（メッセージ自体にはアイコンを持たせない＝軽量）。
// 退出済みなど在席が無い場合は名前の頭文字にフォールバック。
function renderChatAvatar(container, uid, name) {
  container.textContent = "";
  container.style.background = "";
  const player = uid === myId ? me : others[uid];
  if (player && player.iconType === "upload" && player.iconUrl) {
    const img = document.createElement("img");
    img.src = player.iconUrl;
    img.alt = "";
    container.appendChild(img);
    return;
  }
  const preset = player ? presetById(player.iconId) : null;
  if (preset) {
    container.style.background = preset.bg;
    container.textContent = preset.emoji;
  } else {
    container.style.background = "#555b6e";
    container.textContent = safeDisplayName(name, "?").slice(0, 1).toUpperCase();
  }
}

function showChatEmptyState(list) {
  const empty = document.createElement("div");
  empty.className = "chat-empty";
  empty.textContent = "まだメッセージはありません";
  list.appendChild(empty);
}

function trimChatDom(list) {
  while (list.children.length > CHAT_HISTORY_LIMIT) {
    list.removeChild(list.firstChild);
  }
}

function appendChatMessage(id, value) {
  const list = document.getElementById("chat-messages");
  if (!list || !value || typeof value.text !== "string") return;
  const empty = list.querySelector(".chat-empty");
  if (empty) empty.remove();

  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const isMe = value.uid === myId;

  const row = document.createElement("div");
  row.className = "chat-msg" + (isMe ? " me" : "");
  row.dataset.msgId = id;

  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  renderChatAvatar(avatar, value.uid, value.name);

  const body = document.createElement("div");
  body.className = "chat-body";
  const nameEl = document.createElement("span");
  nameEl.className = "chat-name";
  nameEl.textContent = safeDisplayName(value.name, "ゲスト");
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = value.text; // textContent のみ使用（HTML挿入なし＝XSS対策）
  const timeEl = document.createElement("span");
  timeEl.className = "chat-time";
  timeEl.textContent = formatChatTime(value.ts);

  body.append(nameEl, bubble, timeEl);
  row.append(avatar, body);
  list.appendChild(row);

  trimChatDom(list);
  if (nearBottom || isMe) list.scrollTop = list.scrollHeight;
}

function removeChatMessageDom(id) {
  const list = document.getElementById("chat-messages");
  if (!list) return;
  const row = list.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
  if (row) row.remove();
  if (!list.children.length) showChatEmptyState(list);
}

function updateChatBadge() {
  const badge = document.getElementById("chat-badge");
  if (!badge) return;
  if (unreadChatCount > 0) {
    badge.hidden = false;
    badge.textContent = unreadChatCount > 99 ? "99+" : String(unreadChatCount);
  } else {
    badge.hidden = true;
  }
}

function openChatPanel() {
  chatPanelOpen = true;
  document.getElementById("chat-backdrop").hidden = false;
  const panel = document.getElementById("chat-panel");
  panel.hidden = false;
  panel.classList.add("closing");
  requestAnimationFrame(() => panel.classList.remove("closing"));
  unreadChatCount = 0;
  updateChatBadge();
  const list = document.getElementById("chat-messages");
  if (list) list.scrollTop = list.scrollHeight;
  const input = document.getElementById("chat-input");
  if (input) input.focus();
}

function closeChatPanel() {
  chatPanelOpen = false;
  const panel = document.getElementById("chat-panel");
  panel.classList.add("closing");
  document.getElementById("chat-backdrop").hidden = true;
  setTimeout(() => {
    panel.hidden = true;
    panel.classList.remove("closing");
  }, 220);
}

function toggleChatPanel() {
  if (chatPanelOpen) closeChatPanel();
  else openChatPanel();
}

// 直近10秒に送れる件数を制限し、連投による書き込み過多を防ぐ（スタンプの連打対策と同じ考え方）。
async function sendChatMessage(rawText) {
  const value = sanitizeChatText(rawText);
  if (!value || !chatRef || !myId) return false;

  const now = Date.now();
  while (sentChatTimes.length && now - sentChatTimes[0] >= CHAT_RATE_LIMIT_WINDOW_MS) {
    sentChatTimes.shift();
  }
  if (sentChatTimes.length >= CHAT_RATE_LIMIT_MAX) {
    if (now - lastChatRateLimitToastAt >= 2000) {
      lastChatRateLimitToastAt = now;
      toast("メッセージの送信が速すぎます。少し待ってから送ってください");
    }
    return false;
  }
  sentChatTimes.push(now);

  try {
    const msgRef = push(chatRef);
    await set(msgRef, {
      uid: myId,
      name: safeDisplayName(me.name, defaultName),
      text: value,
      ts: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.warn("チャット送信失敗:", e);
    toast("メッセージを送信できませんでした");
    return false;
  }
}

// 初回は get() で直近分をまとめて取得してから onChildAdded を張る。
// 順序を保証することで「既存メッセージの再生分」と「本当に新着のメッセージ」を確実に区別できる
// （先に onChildAdded だけを張ると、初回リプレイと get() の取得が競合し二重描画/誤通知の恐れがある）。
async function initChatSync() {
  chatRef = ref(db, `rooms/${ROOM}/chat`);
  const list = document.getElementById("chat-messages");
  if (list) list.innerHTML = "";

  let initial = {};
  try {
    const snap = await get(query(chatRef, limitToLast(CHAT_HISTORY_LIMIT)));
    initial = snap.val() || {};
  } catch (e) {
    console.warn("チャット履歴の取得失敗:", e);
  }

  const entries = Object.entries(initial).sort(
    ([, a], [, b]) => Number(a && a.ts) - Number(b && b.ts)
  );
  for (const [id, value] of entries) appendChatMessage(id, value);
  if (!entries.length && list) showChatEmptyState(list);
  if (list) list.scrollTop = list.scrollHeight;

  const seenIds = new Set(entries.map(([id]) => id));

  onChildAdded(query(chatRef, limitToLast(CHAT_HISTORY_LIMIT)), (snap) => {
    if (seenIds.has(snap.key)) {
      seenIds.delete(snap.key); // 初回取得分の再生（同じ内容なので描画済み扱い）
      return;
    }
    const value = snap.val();
    appendChatMessage(snap.key, value);
    if (value && value.uid !== myId) {
      playNotificationChime("chat");
      if (!chatPanelOpen) {
        unreadChatCount += 1;
        updateChatBadge();
      }
    }
  });

  onChildRemoved(chatRef, (snap) => removeChatMessageDom(snap.key));
}

async function initPresence() {
  meRef = ref(db, `rooms/${ROOM}/players/${myId}`);
  me.active = false;
  lastPublishedActive = false;
  presenceInitialized = false;
  seenMessageEventIds.clear();
  seenStampEventIds.clear();
  await onDisconnect(meRef).remove(); // タブを閉じたら自動削除
  await set(meRef, currentPresencePayload());
  startPresenceTimers();

  if (presenceServerTimeOffsetUnsubscribe) presenceServerTimeOffsetUnsubscribe();
  presenceServerTimeOffsetUnsubscribe = onValue(
    ref(db, ".info/serverTimeOffset"),
    (snap) => {
      const offset = snap.val();
      presenceServerTimeOffset = Number.isFinite(offset) ? offset : 0;
      pruneStalePlayers();
    }
  );

  if (presencePlayersUnsubscribe) presencePlayersUnsubscribe();
  presencePlayersUnsubscribe = onValue(ref(db, `rooms/${ROOM}/players`), (snap) => {
    const all = snap.val() || {};
    const now = presenceServerNow();
    let messageChanged = false;
    const validOtherIds = new Set();
    for (const id in all) {
      if (id === myId) continue;
      const player = normalizePlayer(id, all[id]);
      if (!player || !isPresenceFresh(player, now)) {
        removeOtherPlayer(id);
        continue;
      }
      validOtherIds.add(id);
      others[id] = player;
      const eventId = player.messageEventId || "";
      if (
        presenceInitialized &&
        eventId &&
        eventId !== seenMessageEventIds.get(id) &&
        player.message
      ) {
        messageChanged = true;
      }
      seenMessageEventIds.set(id, eventId);
      processStampEvents(id, player.stampEvents);
    }
    // 退出したプレイヤーを掃除
    for (const id in others) {
      if (!validOtherIds.has(id)) removeOtherPlayer(id);
    }
    // 集合（summon）の受信: 自分が対象なら集合地点へワープ
    for (const id of validOtherIds) {
      const player = others[id];
      const s = player.summon;
      if (s && Array.isArray(s.targets) && s.targets.includes(myId) && s.ts > lastSummonTs) {
        lastSummonTs = s.ts;
        if (slimeGame && slimeGame.isPlaying()) {
          toast(`🎮 ゲーム中のため ${player.name} からの集合を見送りました`);
        } else {
          me.x = s.x;
          me.y = s.y;
          dirty = true;
          toast(`📍 ${player.name} があなたを集合させました`);
        }
      }
    }
    if (messageChanged) playNotificationChime("message");
    if (presenceInitialized) updateProximityChimes();
    else {
      seedProximityChimeRange();
      presenceInitialized = true;
    }
    updateOnlineStatus();
  });

  if (presenceConnectionUnsubscribe) presenceConnectionUnsubscribe();
  presenceConnectionUnsubscribe = onValue(ref(db, ".info/connected"), (snap) => {
    if (snap.val() !== true || !meRef) return;
    onDisconnect(meRef)
      .remove()
      .then(() => restorePresence())
      .catch((error) => console.warn("切断時処理の再登録失敗:", error));
  });
}

// 位置送信（動いてる時だけ・約12fps に間引いて無料枠を節約）
let dirty = false;
let lastSent = 0;
function flushPosition(now) {
  if (!meRef) return;
  if (currentArea !== AREAS.OFFICE) {
    dirty = false;
    return;
  }
  if (dirty && now - lastSent > 80) {
    update(meRef, { x: Math.round(me.x), y: Math.round(me.y), ts: Date.now() });
    lastSent = now;
    dirty = false;
  }
}

// ---- 入力 ----
const keys = {};
const MOVEMENT_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"]);
addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (
    !MOVEMENT_KEYS.has(key) ||
    e.isComposing ||
    isEditableTarget(e.target) ||
    (slimeGame && slimeGame.isPlaying()) ||
    (virtualQuestGate && virtualQuestGate.isBlockingOverlayOpen())
  ) {
    return;
  }
  keys[key] = true;
  if (key.startsWith("arrow")) e.preventDefault();
});
addEventListener("keyup", (e) => {
  const key = e.key.toLowerCase();
  if (MOVEMENT_KEYS.has(key)) keys[key] = false;
});
document.addEventListener("focusin", (event) => {
  if (isEditableTarget(event.target)) clearMovementInput();
});
window.addEventListener("blur", clearMovementInput);

// ---- タッチ用バーチャルジョイスティック ----
const joy = { active: false, dx: 0, dy: 0, cx: 0, cy: 0, r: 60 };
const joyEl = document.getElementById("joystick");
const stickEl = document.getElementById("stick");

// タッチ端末では確実に表示（@media が効かない端末向けの保険）
if (joyEl && (("ontouchstart" in window) || navigator.maxTouchPoints > 0)) {
  joyEl.style.display = "block";
}

function joyPoint(e) {
  if (e.touches && e.touches.length) return e.touches[0];
  if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0];
  return e;
}
function joyStart(e) {
  if ((slimeGame && slimeGame.isPlaying()) || (virtualQuestGate && virtualQuestGate.isBlockingOverlayOpen())) {
    e.preventDefault();
    return;
  }
  const rect = joyEl.getBoundingClientRect();
  joy.cx = rect.left + rect.width / 2;
  joy.cy = rect.top + rect.height / 2;
  joy.r = rect.width / 2;
  joy.active = true;
  joyMove(e);
  e.preventDefault();
}
function joyMove(e) {
  if (!joy.active) return;
  const p = joyPoint(e);
  let ox = p.clientX - joy.cx;
  let oy = p.clientY - joy.cy;
  const dist = Math.hypot(ox, oy) || 1;
  if (dist > joy.r) {
    ox = (ox / dist) * joy.r;
    oy = (oy / dist) * joy.r;
  }
  joy.dx = ox / joy.r; // -1..1（大きさ＝倒し具合）
  joy.dy = oy / joy.r;
  stickEl.style.transform = `translate(${ox}px, ${oy}px)`;
  e.preventDefault();
}
function joyEnd() {
  joy.active = false;
  joy.dx = 0;
  joy.dy = 0;
  stickEl.style.transform = "translate(0px, 0px)";
}
function clearMovementInput() {
  Object.keys(keys).forEach((key) => {
    keys[key] = false;
  });
  joyEnd();
}
if (joyEl) {
  joyEl.addEventListener("touchstart", joyStart, { passive: false });
  window.addEventListener("touchmove", joyMove, { passive: false });
  window.addEventListener("touchend", joyEnd);
  window.addEventListener("touchcancel", joyEnd);
  // デスクトップでのマウス操作にも対応（確認用）
  joyEl.addEventListener("mousedown", joyStart);
  window.addEventListener("mousemove", joyMove);
  window.addEventListener("mouseup", joyEnd);
}

function step() {
  if ((slimeGame && slimeGame.isPlaying()) || (virtualQuestGate && virtualQuestGate.isBlockingOverlayOpen())) {
    if (lockedGamePosition) {
      me.x = lockedGamePosition.x;
      me.y = lockedGamePosition.y;
    }
    return;
  }

  let dx = 0;
  let dy = 0;
  if (keys["arrowup"] || keys["w"]) dy -= 1;
  if (keys["arrowdown"] || keys["s"]) dy += 1;
  if (keys["arrowleft"] || keys["a"]) dx -= 1;
  if (keys["arrowright"] || keys["d"]) dx += 1;

  if (dx || dy) {
    // キーボード: 単位ベクトル化して等速移動
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
  } else if (joy.active && (joy.dx || joy.dy)) {
    // ジョイスティック: 倒し具合(0..1)を速度に反映
    dx = joy.dx;
    dy = joy.dy;
  }

  if (dx || dy) {
    noteHudActivity(); // 移動操作で HUD を表示維持＆自動非表示タイマーをリセット
    // X/Y を別々に判定 → 壁沿いに滑れる
    const nx = me.x + dx * SPEED;
    if (canBeAt(nx, me.y)) {
      me.x = nx;
      dirty = true;
    }
    const ny = me.y + dy * SPEED;
    if (canBeAt(me.x, ny)) {
      me.y = ny;
      dirty = true;
    }
  }
}

// ---- 接続判定（エリア / 全体アナウンス / 近接）----
let rtc = null;
function isPeerInCallRange(o, wasInRange) {
  if (!isPlayerInCurrentArea(o)) return false;
  if (currentArea !== AREAS.OFFICE) return false;
  const mz = zoneOf(me);
  const oz = zoneOf(o);
  if (mz && oz) return mz === oz;
  if (!mz && !oz) {
    const distance = Math.hypot(o.x - me.x, o.y - me.y);
    return distance <= (wasInRange ? HANGUP_RADIUS : CALL_RADIUS);
  }
  return false;
}

function seedProximityChimeRange() {
  peersInChimeRange.clear();
  for (const id in others) {
    if (isPeerInCallRange(others[id], false)) peersInChimeRange.add(id);
  }
}

function updateProximityChimes() {
  if (!presenceInitialized) return;
  const now = Date.now();
  let shouldPlay = false;
  for (const id in others) {
    const wasInRange = peersInChimeRange.has(id);
    const inRange = isPeerInCallRange(others[id], wasInRange);
    if (inRange) peersInChimeRange.add(id);
    else peersInChimeRange.delete(id);
    if (
      !wasInRange &&
      inRange &&
      now - (lastProximityChimeAt.get(id) || 0) >= PROXIMITY_CHIME_COOLDOWN_MS
    ) {
      lastProximityChimeAt.set(id, now);
      shouldPlay = true;
    }
  }
  if (shouldPlay) playNotificationChime("proximity");
}

function updateConnections() {
  if (!rtc) return;
  for (const id in others) {
    const o = others[id];
    const connected = rtc.isConnected(id);
    let want;
    if (!isPlayerInCurrentArea(o)) {
      want = false;
    } else if (announcing || o.announcing) {
      want = true; // アナウンス中は全員と接続
    } else {
      want = isPeerInCallRange(o, connected);
    }
    if (want && !connected) rtc.connectTo(id);
    else if (!want && connected) rtc.disconnectFrom(id);
  }
}

// 距離で音量フェード（近いほど大きく、遠いほど小さく＝Gather風）
function updateSpatialAudio() {
  if (!rtc) return;
  const mz = zoneOf(me);
  for (const id in others) {
    if (!rtc.isConnected(id)) continue;
    const tile = videoTiles.get(id);
    if (!tile) continue;
    const v = tile.querySelector("video");
    if (!v) continue;
    const o = others[id];
    if (!isPlayerInCurrentArea(o)) {
      v.volume = 0;
      tile.style.opacity = "0.45";
      continue;
    }
    let vol;
    if (announcing || o.announcing || (mz && zoneOf(o) === mz)) {
      vol = 1; // 部屋内 / アナウンスは全員フル音量
    } else {
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      vol = Math.max(0, Math.min(1, (HANGUP_RADIUS - d) / (HANGUP_RADIUS - FULL_VOLUME_RADIUS)));
    }
    v.volume = vol * outputVolume;
    tile.style.opacity = (0.45 + 0.55 * vol).toFixed(2); // 遠いほど薄く表示
  }
}

// ---- トースト / バナー / 集合リスト ----
function toast(msg) {
  const wrap = document.getElementById("toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
function updateBanner() {
  const banner = document.getElementById("banner");
  if (!banner) return;
  const names = [];
  if (announcing) names.push(me.name);
  for (const id in others) {
    if (others[id].announcing && isPlayerInCurrentArea(others[id])) names.push(others[id].name || "誰か");
  }
  if (names.length) {
    banner.hidden = false;
    banner.textContent = "📢 " + names.join("、") + " がアナウンス中";
  } else {
    banner.hidden = true;
  }
}
function renderSummonList(listEl) {
  listEl.innerHTML = "";
  const ids = Object.keys(others).filter((id) => isPlayerInCurrentArea(others[id]));
  if (!ids.length) {
    listEl.innerHTML = '<div class="empty">他に誰もいません</div>';
    return;
  }
  for (const id of ids) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = id;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + (others[id].name || id.slice(0, 5))));
    listEl.appendChild(label);
  }
}

// 診断: 接続状態と受信映像の統計をタイル名に表示（黒画面の原因切り分け用）
async function updateDiag() {
  if (!rtc) return;
  for (const id in others) {
    const tile = videoTiles.get(id);
    if (!tile) continue;
    const d = rtc.getDiag(id);
    if (!d) continue;
    let rxKB = 0;
    let fw = 0;
    try {
      const stats = await d.pc.getStats();
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") {
          rxKB = Math.round((s.bytesReceived || 0) / 1024);
          fw = s.frameWidth || 0;
        }
      });
    } catch (e) {}
    const v = tile.querySelector("video");
    const play = v && v.paused ? "⏸" : "▶";
    const cap = tile.querySelector(".cap");
    const name = (others[id] && others[id].name) || "";
    if (cap) cap.textContent = `${name} ${d.conn}/${d.ice} rx${rxKB}KB ${fw}w ${play}`;
  }
}
setInterval(updateDiag, 1000);

// ---- 描画 ----
// アップロード画像アバターは URL ごとに Image を 1 度だけ読み込んでキャッシュ
const avatarImgCache = new Map(); // url -> HTMLImageElement
function getAvatarImage(url) {
  if (!url) return null;
  let img = avatarImgCache.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    avatarImgCache.set(url, img);
  }
  return img;
}
// 正方形領域に画像を cover 配置で描画（中心クロップ）
function drawImageCover(img, cx, cy, size) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(size / iw, size / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
}

const AVATAR_R = 16;
const MESSAGE_MAX_WIDTH = 120;
const MESSAGE_PADDING_X = 5;
const MESSAGE_PADDING_Y = 4;
const MESSAGE_LINE_HEIGHT = 8;

function messageLines(message) {
  const text = Array.from(String(message || "").replace(/[\r\n\u2028\u2029]+/g, " "))
    .slice(0, 15)
    .join("");
  if (!text) return [];
  const lines = [];
  let line = "";
  for (const char of Array.from(text)) {
    const next = line + char;
    if (line && ctx.measureText(next).width > MESSAGE_MAX_WIDTH - MESSAGE_PADDING_X * 2) {
      lines.push(line);
      line = char;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundedRectPath(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawMessageBubble(p, isMe) {
  if (!p.message) return;
  ctx.save();
  ctx.font = "6px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const lines = messageLines(p.message);
  if (!lines.length) {
    ctx.restore();
    return;
  }
  const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const width = Math.min(MESSAGE_MAX_WIDTH, Math.max(24, textWidth + MESSAGE_PADDING_X * 2));
  const height = lines.length * MESSAGE_LINE_HEIGHT + MESSAGE_PADDING_Y * 2;
  const tailHeight = 3;
  const x = Math.max(4, Math.min(W - width - 4, p.x - width / 2));
  const aboveBottom = p.y - AVATAR_R - 30;
  const placeBelow = aboveBottom - height < 4;
  const y = placeBelow ? p.y + AVATAR_R + 12 : aboveBottom - height;
  const tailX = Math.max(x + 6, Math.min(x + width - 6, p.x));

  roundedRectPath(x, y, width, height, 4);
  ctx.fillStyle = isMe ? "rgba(32, 104, 72, 0.96)" : "rgba(24, 30, 45, 0.96)";
  ctx.fill();
  ctx.strokeStyle = isMe ? "rgba(133, 235, 183, 0.9)" : "rgba(255, 255, 255, 0.65)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  if (placeBelow) {
    ctx.moveTo(tailX - 3, y);
    ctx.lineTo(tailX, y - tailHeight);
    ctx.lineTo(tailX + 3, y);
  } else {
    ctx.moveTo(tailX - 3, aboveBottom);
    ctx.lineTo(tailX, aboveBottom + tailHeight);
    ctx.lineTo(tailX + 3, aboveBottom);
  }
  ctx.closePath();
  ctx.fillStyle = isMe ? "rgba(32, 104, 72, 0.96)" : "rgba(24, 30, 45, 0.96)";
  ctx.fill();

  ctx.fillStyle = "#fff";
  lines.forEach((line, index) => {
    ctx.fillText(
      line,
      x + MESSAGE_PADDING_X,
      y + MESSAGE_PADDING_Y + MESSAGE_LINE_HEIGHT * (index + 0.5)
    );
  });
  ctx.restore();
}

function addStampAnimation(ownerId, type) {
  const emoji = STAMP_TYPES[type];
  if (!emoji) return;
  activeStamps.push({
    ownerId,
    emoji,
    angle: Math.random() * Math.PI * 2,
    distance: 24 + Math.random() * 16,
    startedAt: performance.now(),
  });
}

function drawStampAnimations(now) {
  for (let index = activeStamps.length - 1; index >= 0; index -= 1) {
    const stamp = activeStamps[index];
    const owner = stamp.ownerId === myId ? me : others[stamp.ownerId];
    const elapsed = now - stamp.startedAt;
    if (!owner || !isPlayerInCurrentArea(owner) || elapsed >= STAMP_DURATION_MS) {
      activeStamps.splice(index, 1);
      continue;
    }
    const progress = Math.max(0, elapsed / STAMP_DURATION_MS);
    const appear = Math.min(1, progress / 0.18);
    const settle = Math.min(1, Math.max(0, (progress - 0.18) / 0.2));
    const scale = appear * (1.15 - settle * 0.15);
    const alpha = progress <= 0.68 ? 1 : Math.max(0, (1 - progress) / 0.32);
    const bounce = Math.sin(Math.min(1, progress / 0.3) * Math.PI) * 5;
    const x = owner.x + Math.cos(stamp.angle) * stamp.distance;
    const y = owner.y + Math.sin(stamp.angle) * stamp.distance - progress * 10 - bounce;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.font = `20px ${EMOJI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(stamp.emoji, 0, 0);
    ctx.restore();
  }
}

function drawAvatar(p, isMe, connected) {
  const r = AVATAR_R;
  if (p.active) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(46, 204, 113, 0.9)";
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  if (connected) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 11, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(52, 152, 219, 0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // アイコン本体（円形にクリップして描画）
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.clip();

  let drewImage = false;
  if (p.iconType === "upload" && p.iconUrl) {
    const img = getAvatarImage(p.iconUrl);
    if (img && img.complete && (img.naturalWidth || img.width)) {
      drawImageCover(img, p.x, p.y, r * 2);
      drewImage = true;
    }
  }
  if (!drewImage) {
    const preset = p.iconType === "preset" ? presetById(p.iconId) : null;
    ctx.fillStyle = preset ? preset.bg : p.color || "#888";
    ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    if (preset) {
      ctx.font = `${Math.round(r * 1.5)}px ${EMOJI_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(preset.emoji, p.x, p.y + 1);
      ctx.textBaseline = "alphabetic";
    }
  }
  ctx.restore();

  // 枠線
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = isMe ? "#fff" : "rgba(255,255,255,0.6)";
  ctx.stroke();

  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "center";
  const label =
    safeDisplayName(p.name, isMe ? defaultName : "ゲスト") + (isMe ? "（あなた）" : "");
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.7)"; // 明るい背景でも読めるよう縁取り
  ctx.strokeText(label, p.x, p.y - r - 8);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, p.x, p.y - r - 8);
}

function drawFloor() {
  if (currentArea === AREAS.OFFICE_EXTENSION) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (officeExtensionImgReady) {
      const rect = officeExtensionDrawRect();
      ctx.drawImage(officeExtensionImg, rect.x, rect.y, rect.w, rect.h);
    }
    return;
  }

  if (currentArea === AREAS.OUTER_EDGE) {
    if (outerEdgeImgReady) {
      ctx.drawImage(outerEdgeImg, 0, 0, W, H);
    } else {
      ctx.fillStyle = "#0f242a";
      ctx.fillRect(0, 0, W, H);
    }
    return;
  }

  if (officeImgReady) {
    ctx.drawImage(officeImg, 0, 0, W, H);
  } else {
    ctx.fillStyle = "#1f2433";
    ctx.fillRect(0, 0, W, H);
  }
}

// デバッグ: 採寸グリッド(0.0〜1.0)と壁を可視化（?debug 時のみ）
function drawDebug() {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,0,0.3)";
  ctx.fillStyle = "rgba(255,255,0,0.9)";
  ctx.font = "11px monospace";
  for (let i = 0; i <= 10; i++) {
    const x = (i / 10) * W;
    const y = (i / 10) * H;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText((i / 10).toFixed(1), x + 2, 12);
    ctx.fillText((i / 10).toFixed(1), 2, y + 12);
  }
  ctx.fillStyle = "rgba(255,0,0,0.35)";
  for (const w of WALLS) ctx.fillRect(w.x, w.y, w.w, w.h);
  const gx = GAME_AREA.x * W;
  const gy = GAME_AREA.y * H;
  const gw = GAME_AREA.w * W;
  const gh = GAME_AREA.h * H;
  ctx.fillStyle = "rgba(80,220,120,0.16)";
  ctx.fillRect(gx, gy, gw, gh);
  ctx.strokeStyle = "rgba(100,255,150,0.9)";
  ctx.strokeRect(gx, gy, gw, gh);
  ctx.fillStyle = "rgba(100,255,150,1)";
  ctx.fillText("GAME_AREA", gx + 4, gy + 14);
  ctx.restore();
}

// エリア（部屋）の枠。自分がいる部屋は強調表示。
function drawZones() {
  const mz = zoneOf(me);
  for (const z of ZONES) {
    const zx = z.x * W,
      zy = z.y * H,
      zw = z.w * W,
      zh = z.h * H;
    const mine = mz === z.id;
    ctx.fillStyle = `rgba(${z.rgb},${mine ? 0.2 : 0.08})`;
    ctx.fillRect(zx, zy, zw, zh);
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = `rgba(${z.rgb},${mine ? 0.95 : 0.5})`;
    ctx.lineWidth = mine ? 2.5 : 1.5;
    ctx.strokeRect(zx, zy, zw, zh);
    ctx.setLineDash([]);
    if (mine) {
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = `rgba(${z.rgb},1)`;
      ctx.fillText("🔊 " + z.label + " で通話中", zx + zw / 2, zy + zh - 8);
    }
  }
}

function render() {
  const now = performance.now();
  // 画面クリア（スクリーン座標）
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#11131a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // カメラ変換: 以降は全てワールド座標で描ける（背景画像・ゾーン・アバター）
  const s = camera.zoom * dpr;
  ctx.setTransform(s, 0, 0, s, canvas.width / 2 - camera.x * s, canvas.height / 2 - camera.y * s);

  drawFloor();
  if (currentArea === AREAS.OFFICE) {
    drawZones();
    if (virtualQuestGate) virtualQuestGate.draw(ctx, now);
  }

  // 自分の通話範囲（部屋にいる時・アナウンス中は出さない）
  if (currentArea === AREAS.OFFICE && !zoneOf(me) && !announcing) {
    ctx.beginPath();
    ctx.arc(me.x, me.y, CALL_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(52, 152, 219, 0.10)";
    ctx.fill();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(52, 152, 219, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (DEBUG) drawDebug();

  if (currentArea === AREAS.OFFICE) {
    for (const id in others) {
      if (!isPlayerInCurrentArea(others[id])) continue;
      const diag = rtc && rtc.getDiag(id);
      drawAvatar(others[id], false, !!diag && diag.conn === "connected");
    }
  }
  drawAvatar(me, true, false);
  drawStampAnimations(now);
  // 吹き出しはアバターより後に描き、他のアイコンに隠れにくくする。
  if (currentArea === AREAS.OFFICE) {
    for (const id in others) {
      if (!isPlayerInCurrentArea(others[id])) continue;
      drawMessageBubble(others[id], false);
    }
  }
  drawMessageBubble(me, true);

  ctx.setTransform(1, 0, 0, 1, 0, 0); // 後始末
}

// 誰かが画面共有していたら、その映像を中央に大きく表示する
function updateShareStage() {
  let sharerId = null;
  let stream = null;
  let name = null;
  if (media && media.screenOn) {
    sharerId = "__me__";
    stream = media.outputStream;
    name = "あなた";
  } else {
    for (const id in others) {
      if (others[id] && others[id].sharing && isPlayerInCurrentArea(others[id])) {
        const tile = videoTiles.get(id);
        const v = tile && tile.querySelector("video");
        if (v && v.srcObject) {
          sharerId = id;
          stream = v.srcObject;
          name = others[id].name || "誰か";
          break;
        }
      }
    }
  }

  // 共有中タイルの枠ハイライト
  videoTiles.forEach((tile, id) => {
    const sharing =
      (id === "__me__" && media && media.screenOn) ||
      (others[id] && others[id].sharing && isPlayerInCurrentArea(others[id]));
    tile.classList.toggle("sharing", !!sharing);
  });

  if (sharerId && stream) {
    if (currentShareId !== sharerId || shareVideo.srcObject !== stream) {
      shareVideo.srcObject = stream;
      tryPlay(shareVideo);
      currentShareId = sharerId;
    }
    shareLabel.textContent = `${name} が画面共有中`;
    shareStage.hidden = false;
  } else if (!shareStage.hidden) {
    shareStage.hidden = true;
    shareVideo.srcObject = null;
    currentShareId = null;
  }
}

// ---- 下部コントロールのツールチップ ----
const CONTROL_TOOLTIP_DELAY_MS = 300;
const CONTROL_TOOLTIP_FADE_MS = 120;
let controlTooltipShowTimer = null;
let controlTooltipHideTimer = null;
let hoveredControlButton = null;
let keyboardFocusedControlButton = null;
let activeControlTooltipButton = null;
let keyboardNavigation = false;

function isControlTooltipInteractionActive() {
  return !!hoveredControlButton || !!keyboardFocusedControlButton;
}

function positionControlTooltip(button) {
  const tooltip = document.getElementById("control-tooltip");
  if (!tooltip || tooltip.hidden || !button) return;

  const margin = 8;
  const buttonRect = button.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const centeredLeft = buttonRect.left + buttonRect.width / 2 - tooltipRect.width / 2;
  const maxLeft = Math.max(margin, window.innerWidth - tooltipRect.width - margin);

  tooltip.style.left = `${Math.max(margin, Math.min(maxLeft, centeredLeft))}px`;
  tooltip.style.top = `${Math.max(margin, buttonRect.top - tooltipRect.height - margin)}px`;
}

function showControlTooltip(button) {
  const tooltip = document.getElementById("control-tooltip");
  const title = document.getElementById("control-tooltip-title");
  const help = document.getElementById("control-tooltip-help");
  if (!tooltip || !title || !help || !button) return;

  clearTimeout(controlTooltipHideTimer);
  activeControlTooltipButton = button;
  title.textContent = button.getAttribute("aria-label") || "";
  help.textContent = button.dataset.help || "";
  tooltip.hidden = false;
  positionControlTooltip(button);

  requestAnimationFrame(() => {
    if (activeControlTooltipButton === button) tooltip.classList.add("visible");
  });
}

function hideControlTooltip(immediate = false) {
  clearTimeout(controlTooltipShowTimer);
  clearTimeout(controlTooltipHideTimer);
  activeControlTooltipButton = null;

  const tooltip = document.getElementById("control-tooltip");
  if (!tooltip) return;
  tooltip.classList.remove("visible");
  if (immediate) {
    tooltip.hidden = true;
    return;
  }
  controlTooltipHideTimer = setTimeout(() => {
    if (!activeControlTooltipButton) tooltip.hidden = true;
  }, CONTROL_TOOLTIP_FADE_MS);
}

function setupControlTooltips() {
  const controls = document.getElementById("controls");
  if (!controls) return;

  const buttons = controls.querySelectorAll(".ctrl[data-help]");
  buttons.forEach((button) => {
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      hoveredControlButton = button;
      noteHudActivity();
      clearTimeout(controlTooltipShowTimer);
      controlTooltipShowTimer = setTimeout(() => {
        if (hoveredControlButton === button) showControlTooltip(button);
      }, CONTROL_TOOLTIP_DELAY_MS);
    });

    button.addEventListener("pointerleave", () => {
      if (hoveredControlButton === button) hoveredControlButton = null;
      if (!keyboardFocusedControlButton) hideControlTooltip();
    });

    button.addEventListener("focus", () => {
      if (!keyboardNavigation) return;
      keyboardFocusedControlButton = button;
      noteHudActivity();
      showControlTooltip(button);
    });

    button.addEventListener("blur", () => {
      if (keyboardFocusedControlButton === button) keyboardFocusedControlButton = null;
      if (!hoveredControlButton) hideControlTooltip();
    });

    button.addEventListener("click", () => hideControlTooltip());
  });

  document.addEventListener(
    "pointerdown",
    () => {
      keyboardNavigation = false;
      keyboardFocusedControlButton = null;
    },
    true
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab") keyboardNavigation = true;
    if (event.key === "Escape") hideControlTooltip();
  });
  window.addEventListener("resize", () => {
    if (activeControlTooltipButton) positionControlTooltip(activeControlTooltipButton);
  });
  controls.addEventListener("scroll", () => {
    if (activeControlTooltipButton) positionControlTooltip(activeControlTooltipButton);
  });
}

// ---- ゲームコーナー「スライムたたき」 ----
function isEditableTarget(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function isBlockingOverlayOpen(excludeIds = []) {
  return ["slime-game-modal", "virtual-quest-gate-modal", "crop-modal", "console", "chat-panel", "leave-confirm-dialog"].some((id) => {
    if (excludeIds.includes(id)) return false;
    const element = document.getElementById(id);
    return element && !element.hidden;
  });
}

function finishSlimeGameSession() {
  document.body.classList.remove("game-open");
  lockedGamePosition = null;
  clearMovementInput();
  gameState = GAME_STATES.COOLDOWN;
  gameCooldownUntil = performance.now() + 1000;
  const prompt = document.getElementById("game-prompt");
  const playButton = document.getElementById("game-play");
  prompt.hidden = !isInGameArea(me);
  playButton.setAttribute("aria-disabled", "true");
  showHud();
  if (!prompt.hidden) playButton.focus({ preventScroll: true });
}

function startSlimeGame() {
  if (!slimeGame || gameState !== GAME_STATES.READY) return;

  clearMovementInput();
  lockedGamePosition = { x: me.x, y: me.y };
  gameState = GAME_STATES.PLAYING;
  document.getElementById("game-prompt").hidden = true;
  document.body.classList.add("game-open");
  showHud();

  if (!slimeGame.start() && gameState === GAME_STATES.PLAYING) {
    finishSlimeGameSession();
  }
}

function updateGameArea(now) {
  const prompt = document.getElementById("game-prompt");
  const playButton = document.getElementById("game-play");
  if (!prompt || gameState === GAME_STATES.PLAYING) return;

  if (!isInGameArea(me)) {
    gameState = GAME_STATES.OUTSIDE;
    prompt.hidden = true;
    playButton.removeAttribute("aria-disabled");
    return;
  }

  if (gameState === GAME_STATES.OUTSIDE) gameState = GAME_STATES.READY;
  if (gameState === GAME_STATES.COOLDOWN && now < gameCooldownUntil) {
    prompt.hidden = false;
    playButton.setAttribute("aria-disabled", "true");
    return;
  }
  if (gameState === GAME_STATES.COOLDOWN && now >= gameCooldownUntil) {
    gameState = GAME_STATES.READY;
  }
  playButton.removeAttribute("aria-disabled");
  prompt.hidden = gameState !== GAME_STATES.READY;
}

function setupSlimeGame() {
  const modal = document.getElementById("slime-game-modal");
  const canvas = document.getElementById("slime-game-canvas");
  const playButton = document.getElementById("game-play");
  if (!modal || !canvas || !playButton) return;

  slimeGame = new SlimeGame({
    modal,
    canvas,
    timeEl: document.getElementById("slime-game-time"),
    scoreEl: document.getElementById("slime-game-score"),
    highScoreEl: document.getElementById("slime-game-high-score"),
    onFinish: ({ score, highScore }) => {
      finishSlimeGameSession();
      toast(`スライムたたき終了！ ${score}点（自己ベスト ${highScore}点）`);
    },
    onCancel: finishSlimeGameSession,
    onError: (error) => {
      console.error("スライムゲームエラー:", error);
      finishSlimeGameSession();
      toast("ゲームを開始できませんでした");
    },
  });

  playButton.addEventListener("click", startSlimeGame);
  addEventListener("keydown", (event) => {
    if (
      event.key.toLowerCase() === "g" &&
      gameState === GAME_STATES.READY &&
      !event.repeat &&
      !event.isComposing &&
      !isEditableTarget(event.target) &&
      !isBlockingOverlayOpen()
    ) {
      event.preventDefault();
      startSlimeGame();
    }
  });
}

function setupVirtualQuestGate() {
  virtualQuestGate = new VirtualQuestGate({
    worldWidth: W,
    worldHeight: H,
    getPlayer: () => me,
    getDestinationParticipants: getVirtualQuestDestinationParticipants,
    clearMovementInput,
    showHud,
    toast,
    canOpen: () => !isBlockingOverlayOpen(["virtual-quest-gate-modal"]),
  });
  virtualQuestGate.setup();

  window.addEventListener("virtualquest:prepare-departure", (event) => {
    if (event.detail && event.detail.destinationId === AREAS.OUTER_EDGE) {
      enterOuterEdgeArea();
    }
  });
}

function setupVirtualQuestStageControls() {
  const participantsPanel = document.createElement("div");
  participantsPanel.id = "virtual-quest-area-participants";
  participantsPanel.hidden = true;
  document.body.appendChild(participantsPanel);

  const returnPrompt = document.createElement("div");
  returnPrompt.id = "virtual-quest-return-prompt";
  returnPrompt.hidden = true;
  returnPrompt.innerHTML = `
    <div class="virtual-quest-prompt-copy">
      <strong>外縁ゲート</strong>
      <span>オフィスへ帰還できます</span>
    </div>
    <span class="virtual-quest-prompt-key">F</span>
    <button type="button">帰還する</button>
  `;
  returnPrompt.querySelector("button").addEventListener("click", returnToOfficeArea);
  document.body.appendChild(returnPrompt);

  const comingSoonPanel = document.createElement("div");
  comingSoonPanel.id = "virtual-quest-coming-soon";
  comingSoonPanel.hidden = true;

  const comingSoonTitle = document.createElement("div");
  comingSoonTitle.className = "virtual-quest-coming-soon-title";
  const comingSoonMessage = document.createElement("div");
  comingSoonMessage.className = "virtual-quest-coming-soon-message";
  comingSoonPanel.appendChild(comingSoonTitle);
  comingSoonPanel.appendChild(comingSoonMessage);
  document.body.appendChild(comingSoonPanel);

  const returnButton = document.createElement("button");
  returnButton.id = "virtual-quest-return";
  returnButton.type = "button";
  returnButton.hidden = true;
  returnButton.innerHTML = `<i class="ti ti-door-exit" aria-hidden="true"></i><span>オフィスへ戻る</span>`;
  returnButton.addEventListener("click", returnToOfficeArea);
  document.body.appendChild(returnButton);

  addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      currentArea === AREAS.OUTER_EDGE &&
      !event.repeat &&
      !event.isComposing &&
      !isEditableTarget(event.target) &&
      !isBlockingOverlayOpen()
    ) {
      event.preventDefault();
      returnToOfficeArea();
    }
    if (
      event.key.toLowerCase() === "f" &&
      isPlayerInOuterEdgeReturnGate() &&
      !event.repeat &&
      !event.isComposing &&
      !isEditableTarget(event.target) &&
      !isBlockingOverlayOpen()
    ) {
      event.preventDefault();
      returnToOfficeArea();
    }
  });
}

function isPlayerInOuterEdgeReturnGate() {
  return (
    currentArea === AREAS.OUTER_EDGE &&
    me.x >= OUTER_EDGE_RETURN_GATE.x &&
    me.x <= OUTER_EDGE_RETURN_GATE.x + OUTER_EDGE_RETURN_GATE.w &&
    me.y >= OUTER_EDGE_RETURN_GATE.y &&
    me.y <= OUTER_EDGE_RETURN_GATE.y + OUTER_EDGE_RETURN_GATE.h
  );
}

function enterOuterEdgeArea() {
  if (currentArea === AREAS.OUTER_EDGE) return;
  officeReturnPosition = { x: me.x, y: me.y };
  currentArea = AREAS.OUTER_EDGE;
  clearMovementInput();
  me.x = OUTER_EDGE_ENTRY.x;
  me.y = OUTER_EDGE_ENTRY.y;
  camera.x = me.x;
  camera.y = me.y;
  const returnButton = document.getElementById("virtual-quest-return");
  if (returnButton) returnButton.hidden = false;
  restorePresence();
  updateOnlineStatus();
  updateVirtualQuestComingSoon();
  updateVirtualQuestReturnPrompt();
  updateOfficeExtensionPrompts();
  showHud();
}

function returnToOfficeArea() {
  if (currentArea !== AREAS.OUTER_EDGE) return;
  currentArea = AREAS.OFFICE;
  clearMovementInput();
  me.x = officeReturnPosition.x;
  me.y = officeReturnPosition.y;
  camera.x = me.x;
  camera.y = me.y;
  dirty = true;
  const returnButton = document.getElementById("virtual-quest-return");
  if (returnButton) returnButton.hidden = true;
  restorePresence();
  updateOnlineStatus();
  updateVirtualQuestComingSoon();
  updateVirtualQuestReturnPrompt();
  updateOfficeExtensionPrompts();
  showHud();
}

function nearestOuterEdgeComingSoonSpot() {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const spot of OUTER_EDGE_COMING_SOON_SPOTS) {
    const distance = Math.hypot(me.x - spot.x, me.y - spot.y);
    if (distance < nearestDistance) {
      nearest = spot;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= OUTER_EDGE_COMING_SOON_RANGE ? nearest : null;
}

function updateVirtualQuestComingSoon() {
  const panel = document.getElementById("virtual-quest-coming-soon");
  if (!panel) return;

  const spot = currentArea === AREAS.OUTER_EDGE ? nearestOuterEdgeComingSoonSpot() : null;
  panel.hidden = !spot;
  if (!spot) return;

  const title = panel.querySelector(".virtual-quest-coming-soon-title");
  const message = panel.querySelector(".virtual-quest-coming-soon-message");
  if (title) title.textContent = spot.title;
  if (message) message.textContent = spot.message;
}

function updateVirtualQuestReturnPrompt() {
  const prompt = document.getElementById("virtual-quest-return-prompt");
  if (!prompt) return;
  prompt.hidden = !isPlayerInOuterEdgeReturnGate() || isBlockingOverlayOpen();
}

function isInsideRect(rect) {
  return (
    me.x >= rect.x &&
    me.x <= rect.x + rect.w &&
    me.y >= rect.y &&
    me.y <= rect.y + rect.h
  );
}

function isPlayerAtOfficeExtensionDoor() {
  return currentArea === AREAS.OFFICE && isInsideRect(OFFICE_EXTENSION_DOOR);
}

function isPlayerAtOfficeExtensionReturnDoor() {
  return (
    currentArea === AREAS.OFFICE_EXTENSION &&
    isInsideRect(officeExtensionRectFromNormalized(OFFICE_EXTENSION_RETURN_DOOR_N))
  );
}

function isPlayerAtOfficeExtensionLockedDoor() {
  return (
    currentArea === AREAS.OFFICE_EXTENSION &&
    isInsideRect(officeExtensionRectFromNormalized(OFFICE_EXTENSION_LOCKED_DOOR_N))
  );
}

function currentOfficeExtensionMessageSpot() {
  if (currentArea !== AREAS.OFFICE_EXTENSION) return null;
  if (isPlayerAtOfficeExtensionLockedDoor()) {
    return { title: "LOCKED", message: "鍵がかかっている。" };
  }
  return (
    OFFICE_EXTENSION_MESSAGE_SPOTS.find((spot) =>
      isInsideRect(officeExtensionRectFromNormalized(spot.rect))
    ) || null
  );
}

function enterOfficeExtensionArea() {
  if (currentArea === AREAS.OFFICE_EXTENSION) return;
  extensionReturnPosition = { x: me.x, y: me.y };
  currentArea = AREAS.OFFICE_EXTENSION;
  clearMovementInput();
  const entry = officeExtensionPointFromNormalized(OFFICE_EXTENSION_ENTRY_N);
  me.x = entry.x;
  me.y = entry.y;
  camera.x = me.x;
  camera.y = me.y;
  dirty = true;
  restorePresence();
  updateOnlineStatus();
  updateVirtualQuestComingSoon();
  updateVirtualQuestReturnPrompt();
  updateOfficeExtensionPrompts();
  showHud();
}

function returnFromOfficeExtensionArea() {
  if (currentArea !== AREAS.OFFICE_EXTENSION) return;
  currentArea = AREAS.OFFICE;
  clearMovementInput();
  me.x = extensionReturnPosition.x;
  me.y = extensionReturnPosition.y;
  camera.x = me.x;
  camera.y = me.y;
  dirty = true;
  restorePresence();
  updateOnlineStatus();
  updateVirtualQuestComingSoon();
  updateVirtualQuestReturnPrompt();
  updateOfficeExtensionPrompts();
  showHud();
}

function updateOfficeExtensionPrompts() {
  const enterPrompt = document.getElementById("office-extension-enter-prompt");
  const returnPrompt = document.getElementById("office-extension-return-prompt");
  const messagePanel = document.getElementById("office-extension-locked-message");
  const blocked = isBlockingOverlayOpen();
  const messageSpot = blocked ? null : currentOfficeExtensionMessageSpot();

  if (enterPrompt) enterPrompt.hidden = !isPlayerAtOfficeExtensionDoor() || blocked;
  if (returnPrompt) returnPrompt.hidden = !isPlayerAtOfficeExtensionReturnDoor() || blocked;
  if (messagePanel) {
    messagePanel.hidden = !messageSpot;
    if (messageSpot) {
      const title = messagePanel.querySelector(".virtual-quest-coming-soon-title");
      const message = messagePanel.querySelector(".virtual-quest-coming-soon-message");
      if (title) title.textContent = messageSpot.title;
      if (message) message.textContent = messageSpot.message;
    }
  }
}

function setupOfficeExtensionStageControls() {
  const enterPrompt = document.createElement("div");
  enterPrompt.id = "office-extension-enter-prompt";
  enterPrompt.hidden = true;
  enterPrompt.innerHTML = `
    <div class="virtual-quest-prompt-copy">
      <strong>拡張部屋</strong>
      <span>ドアから移動できます</span>
    </div>
    <span class="virtual-quest-prompt-key">F</span>
    <button type="button">入る</button>
  `;
  enterPrompt.querySelector("button").addEventListener("click", enterOfficeExtensionArea);
  document.body.appendChild(enterPrompt);

  const returnPrompt = document.createElement("div");
  returnPrompt.id = "office-extension-return-prompt";
  returnPrompt.hidden = true;
  returnPrompt.innerHTML = `
    <div class="virtual-quest-prompt-copy">
      <strong>オフィス</strong>
      <span>元のオフィスへ戻れます</span>
    </div>
    <span class="virtual-quest-prompt-key">F</span>
    <button type="button">戻る</button>
  `;
  returnPrompt.querySelector("button").addEventListener("click", returnFromOfficeExtensionArea);
  document.body.appendChild(returnPrompt);

  const lockedMessage = document.createElement("div");
  lockedMessage.id = "office-extension-locked-message";
  lockedMessage.hidden = true;
  lockedMessage.innerHTML = `
    <div class="virtual-quest-coming-soon-title"></div>
    <div class="virtual-quest-coming-soon-message"></div>
  `;
  document.body.appendChild(lockedMessage);

  addEventListener("keydown", (event) => {
    if (
      event.key.toLowerCase() !== "f" ||
      event.repeat ||
      event.isComposing ||
      isEditableTarget(event.target) ||
      isBlockingOverlayOpen()
    ) {
      return;
    }
    if (isPlayerAtOfficeExtensionDoor()) {
      event.preventDefault();
      enterOfficeExtensionArea();
      return;
    }
    if (isPlayerAtOfficeExtensionReturnDoor()) {
      event.preventDefault();
      returnFromOfficeExtensionArea();
      return;
    }
    if (isPlayerAtOfficeExtensionLockedDoor()) {
      event.preventDefault();
      toast("鍵がかかっている。");
      updateOfficeExtensionPrompts();
    }
  });
}

// ---- HUD 自動表示/非表示（無操作で隠す＋マップのタップ/クリックでトグル）----
const HUD_AUTOHIDE_MS = 5000; // 無操作がこの時間続いたら自動非表示
let hudVisible = true;
let lastHudActivity = performance.now();
let wasInCall = false;

// ポップオーバー/コンソールを開いている間は自動非表示しない（操作中に消えないように）
function isHudPaused() {
  const bg = document.getElementById("bg-popover");
  const volume = document.getElementById("output-volume-popover");
  const sp = document.getElementById("summon-panel");
  const mp = document.getElementById("message-popover");
  const stamp = document.getElementById("stamp-popover");
  const leaveConfirm = document.getElementById("leave-confirm-dialog");
  const questGate = document.getElementById("virtual-quest-gate-modal");
  const cs = document.getElementById("console");
  const cp = document.getElementById("chat-panel");
  return (
    (bg && !bg.hidden) ||
    (volume && !volume.hidden) ||
    (sp && !sp.hidden) ||
    (mp && !mp.hidden) ||
    (stamp && !stamp.hidden) ||
    (leaveConfirm && !leaveConfirm.hidden) ||
    (questGate && !questGate.hidden) ||
    (cs && !cs.hidden) ||
    (cp && !cp.hidden) ||
    (slimeGame && slimeGame.isPlaying()) ||
    isControlTooltipInteractionActive()
  );
}
function showHud() {
  hudVisible = true;
  document.body.classList.remove("hud-hidden");
  lastHudActivity = performance.now();
}
function cancelTransientHudOperations() {
  const activeElement = document.activeElement;
  let shouldBlur = false;
  if (virtualQuestGate && virtualQuestGate.isBlockingOverlayOpen()) {
    virtualQuestGate.closeModal();
    shouldBlur = true;
  }
  for (const id of ["bg-popover", "output-volume-popover", "stamp-popover", "message-popover", "summon-panel"]) {
    const panel = document.getElementById(id);
    if (!panel || panel.hidden) continue;
    if (activeElement && panel.contains(activeElement)) shouldBlur = true;
    panel.hidden = true;
  }
  const volumeBtn = document.getElementById("btn-volume");
  if (volumeBtn) volumeBtn.setAttribute("aria-expanded", "false");
  if (shouldBlur && activeElement instanceof HTMLElement) activeElement.blur();
}
function hideHud() {
  hudVisible = false;
  cancelTransientHudOperations();
  hideControlTooltip(true);
  document.body.classList.add("hud-hidden");
}
function toggleHud() {
  if (hudVisible) hideHud();
  else showHud();
}
// 移動などの操作で呼ぶ：表示を維持＆タイマーをリセット
function noteHudActivity() {
  lastHudActivity = performance.now();
  if (!hudVisible) showHud();
}
function updateHud(now) {
  // 通話中（誰かと接続中）は #videos を隠さない（body.in-call で制御）
  let inCall = false;
  if (rtc) {
    for (const id in others) {
      if (rtc.isConnected(id)) {
        inCall = true;
        break;
      }
    }
  }
  if (inCall !== wasInCall) {
    document.body.classList.toggle("in-call", inCall);
    wasInCall = inCall;
  }
  // 無操作が続いたら自動非表示
  if (hudVisible && !isHudPaused() && now - lastHudActivity > HUD_AUTOHIDE_MS) {
    hideHud();
  }
}

// マップのシングルタップ/クリックで HUD をトグル（ドラッグ/ピンチでは発動しない）
let hudTapStart = null;
let hudActivePointers = 0;
canvas.addEventListener("pointerdown", (e) => {
  hudActivePointers++;
  // 2本以上（ピンチ等）はタップ扱いにしない
  hudTapStart =
    hudActivePointers === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
});
function hudPointerEnd(e) {
  hudActivePointers = Math.max(0, hudActivePointers - 1);
  if (hudTapStart) {
    const dist = Math.hypot(e.clientX - hudTapStart.x, e.clientY - hudTapStart.y);
    const dt = performance.now() - hudTapStart.t;
    if (dist < 10 && dt < 250) toggleHud(); // 移動<10px・250ms以内 のみトグル
  }
  hudTapStart = null;
}
canvas.addEventListener("pointerup", hudPointerEnd);
canvas.addEventListener("pointercancel", () => {
  hudActivePointers = Math.max(0, hudActivePointers - 1);
  hudTapStart = null;
});

function loop(now) {
  const t = now || performance.now();
  step();
  updateGameArea(t);
  if (virtualQuestGate && currentArea === AREAS.OFFICE) virtualQuestGate.update(t);
  updateVirtualQuestComingSoon();
  updateVirtualQuestReturnPrompt();
  updateOfficeExtensionPrompts();
  flushPosition(t);
  updateProximityChimes();
  updateConnections();
  updateSpatialAudio();
  updateBanner();
  updateShareStage();
  updateHud(t);
  updateCamera();
  render();
  requestAnimationFrame(loop);
}

// ---- 起動 ----
async function start() {
  // サインインは起動時の認証フロー（initAuthFlow）で完了済み＝myId は確定している。

  // 2) presence 開始
  await initPresence();

  // 3) メディア（カメラ/マイク/背景効果）を起動。送出ストリーム＝加工後の映像＋マイク
  media = new MediaController();
  const stream = await media.init();
  if (!media.hasCamera) {
    document.getElementById("status").textContent = "カメラ無し（音声/移動のみ）";
  }
  makeTile("__me__", me.name + "（あなた）", stream, true, true);
  setupControls(media);
  initChatSync().catch((e) => console.warn("チャット初期化失敗:", e));

  // 4) WebRTC マネージャ（iceServers は起動時に一度だけ解決＝Metered動的取得も反映）
  const iceServers = await getIceServers();
  rtc = new RTCManager({
    db,
    roomId: ROOM,
    myId,
    localStream: stream,
    iceServers,
    onRemoteStream: addRemoteVideo,
    onClose: removeVideo,
  });
  communicationReady = true;
  syncActivePresence();

  // 5) ループ開始（入室時点を起点に HUD 自動非表示タイマーをリセット）
  showHud();
  resizeCanvas(); // 初回のビューポート寸法を確定
  requestAnimationFrame(loop);
}

// ---- ICE 候補テスト画面（?icetest）----
// iPhone 等で開発者ツールが使えなくても、設定中の TURN が効いているか
// 画面でそのまま確認できる。relay 候補が出れば黒画面は解消する見込み。
async function runIceTestUI() {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;inset:0;background:#0b0e16;color:#e6e6e6;" +
    "font:13px/1.6 ui-monospace,monospace;padding:20px;overflow:auto;" +
    "z-index:99999;white-space:pre-wrap;-webkit-overflow-scrolling:touch;";
  document.body.appendChild(box);

  const iceServers = await getIceServers();
  box.textContent =
    "ICE候補テスト実行中…（最大8秒）\n\n設定中の iceServers:\n" +
    JSON.stringify(iceServers, null, 2);

  const { types, errors } = await runIceTest(iceServers);
  const relayOk = (types.relay || 0) > 0;
  box.textContent =
    (relayOk
      ? "✅ relay 候補あり = TURN は正常に使えています\n（これで相手の映像が出るはず）\n\n"
      : "❌ relay 候補なし = TURN が効いていません\n（同一Wi-Fiでも直結できない環境では黒画面の原因）\n\n") +
    "候補タイプ別件数: " +
    JSON.stringify(types) +
    "\n\nICEエラー:\n" +
    (errors.length ? errors.join("\n") : "なし") +
    "\n\n設定中の iceServers:\n" +
    JSON.stringify(iceServers, null, 2) +
    "\n\n（通常画面に戻るには URL の ?icetest を外して再読み込み）";
}

// ---- ロビー（入室画面）----
// ルーム名を RTDB キー用に整える（ルームは名前のみで識別。合言葉は別途 meta で照合）
function slugRoom(s) {
  return (s || "").trim().toLowerCase().replace(/[.#$\[\]/\s]+/g, "-").slice(0, 40) || "lobby";
}
// 招待リンクの #k= から合言葉を取得
function passFromHash() {
  return new URLSearchParams(location.hash.replace(/^#/, "")).get("k") || "";
}

// 固定（公式）ルーム: 合言葉をコード側で確定し、meta の「先着作成者」に依存しない。
// （先着者に乗っ取られて作成者以外が直せなくなる事故を防ぐ）。
// .preset-rooms の data-fixed ボタンから roomKey→合言葉 を取り込む。
const FIXED_ROOMS = {};
document.querySelectorAll('.preset-rooms [data-fixed="1"]').forEach((b) => {
  FIXED_ROOMS[slugRoom(b.dataset.room)] = b.dataset.pass || "";
});

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 合言葉を rooms/{roomKey}/meta で照合する。
//  - 新規ルーム: 最初の入室者が作成者となり合言葉(ハッシュ)を確定。
//  - 既存ルーム(合言葉あり): ハッシュ不一致なら wrong_pass を投げる＝入れない。
//  - 既存ルーム(合言葉なし=オープン): そのまま入室可。
async function validateAndEnter({ roomName, pass }) {
  const roomKey = slugRoom(roomName);
  const wrongPass = () => {
    const e = new Error("wrong_pass");
    e.code = "wrong_pass";
    return e;
  };
  // 固定ルーム(NCM等): 合言葉はコード側で確定。meta に依存せず照合する。
  if (Object.prototype.hasOwnProperty.call(FIXED_ROOMS, roomKey)) {
    if (pass !== FIXED_ROOMS[roomKey]) throw wrongPass();
    return { roomKey, isCreator: false };
  }
  const metaRef = ref(db, `rooms/${roomKey}/meta`);
  const passHash = pass ? await sha256Hex(pass) : "";
  const snap = await get(metaRef);
  let isCreator = false;
  if (!snap.exists()) {
    try {
      await set(metaRef, { passHash, createdBy: myId, createdAt: Date.now() });
      isCreator = true;
    } catch (e) {
      // ほぼ同時に他者が作成した場合 → 読み直して照合
      const again = await get(metaRef);
      const m = again.exists() ? again.val() : null;
      if (m && m.passHash && m.passHash !== passHash) throw wrongPass();
    }
  } else {
    const m = snap.val();
    if (m.passHash && m.passHash !== passHash) throw wrongPass();
  }
  return { roomKey, isCreator };
}

function enter(roomKey, name, label) {
  ROOM = roomKey;
  myName = name;
  me.name = name;
  document.getElementById("room-label").textContent = label || roomKey;
  start();
}

// ---- 招待リンク / 退出 ----
function buildInviteLink() {
  const slug = slugRoom(currentRoomName || ROOM || "");
  let url = location.origin + location.pathname + "?room=" + encodeURIComponent(slug);
  if (currentPassphrase) url += "#k=" + encodeURIComponent(currentPassphrase);
  return url;
}
async function copyInvite() {
  const link = buildInviteLink();
  try {
    await navigator.clipboard.writeText(link);
    toast("招待リンクをコピーしました（合言葉入り・ワンクリック入室）");
  } catch (e) {
    window.prompt("招待リンク（コピーしてください）", link);
  }
}
// 退出: 在席削除・全切断・メディア停止のうえ、クエリ/ハッシュを消してロビーへ戻す（完全リセット）
async function leaveRoom() {
  if (slimeGame && slimeGame.isPlaying()) slimeGame.cancel();
  communicationReady = false;
  stopPresenceTimers();
  const leavingPresenceRef = meRef;
  meRef = null;
  if (presencePlayersUnsubscribe) {
    presencePlayersUnsubscribe();
    presencePlayersUnsubscribe = null;
  }
  if (presenceConnectionUnsubscribe) {
    presenceConnectionUnsubscribe();
    presenceConnectionUnsubscribe = null;
  }
  if (presenceServerTimeOffsetUnsubscribe) {
    presenceServerTimeOffsetUnsubscribe();
    presenceServerTimeOffsetUnsubscribe = null;
  }
  try {
    if (leavingPresenceRef) await remove(leavingPresenceRef);
  } catch (_) {}
  try {
    if (rtc) rtc.disconnectAll();
  } catch (_) {}
  try {
    if (media) {
      if (media.screenOn) media.stopScreenShare();
      media.stop();
    }
  } catch (_) {}
  location.href = location.origin + location.pathname;
}
let leaveConfirmDialogWired = false;
function closeLeaveConfirmDialog(returnFocus = true) {
  const dialog = document.getElementById("leave-confirm-dialog");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  if (returnFocus) document.getElementById("btn-leave")?.focus();
}
function showLeaveConfirmDialog() {
  const dialog = document.getElementById("leave-confirm-dialog");
  const card = dialog?.querySelector(".confirm-dialog-card");
  if (!dialog || !card) {
    leaveRoom();
    return;
  }
  cancelTransientHudOperations();
  showHud();
  dialog.hidden = false;
  card.focus();
  noteHudActivity();
}
function setupLeaveConfirmDialog() {
  if (leaveConfirmDialogWired) return;
  leaveConfirmDialogWired = true;

  const dialog = document.getElementById("leave-confirm-dialog");
  const yesBtn = document.getElementById("leave-confirm-yes");
  const noBtn = document.getElementById("leave-confirm-no");
  if (!dialog || !yesBtn || !noBtn) return;

  yesBtn.addEventListener("click", leaveRoom);
  noBtn.addEventListener("click", () => closeLeaveConfirmDialog());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeLeaveConfirmDialog();
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (dialog.hidden) return;
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        leaveRoom();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeLeaveConfirmDialog();
      }
    },
    true
  );
}
function wireRoomButtons() {
  const inviteBtn = document.getElementById("btn-invite");
  const leaveBtn = document.getElementById("btn-leave");
  setupLeaveConfirmDialog();
  if (inviteBtn) inviteBtn.addEventListener("click", copyInvite);
  if (leaveBtn) leaveBtn.addEventListener("click", showLeaveConfirmDialog);
}

function setupLobby() {
  const lobby = document.getElementById("lobby");
  const nameInput = document.getElementById("lobby-name");
  const roomInput = document.getElementById("lobby-room");
  const passInput = document.getElementById("lobby-pass");
  const presets = document.querySelector(".preset-rooms");
  const enterBtn = document.getElementById("lobby-enter");
  const errEl = document.getElementById("lobby-error");

  const showErr = (msg) => {
    errEl.textContent = "⚠ " + msg;
    errEl.hidden = false;
    passInput.focus();
    passInput.select && passInput.select();
  };
  const hideErr = () => (errEl.hidden = true);

  nameInput.value = (urlName || defaultName).slice(0, 16);

  // 招待リンク経由（?room=slug #k=合言葉）: ルームを固定し、合言葉を自動入力
  if (urlRoom) {
    roomInput.value = urlRoom;
    roomInput.disabled = true;
    if (presets) presets.style.display = "none";
    const k = passFromHash();
    if (k) passInput.value = k;
  } else {
    // NCM（公式ルーム）: ルーム名のみ固定(編集不可)。合言葉は空欄・編集可とし、
    // 合言葉(ncm)を知っている人が自分で入力したときだけ入室できる。ボタンは「入室する」。
    presets.querySelectorAll("[data-room]").forEach((b) =>
      b.addEventListener("click", () => {
        roomInput.value = b.dataset.room;
        roomInput.disabled = b.dataset.fixed === "1";
        passInput.disabled = false;
        passInput.value = "";
        enterBtn.textContent = "入室する";
        hideErr();
        passInput.focus();
      })
    );
    // 新規ルーム作成: ルーム名・合言葉を空にして編集可。ボタンは「新規作成」。
    // 好きなルーム名＋合言葉を入れて押すと、作成者として新規ルームを作る。
    const createBtn = document.getElementById("create-room");
    if (createBtn)
      createBtn.addEventListener("click", () => {
        roomInput.disabled = false;
        passInput.disabled = false;
        roomInput.value = "";
        passInput.value = "";
        enterBtn.textContent = "新規作成";
        hideErr();
        roomInput.focus();
      });
  }

  async function doEnter() {
    unlockNotificationAudio();
    const name = (nameInput.value || defaultName).slice(0, 16);
    const roomName = (urlRoom || roomInput.value || "").trim();
    const pass = passInput.value.trim();
    hideErr();
    if (!roomName) return showErr("ルーム名を入力してください");
    enterBtn.disabled = true;
    const orig = enterBtn.textContent;
    enterBtn.textContent = orig === "新規作成" ? "作成中…" : "入室中…";
    try {
      const { roomKey, isCreator } = await validateAndEnter({ roomName, pass });
      currentRoomName = roomName;
      currentPassphrase = pass;
      me.name = name;
      saveProfile(); // ロビーで変えた表示名をプロフィールに保存
      history.replaceState(null, "", `?room=${encodeURIComponent(roomKey)}`);
      lobby.hidden = true;
      enter(roomKey, name, roomName);
      if (isCreator) toast(`ルーム「${roomName}」を作成しました。🔗で招待リンクを共有できます`);
    } catch (err) {
      const code = (err && (err.code || err.message)) || String(err);
      if (err && err.code === "wrong_pass") showErr("合言葉が違います");
      else if (/auth\//i.test(code))
        showErr("認証エラーが発生しました。再度サインインしてください");
      else if (/permission/i.test(code))
        showErr("権限エラー：Realtime Database のルールを更新してください");
      else {
        console.error("入室失敗:", err);
        showErr("入室に失敗しました（" + code + "）");
      }
    } finally {
      enterBtn.disabled = false;
      enterBtn.textContent = orig;
    }
  }

  enterBtn.addEventListener("click", doEnter);
  [nameInput, roomInput, passInput].forEach((el) =>
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doEnter();
    })
  );
  nameInput.focus();
}

// =============================================================
//  プロフィール（表示名・アイコン）: users/{uid} に保存し、
//  在席ノードにも反映 → 他の参加者のマップへリアルタイム反映。
// =============================================================
function profileRef(uid) {
  return ref(db, `users/${uid}`);
}

// 端末ローカルの控え。クラウド(RTDB)書き込みが失敗してもアバター/表示名を保持する。
function localProfileKey(uid) {
  return "vo_profile_" + uid;
}
function readLocalProfile(uid) {
  try {
    const raw = localStorage.getItem(localProfileKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}
function writeLocalProfile(uid, data) {
  try {
    localStorage.setItem(localProfileKey(uid), JSON.stringify(data));
  } catch (_) {}
}

function applyProfileToMe(p) {
  if (!p) return;
  if (p.displayName) {
    me.name = p.displayName.slice(0, 16);
    myName = me.name;
  }
  me.iconType = p.iconType === "upload" ? "upload" : "preset";
  me.iconId = p.iconId || "";
  me.iconUrl = p.iconUrl || "";
}

// サインイン直後に呼ぶ。クラウドと端末の控えの「新しい方」を採用する。
async function loadUserProfile(user) {
  let cloud = null;
  let cloudReadOk = false;
  try {
    const snap = await get(profileRef(user.uid));
    cloudReadOk = true;
    if (snap.exists()) cloud = snap.val();
  } catch (e) {
    console.warn("プロフィール読込失敗:", e);
  }
  const local = readLocalProfile(user.uid);

  // 新しい方（updatedAt が大きい方）を採用。クラウド書き込み失敗で stale な場合に
  // 端末の最新編集が勝つようにする。
  let profile = null;
  if (cloud && local) {
    profile = (local.updatedAt || 0) > (cloud.updatedAt || 0) ? local : cloud;
  } else {
    profile = cloud || local || null;
  }

  if (!profile) {
    profile = {
      displayName: (user.displayName || (user.email || "").split("@")[0] || defaultName).slice(0, 16),
      iconType: "preset",
      iconId: defaultPresetIdFor(user.uid),
      iconUrl: "",
      updatedAt: Date.now(),
    };
  }
  // 採用したものがクラウドより新しければクラウドへ復元（次回・他端末用）
  if (cloudReadOk && profile !== cloud && (profile.updatedAt || 0) > ((cloud && cloud.updatedAt) || 0)) {
    set(profileRef(user.uid), profile).catch((e) => console.warn("プロフィール復元失敗:", e));
  }
  writeLocalProfile(user.uid, profile);
  applyProfileToMe(profile);
  // ロビー / コンソールの表示名欄へ反映（入力中の欄は上書きしない）
  const lobbyName = document.getElementById("lobby-name");
  const consoleName = document.getElementById("console-name");
  if (lobbyName && !urlName && document.activeElement !== lobbyName) lobbyName.value = me.name;
  if (consoleName && document.activeElement !== consoleName) consoleName.value = me.name;
  renderConsolePreview();
}

// me の現在値をプロフィール(users/{uid})と在席ノードに保存し、UIへ反映。
function saveProfile() {
  if (!myId) return;
  const data = {
    displayName: me.name || defaultName,
    iconType: me.iconType || "preset",
    iconId: me.iconId || "",
    iconUrl: me.iconUrl || "",
    updatedAt: Date.now(),
  };
  // まず端末ローカルに控える（クラウド書き込みが失敗しても保持される）
  writeLocalProfile(myId, data);
  // クラウドへ保存（失敗時は原因が分かるようトーストで通知）
  set(profileRef(myId), data).catch((e) => {
    console.warn("プロフィール保存失敗:", e);
    toast("⚠ プロフィールをクラウドに保存できませんでした（" + (e.code || e.message) + "）");
  });
  // 入室済みなら在席ノードを更新 → 他の参加者に即反映
  if (meRef) {
    update(meRef, {
      name: data.displayName,
      iconType: data.iconType,
      iconId: data.iconId,
      iconUrl: data.iconUrl,
    }).catch(() => {});
  }
  // 自分の映像タイルの名前も更新
  const myTile = videoTiles.get("__me__");
  if (myTile) {
    const cap = myTile.querySelector(".cap");
    if (cap) cap.textContent = data.displayName + "（あなた）";
  }
  const lobbyName = document.getElementById("lobby-name");
  if (lobbyName && document.activeElement !== lobbyName) lobbyName.value = data.displayName;
  renderConsolePreview();
}

// =============================================================
//  バーチャル背景の設定を保存/復元（Issue #7）
//  保存先は users/{uid} とは別ノード（プロフィール保存が set() で
//  users/{uid} を丸ごと上書きするため、同じノードに置くと消えてしまう）。
//  背景画像は自分専用の設定＝他ユーザーへ配信しないので .read も本人限定。
// =============================================================
let bgImageDataUrl = ""; // 直近にアップロードした背景画像（圧縮済みdata URL）。保存/モード切替の再利用に使う。

function backgroundPrefRef(uid) {
  return ref(db, `backgroundSettings/${uid}`);
}
function localBackgroundKey(uid) {
  return "vo_background_" + uid;
}
function readLocalBackgroundPref(uid) {
  try {
    const raw = localStorage.getItem(localBackgroundKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}
function writeLocalBackgroundPref(uid, data) {
  try {
    localStorage.setItem(localBackgroundKey(uid), JSON.stringify(data));
  } catch (_) {}
}

// アップロード画像を「動画背景として十分な解像度」に圧縮してdata URL化する
// （アバターの192pxより大きめ。他ユーザーへは配信されずRTDBの本人ノードのみに
//  保存するため、アバターアイコンほどサイズをシビアに削る必要はない）。
function compressBackgroundImage(img, maxDim = 960, quality = 0.82) {
  const iw = img.naturalWidth || img.width || 0;
  const ih = img.naturalHeight || img.height || 0;
  if (!iw || !ih) return "";
  const scale = Math.min(1, maxDim / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

// クラウドと端末控えの「新しい方」を採用する（プロフィールと同じ考え方）。
async function loadBackgroundPreference(uid) {
  let cloud = null;
  try {
    const snap = await get(backgroundPrefRef(uid));
    if (snap.exists()) cloud = snap.val();
  } catch (e) {
    console.warn("背景設定の読込失敗:", e);
  }
  const local = readLocalBackgroundPref(uid);
  if (cloud && local) return (local.updatedAt || 0) > (cloud.updatedAt || 0) ? local : cloud;
  return cloud || local || null;
}

// media/UIの現在値をそのまま保存する（実際に適用された結果を保存＝復元時に再現しやすい）。
function saveBackgroundPreference() {
  if (!myId || !media) return;
  const data = {
    mode: media.mode || "none",
    blurAmount: Number.isFinite(media.blurAmount) ? media.blurAmount : 8,
    imageUrl: bgImageDataUrl || "", // モードに関わらず保持＝再アップロードせず image に戻せる
    updatedAt: Date.now(),
  };
  writeLocalBackgroundPref(myId, data);
  set(backgroundPrefRef(myId), data).catch((e) => console.warn("背景設定の保存失敗:", e));
}

// =============================================================
//  プロフィール設定コンソール（歯車 → 左からスライドイン）
// =============================================================
function renderConsolePreview() {
  const el = document.getElementById("avatar-preview");
  if (!el) return;
  if (me.iconType === "upload" && me.iconUrl) {
    el.textContent = "";
    el.style.backgroundImage = `url("${me.iconUrl}")`;
    el.style.background = `#2a3145 url("${me.iconUrl}") center/cover no-repeat`;
  } else {
    const preset = presetById(me.iconId) || presetById(defaultPresetIdFor(myId || ""));
    el.style.backgroundImage = "none";
    el.style.background = preset ? preset.bg : me.color;
    el.textContent = preset ? preset.emoji : "";
  }
  // プリセットグリッドの選択状態
  document.querySelectorAll("#preset-grid .preset-item").forEach((it) => {
    it.classList.toggle(
      "selected",
      me.iconType === "preset" && it.dataset.id === me.iconId
    );
  });
}

let consoleBuilt = false;
function buildPresetGrid() {
  const grid = document.getElementById("preset-grid");
  if (!grid || grid.childElementCount) return;
  for (const p of PRESET_ICONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "preset-item";
    item.dataset.id = p.id;
    item.style.background = p.bg;
    item.textContent = p.emoji;
    item.title = p.id;
    item.addEventListener("click", () => {
      me.iconType = "preset";
      me.iconId = p.id;
      me.iconUrl = "";
      renderConsolePreview();
    });
    grid.appendChild(item);
  }
}

function openConsole() {
  buildPresetGrid();
  const consoleName = document.getElementById("console-name");
  if (consoleName) consoleName.value = me.name || "";
  renderConsolePreview();
  document.getElementById("console-backdrop").hidden = false;
  const panel = document.getElementById("console");
  panel.hidden = false;
  panel.classList.add("closing"); // いったん画面外
  requestAnimationFrame(() => panel.classList.remove("closing")); // スライドイン
}

// × で閉じる → その瞬間に保存＆全員へ反映（確定仕様）
function closeConsole() {
  const consoleName = document.getElementById("console-name");
  if (consoleName) {
    const n = (consoleName.value || "").trim().slice(0, 16);
    if (n) me.name = n;
  }
  saveProfile();
  const panel = document.getElementById("console");
  panel.classList.add("closing");
  document.getElementById("console-backdrop").hidden = true;
  setTimeout(() => {
    panel.hidden = true;
    panel.classList.remove("closing");
  }, 220);
}

function setupConsole() {
  const lobbyGear = document.getElementById("lobby-settings");
  const ctrlGear = document.getElementById("btn-settings");
  const closeBtn = document.getElementById("console-close");
  const backdrop = document.getElementById("console-backdrop");
  const uploadBtn = document.getElementById("upload-icon");
  const fileInput = document.getElementById("icon-file");
  const note = document.getElementById("console-note");
  const logoutBtn = document.getElementById("console-logout");

  if (lobbyGear) lobbyGear.addEventListener("click", openConsole);
  if (ctrlGear) ctrlGear.addEventListener("click", openConsole);
  if (closeBtn) closeBtn.addEventListener("click", closeConsole);
  if (backdrop) backdrop.addEventListener("click", closeConsole);

  if (uploadBtn) uploadBtn.addEventListener("click", () => fileInput.click());
  if (fileInput)
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ""; // 同じファイルを連続選択できるように
      if (!file) return;
      // Storage(Blaze必須)は使わず、クロップ画像を小さく圧縮して data URL で保存する。
      const dataUrl = await openCrop(file);
      if (!dataUrl) return;
      me.iconType = "upload";
      me.iconUrl = dataUrl;
      getAvatarImage(dataUrl); // 先読み
      renderConsolePreview();
      note.textContent = "画像を設定しました";
    });

  if (logoutBtn)
    logoutBtn.addEventListener("click", async () => {
      try {
        await signOut(auth);
      } catch (_) {}
      location.href = location.origin + location.pathname; // ロビー/ルーム状態を完全リセット
    });
}

// =============================================================
//  円形クロップ（外部ライブラリ不要・Canvas で実装）
//  Storage(有料) を使わず RTDB に収めるため、出力は小さめ JPEG の data URL。
//  アバターは描画時に円形クリップするので JPEG の角は見えない。
//  返り値: data URL 文字列（キャンセル時は null）
// =============================================================
const AVATAR_OUT = 192; // 出力解像度（px）。data URL を小さく保つ
function openCrop(file) {
  return new Promise((resolve) => {
    const modal = document.getElementById("crop-modal");
    const canvas = document.getElementById("crop-canvas");
    const range = document.getElementById("crop-range");
    const cancelBtn = document.getElementById("crop-cancel");
    const confirmBtn = document.getElementById("crop-confirm");
    const cctx = canvas.getContext("2d");
    const VIEW = canvas.width; // 256

    const img = new Image();
    img.onload = () => {
      let baseScale = Math.max(VIEW / img.naturalWidth, VIEW / img.naturalHeight);
      let zoom = 1;
      // 画像中心のキャンバス座標（ドラッグで移動）
      let cx = VIEW / 2;
      let cy = VIEW / 2;
      range.value = "1";

      const clamp = () => {
        const dw = img.naturalWidth * baseScale * zoom;
        const dh = img.naturalHeight * baseScale * zoom;
        cx = Math.min(dw / 2, Math.max(VIEW - dw / 2, cx));
        cy = Math.min(dh / 2, Math.max(VIEW - dh / 2, cy));
      };
      const draw = () => {
        clamp();
        const dw = img.naturalWidth * baseScale * zoom;
        const dh = img.naturalHeight * baseScale * zoom;
        cctx.clearRect(0, 0, VIEW, VIEW);
        cctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
      };

      // ドラッグでパン（マウス＆タッチ）
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const toCanvas = (clientX, clientY) => {
        const r = canvas.getBoundingClientRect();
        return { x: ((clientX - r.left) / r.width) * VIEW, y: ((clientY - r.top) / r.height) * VIEW };
      };
      const onDown = (e) => {
        dragging = true;
        const p = e.touches ? e.touches[0] : e;
        const c = toCanvas(p.clientX, p.clientY);
        lastX = c.x;
        lastY = c.y;
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        const p = e.touches ? e.touches[0] : e;
        const c = toCanvas(p.clientX, p.clientY);
        cx += c.x - lastX;
        cy += c.y - lastY;
        lastX = c.x;
        lastY = c.y;
        draw();
        e.preventDefault();
      };
      const onUp = () => (dragging = false);

      const onZoom = () => {
        zoom = parseFloat(range.value);
        draw();
      };

      canvas.addEventListener("mousedown", onDown);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      canvas.addEventListener("touchstart", onDown, { passive: false });
      canvas.addEventListener("touchmove", onMove, { passive: false });
      canvas.addEventListener("touchend", onUp);
      range.addEventListener("input", onZoom);

      const cleanup = () => {
        canvas.removeEventListener("mousedown", onDown);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        canvas.removeEventListener("touchstart", onDown);
        canvas.removeEventListener("touchmove", onMove);
        canvas.removeEventListener("touchend", onUp);
        range.removeEventListener("input", onZoom);
        cancelBtn.removeEventListener("click", onCancel);
        confirmBtn.removeEventListener("click", onConfirm);
        modal.hidden = true;
      };
      const onCancel = () => {
        cleanup();
        resolve(null);
      };
      const onConfirm = () => {
        // 選択範囲を AVATAR_OUT 角の JPEG に縮小して data URL 化（RTDBに収まるサイズに）。
        // 角は描画時の円形クリップで隠れるため、背景を黒く塗ってから cover 配置する。
        const out = document.createElement("canvas");
        out.width = AVATAR_OUT;
        out.height = AVATAR_OUT;
        const octx = out.getContext("2d");
        const k = AVATAR_OUT / VIEW; // プレビュー座標 → 出力座標の倍率
        octx.fillStyle = "#000";
        octx.fillRect(0, 0, AVATAR_OUT, AVATAR_OUT);
        const dw = img.naturalWidth * baseScale * zoom * k;
        const dh = img.naturalHeight * baseScale * zoom * k;
        octx.drawImage(img, cx * k - dw / 2, cy * k - dh / 2, dw, dh);
        const dataUrl = out.toDataURL("image/jpeg", 0.85);
        cleanup();
        resolve(dataUrl);
      };
      cancelBtn.addEventListener("click", onCancel);
      confirmBtn.addEventListener("click", onConfirm);

      modal.hidden = false;
      draw();
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

// =============================================================
//  認証フロー: サインイン画面 ↔ ロビー
// =============================================================
function showSignin() {
  document.getElementById("signin").hidden = false;
  document.getElementById("lobby").hidden = true;
}
function showLobby() {
  document.getElementById("signin").hidden = true;
  document.getElementById("lobby").hidden = false;
}

function setupSignin() {
  const googleBtn = document.getElementById("google-signin");
  const nameInput = document.getElementById("auth-name");
  const emailInput = document.getElementById("auth-email");
  const passInput = document.getElementById("auth-pass");
  const submitBtn = document.getElementById("auth-submit");
  const errEl = document.getElementById("auth-error");
  const toggleText = document.getElementById("auth-toggle-text");
  const toggleLink = document.getElementById("auth-toggle-link");
  const nameRow = document.getElementById("auth-name-row");

  let mode = "register"; // "register" | "login"
  const showErr = (msg) => {
    errEl.textContent = "⚠ " + msg;
    errEl.hidden = false;
  };
  const hideErr = () => (errEl.hidden = true);
  const setMode = (m) => {
    mode = m;
    hideErr();
    if (m === "register") {
      nameRow.style.display = "";
      submitBtn.textContent = "メールアドレスで登録";
      toggleText.textContent = "アカウントをお持ちですか？";
      toggleLink.textContent = "ログイン";
    } else {
      nameRow.style.display = "none";
      submitBtn.textContent = "ログイン";
      toggleText.textContent = "アカウントが未登録ですか？";
      toggleLink.textContent = "新規登録";
    }
  };
  toggleLink.addEventListener("click", (e) => {
    e.preventDefault();
    setMode(mode === "register" ? "login" : "register");
  });

  googleBtn.addEventListener("click", async () => {
    hideErr();
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      // 以降は onAuthStateChanged が処理
    } catch (e) {
      console.error("Googleログイン失敗:", e);
      if (e.code === "auth/popup-blocked")
        showErr("ポップアップがブロックされました。許可して再試行してください");
      else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request")
        showErr("Googleログインに失敗しました（" + (e.code || e.message) + "）");
    }
  });

  const submit = async () => {
    hideErr();
    const email = (emailInput.value || "").trim();
    const pass = passInput.value;
    if (!email || !pass) return showErr("メールアドレスとパスワードを入力してください");
    submitBtn.disabled = true;
    const orig = submitBtn.textContent;
    submitBtn.textContent = "処理中…";
    try {
      if (mode === "register") {
        const name = (nameInput.value || "").trim().slice(0, 16);
        if (!name) {
          showErr("ユーザー名（表示名）を入力してください");
          return;
        }
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        try {
          await updateProfile(cred.user, { displayName: name });
        } catch (_) {}
        // 表示名を確実にプロフィールへ（onAuthStateChanged が拾う前に作っておく）
        try {
          await set(profileRef(cred.user.uid), {
            displayName: name,
            iconType: "preset",
            iconId: defaultPresetIdFor(cred.user.uid),
            iconUrl: "",
            updatedAt: Date.now(),
          });
        } catch (_) {}
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
      // 以降は onAuthStateChanged が処理
    } catch (e) {
      console.error("メール認証失敗:", e);
      const c = e.code || "";
      if (c === "auth/email-already-in-use") showErr("このメールアドレスは登録済みです。ログインしてください");
      else if (c === "auth/invalid-email") showErr("メールアドレスの形式が正しくありません");
      else if (c === "auth/weak-password") showErr("パスワードは6文字以上にしてください");
      else if (c === "auth/invalid-credential" || c === "auth/wrong-password" || c === "auth/user-not-found")
        showErr("メールアドレスまたはパスワードが違います");
      else if (c === "auth/operation-not-allowed")
        showErr("メール認証が未有効です。Firebaseで有効化してください");
      else showErr("認証に失敗しました（" + (c || e.message) + "）");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = orig;
    }
  };
  submitBtn.addEventListener("click", submit);
  [emailInput, passInput, nameInput].forEach((el) =>
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    })
  );
  setMode("register");
}

function initAuthFlow() {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      myId = user.uid;
      currentUser = user;
      await loadUserProfile(user);
      showLobby();
      const nameInput = document.getElementById("lobby-name");
      if (nameInput) nameInput.focus();
    } else {
      myId = null;
      currentUser = null;
      showSignin();
    }
  });
}

// ---- 起動の振り分け ----
setupControlTooltips();
setupSlimeGame();
setupVirtualQuestGate();
setupVirtualQuestStageControls();
setupOfficeExtensionStageControls();

if (ICETEST) {
  document.getElementById("signin").hidden = true;
  document.getElementById("lobby").hidden = true;
  ROOM = urlRoom || "lobby";
  myName = defaultName;
  me.name = myName;
  me.iconId = defaultPresetIdFor("icetest");
  document.getElementById("room-label").textContent = ROOM;
  runIceTestUI();
} else {
  wireRoomButtons();
  setupLobby();
  setupConsole();
  setupSignin();
  initAuthFlow();
}
