const GAME_DURATION_MS = 20_000;
const SLIME_LIFETIME_MS = 1_100;
const GOLD_SLIME_RATE = 0.15;
const HIGH_SCORE_KEY = "vo_slime_game_high_score";

export class SlimeGame {
  constructor({
    modal,
    canvas,
    timeEl,
    scoreEl,
    highScoreEl,
    onFinish = () => {},
    onCancel = () => {},
    onError = () => {},
  }) {
    if (!modal || !canvas || !timeEl || !scoreEl || !highScoreEl) {
      throw new Error("スライムゲームの表示要素が不足しています");
    }

    this.modal = modal;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.timeEl = timeEl;
    this.scoreEl = scoreEl;
    this.highScoreEl = highScoreEl;
    this.onFinish = onFinish;
    this.onCancel = onCancel;
    this.onError = onError;
    this.closeButtons = [...modal.querySelectorAll("[data-game-close]")];

    this.running = false;
    this.score = 0;
    this.highScore = 0;
    this.startedAt = 0;
    this.lastShownSecond = null;
    this.slime = null;
    this.frameId = 0;
    this.logicalWidth = 0;
    this.logicalHeight = 0;

    this.handlePointer = this.handlePointer.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.loop = this.loop.bind(this);
  }

  isPlaying() {
    return this.running;
  }

  start() {
    if (this.running) return false;

    try {
      this.running = true;
      this.score = 0;
      this.highScore = this.readHighScore();
      this.startedAt = performance.now();
      this.lastShownSecond = null;
      this.slime = null;

      this.modal.hidden = false;
      this.resizeCanvas();
      this.updateScore();
      this.updateTime(GAME_DURATION_MS / 1000);
      this.spawnSlime(this.startedAt);
      this.addListeners();
      this.draw();

      requestAnimationFrame(() => {
        if (this.running) this.canvas.focus({ preventScroll: true });
      });
      this.frameId = requestAnimationFrame(this.loop);
      return true;
    } catch (error) {
      this.cleanup();
      this.onError(error);
      return false;
    }
  }

  cancel() {
    if (!this.running) return false;
    this.cleanup();
    this.onCancel();
    return true;
  }

  addListeners() {
    this.canvas.addEventListener("pointerdown", this.handlePointer);
    document.addEventListener("keydown", this.handleKeydown, true);
    window.addEventListener("resize", this.handleResize);
    this.closeButtons.forEach((button) => button.addEventListener("click", this.handleClose));
  }

  removeListeners() {
    this.canvas.removeEventListener("pointerdown", this.handlePointer);
    document.removeEventListener("keydown", this.handleKeydown, true);
    window.removeEventListener("resize", this.handleResize);
    this.closeButtons.forEach((button) => button.removeEventListener("click", this.handleClose));
  }

  cleanup() {
    this.running = false;
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.removeListeners();
    this.slime = null;
    this.modal.hidden = true;
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  finish() {
    if (!this.running) return;

    const score = this.score;
    const previousHighScore = this.readHighScore();
    const highScore = Math.max(previousHighScore, score);
    if (highScore > previousHighScore) this.writeHighScore(highScore);

    this.cleanup();
    this.onFinish({ score, highScore });
  }

  loop(now) {
    if (!this.running) return;

    try {
      const elapsed = now - this.startedAt;
      const remainingMs = Math.max(0, GAME_DURATION_MS - elapsed);
      this.updateTime(Math.ceil(remainingMs / 1000));

      if (remainingMs <= 0) {
        this.finish();
        return;
      }
      if (!this.slime || now - this.slime.spawnedAt >= SLIME_LIFETIME_MS) {
        this.spawnSlime(now);
      }

      this.draw();
      this.frameId = requestAnimationFrame(this.loop);
    } catch (error) {
      this.cleanup();
      this.onError(error);
    }
  }

  handlePointer(event) {
    if (!this.running || !this.slime) return;
    event.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * this.logicalWidth;
    const y = ((event.clientY - rect.top) / rect.height) * this.logicalHeight;
    const distance = Math.hypot(x - this.slime.x, y - this.slime.y);
    if (distance <= this.slime.radius * 1.1) this.hitSlime();
  }

  handleKeydown(event) {
    if (!this.running) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
      return;
    }

    if (
      (event.key === " " || event.key === "Enter") &&
      document.activeElement === this.canvas
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.hitSlime();
      return;
    }

    if (event.key === "Tab") this.trapFocus(event);
  }

  handleResize() {
    if (!this.running) return;
    this.resizeCanvas();
    this.spawnSlime(performance.now());
    this.draw();
  }

  handleClose(event) {
    event.preventDefault();
    this.cancel();
  }

  trapFocus(event) {
    const focusable = [
      this.canvas,
      ...this.modal.querySelectorAll(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      ),
    ].filter((element, index, all) => all.indexOf(element) === index);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  hitSlime() {
    if (!this.running || !this.slime) return;
    this.score += this.slime.gold ? 3 : 1;
    this.updateScore();
    this.spawnSlime(performance.now());
    this.draw();
  }

  spawnSlime(now) {
    const radius = Math.max(24, Math.min(36, this.logicalWidth * 0.075));
    const margin = radius + 12;
    const usableWidth = Math.max(1, this.logicalWidth - margin * 2);
    const usableHeight = Math.max(1, this.logicalHeight - margin * 2);

    this.slime = {
      x: margin + Math.random() * usableWidth,
      y: margin + Math.random() * usableHeight,
      radius,
      gold: Math.random() < GOLD_SLIME_RATE,
      spawnedAt: now,
    };
  }

  resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error("ゲーム盤面を初期化できませんでした");

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.logicalWidth = rect.width;
    this.logicalHeight = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw() {
    const ctx = this.ctx;
    const width = this.logicalWidth;
    const height = this.logicalHeight;

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#18382e");
    gradient.addColorStop(1, "#0d211c");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "rgba(255,255,255,0.035)";
    for (let y = 24; y < height; y += 42) {
      for (let x = 24; x < width; x += 42) {
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (this.slime) this.drawSlime(this.slime);
  }

  drawSlime(slime) {
    const { x, y, radius, gold } = slime;
    const ctx = this.ctx;

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.ellipse(x, y + radius * 0.72, radius * 0.9, radius * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x - radius, y + radius * 0.55);
    ctx.quadraticCurveTo(x - radius * 1.08, y - radius * 0.1, x - radius * 0.55, y - radius * 0.58);
    ctx.quadraticCurveTo(x, y - radius * 1.05, x + radius * 0.55, y - radius * 0.58);
    ctx.quadraticCurveTo(x + radius * 1.08, y - radius * 0.1, x + radius, y + radius * 0.55);
    ctx.quadraticCurveTo(x + radius * 0.45, y + radius * 0.85, x, y + radius * 0.68);
    ctx.quadraticCurveTo(x - radius * 0.45, y + radius * 0.85, x - radius, y + radius * 0.55);
    ctx.closePath();
    ctx.fillStyle = gold ? "#f3c94b" : "#54c779";
    ctx.fill();
    ctx.strokeStyle = gold ? "#fff0a8" : "#a5efb9";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#10231d";
    ctx.beginPath();
    ctx.arc(x - radius * 0.3, y - radius * 0.12, radius * 0.09, 0, Math.PI * 2);
    ctx.arc(x + radius * 0.3, y - radius * 0.12, radius * 0.09, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#10231d";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(x, y + radius * 0.12, radius * 0.2, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();

    if (gold) {
      ctx.fillStyle = "#5b4310";
      ctx.font = `bold ${Math.round(radius * 0.55)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("★", x, y - radius * 0.5);
    }
    ctx.restore();
  }

  updateTime(seconds) {
    if (seconds === this.lastShownSecond) return;
    this.lastShownSecond = seconds;
    this.timeEl.textContent = String(seconds);
  }

  updateScore() {
    this.scoreEl.textContent = String(this.score);
    this.highScoreEl.textContent = String(this.highScore);
  }

  readHighScore() {
    try {
      const value = Number.parseInt(localStorage.getItem(HIGH_SCORE_KEY) || "0", 10);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (_) {
      return 0;
    }
  }

  writeHighScore(score) {
    try {
      localStorage.setItem(HIGH_SCORE_KEY, String(score));
    } catch (_) {
      // 保存できない環境でもゲーム自体は継続する。
    }
  }
}
