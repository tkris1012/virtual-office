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
import { RTCManager, getIceServers, runIceTest } from "./rtc.js";
import { MediaController } from "./media.js";

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
const ICETEST = new URLSearchParams(location.search).has("icetest"); // 診断画面では名前を聞かない
const myName = (
  nameParam || (ICETEST ? defaultName : prompt("名前を入力してください", defaultName)) || defaultName
).slice(0, 16);
const myColor = `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`;

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

// ---- オフィスのマップ（背景画像 office.png ＋ 壁の当たり判定） ----
const R = 16; // アバター半径（衝突マージン）
const DEBUG = new URLSearchParams(location.search).has("debug"); // ?debug で採寸グリッド表示

// 背景のオフィス画像
const officeImg = new Image();
let officeImgReady = false;
officeImg.onload = () => (officeImgReady = true);
officeImg.src = "office2.png";

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

const me = {
  x: W * 0.45, // 中央の島デスクあたり
  y: H * 0.5,
  name: myName,
  color: myColor,
};
const others = {}; // id -> {x, y, name, color}

document.getElementById("room-label").textContent = `room: ${ROOM}`;

// ---- 映像タイル ----
const videosEl = document.getElementById("videos");
const videoTiles = new Map(); // id -> wrapper element

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
  const bgMode = document.getElementById("bg-mode");
  const blurRange = document.getElementById("blur-range");
  const bgImageBtn = document.getElementById("btn-bg-image");
  const bgFile = document.getElementById("bg-file");
  const bgNote = document.getElementById("bg-note");

  function syncCamUI() {
    const on = media.cameraOn;
    camBtn.textContent = on ? "🎥 カメラ ON" : "🚫 カメラ OFF";
    camBtn.classList.toggle("off", !on);
    camBtn.setAttribute("aria-pressed", String(on));
    // 自分タイルはカメラON時のみ鏡像（OFF時はプレースホルダ文字を正しく表示）
    const myTile = videoTiles.get("__me__");
    if (myTile) myTile.classList.toggle("mirror", on);
  }
  function syncMicUI() {
    const on = media.micOn;
    micBtn.textContent = on ? "🎤 マイク ON" : "🔇 マイク OFF";
    micBtn.classList.toggle("off", !on);
    micBtn.setAttribute("aria-pressed", String(on));
  }
  function syncBgUI() {
    blurRange.style.display = bgMode.value === "blur" ? "" : "none";
    bgImageBtn.style.display = bgMode.value === "image" ? "" : "none";
  }

  camBtn.addEventListener("click", () => {
    media.toggleCamera();
    syncCamUI();
  });
  micBtn.addEventListener("click", () => {
    media.toggleMic();
    syncMicUI();
  });

  bgMode.addEventListener("change", async () => {
    const want = bgMode.value;
    bgNote.textContent = want === "none" ? "" : "背景処理を準備中…";
    const res = await media.setBackground(want);
    if (res.error === "segmentation_unavailable") {
      bgMode.value = "none";
      bgNote.textContent = "⚠ 背景処理を読み込めませんでした（ネット環境/対応ブラウザをご確認ください）";
    } else {
      bgNote.textContent = "";
    }
    syncBgUI();
  });

  blurRange.addEventListener("input", () => media.setBlurAmount(blurRange.value));

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
      }
      syncBgUI();
    };
    img.onerror = () => (bgNote.textContent = "⚠ 画像の読み込みに失敗しました");
    img.src = URL.createObjectURL(file);
  });

  syncCamUI();
  syncMicUI();
  syncBgUI();
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

  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "center";
  const label = p.name + (isMe ? "（あなた）" : "");
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.7)"; // 明るい背景でも読めるよう縁取り
  ctx.strokeText(label, p.x, p.y - 24);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, p.x, p.y - 24);
}

function drawFloor() {
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
  ctx.restore();
}

function render() {
  drawFloor();

  // 自分の通話範囲
  ctx.beginPath();
  ctx.arc(me.x, me.y, CALL_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(52, 152, 219, 0.10)";
  ctx.fill();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = "rgba(52, 152, 219, 0.55)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  if (DEBUG) drawDebug();

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

  // 3) メディア（カメラ/マイク/背景効果）を起動。送出ストリーム＝加工後の映像＋マイク
  const media = new MediaController();
  const stream = await media.init();
  if (!media.hasCamera) {
    document.getElementById("status").textContent = "カメラ無し（音声/移動のみ）";
  }
  makeTile("__me__", me.name + "（あなた）", stream, true, true);
  setupControls(media);

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

  // 5) ループ開始
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

if (ICETEST) {
  runIceTestUI();
} else {
  start();
}
