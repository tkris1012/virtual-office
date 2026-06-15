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

const RTC_CONFIG = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    // 本番で企業ファイアウォール配下も確実に繋ぐには、ここに TURN を追加。
    // 例: { urls: "turn:xxx", username: "...", credential: "..." }
  ],
};

export class RTCManager {
  constructor({ db, roomId, myId, localStream, onRemoteStream, onClose }) {
    this.db = db;
    this.roomId = roomId;
    this.myId = myId;
    this.localStream = localStream;
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

  async connectTo(peerId) {
    if (this.peers[peerId]) return;
    const initiator = this.myId < peerId;

    const pc = new RTCPeerConnection(RTC_CONFIG);
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
