// =============================================================
//  メイン: マップ描画 / 移動 / 位置同期(presence) / 近接判定
// =============================================================
import { db, auth } from "./firebase-config.js";
import {
  ref,
  set,
  update,
  onValue,
  onDisconnect,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { RTCManager } from "./rtc.js";

// ---- 設定 ----
const ROOM = new URLSearchParams(location.search).get("room") || "lobby";
const CALL_RADIUS = 120; // この距離以内で通話開始
const HANGUP_RADIUS = 175; // この距離を超えたら切断（ヒステリシスでバタつき防止）
const FULL_VOLUME_RADIUS = 45; // この距離以内なら最大音量（以遠は離れるほど小さく）
const SPEED = 3.2;

// ---- 自分 ----
let myId = null; // 匿名認証の uid を起動時にセット
let meRef = null;
const rand4 = Math.random().toString(36).slice(2, 6);
const defaultName = "user-" + rand4;
const nameParam = new URLSearchParams(location.search).get("name");
const myName = (nameParam || prompt("名前を入力してください", defaultName) || defaultName).slice(0, 16);
const myColor = `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`;

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

// ---- オフィスのマップ（壁・家具・ゾーン） ----
const R = 16; // アバター半径（衝突マージン）

// 通り抜け不可（type で見た目を変える）
const WALLS = [
  // 会議室A（左上）: 上・左・右の壁＋下は出入口を空ける
  { x: 60, y: 70, w: 290, h: 14, type: "wall" },
  { x: 60, y: 70, w: 14, h: 180, type: "wall" },
  { x: 336, y: 70, w: 14, h: 180, type: "wall" },
  { x: 60, y: 236, w: 100, h: 14, type: "wall" }, // 下・左側
  { x: 270, y: 236, w: 80, h: 14, type: "wall" }, // 下・右側（出入口は中央）
  { x: 130, y: 120, w: 150, h: 70, type: "desk" }, // 会議テーブル

  // 中央〜右: デスクの島
  { x: 520, y: 120, w: 120, h: 48, type: "desk" },
  { x: 700, y: 120, w: 120, h: 48, type: "desk" },
  { x: 520, y: 280, w: 120, h: 48, type: "desk" },
  { x: 700, y: 280, w: 120, h: 48, type: "desk" },

  // 下部の間仕切り（中央に通路を残す）
  { x: 360, y: 430, w: 180, h: 14, type: "wall" },
  { x: 640, y: 430, w: 260, h: 14, type: "wall" },

  // 観葉植物
  { x: 70, y: 540, w: 28, h: 28, type: "plant" },
  { x: 880, y: 70, w: 28, h: 28, type: "plant" },
  { x: 470, y: 520, w: 28, h: 28, type: "plant" },
];

// 通り抜け可（床の色分け＝ゾーン表示のみ）
const ZONES = [
  { x: 74, y: 84, w: 262, h: 152, color: "rgba(52,152,219,0.10)", label: "会議室A" },
  { x: 660, y: 470, w: 240, h: 110, color: "rgba(46,204,113,0.10)", label: "ラウンジ" },
];

// その座標にアバター中心を置けるか（壁・画面外なら false）
function canBeAt(x, y) {
  if (x < R || x > W - R || y < R || y > H - R) return false;
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

// 壁にめり込まない初期位置を探す
function randomSpawn() {
  for (let i = 0; i < 300; i++) {
    const x = 40 + Math.random() * (W - 80);
    const y = 40 + Math.random() * (H - 80);
    if (canBeAt(x, y)) return { x, y };
  }
  return { x: W / 2, y: H / 2 };
}

const spawn = randomSpawn();
const me = {
  x: spawn.x,
  y: spawn.y,
  name: myName,
  color: myColor,
};
const others = {}; // id -> {x, y, name, color}

document.getElementById("room-label").textContent = `room: ${ROOM}`;

// ---- 映像タイル ----
const videosEl = document.getElementById("videos");
const videoTiles = new Map(); // id -> wrapper element

function makeTile(id, label, stream, muted) {
  const wrap = document.createElement("div");
  wrap.className = "tile";
  const v = document.createElement("video");
  v.autoplay = true;
  v.playsInline = true;
  v.muted = !!muted;
  v.srcObject = stream;
  const cap = document.createElement("span");
  cap.className = "cap";
  cap.textContent = label;
  wrap.appendChild(v);
  wrap.appendChild(cap);
  videosEl.appendChild(wrap);
  videoTiles.set(id, wrap);
}
function addRemoteVideo(peerId, stream) {
  const existing = videoTiles.get(peerId);
  if (existing) {
    existing.querySelector("video").srcObject = stream;
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

// ---- presence (Realtime Database) ----
// 匿名サインインで uid が確定してから呼ぶ
function initPresence() {
  meRef = ref(db, `rooms/${ROOM}/players/${myId}`);
  onDisconnect(meRef).remove(); // タブを閉じたら自動削除
  set(meRef, {
    x: Math.round(me.x),
    y: Math.round(me.y),
    name: me.name,
    color: me.color,
    ts: Date.now(),
  });

  onValue(ref(db, `rooms/${ROOM}/players`), (snap) => {
    const all = snap.val() || {};
    for (const id in all) {
      if (id === myId) continue;
      others[id] = all[id];
    }
    // 退出したプレイヤーを掃除
    for (const id in others) {
      if (!all[id]) {
        delete others[id];
        if (rtc) rtc.disconnectFrom(id);
        removeVideo(id);
      }
    }
    document.getElementById("status").textContent = `オンライン: ${Object.keys(all).length}人`;
  });
}

// 位置送信（動いてる時だけ・約12fps に間引いて無料枠を節約）
let dirty = false;
let lastSent = 0;
function flushPosition(now) {
  if (!meRef) return;
  if (dirty && now - lastSent > 80) {
    update(meRef, { x: Math.round(me.x), y: Math.round(me.y), ts: Date.now() });
    lastSent = now;
    dirty = false;
  }
}

// ---- 入力 ----
const keys = {};
addEventListener("keydown", (e) => {
  keys[e.key.toLowerCase()] = true;
});
addEventListener("keyup", (e) => {
  keys[e.key.toLowerCase()] = false;
});

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

// ---- 近接判定 ----
let rtc = null;
function checkProximity() {
  if (!rtc) return;
  for (const id in others) {
    const o = others[id];
    const d = Math.hypot(o.x - me.x, o.y - me.y);
    if (d <= CALL_RADIUS && !rtc.isConnected(id)) {
      rtc.connectTo(id);
    } else if (d > HANGUP_RADIUS && rtc.isConnected(id)) {
      rtc.disconnectFrom(id);
    }
  }
}

// 距離で音量フェード（近いほど大きく、遠いほど小さく＝Gather風）
function updateSpatialAudio() {
  if (!rtc) return;
  for (const id in others) {
    if (!rtc.isConnected(id)) continue;
    const tile = videoTiles.get(id);
    if (!tile) continue;
    const v = tile.querySelector("video");
    if (!v) continue;
    const o = others[id];
    const d = Math.hypot(o.x - me.x, o.y - me.y);
    const vol = Math.max(
      0,
      Math.min(1, (HANGUP_RADIUS - d) / (HANGUP_RADIUS - FULL_VOLUME_RADIUS))
    );
    v.volume = vol;
    tile.style.opacity = (0.45 + 0.55 * vol).toFixed(2); // 遠いほど薄く表示
  }
}

// ---- 描画 ----
function drawAvatar(p, isMe, connected) {
  if (connected) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(46, 204, 113, 0.9)";
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
  ctx.fillStyle = p.color || "#888";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = isMe ? "#fff" : "rgba(255,255,255,0.6)";
  ctx.stroke();

  ctx.font = "13px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.fillText(p.name + (isMe ? "（あなた）" : ""), p.x, p.y - 24);
}

function drawFloor() {
  ctx.fillStyle = "#1f2433";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
}

// ゾーン（床の色分け・通り抜け可）
function drawZones() {
  for (const z of ZONES) {
    ctx.fillStyle = z.color;
    ctx.fillRect(z.x, z.y, z.w, z.h);
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(z.label, z.x + 8, z.y + 18);
  }
}

// 壁・家具・植物（通り抜け不可）
function drawWalls() {
  for (const w of WALLS) {
    if (w.type === "plant") {
      ctx.fillStyle = "#6b4f3a"; // 鉢
      ctx.fillRect(w.x, w.y + w.h * 0.6, w.w, w.h * 0.4);
      ctx.beginPath(); // 葉
      ctx.fillStyle = "#3a9d54";
      ctx.arc(w.x + w.w / 2, w.y + w.h * 0.42, w.w * 0.55, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    if (w.type === "desk") {
      ctx.fillStyle = "#5a4636";
    } else {
      ctx.fillStyle = "#3a4257";
    }
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  }
}

function render() {
  drawFloor();
  drawZones();

  // 自分の通話範囲
  ctx.beginPath();
  ctx.arc(me.x, me.y, CALL_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(52, 152, 219, 0.07)";
  ctx.fill();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = "rgba(52, 152, 219, 0.4)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  drawWalls();

  for (const id in others) {
    drawAvatar(others[id], false, rtc && rtc.isConnected(id));
  }
  drawAvatar(me, true, false);
}

function loop(now) {
  step();
  flushPosition(now || 0);
  checkProximity();
  updateSpatialAudio();
  render();
  requestAnimationFrame(loop);
}

// ---- 起動 ----
async function start() {
  // 1) 匿名サインイン（uid を自分のIDに使う）
  try {
    const cred = await signInAnonymously(auth);
    myId = cred.user.uid;
  } catch (e) {
    console.error("匿名サインイン失敗:", e);
    document.getElementById("status").textContent =
      "サインイン失敗（Firebaseで匿名ログインを有効化してください）";
    alert(
      "Firebase Authentication の「匿名」サインインが未有効です。\n" +
        "コンソール → Authentication → Sign-in method → 匿名 → 有効化 してください。\n\n" +
        (e.code || e.message)
    );
    return;
  }

  // 2) presence 開始
  initPresence();

  // 3) カメラ/マイク取得
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    console.warn("getUserMedia 失敗:", e);
    document.getElementById("status").textContent = "カメラ/マイク不可（移動のみ）";
    stream = new MediaStream();
  }
  makeTile("__me__", me.name + "（あなた）", stream, true);

  // 4) WebRTC マネージャ
  rtc = new RTCManager({
    db,
    roomId: ROOM,
    myId,
    localStream: stream,
    onRemoteStream: addRemoteVideo,
    onClose: removeVideo,
  });

  // 5) ループ開始
  requestAnimationFrame(loop);
}

start();
