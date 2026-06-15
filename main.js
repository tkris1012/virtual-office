// =============================================================
//  メイン: マップ描画 / 移動 / 位置同期(presence) / 近接判定
// =============================================================
import { db } from "./firebase-config.js";
import {
  ref,
  set,
  update,
  onValue,
  onDisconnect,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { RTCManager } from "./rtc.js";

// ---- 設定 ----
const ROOM = new URLSearchParams(location.search).get("room") || "lobby";
const CALL_RADIUS = 120; // この距離以内で通話開始
const HANGUP_RADIUS = 175; // この距離を超えたら切断（ヒステリシスでバタつき防止）
const SPEED = 3.2;

// ---- 自分 ----
const myId = Math.random().toString(36).slice(2, 10);
const defaultName = "user-" + myId.slice(0, 4);
const nameParam = new URLSearchParams(location.search).get("name");
const myName = (nameParam || prompt("名前を入力してください", defaultName) || defaultName).slice(0, 16);
const myColor = `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`;

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

const me = {
  x: 200 + Math.random() * (W - 400),
  y: 150 + Math.random() * (H - 300),
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
const meRef = ref(db, `rooms/${ROOM}/players/${myId}`);
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

// 位置送信（動いてる時だけ・約12fps に間引いて無料枠を節約）
let dirty = false;
let lastSent = 0;
function flushPosition(now) {
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
    me.x = Math.max(16, Math.min(W - 16, me.x + dx * SPEED));
    me.y = Math.max(16, Math.min(H - 16, me.y + dy * SPEED));
    dirty = true;
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

function render() {
  drawFloor();
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

  for (const id in others) {
    drawAvatar(others[id], false, rtc && rtc.isConnected(id));
  }
  drawAvatar(me, true, false);
}

function loop(now) {
  step();
  flushPosition(now || 0);
  checkProximity();
  render();
  requestAnimationFrame(loop);
}

// ---- 起動 ----
async function start() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    console.warn("getUserMedia 失敗:", e);
    document.getElementById("status").textContent = "カメラ/マイク不可（移動のみ）";
    stream = new MediaStream();
  }
  makeTile("__me__", me.name + "（あなた）", stream, true);

  rtc = new RTCManager({
    db,
    roomId: ROOM,
    myId,
    localStream: stream,
    onRemoteStream: addRemoteVideo,
    onClose: removeVideo,
  });

  requestAnimationFrame(loop);
}

start();
