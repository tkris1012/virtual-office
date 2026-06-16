// =============================================================
//  メディア制御（PC向け）
//   - カメラ ON/OFF・マイク ON/OFF
//   - 背景ぼかし / バーチャル背景（MediaPipe Selfie Segmentation）
//
//  仕組み: 生カメラ映像を隠し<video>へ → 毎フレーム<canvas>へ描画
//  （素通し / ぼかし / 背景画像 / カメラオフ用プレースホルダ）→
//  canvas.captureStream() の映像トラック＋生マイクトラックを「送出用ストリーム」
//  として常に使う。これにより効果の切替で再ネゴシエーション不要。
// =============================================================

const SEG_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation";

export class MediaController {
  constructor() {
    this.rawStream = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.hasCamera = false;
    this.hasMic = false;

    this.cameraOn = true;
    this.micOn = true;
    this.mode = "none"; // 'none' | 'blur' | 'image'
    this.blurAmount = 8; // px
    this.bgImage = null; // HTMLImageElement / Canvas（バーチャル背景）

    this.W = 640;
    this.H = 480;

    this.seg = null;
    this.segReady = false;
    this.segBusy = false;
    this._segFailed = false;
    this._stopped = false;

    // 画面共有
    this.screenOn = false;
    this.screenStream = null;
    this.screenVideo = null;
    this.onScreenEnd = null; // ブラウザ側の「共有を停止」で呼ばれる
  }

  // ---- 画面共有 ----
  // canvas に画面を描くことで、送出トラック（canvas captureStream）を差し替えず
  // 全ピア（既存・新規とも）に自動反映。再ネゴシエーション不要。
  async startScreenShare() {
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: false,
      });
    } catch (e) {
      return { error: "denied" };
    }
    const track = this.screenStream.getVideoTracks()[0];
    if (!track) return { error: "no_track" };

    this.screenVideo = document.createElement("video");
    this.screenVideo.autoplay = true;
    this.screenVideo.muted = true;
    this.screenVideo.playsInline = true;
    this.screenVideo.setAttribute("playsinline", "");
    this.screenVideo.srcObject = this.screenStream;
    this.screenVideo.play().catch(() => {});

    // 解像度確保のため canvas を画面サイズへ（最大1280x720）。captureStream は追従する。
    const s = track.getSettings();
    this._camW = this.canvas.width;
    this._camH = this.canvas.height;
    this.canvas.width = Math.min(s.width || 1280, 1280);
    this.canvas.height = Math.min(s.height || 720, 720);

    track.addEventListener("ended", () => this.stopScreenShare()); // 「共有を停止」ボタン
    this.screenOn = true;
    return { ok: true };
  }

  stopScreenShare() {
    if (!this.screenOn) return;
    this.screenOn = false;
    if (this.screenStream) this.screenStream.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.screenVideo = null;
    if (this._camW) {
      this.canvas.width = this._camW;
      this.canvas.height = this._camH;
    }
    if (this.onScreenEnd) this.onScreenEnd();
  }

  toggleScreenShare() {
    return this.screenOn ? (this.stopScreenShare(), { ok: true, on: false }) : this.startScreenShare();
  }

  _drawScreen(W, H) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const v = this.screenVideo;
    if (v && v.readyState >= 2 && v.videoWidth) {
      const scale = Math.min(W / v.videoWidth, H / v.videoHeight); // 全体が映るように contain
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    ctx.restore();
  }

  // カメラ/マイク取得 → 処理パイプライン起動 → 送出用ストリームを返す
  async init() {
    const tries = [
      { video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: true },
      { video: true, audio: true },
      { audio: true },
    ];
    for (const c of tries) {
      try {
        this.rawStream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) {
        console.warn("getUserMedia 失敗:", c, e);
      }
    }
    if (!this.rawStream) this.rawStream = new MediaStream();

    this.videoTrack = this.rawStream.getVideoTracks()[0] || null;
    this.audioTrack = this.rawStream.getAudioTracks()[0] || null;
    this.hasCamera = !!this.videoTrack;
    this.hasMic = !!this.audioTrack;

    // 隠しソース映像
    this.srcVideo = document.createElement("video");
    this.srcVideo.autoplay = true;
    this.srcVideo.muted = true;
    this.srcVideo.playsInline = true;
    this.srcVideo.setAttribute("playsinline", "");
    this.srcVideo.srcObject = this.rawStream;
    // play() は待たない: カメラ無し（空ストリーム）だと解決せず init が固まるため。
    // 描画ループ側で readyState を見てから描くので await 不要。
    this.srcVideo.play().catch(() => {});

    if (this.videoTrack) {
      const s = this.videoTrack.getSettings();
      if (s.width && s.height) {
        this.W = s.width;
        this.H = s.height;
      }
    }

    // 出力キャンバス
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext("2d");
    this.bgImage = this._defaultBg(); // 既定のバーチャル背景（未アップロード時）

    // 送出用ストリーム = 加工後の映像 ＋ 生マイク
    this.canvasStream = this.canvas.captureStream(30);
    this.outVideoTrack = this.canvasStream.getVideoTracks()[0] || null;
    this.outputStream = new MediaStream();
    if (this.outVideoTrack) this.outputStream.addTrack(this.outVideoTrack);
    if (this.audioTrack) this.outputStream.addTrack(this.audioTrack);

    this._loop();
    return this.outputStream;
  }

  // ---- カメラ / マイク ----
  setCamera(on) {
    this.cameraOn = on;
    if (this.videoTrack) this.videoTrack.enabled = on; // カメラのランプも消える
    return this.cameraOn;
  }
  toggleCamera() {
    return this.setCamera(!this.cameraOn);
  }

  setMic(on) {
    this.micOn = on;
    if (this.audioTrack) this.audioTrack.enabled = on; // 相手へ自動反映（再ネゴ不要）
    return this.micOn;
  }
  toggleMic() {
    return this.setMic(!this.micOn);
  }

  // ---- 背景 ----
  // mode: 'none' | 'blur' | 'image'。image 指定時は第2引数で画像差し替え可。
  // セグメンテーション未対応/読込失敗時は 'none' に戻して error を返す。
  async setBackground(mode, image) {
    if (image !== undefined && image !== null) this.bgImage = image;
    if (mode === "blur" || mode === "image") {
      const ok = await this._ensureSeg();
      if (!ok) {
        this.mode = "none";
        return { mode: "none", error: "segmentation_unavailable" };
      }
    }
    this.mode = mode;
    return { mode };
  }
  setBlurAmount(px) {
    this.blurAmount = Math.max(0, +px || 0);
  }

  // ---- MediaPipe（遅延ロード）----
  async _ensureSeg() {
    if (this.segReady) return true;
    if (this._segFailed) return false;
    try {
      await loadScript(`${SEG_CDN}/selfie_segmentation.js`);
      const SS = window.SelfieSegmentation;
      if (!SS) throw new Error("SelfieSegmentation 未定義");
      this.seg = new SS({ locateFile: (f) => `${SEG_CDN}/${f}` });
      this.seg.setOptions({ modelSelection: 1, selfieMode: false });
      this.seg.onResults((r) => this._onSeg(r));
      this.segReady = true;
      return true;
    } catch (e) {
      console.warn("Selfie Segmentation 読み込み失敗:", e);
      this._segFailed = true;
      return false;
    }
  }

  _onSeg(results) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    // 1) 人物マスクを描く → source-in で人物だけ残す
    ctx.drawImage(results.segmentationMask, 0, 0, W, H);
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(results.image, 0, 0, W, H);
    // 2) 背景を人物の後ろに敷く
    ctx.globalCompositeOperation = "destination-over";
    if (this.mode === "image" && this.bgImage) {
      this._drawCover(this.bgImage, W, H);
    } else {
      ctx.filter = `blur(${this.blurAmount}px)`;
      ctx.drawImage(results.image, 0, 0, W, H);
      ctx.filter = "none";
    }
    ctx.restore();
  }

  _drawCover(img, W, H) {
    const iw = img.videoWidth || img.naturalWidth || img.width || 0;
    const ih = img.videoHeight || img.naturalHeight || img.height || 0;
    if (!iw || !ih) {
      this.ctx.fillStyle = "#1b2030";
      this.ctx.fillRect(0, 0, W, H);
      return;
    }
    const scale = Math.max(W / iw, H / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    this.ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  _drawPlaceholder() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const u = Math.min(W, H);
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.fillStyle = "#0e1320";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#2a3550";
    ctx.beginPath();
    ctx.arc(W / 2, H / 2 - u * 0.06, u * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#9fb0d0";
    ctx.font = `${Math.round(u * 0.08)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.hasCamera ? "カメラオフ" : "カメラなし", W / 2, H / 2 + u * 0.22);
    ctx.restore();
  }

  _defaultBg() {
    // 既定のバーチャル背景（落ち着いたグラデーション）
    const c = document.createElement("canvas");
    c.width = this.W;
    c.height = this.H;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, c.width, c.height);
    grad.addColorStop(0, "#22324f");
    grad.addColorStop(1, "#0e1320");
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  _loop() {
    const tick = async () => {
      if (this._stopped) return;
      const ctx = this.ctx;
      const W = this.canvas.width;
      const H = this.canvas.height;
      try {
        if (this.screenOn) {
          this._drawScreen(W, H);
        } else if (!this.cameraOn || !this.hasCamera) {
          this._drawPlaceholder();
        } else if (this.mode === "none" || !this.segReady) {
          if (this.srcVideo.readyState >= 2) ctx.drawImage(this.srcVideo, 0, 0, W, H);
        } else if (!this.segBusy && this.srcVideo.readyState >= 2) {
          // ぼかし / バーチャル背景（onResults 内で描画）
          this.segBusy = true;
          await this.seg.send({ image: this.srcVideo });
          this.segBusy = false;
        }
      } catch (e) {
        this.segBusy = false;
      }
      setTimeout(() => requestAnimationFrame(tick), 1000 / 30); // 約30fps
    };
    requestAnimationFrame(tick);
  }

  stop() {
    this._stopped = true;
    if (this.rawStream) this.rawStream.getTracks().forEach((t) => t.stop());
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("script load failed: " + src));
    document.head.appendChild(s);
  });
}
