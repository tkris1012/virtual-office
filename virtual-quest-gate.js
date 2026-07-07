const GATE_AREA_N = Object.freeze({
  x: 0.385,
  y: 0.865,
  w: 0.18,
  h: 0.105,
});

const DESTINATIONS = Object.freeze([
  {
    id: "outer-edge",
    name: "外縁ゲート",
    status: "開放中",
    state: "open",
    title: "外縁エリア",
    summary: "オフィスのすぐ外。最初の探索地点です。",
    objective: "集中ノイズを払う",
    reward: "ノイズ結晶",
  },
  {
    id: "old-corridor",
    name: "???",
    status: "COMING SOON",
    state: "locked",
    title: "???",
    summary: "まだ行き先の情報を確認できません。",
    objective: "???",
    reward: "???",
  },
  {
    id: "meeting-ruins",
    name: "???",
    status: "COMING SOON",
    state: "locked",
    title: "???",
    summary: "まだ行き先の情報を確認できません。",
    objective: "???",
    reward: "???",
  },
]);

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class VirtualQuestGate {
  constructor({
    worldWidth,
    worldHeight,
    getPlayer,
    getDestinationParticipants,
    clearMovementInput,
    showHud,
    toast,
    canOpen,
  }) {
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;
    this.getPlayer = getPlayer;
    this.getDestinationParticipants = getDestinationParticipants || (() => ({}));
    this.clearMovementInput = clearMovementInput;
    this.showHud = showHud;
    this.toast = toast;
    this.canOpen = canOpen || (() => true);
    this.prompt = null;
    this.modal = null;
    this.destinationsEl = null;
    this.departButton = null;
    this.closeButton = null;
    this.cancelButton = null;
    this.destination = DESTINATIONS[0];
    this.destinationParticipants = {};
  }

  setup() {
    this.prompt = this.createPrompt();
    this.modal = this.createModal();
    document.body.appendChild(this.prompt);
    document.body.appendChild(this.modal);

    this.prompt.querySelector("[data-virtual-quest-open]").addEventListener("click", () => {
      this.openModal();
    });
    this.closeButton.addEventListener("click", () => this.closeModal());
    this.cancelButton.addEventListener("click", () => this.closeModal());
    this.departButton.addEventListener("click", () => this.prepareDeparture());
    this.modal.addEventListener("click", (event) => {
      if (event.target === this.modal) this.closeModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.modal.hidden) {
        event.preventDefault();
        this.closeModal();
        return;
      }
      const target = event.target;
      const isEditing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (
        event.key.toLowerCase() === "f" &&
        this.modal.hidden &&
        this.isPlayerInGate() &&
        this.canOpen() &&
        !event.repeat &&
        !event.isComposing &&
        !isEditing
      ) {
        event.preventDefault();
        this.openModal();
      }
    });
  }

  update() {
    if (!this.prompt || !this.modal || !this.modal.hidden) return;
    this.prompt.hidden = !this.isPlayerInGate();
  }

  draw(ctx, now = performance.now()) {
    const area = this.area();
    const active = this.isPlayerInGate();
    const pulse = 0.5 + Math.sin(now / 420) * 0.5;
    const cx = area.x + area.w / 2;
    const cy = area.y + area.h / 2;

    ctx.save();
    roundedRect(ctx, area.x, area.y, area.w, area.h, 10);
    ctx.fillStyle = active ? "rgba(55, 211, 181, 0.2)" : "rgba(55, 211, 181, 0.11)";
    ctx.fill();
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = active ? 2.8 : 1.8;
    ctx.strokeStyle = active
      ? `rgba(106, 255, 222, ${0.72 + pulse * 0.22})`
      : "rgba(106, 255, 222, 0.52)";
    ctx.stroke();
    ctx.setLineDash([]);

    const gradient = ctx.createRadialGradient(cx, cy, 4, cx, cy, Math.max(area.w, area.h) * 0.55);
    gradient.addColorStop(0, `rgba(94, 239, 255, ${0.24 + pulse * 0.14})`);
    gradient.addColorStop(1, "rgba(94, 239, 255, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(area.x - 18, area.y - 18, area.w + 36, area.h + 36);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 12px sans-serif";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(5, 12, 18, 0.78)";
    ctx.strokeText("外縁ゲート", cx, area.y - 9);
    ctx.fillStyle = active ? "#bfffee" : "#8cebd5";
    ctx.fillText("外縁ゲート", cx, area.y - 9);
    ctx.restore();
  }

  isBlockingOverlayOpen() {
    return !!this.modal && !this.modal.hidden;
  }

  area() {
    return {
      x: GATE_AREA_N.x * this.worldWidth,
      y: GATE_AREA_N.y * this.worldHeight,
      w: GATE_AREA_N.w * this.worldWidth,
      h: GATE_AREA_N.h * this.worldHeight,
    };
  }

  isPlayerInGate() {
    const player = this.getPlayer();
    const area = this.area();
    return (
      player.x >= area.x &&
      player.x <= area.x + area.w &&
      player.y >= area.y &&
      player.y <= area.y + area.h
    );
  }

  openModal() {
    if (!this.modal) return;
    if (!this.canOpen()) return;
    this.setDestinationParticipants(this.getDestinationParticipants());
    this.clearMovementInput();
    this.prompt.hidden = true;
    this.modal.hidden = false;
    document.body.classList.add("virtual-quest-open");
    this.showHud();
    this.departButton.focus({ preventScroll: true });
  }

  closeModal() {
    if (!this.modal) return;
    this.modal.hidden = true;
    document.body.classList.remove("virtual-quest-open");
    this.departButton.disabled = false;
    this.departButton.textContent = "外縁エリアへ出る";
    if (this.isPlayerInGate()) this.prompt.hidden = false;
  }

  setDestinationParticipants(participantsByDestination = {}) {
    this.destinationParticipants = participantsByDestination;
    this.renderDestinations();
  }

  prepareDeparture() {
    this.clearMovementInput();
    this.departButton.disabled = true;
    this.departButton.textContent = "出発準備中...";

    window.dispatchEvent(
      new CustomEvent("virtualquest:prepare-departure", {
        detail: {
          destinationId: this.destination.id,
          destinationName: this.destination.title,
        },
      })
    );

    setTimeout(() => {
      this.closeModal();
      this.toast("外縁エリアへ出発しました");
    }, 450);
  }

  createPrompt() {
    const prompt = document.createElement("div");
    prompt.id = "virtual-quest-prompt";
    prompt.hidden = true;
    prompt.innerHTML = `
      <div class="virtual-quest-prompt-copy">
        <strong>外縁ゲート</strong>
        <span>外の世界へ出られます</span>
      </div>
      <span class="virtual-quest-prompt-key">F</span>
      <button type="button" data-virtual-quest-open>行先を見る</button>
    `;
    return prompt;
  }

  createModal() {
    const modal = document.createElement("div");
    modal.id = "virtual-quest-gate-modal";
    modal.hidden = true;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "virtual-quest-gate-title");
    modal.innerHTML = `
      <section class="virtual-quest-card">
        <header class="virtual-quest-head">
          <div>
            <span class="virtual-quest-kicker">OUTER GATE</span>
            <h2 id="virtual-quest-gate-title">バーチャルクエスト</h2>
          </div>
          <button class="virtual-quest-close" type="button" aria-label="閉じる">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </header>
        <div class="virtual-quest-destinations"></div>
        <div class="virtual-quest-actions">
          <button class="virtual-quest-cancel" type="button">戻る</button>
          <button class="virtual-quest-depart" type="button">外縁エリアへ出る</button>
        </div>
      </section>
    `;
    this.destinationsEl = modal.querySelector(".virtual-quest-destinations");
    this.closeButton = modal.querySelector(".virtual-quest-close");
    this.cancelButton = modal.querySelector(".virtual-quest-cancel");
    this.departButton = modal.querySelector(".virtual-quest-depart");
    this.renderDestinations();
    return modal;
  }

  renderDestinations() {
    if (!this.destinationsEl) return;
    this.destinationsEl.innerHTML = DESTINATIONS.map((destination) =>
      this.destinationMarkup(destination)
    ).join("");
  }

  destinationMarkup(destination) {
    const locked = destination.state !== "open";
    const participants = this.destinationParticipants[destination.id] || [];
    const countLabel = `${participants.length}人`;
    return `
      <article class="virtual-quest-destination${locked ? " locked" : " open"}">
        <div class="virtual-quest-destination-top">
          <strong>${destination.title}</strong>
          <span>${destination.status} / ${countLabel}</span>
        </div>
        <p>${destination.summary}</p>
        <dl>
          <div><dt>目的</dt><dd>${destination.objective}</dd></div>
          <div><dt>報酬</dt><dd>${destination.reward}</dd></div>
        </dl>
        <div class="virtual-quest-participants">
          <div class="virtual-quest-participants-title">参加中</div>
          ${
            participants.length
              ? participants.map((participant) => this.participantMarkup(participant)).join("")
              : '<div class="virtual-quest-empty">現在いません</div>'
          }
        </div>
      </article>
    `;
  }

  participantMarkup(participant) {
    const name = escapeHtml(participant.name || "ゲスト");
    const iconUrl = participant.iconType === "upload" ? participant.iconUrl || "" : "";
    const icon = iconUrl
      ? `<img src="${escapeHtml(iconUrl)}" alt="" />`
      : `<span style="background:${escapeHtml(participant.bg || "#60758a")}">${escapeHtml(
          participant.emoji || "👤"
        )}</span>`;
    return `
      <div class="virtual-quest-participant">
        <div class="virtual-quest-participant-icon">${icon}</div>
        <div class="virtual-quest-participant-name">${name}</div>
      </div>
    `;
  }
}
