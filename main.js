// =============================================================
//  メイン: マップ描画 / 移動 / 位置同期(presence) / 近接判定
// =============================================================
import { db, auth } from "./firebase-config.js";
import {
  ref,
  get,
  set,
  update,
  onValue,
  onDisconnect,
  remove,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { RTCManager, getIceServers, runIceTest } from "./rtc.js";
import { MediaController } from "./media.js";

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
const SPEED = 3.2;

// ---- 自分 ----
let myId = null; // 匿名認証の uid を起動時にセット
let meRef = null;
const rand4 = Math.random().toString(36).slice(2, 6);
const defaultName = "user-" + rand4;
let myName = null; // ロビーで確定
const myColor = `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`;

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");

// ---- ワールド（マップ）座標。RTDBで共有する座標系。office2.png の基準サイズ。----
// 既存コード(ゾーン/壁/描画)はワールド座標で書かれているため、名前は W/H のまま固定値にする。
const W = 960; // WORLD_W（office3.png は 16:9）
const H = 540; // WORLD_H

// ---- カメラ（各端末ローカル・通信しない）。アバターを追従しズームしてスクロール表示 ----
const MOBILE = matchMedia("(pointer: coarse)").matches || window.innerWidth < 700;
// ワールドが画面を覆う最小ズーム（これ未満だと黒余白が出る＝全画面表示の下限）
function fitZoom() {
  return Math.max(window.innerWidth / W, window.innerHeight / H);
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

function updateCamera() {
  // アバターへスムーズ追従
  camera.x += (me.x - camera.x) * 0.15;
  camera.y += (me.y - camera.y) * 0.15;
  // マップ外の黒余白を出さないようクランプ（ビューがワールドより大きければ中央寄せ）
  const s = camera.zoom * dpr;
  const halfW = canvas.width / 2 / s;
  const halfH = canvas.height / 2 / s;
  camera.x = halfW * 2 >= W ? W / 2 : Math.max(halfW, Math.min(W - halfW, camera.x));
  camera.y = halfH * 2 >= H ? H / 2 : Math.max(halfH, Math.min(H - halfH, camera.y));
}

// ---- 手動ズーム（PC=ホイール / スマホ=ピンチ）----
function setZoom(z) {
  camera.zoom = Math.max(fitZoom(), Math.min(4, z)); // 下限＝全画面フィット
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
officeImg.src = "office3.png";

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

// ---- エリア（部屋）: 同じエリアにいる人同士は距離に関係なく通話 ----
// 座標は office2.png に合わせた正規化(0..1)。?debug で枠を見ながら調整可。
// エリア通話は会議室だけ。それ以外の部屋は通常の近接通話（青い円）にする。
const ZONES = [
  { id: "meeting", label: "会議室", x: 0.04, y: 0.07, w: 0.23, h: 0.39, rgb: "52,152,219" },
];
function zoneOf(p) {
  for (const z of ZONES) {
    const zx = z.x * W,
      zy = z.y * H,
      zw = z.w * W,
      zh = z.h * H;
    if (p.x >= zx && p.x <= zx + zw && p.y >= zy && p.y <= zy + zh) return z.id;
  }
  return null;
}

const me = {
  x: W * 0.45, // 中央の島デスクあたり
  y: H * 0.5,
  name: "", // ロビー入室時に設定
  color: myColor,
};
camera.x = me.x; // 開始時のカメラを自分に合わせる（追従の初期ジャンプ防止）
camera.y = me.y;
const others = {}; // id -> {x, y, name, color, announcing?, summon?}
let announcing = false; // 全体アナウンス中か（自分）
let lastSummonTs = Date.now(); // 自分が処理済みの最新の集合ts（join前の古い集合は無視）
let media = null; // MediaController（カメラ/マイク/背景/画面共有）
let currentRoomName = ""; // 入室中ルームの表示名（招待リンク生成に使う）
let currentPassphrase = ""; // 入室中ルームの合言葉（招待リンクに埋め込む）

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
  const screenBtn = document.getElementById("btn-screen");
  const bgBtn = document.getElementById("btn-bg");
  const annBtn = document.getElementById("btn-announce");
  const summonBtn = document.getElementById("btn-summon");

  const bgPopover = document.getElementById("bg-popover");
  const summonPanel = document.getElementById("summon-panel");
  const summonList = document.getElementById("summon-list");

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
    summonPanel.hidden = true;
  };

  function syncCamUI() {
    const on = media.cameraOn;
    setIcon(camBtn, on ? "ti-video" : "ti-video-off");
    camBtn.classList.toggle("off", !on);
    camBtn.setAttribute("aria-label", on ? "カメラ オン" : "カメラ オフ");
    // 自分タイルはカメラON時のみ鏡像（OFF/画面共有中はそのまま表示）
    const myTile = videoTiles.get("__me__");
    if (myTile) myTile.classList.toggle("mirror", on && !media.screenOn);
  }
  function syncMicUI() {
    const on = media.micOn;
    setIcon(micBtn, on ? "ti-microphone" : "ti-microphone-off");
    micBtn.classList.toggle("off", !on);
    micBtn.setAttribute("aria-label", on ? "マイク オン" : "マイク オフ");
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

  camBtn.addEventListener("click", () => {
    media.toggleCamera();
    syncCamUI();
  });
  micBtn.addEventListener("click", () => {
    media.toggleMic();
    syncMicUI();
  });

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
  annBtn.addEventListener("click", () => {
    announcing = !announcing;
    annBtn.classList.toggle("active", announcing);
    if (meRef) update(meRef, { announcing });
    toast(announcing ? "全体アナウンスを開始（全員に配信）" : "アナウンスを終了しました");
  });

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

  // --- 集合（特定の人を呼ぶ・ポップオーバー）---
  summonBtn.addEventListener("click", () => {
    const show = summonPanel.hidden;
    closePopovers();
    if (show) {
      renderSummonList(summonList);
      summonPanel.hidden = false;
    }
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

  syncCamUI();
  syncMicUI();
  syncScreenUI();
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
    announcing: false,
    sharing: false,
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
    // 集合（summon）の受信: 自分が対象なら集合地点へワープ
    for (const id in all) {
      if (id === myId) continue;
      const s = all[id].summon;
      if (s && Array.isArray(s.targets) && s.targets.includes(myId) && s.ts > lastSummonTs) {
        lastSummonTs = s.ts;
        me.x = s.x;
        me.y = s.y;
        dirty = true;
        toast(`📍 ${all[id].name || "誰か"} があなたを集合させました`);
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

// ---- 接続判定（エリア / 全体アナウンス / 近接）----
let rtc = null;
function updateConnections() {
  if (!rtc) return;
  const mz = zoneOf(me);
  for (const id in others) {
    const o = others[id];
    const connected = rtc.isConnected(id);
    let want;
    if (announcing || o.announcing) {
      want = true; // アナウンス中は全員と接続
    } else {
      const oz = zoneOf(o);
      if (mz && oz) {
        want = mz === oz; // 同じ部屋にいれば通話
      } else if (!mz && !oz) {
        const d = Math.hypot(o.x - me.x, o.y - me.y);
        want = connected ? d <= HANGUP_RADIUS : d <= CALL_RADIUS; // 屋外は近接＋ヒステリシス
      } else {
        want = false; // 片方だけ部屋の中なら繋がない
      }
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
    let vol;
    if (announcing || o.announcing || (mz && zoneOf(o) === mz)) {
      vol = 1; // 部屋内 / アナウンスは全員フル音量
    } else {
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      vol = Math.max(0, Math.min(1, (HANGUP_RADIUS - d) / (HANGUP_RADIUS - FULL_VOLUME_RADIUS)));
    }
    v.volume = vol;
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
  for (const id in others) if (others[id].announcing) names.push(others[id].name || "誰か");
  if (names.length) {
    banner.hidden = false;
    banner.textContent = "📢 " + names.join("、") + " がアナウンス中";
  } else {
    banner.hidden = true;
  }
}
function renderSummonList(listEl) {
  listEl.innerHTML = "";
  const ids = Object.keys(others);
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
  // 画面クリア（スクリーン座標）
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#11131a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // カメラ変換: 以降は全てワールド座標で描ける（背景画像・ゾーン・アバター）
  const s = camera.zoom * dpr;
  ctx.setTransform(s, 0, 0, s, canvas.width / 2 - camera.x * s, canvas.height / 2 - camera.y * s);

  drawFloor();
  drawZones();

  // 自分の通話範囲（部屋にいる時・アナウンス中は出さない）
  if (!zoneOf(me) && !announcing) {
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

  for (const id in others) {
    drawAvatar(others[id], false, rtc && rtc.isConnected(id));
  }
  drawAvatar(me, true, false);

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
      if (others[id] && others[id].sharing) {
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
      (id === "__me__" && media && media.screenOn) || (others[id] && others[id].sharing);
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

function loop(now) {
  step();
  flushPosition(now || 0);
  updateConnections();
  updateSpatialAudio();
  updateBanner();
  updateShareStage();
  updateCamera();
  render();
  requestAnimationFrame(loop);
}

// ---- 起動 ----
async function start() {
  // 1) 匿名サインイン（uid を自分のIDに使う。入室時に解決済みなら即返る）
  try {
    await ensureSignedIn();
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
  media = new MediaController();
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

async function ensureSignedIn() {
  if (myId) return myId;
  const cred = await signInAnonymously(auth);
  myId = cred.user.uid;
  return myId;
}

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
  await ensureSignedIn();
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
  try {
    if (meRef) await remove(meRef);
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
function wireRoomButtons() {
  const inviteBtn = document.getElementById("btn-invite");
  const leaveBtn = document.getElementById("btn-leave");
  if (inviteBtn) inviteBtn.addEventListener("click", copyInvite);
  if (leaveBtn) leaveBtn.addEventListener("click", leaveRoom);
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
    presets.querySelectorAll("[data-room]").forEach((b) =>
      b.addEventListener("click", () => {
        roomInput.value = b.dataset.room;
        passInput.value = b.dataset.pass || "";
        // data-fixed のルーム(NCM)は名前・合言葉を固定して編集不可にする
        const fixed = b.dataset.fixed === "1";
        roomInput.disabled = fixed;
        passInput.disabled = fixed;
        hideErr();
      })
    );
    const tempBtn = document.getElementById("temp-room");
    if (tempBtn)
      tempBtn.addEventListener("click", () => {
        roomInput.disabled = false;
        passInput.disabled = false;
        roomInput.value = "temp-" + Math.random().toString(36).slice(2, 8);
        passInput.value = "";
      });
  }

  async function doEnter() {
    const name = (nameInput.value || defaultName).slice(0, 16);
    const roomName = (urlRoom || roomInput.value || "").trim();
    const pass = passInput.value.trim();
    hideErr();
    if (!roomName) return showErr("ルーム名を入力してください");
    enterBtn.disabled = true;
    const orig = enterBtn.textContent;
    enterBtn.textContent = "入室中…";
    try {
      const { roomKey, isCreator } = await validateAndEnter({ roomName, pass });
      currentRoomName = roomName;
      currentPassphrase = pass;
      history.replaceState(null, "", `?room=${encodeURIComponent(roomKey)}`);
      lobby.hidden = true;
      enter(roomKey, name, roomName);
      if (isCreator) toast(`ルーム「${roomName}」を作成しました。🔗で招待リンクを共有できます`);
    } catch (err) {
      const code = (err && (err.code || err.message)) || String(err);
      if (err && err.code === "wrong_pass") showErr("合言葉が違います");
      else if (/auth\//i.test(code))
        showErr("サインインに失敗しました。Firebaseで匿名ログインを有効化してください");
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

// ---- 起動の振り分け ----
if (ICETEST) {
  document.getElementById("lobby").hidden = true;
  ROOM = urlRoom || "lobby";
  myName = defaultName;
  me.name = myName;
  document.getElementById("room-label").textContent = ROOM;
  runIceTestUI();
} else {
  wireRoomButtons();
  setupLobby();
}
