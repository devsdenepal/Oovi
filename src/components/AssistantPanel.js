/**
 * AssistantPanel | compact AI chat inside the sidebar AI tab (Goal 4).
 *
 * Selection-aware context chips + suggestions, message log, input, and
 * the proposal card (change list, Apply/Cancel, before/after toggle,
 * follow-up input). All behavior via handlers; no editor/AI imports.
 */

export class AssistantPanel {
  /**
   * @param {HTMLElement} container
   * @param {Object} handlers
   * @param {(message: string) => void} handlers.onSend
   * @param {(sug: {label: string, kind: "ai"|"cmd", text?: string, cmd?: string}) => void} handlers.onSuggestion
   * @param {() => void} handlers.onApply
   * @param {() => void} handlers.onCancel
   * @param {() => void} handlers.onTogglePreview
   * @param {() => void} handlers.onRegenerate
   */
  constructor(container, handlers) {
    this.handlers = handlers;
    this.container = container;
    this.container.classList.add("assistant-panel");
    this.container.innerHTML = `
      <div class="assistant-context" id="asst-context"></div>
      <div class="assistant-suggest" id="asst-suggest"></div>
      <div class="assistant-log" id="asst-log" aria-live="polite"></div>
      <div class="assistant-proposal" id="asst-proposal" hidden></div>
      <div class="assistant-input-row">
        <input id="asst-input" type="text" placeholder="Ask for a change…" maxlength="500" autocomplete="off" />
        <button id="asst-send" class="btn btn-primary btn-sm" title="Send"><i class="fa-solid fa-paper-plane"></i></button>
      </div>
      <button id="asst-regen" class="btn btn-sm btn-light border w-100" title="Replace the whole design (asks first)"><i class="fa-solid fa-rotate-right"></i> Regenerate whole design</button>
    `;
    this.ctxEl = this.container.querySelector("#asst-context");
    this.sugEl = this.container.querySelector("#asst-suggest");
    this.logEl = this.container.querySelector("#asst-log");
    this.proposalEl = this.container.querySelector("#asst-proposal");
    this.input = this.container.querySelector("#asst-input");
    this.sendBtn = this.container.querySelector("#asst-send");
    this.toggleBtn = null;

    const send = () => {
      const v = this.input.value.trim();
      if (!v) return;
      this.input.value = "";
      this.handlers.onSend(v);
    };
    this.sendBtn.addEventListener("click", send);
    this.input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") send();
    });
    this.container.querySelector("#asst-regen").addEventListener("click", () => this.handlers.onRegenerate());
  }

  /**
   * @param {{label: string, suggestions: Array<{label: string, kind: "ai"|"cmd", text?: string, cmd?: string}>}} ctx
   */
  setContext(ctx) {
    this.ctxEl.innerHTML = `<span class="ctx-chip"><i class="fa-solid fa-crosshairs"></i> ${esc(ctx.label)}</span>`;
    this.sugEl.innerHTML = "";
    for (const sug of ctx.suggestions || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm btn-light border sug-btn";
      b.textContent = sug.label;
      b.addEventListener("click", () => this.handlers.onSuggestion(sug));
      this.sugEl.appendChild(b);
    }
  }

  pushUser(text) {
    const div = document.createElement("div");
    div.className = "chat-msg chat-user";
    div.textContent = text;
    this.logEl.appendChild(div);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  pushAssistant(text, kind = "") {
    const div = document.createElement("div");
    div.className = `chat-msg chat-ai${kind ? ` chat-${kind}` : ""}`;
    div.textContent = text;
    this.logEl.appendChild(div);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /**
   * @param {{lines: string[], errors: string[], note: string, source: string}} proposal
   */
  showProposal(proposal) {
    this.proposalEl.hidden = false;
    this.proposalEl.innerHTML = `
      <div class="proposal-card">
        <div class="proposal-title">Proposed changes <span class="ai-tag">AI</span> <span class="muted">· ${esc(proposal.source)}</span></div>
        <ul class="change-list">${proposal.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
        ${proposal.errors.length ? `<div class="proposal-errors">Skipped: ${esc(proposal.errors.join("; "))}</div>` : ""}
        ${proposal.note ? `<div class="muted">${esc(proposal.note)}</div>` : ""}
        <div class="proposal-btns">
          <button class="btn btn-sm btn-primary" data-p="apply">Apply</button>
          <button class="btn btn-sm btn-light border" data-p="cancel">Cancel</button>
          <button class="btn btn-sm btn-light border" data-p="toggle">Show before</button>
        </div>
      </div>`;
    this.toggleBtn = this.proposalEl.querySelector('[data-p="toggle"]');
    this.proposalEl.querySelector('[data-p="apply"]').addEventListener("click", () => this.handlers.onApply());
    this.proposalEl.querySelector('[data-p="cancel"]').addEventListener("click", () => this.handlers.onCancel());
    this.toggleBtn.addEventListener("click", () => this.handlers.onTogglePreview());
    this.proposalEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /** @param {boolean} showingAfter */
  setToggleLabel(showingAfter) {
    if (this.toggleBtn) this.toggleBtn.textContent = showingAfter ? "Show before" : "Show after";
  }

  /** @param {boolean} enabled */
  setToggleEnabled(enabled) {
    if (this.toggleBtn) this.toggleBtn.disabled = !enabled;
  }

  clearProposal() {
    this.proposalEl.hidden = true;
    this.proposalEl.innerHTML = "";
    this.toggleBtn = null;
  }

  /** @param {boolean} busy */
  setBusy(busy) {
    this.sendBtn.disabled = busy;
    this.input.disabled = busy;
    this.input.placeholder = busy ? "Thinking…" : "Ask for a change…";
  }
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
