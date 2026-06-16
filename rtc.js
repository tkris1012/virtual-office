// =============================================================
//  WebRTC マネージャ
//  Realtime Database をシグナリング経路として、近接した相手と
//  P2P の映像/音声接続を確立・切断する。
//
//  グレア(衝突)回避: ID が小さい方を発信者(initiator)に固定。
//  接続ごとのシグナリングは rooms/{room}/connections/{connId} 配下。
// =============================================================
import {
  ref,
  set,
  onValue,
  onChildAdded,
  push,
  remove,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ── ICE / TURN 設定 ─────────────────────────────────────────
// 相手の映像が黒い＝多くの場合「TURN 中継が無い」こと。STUN だけでは
// AP分離・CGNAT・厳しいFW配下で P2P 直結できず、ICE が checking で止まる。
// （旧 openrelay の固定資格 `openrelayproject` は 2026 時点で廃止＝API Key 必須に
//   なり、relay 候補ゼロ・code=701 になるため削除した。）
//
// 動く TURN を下のどちらかで設定する（両方空なら STUN のみ＝従来動作）。
//
//  方法A) Metered の動的取得（推奨・無料 20GB/月）
//    1) https://dashboard.metered.ca/ で無料登録
//    2) アプリのサブドメイン（例 myapp → https://myapp.metered.live）と API Key を取得
//    3) METERED に記入 → 起動時に最新の iceServers を自動取得する
//
//  方法B) 静的な資格情報を直接貼る（Twilio / 自前 coturn / その他の TURN）
//    STATIC_TURN に { urls:[...], username, credential } を追記する
//
// 検証: URL に ?icetest を付けて開くと relay 候補が出るか画面で確認できる。
//       ?relay を付けると TURN 経由のみ(relay-only)で接続テストできる。
const STUN_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

// 方法A: Metered 動的取得（使う場合のみ埋める）
const METERED = {
  subdomain: "", // 例: "myapp"
  apiKey: "", // ダッシュボードの API Key
};

// 方法B: 静的TURN（使う場合のみ。複数可）
const STATIC_TURN = [
  // {
  //   urls: ["turn:turn.example.com:3478", "turn:turn.example.com:443?transport=tcp"],
  //   username: "user",
  //   credential: "pass",
  // },
];

// ?relay で relay-only（TURN 経由のみ）強制 → TURN が効いているかの切り分け用
const ICE_TRANSPORT_POLICY = new URLSearchParams(location.search).has("relay")
  ? "relay"
  : "all";

// iceServers は起動時に一度だけ解決してキャッシュする（Metered は非同期取得のため）
let _iceServersPromise = null;
export function getIceServers() {
  if (!_iceServersPromise) _iceServersPromise = resolveIceServers();
  return _iceServersPromise;
}

async function resolveIceServers() {
  const servers = [...STUN_SERVERS, ...STATIC_TURN];
  if (METERED.subdomain && METERED.apiKey) {
    try {
      const url = `https://${METERED.subdomain}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(
        METERED.apiKey
      )}`;
      const res = await fetch(url);
      if (res.ok) {
        const fetched = await res.json();
        if (Array.isArray(fetched) && fetched.length) servers.push(...fetched);
      } else {
        console.warn("Metered TURN 取得失敗:", res.status);
      }
    } catch (e) {
      console.warn("Metered TURN 取得エラー:", e);
    }
  }
  return servers;
}

// ICE 候補テスト: 設定中の iceServers で host/srflx/relay 候補が出るか確認する。
// relay が 1 件以上出れば TURN は正常。?icetest 画面（main.js）から呼ぶ。
export async function runIceTest(iceServers, ms = 8000) {
  const pc = new RTCPeerConnection({ iceServers });
  const types = {};
  const errors = [];
  pc.createDataChannel("t");
  pc.onicecandidate = (e) => {
    const cand = e.candidate && e.candidate.candidate;
    if (cand) {
      const parts = cand.split(" ");
      const t = parts[parts.indexOf("typ") + 1];
      types[t] = (types[t] || 0) + 1;
    }
  };
  pc.onicecandidateerror = (e) =>
    errors.push((e.url || "") + " code=" + e.errorCode + " " + (e.errorText || ""));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, ms));
  pc.close();
  return { types, errors };
}

export class RTCManager {
  constructor({ db, roomId, myId, localStream, iceServers, onRemoteStream, onClose }) {
    this.db = db;
    this.roomId = roomId;
    this.myId = myId;
    this.localStream = localStream;
    this.iceServers = iceServers || []; // 起動時に getIceServers() で解決済みのもの
    this.onRemoteStream = onRemoteStream;
    this.onClose = onClose;
    this.peers = {}; // peerId -> { pc, unsubs: [] }
  }

  _connId(peerId) {
    return [this.myId, peerId].sort().join("__");
  }
  _ref(peerId, sub) {
    const base = `rooms/${this.roomId}/connections/${this._connId(peerId)}`;
    return ref(this.db, sub ? `${base}/${sub}` : base);
  }

  isConnected(peerId) {
    return !!this.peers[peerId];
  }

  // 診断用: 接続状態と RTCPeerConnection を返す
  getDiag(peerId) {
    const e = this.peers[peerId];
    if (!e) return null;
    return { conn: e.pc.connectionState, ice: e.pc.iceConnectionState, pc: e.pc };
  }

  async connectTo(peerId) {
    if (this.peers[peerId]) return;
    const initiator = this.myId < peerId;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: ICE_TRANSPORT_POLICY,
    });
    const entry = { pc, unsubs: [] };
    this.peers[peerId] = entry; // 二重接続防止のため即登録

    // 発信側は古い残骸を消してクリーンに開始
    if (initiator) {
      await remove(this._ref(peerId)).catch(() => {});
    }

    // ローカルトラックを送出
    this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));

    // 相手の映像/音声を受信
    pc.ontrack = (e) => {
      if (this.onRemoteStream) this.onRemoteStream(peerId, e.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        this.disconnectFrom(peerId);
      }
    };

    // ICE 候補の交換
    const myCandRef = this._ref(peerId, `candidates/${this.myId}`);
    pc.onicecandidate = (e) => {
      if (e.candidate) push(myCandRef, e.candidate.toJSON());
    };
    const theirCandRef = this._ref(peerId, `candidates/${peerId}`);
    entry.unsubs.push(
      onChildAdded(theirCandRef, (snap) => {
        const c = snap.val();
        if (c) pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      })
    );

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(this._ref(peerId, "offer"), { type: offer.type, sdp: offer.sdp });

      entry.unsubs.push(
        onValue(this._ref(peerId, "answer"), async (snap) => {
          const ans = snap.val();
          if (ans && !pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(ans));
          }
        })
      );
    } else {
      entry.unsubs.push(
        onValue(this._ref(peerId, "offer"), async (snap) => {
          const off = snap.val();
          if (off && !pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(off));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await set(this._ref(peerId, "answer"), {
              type: answer.type,
              sdp: answer.sdp,
            });
          }
        })
      );
    }
  }

  disconnectFrom(peerId) {
    const entry = this.peers[peerId];
    if (!entry) return;
    delete this.peers[peerId];
    entry.unsubs.forEach((u) => {
      try {
        u();
      } catch (_) {}
    });
    try {
      entry.pc.close();
    } catch (_) {}
    remove(this._ref(peerId)).catch(() => {});
    if (this.onClose) this.onClose(peerId);
  }

  disconnectAll() {
    Object.keys(this.peers).forEach((p) => this.disconnectFrom(p));
  }
}
