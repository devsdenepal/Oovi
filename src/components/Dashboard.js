/**
 * Home dashboard: a focused workspace for starting and finding designs.
 *
 * The dashboard is deliberately self-sufficient: it owns its chrome, its
 * project list and the small amount of view state needed to filter that list.
 * Generation and editing still happen in the editor; cards open there in a
 * new tab. No AI call is made here.
 */

import { projects } from "../storage/projects";
import { DEFAULT_PRESET_ID, getPreset } from "../design/presets";
import { editorUrl } from "../ui/router";
import { titleFromPrompt } from "../ui/designTitle";
import { formatForCanvas } from "../ui/designMeta";
import { notify } from "../ui/toasts";

const PENDING_KEY = "oovi.pendingPrompt";
const SIDEBAR_KEY = "oovi.dashSidebar";
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CANVAS = 64;
const MAX_CANVAS = 4096;

const PROMPT_EXAMPLES = [
  "A Hacktoberfest 2026 banner for our developer community…",
  "A launch post for a quiet, premium skincare brand…",
  "An event poster for a weekend design conference…",
  "A hiring story for a remote design studio…",
  "A brand board for a warm, editorial coffee roaster…",
];

const TYPE_MS = 34;
const DELETE_MS = 18;
const HOLD_MS = 2100;
const EXAMPLE_GAP_MS = 420;

const A4 = {
  id: "poster-a4",
  label: "Poster A4",
  width: 2480,
  height: 3508,
  hint: "Print",
};

const WORKSPACE_PRESETS = [
  { id: "facebook-post", label: "Feed", hint: "1.91:1" },
  { id: "facebook-square", label: "Square", hint: "1:1" },
  { id: "instagram-portrait", label: "Portrait", hint: "4:5" },
  { id: "story", label: "Story", hint: "9:16" },
  { id: "x-post", label: "Banner", hint: "16:9" },
  { id: "poster-a4", label: "A4", hint: "Print" },
  { id: "custom", label: "Custom", hint: "Size" },
];

function presetFor(id) {
  if (id === "poster-a4") return A4;
  if (id === "custom") return null;
  return getPreset(id);
}

function frameSize(width, height) {
  const maxW = 30;
  const maxH = 24;
  const ratio = width / height;
  if (ratio >= maxW / maxH) return { width: maxW, height: Math.max(6, Math.round(maxW / ratio)) };
  return { width: Math.max(6, Math.round(maxH * ratio)), height: maxH };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

function fullDate(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function dimensionsLabel(row) {
  const width = Number(row.canvas_width);
  const height = Number(row.canvas_height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
  return `${width} × ${height}`;
}

function emptyArt() {
  return `
    <svg class="dash-empty-art" viewBox="0 0 220 150" fill="none" aria-hidden="true">
      <rect x="29" y="21" width="120" height="92" rx="6" fill="#E5E2D8" stroke="#C9C5B8"/>
      <rect x="43" y="35" width="120" height="92" rx="6" fill="#FFFFFF" stroke="#C9C5B8"/>
      <rect x="57" y="49" width="120" height="92" rx="6" fill="#FFFFFF" stroke="#15171A"/>
      <rect x="71" y="64" width="47" height="7" rx="3.5" fill="#15171A"/>
      <rect x="71" y="78" width="76" height="4" rx="2" fill="#C9C5B8"/>
      <rect x="71" y="87" width="61" height="4" rx="2" fill="#C9C5B8"/>
      <rect x="71" y="107" width="34" height="17" rx="4" fill="#D9480F"/>
      <rect x="112" y="107" width="34" height="17" rx="4" fill="#DDF2EE" stroke="#0F766E"/>
      <circle cx="176" cy="46" r="15" fill="#DDF2EE" stroke="#0F766E"/>
      <path d="M176 38v16M168 46h16" stroke="#0F766E" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
}

export class Dashboard {
  constructor(container) {
    this.container = container;
    this.list = [];
    this.trash = [];
    this.state = "loading";
    this.error = "";
    this.filter = "all";
    this.query = "";
    this.sort = "updated";
    this.presetId = DEFAULT_PRESET_ID;
    this.customWidth = 1200;
    this.customHeight = 630;
    this.refreshToken = 0;
    this.promptExampleIndex = 0;
    this.promptChar = 0;
    this.promptDeleting = false;
    this.promptTimer = null;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.container.classList.add("dash");
    this.container.innerHTML = `
      <button class="dash-scrim" type="button" data-dash="close-sidebar" aria-label="Close navigation"></button>

      <aside class="dash-sidebar" aria-label="Workspace navigation">
        <div class="dash-side-head">
          <a class="dash-brand" href="#/" aria-label="Oovi Studio home">
            <span class="dash-brand-mark" aria-hidden="true"><i class="fa-solid fa-pen-nib"></i></span>
            <span class="dash-brand-text"><strong>Oovi</strong><small>Studio</small></span>
          </a>
          <button class="dash-icon-btn dash-side-close" type="button" data-dash="close-sidebar" title="Close navigation" aria-label="Close navigation">
            <i class="fa-solid fa-xmark"></i>
          </button>
          <button class="dash-icon-btn dash-side-toggle" type="button" data-dash="toggle-sidebar" title="Collapse sidebar" aria-label="Collapse sidebar" aria-expanded="true">
            <i class="fa-solid fa-angles-left"></i>
          </button>
        </div>

        <nav class="dash-nav" aria-label="Design views">
          <p class="dash-nav-label">Workspace</p>
          <button type="button" data-filter="all" class="is-active" aria-pressed="true" aria-label="All designs" title="All designs">
            <i class="fa-solid fa-shapes" aria-hidden="true"></i><span>All designs</span><b data-count="all">0</b>
          </button>
          <button type="button" data-filter="recent" aria-pressed="false" aria-label="Recent designs" title="Recent designs">
            <i class="fa-solid fa-clock" aria-hidden="true"></i><span>Recent</span><b data-count="recent">0</b>
          </button>
          <button type="button" data-filter="trash" aria-pressed="false" aria-label="Trash" title="Trash">
            <i class="fa-solid fa-trash-can" aria-hidden="true"></i><span>Trash</span><b data-count="trash">0</b>
          </button>
        </nav>

        <div class="dash-side-spacer"></div>
        <div class="dash-side-foot">
          <div class="dash-local">
            <span><strong>Private workspace</strong><small>Your designs stay on this device</small></span>
          </div>
          <p class="dash-side-note">Editable text, shapes and images. Your designs stay editable from canvas to export.</p>
        </div>
      </aside>

      <main class="dash-main">
        <header class="dash-top">
          <button class="dash-icon-btn dash-menu" type="button" data-dash="toggle-sidebar" title="Open navigation" aria-label="Open navigation" aria-expanded="false">
            <i class="fa-solid fa-bars" aria-hidden="true"></i>
          </button>
          <a class="dash-top-brand" href="#/" aria-label="Oovi Studio home">
            <i class="fa-solid fa-pen-nib" aria-hidden="true"></i>
          </a>
          <div class="dash-crumb">
            <span>Workspace</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i><strong data-view-title>All designs</strong>
          </div>
          <label class="dash-search">
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <input id="dash-search" type="search" placeholder="Search designs" autocomplete="off" spellcheck="false" aria-label="Search designs" />
            <kbd>/</kbd>
          </label>
          <div class="dash-top-actions">
            <button class="dash-new" type="button" data-dash="focus"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>New design</span></button>
          </div>
        </header>

        <div class="dash-scroll">
          <section class="dash-hero" aria-labelledby="dash-hero-title">
            <div class="dash-hero-copy">
              <p class="dash-kicker">Design workspace</p>
              <h1 id="dash-hero-title">Start with an idea.<br /><span>Leave with layers.</span></h1>
              <p class="dash-sub">Describe what you need. Oovi turns your idea into an editable design, not a flat picture.</p>
            </div>

            <div class="dash-composer">
              <div class="dash-composer-top">
                <span class="dash-output"><i class="fa-solid fa-layer-group" aria-hidden="true"></i> Editable text and graphics</span>
              </div>
              <div class="dash-prompt-wrap">
                <textarea id="dash-prompt" rows="4" maxlength="500" placeholder="${escapeHtml(PROMPT_EXAMPLES[0])}" aria-label="Design brief"></textarea>
                <span class="dash-char" id="dash-char">0 / 500</span>
              </div>

              <div class="dash-composer-bottom">
                <div class="dash-presets" id="dash-presets" role="group" aria-label="Design format"></div>
                <button class="dash-generate" type="button" data-dash="create">
                  <span>Generate layers</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
                </button>
              </div>

              <div class="dash-custom" id="dash-custom" hidden>
                <label for="dash-width">W <input id="dash-width" type="number" min="${MIN_CANVAS}" max="${MAX_CANVAS}" step="1" value="${this.customWidth}" inputmode="numeric" /></label>
                <span aria-hidden="true">×</span>
                <label for="dash-height">H <input id="dash-height" type="number" min="${MIN_CANVAS}" max="${MAX_CANVAS}" step="1" value="${this.customHeight}" inputmode="numeric" /></label>
                <span class="dash-custom-note">${MIN_CANVAS} to ${MAX_CANVAS} px</span>
              </div>
              <p class="dash-composer-status" id="dash-composer-status" role="status"></p>
            </div>
          </section>

          <section class="dash-library" aria-labelledby="dash-library-title">
            <div class="dash-library-head">
              <div>
                <h2 id="dash-library-title" data-view-title>All designs</h2>
                <p data-view-sub>Every canvas in this workspace</p>
              </div>
              <label class="dash-sort">
                <span>Sort</span>
                <select id="dash-sort" aria-label="Sort designs">
                  <option value="updated">Last edited</option>
                  <option value="created">Newest</option>
                  <option value="title">Name</option>
                </select>
              </label>
            </div>

            <div class="dash-filter-row">
              <div class="dash-chips" role="group" aria-label="Filter designs">
                <button type="button" class="dash-chip is-active" data-filter="all" aria-pressed="true">All designs</button>
                <button type="button" class="dash-chip" data-filter="recent" aria-pressed="false">Recent</button>
                <button type="button" class="dash-chip" data-filter="trash" aria-pressed="false">Trash</button>
              </div>
              <span class="dash-result" data-result-count></span>
            </div>

            <div id="dash-status" class="dash-status" role="status"></div>
            <div class="dash-grid" id="dash-grid"></div>
            <div class="dash-empty" id="dash-empty" hidden></div>
            <div class="dash-trash-row" id="dash-trash-row" hidden>
              <button class="dash-quiet danger" type="button" data-dash="empty-trash"><i class="fa-solid fa-trash-can" aria-hidden="true"></i> Empty trash</button>
            </div>
          </section>
        </div>
      </main>
    `;

    this.grid = this.container.querySelector("#dash-grid");
    this.empty = this.container.querySelector("#dash-empty");
    this.status = this.container.querySelector("#dash-status");
    this.composerStatus = this.container.querySelector("#dash-composer-status");
    this.presetsEl = this.container.querySelector("#dash-presets");
    this.customEl = this.container.querySelector("#dash-custom");
    this.prompt = this.container.querySelector("#dash-prompt");
    this.charCount = this.container.querySelector("#dash-char");
    this.search = this.container.querySelector("#dash-search");
    this.sortSelect = this.container.querySelector("#dash-sort");
    this.widthInput = this.container.querySelector("#dash-width");
    this.heightInput = this.container.querySelector("#dash-height");
    this.generateBtn = this.container.querySelector('[data-dash="create"]');
    this.trashRow = this.container.querySelector("#dash-trash-row");

    this.renderPresets();
    this.bindEvents();
    this.startPromptPlaceholder();
    this.restoreSidebar();
    this.refresh();
  }

  bindEvents() {
    this.container.addEventListener("click", (event) => {
      const filterBtn = event.target.closest("[data-filter]");
      if (filterBtn) {
        this.setFilter(filterBtn.dataset.filter);
        return;
      }

      const presetBtn = event.target.closest("[data-preset]");
      if (presetBtn) {
        this.setPreset(presetBtn.dataset.preset);
        return;
      }

      const action = event.target.closest("[data-dash]")?.dataset.dash;
      if (action === "focus") {
        this.prompt.focus();
        this.closeMobileSidebar();
        return;
      }
      if (action === "create") {
        this.create();
        return;
      }
      if (action === "toggle-sidebar") {
        this.toggleSidebar();
        return;
      }
      if (action === "close-sidebar") {
        this.closeMobileSidebar();
        return;
      }
      if (action === "retry") {
        this.refresh();
        return;
      }
      if (action === "clear-search") {
        this.search.value = "";
        this.query = "";
        this.render();
        this.search.focus();
        return;
      }
      if (action === "empty-trash") {
        this.emptyTrash();
        return;
      }

      const cardAction = event.target.closest("[data-act]");
      if (cardAction) {
        const card = cardAction.closest("[data-card-id]");
        if (card && cardAction.dataset.act === "rename") {
          this.rename(card, card.dataset.cardId);
        } else if (card) {
          this.cardAction(cardAction.dataset.act, card.dataset.cardId, card.dataset.trash === "1");
        }
        return;
      }

      const open = event.target.closest("[data-open]");
      if (open) {
        const card = open.closest("[data-card-id]");
        if (card) this.open(card.dataset.cardId);
      }
    });

    this.prompt.addEventListener("input", () => {
      this.charCount.textContent = `${this.prompt.value.length} / 500`;
      this.composerStatus.textContent = "";
      this.composerStatus.className = "dash-composer-status";
      this.syncPromptPlaceholder();
    });

    this.prompt.addEventListener("focus", () => {
      this.pausePromptPlaceholder();
      if (!this.prompt.value) this.prompt.placeholder = PROMPT_EXAMPLES[this.promptExampleIndex];
    });

    this.prompt.addEventListener("blur", () => {
      if (!this.prompt.value) this.restartPromptPlaceholder();
    });

    this.prompt.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        this.create();
      }
    });

    this.search.addEventListener("input", () => {
      this.query = this.search.value;
      this.render();
    });

    this.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.search.value = "";
        this.query = "";
        this.render();
        this.search.blur();
      }
    });

    this.sortSelect.addEventListener("change", () => {
      this.sort = this.sortSelect.value;
      this.render();
    });

    this.widthInput.addEventListener("input", () => {
      this.customWidth = Number(this.widthInput.value) || 0;
      this.setComposerStatus("");
    });
    this.heightInput.addEventListener("input", () => {
      this.customHeight = Number(this.heightInput.value) || 0;
      this.setComposerStatus("");
    });

    this.container.addEventListener("dblclick", (event) => {
      const title = event.target.closest(".dash-title");
      const card = title?.closest("[data-card-id]");
      if (title && card) this.rename(card, card.dataset.cardId);
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.container.classList.contains("dash-side-open")) {
        this.closeMobileSidebar();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        this.search.focus();
        this.search.select();
      } else if (event.key === "/" && !this.isTyping(event.target)) {
        event.preventDefault();
        this.search.focus();
      }
    });

    window.addEventListener("resize", () => {
      if (window.matchMedia("(min-width: 901px)").matches) this.closeMobileSidebar();
    });

    this.reducedMotion.addEventListener("change", () => {
      if (this.reducedMotion.matches) {
        this.pausePromptPlaceholder();
        this.prompt.placeholder = PROMPT_EXAMPLES[this.promptExampleIndex];
      } else if (!this.prompt.value && document.activeElement !== this.prompt) {
        this.startPromptPlaceholder();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.pausePromptPlaceholder();
      } else if (!this.prompt.value && document.activeElement !== this.prompt) {
        this.startPromptPlaceholder();
      }
    });
  }

  startPromptPlaceholder() {
    this.pausePromptPlaceholder();
    if (this.reducedMotion.matches) {
      this.prompt.placeholder = PROMPT_EXAMPLES[this.promptExampleIndex];
      return;
    }
    if (this.prompt.value || document.activeElement === this.prompt) {
      this.prompt.placeholder = PROMPT_EXAMPLES[this.promptExampleIndex];
      return;
    }

    // Begin with the current example visible, then let the loop delete it
    // and type the next one. This avoids a flash of empty placeholder text.
    const example = PROMPT_EXAMPLES[this.promptExampleIndex];
    this.promptChar = example.length;
    this.promptDeleting = true;
    this.prompt.placeholder = example;
    this.promptTimer = window.setTimeout(() => this.tickPromptPlaceholder(), HOLD_MS);
  }

  restartPromptPlaceholder() {
    this.pausePromptPlaceholder();
    if (this.reducedMotion.matches) {
      this.prompt.placeholder = PROMPT_EXAMPLES[this.promptExampleIndex];
      return;
    }
    this.promptExampleIndex = (this.promptExampleIndex + 1) % PROMPT_EXAMPLES.length;
    this.promptChar = 0;
    this.promptDeleting = false;
    this.prompt.placeholder = "";
    this.promptTimer = window.setTimeout(() => this.tickPromptPlaceholder(), EXAMPLE_GAP_MS);
  }

  tickPromptPlaceholder() {
    this.promptTimer = null;
    if (this.reducedMotion.matches) {
      this.prompt.placeholder = PROMPT_EXAMPLES[this.promptExampleIndex];
      return;
    }
    if (this.prompt.value || document.activeElement === this.prompt || document.hidden) {
      this.promptTimer = window.setTimeout(() => this.tickPromptPlaceholder(), 500);
      return;
    }

    const example = PROMPT_EXAMPLES[this.promptExampleIndex];
    if (this.promptDeleting) {
      this.promptChar = Math.max(0, this.promptChar - 1);
      this.prompt.placeholder = example.slice(0, this.promptChar);
      if (this.promptChar === 0) {
        this.promptDeleting = false;
        this.promptExampleIndex = (this.promptExampleIndex + 1) % PROMPT_EXAMPLES.length;
        this.promptTimer = window.setTimeout(() => this.tickPromptPlaceholder(), EXAMPLE_GAP_MS);
      } else {
        this.promptTimer = window.setTimeout(() => this.tickPromptPlaceholder(), DELETE_MS);
      }
      return;
    }

    this.promptChar = Math.min(example.length, this.promptChar + 1);
    this.prompt.placeholder = example.slice(0, this.promptChar);
    if (this.promptChar >= example.length) {
      this.promptDeleting = true;
      this.promptTimer = window.setTimeout(() => this.tickPromptPlaceholder(), HOLD_MS);
    } else {
      this.promptTimer = window.setTimeout(() => this.tickPromptPlaceholder(), TYPE_MS);
    }
  }

  pausePromptPlaceholder() {
    if (this.promptTimer !== null) {
      window.clearTimeout(this.promptTimer);
      this.promptTimer = null;
    }
  }

  syncPromptPlaceholder() {
    this.pausePromptPlaceholder();
    if (this.prompt.value) return;
    this.prompt.placeholder = PROMPT_EXAMPLES[this.promptExampleIndex];
  }

  isTyping(target) {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable
    );
  }

  restoreSidebar() {
    let collapsed = false;
    try {
      collapsed = window.localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch {
      collapsed = false;
    }
    this.container.classList.toggle("dash-side-collapsed", collapsed);
    this.updateSidebarButtons();
  }

  updateSidebarButtons() {
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    const expanded = mobile
      ? this.container.classList.contains("dash-side-open")
      : !this.container.classList.contains("dash-side-collapsed");
    this.container.querySelectorAll('[data-dash="toggle-sidebar"]').forEach((button) => {
      button.setAttribute("aria-expanded", String(expanded));
      button.title = expanded ? "Collapse sidebar" : "Open sidebar";
      const icon = button.querySelector("i");
      if (icon && !mobile) {
        icon.className = expanded ? "fa-solid fa-angles-left" : "fa-solid fa-angles-right";
      }
    });
  }

  toggleSidebar() {
    if (window.matchMedia("(max-width: 900px)").matches) {
      const open = this.container.classList.toggle("dash-side-open");
      this.updateSidebarButtons();
      if (open) {
        window.requestAnimationFrame(() => this.container.querySelector(".dash-side-close")?.focus());
      }
      return;
    }
    const collapsed = this.container.classList.toggle("dash-side-collapsed");
    try {
      window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "open");
    } catch {
      // private mode: state simply isn't remembered
    }
    this.updateSidebarButtons();
  }

  closeMobileSidebar() {
    if (!this.container.classList.contains("dash-side-open")) return;
    this.container.classList.remove("dash-side-open");
    this.updateSidebarButtons();
    if (window.matchMedia("(max-width: 900px)").matches) {
      this.container.querySelector(".dash-menu")?.focus({ preventScroll: true });
    }
  }

  setPreset(id) {
    this.presetId = id;
    this.renderPresets();
    this.setComposerStatus("");
    const custom = id === "custom";
    this.customEl.hidden = !custom;
    if (custom) {
      window.requestAnimationFrame(() => this.widthInput.focus());
    } else {
      this.prompt.focus();
    }
  }

  renderPresets() {
    this.presetsEl.innerHTML = WORKSPACE_PRESETS.map((item) => {
      const preset = presetFor(item.id);
      const width = preset?.width || this.customWidth || 1200;
      const height = preset?.height || this.customHeight || 630;
      const frame = frameSize(width, height);
      const active = item.id === this.presetId;
      const name = preset?.label || "Custom size";
      return `
        <button type="button" class="dash-preset${active ? " is-active" : ""}" data-preset="${item.id}" aria-pressed="${active}" title="${escapeHtml(name)} · ${width} × ${height}">
          <span class="dash-preset-frame" aria-hidden="true">
            <span class="dash-preset-shape${item.id === "custom" ? " is-custom" : ""}" style="width:${frame.width}px;height:${frame.height}px"></span>
          </span>
          <span class="dash-preset-label">${item.label}</span>
        </button>`;
    }).join("");
  }

  setFilter(filter) {
    if (!["all", "recent", "trash"].includes(filter)) return;
    this.filter = filter;
    this.render();
    this.closeMobileSidebar();
  }

  async refresh() {
    const token = ++this.refreshToken;
    this.state = "loading";
    this.error = "";
    this.render();
    this.status.textContent = "";

    try {
      this.list = await projects.list();
    } catch (error) {
      if (token !== this.refreshToken) return;
      this.state = "error";
      this.error = error.message;
      this.render();
      return;
    }

    try {
      this.trash = await projects.trash();
    } catch {
      this.trash = [];
    }
    if (token !== this.refreshToken) return;
    this.state = "ready";
    this.render();
  }

  visibleRows() {
    const now = Date.now();
    let rows = this.filter === "trash" ? this.trash : this.list;
    if (this.filter === "recent") {
      rows = rows.filter((row) => {
        const updated = new Date(row.updated_at).getTime();
        return Number.isFinite(updated) && now - updated <= RECENT_MS;
      });
    }
    const query = this.query.trim().toLowerCase();
    if (query) rows = rows.filter((row) => String(row.title || "").toLowerCase().includes(query));
    return [...rows].sort((a, b) => {
      if (this.sort === "title") return String(a.title || "").localeCompare(String(b.title || ""));
      const left = new Date(this.sort === "created" ? a.created_at : a.updated_at).getTime() || 0;
      const right = new Date(this.sort === "created" ? b.created_at : b.updated_at).getTime() || 0;
      return right - left;
    });
  }

  render() {
    this.updateCounts();
    const view = this.filter;
    const titles = {
      all: ["All designs", "Editable documents in this workspace"],
      recent: ["Recent", "Designs edited in the last 7 days"],
      trash: ["Trash", "Restore a design or remove it for good"],
    };
    const [title, sub] = titles[view];
    this.container.querySelectorAll("[data-view-title]").forEach((el) => {
      el.textContent = title;
    });
    this.container.querySelectorAll("[data-view-sub]").forEach((el) => {
      el.textContent = sub;
    });
    this.container.querySelectorAll("[data-filter]").forEach((el) => {
      const active = el.dataset.filter === view;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });

    this.empty.hidden = true;
    this.empty.innerHTML = "";
    this.trashRow.hidden = true;
    this.status.innerHTML = "";

    if (this.state === "loading") {
      this.grid.innerHTML = Array.from({ length: 6 }, () => `
        <div class="dash-skeleton" aria-hidden="true">
          <div class="dash-skel-title"></div>
          <div class="dash-skel-thumb"></div>
          <div class="dash-skel-meta"></div>
          <div class="dash-skel-structure"></div>
          <div class="dash-skel-footer"></div>
        </div>`).join("");
      return;
    }

    if (this.state === "error") {
      this.grid.innerHTML = "";
      this.status.innerHTML = `
        <div class="dash-error">
          <i class="fa-solid fa-plug-circle-exclamation" aria-hidden="true"></i>
          <div><strong>Can't reach the project list</strong><p>${escapeHtml(this.error)}</p></div>
          <button type="button" class="dash-quiet" data-dash="retry">Retry</button>
        </div>`;
      return;
    }

    const rows = this.visibleRows();
    const label = rows.length === 1 ? "design" : "designs";
    this.container.querySelector("[data-result-count]").textContent = `${rows.length} ${label}`;

    if (!rows.length) {
      this.grid.innerHTML = "";
      this.empty.hidden = false;
      this.empty.innerHTML = this.emptyMarkup();
      if (this.filter === "trash" && this.trash.length) this.trashRow.hidden = false;
      return;
    }

    if (this.filter === "trash") {
      this.trashRow.hidden = false;
      this.grid.innerHTML = rows.map((row) => this.trashCardMarkup(row)).join("");
      this.grid.querySelectorAll(".dash-title").forEach((titleEl) => {
        titleEl.removeAttribute("title");
      });
      return;
    }

    this.grid.innerHTML = rows.map((row) => this.cardMarkup(row)).join("");
  }

  updateCounts() {
    const now = Date.now();
    const recent = this.list.filter((row) => {
      const updated = new Date(row.updated_at).getTime();
      return Number.isFinite(updated) && now - updated <= RECENT_MS;
    }).length;
    this.container.querySelectorAll('[data-count="all"]').forEach((el) => (el.textContent = String(this.list.length)));
    this.container.querySelectorAll('[data-count="recent"]').forEach((el) => (el.textContent = String(recent)));
    this.container.querySelectorAll('[data-count="trash"]').forEach((el) => (el.textContent = String(this.trash.length)));
  }

  emptyMarkup() {
    if (this.query.trim()) {
      return `
        ${emptyArt()}
        <h3>No designs match “${escapeHtml(this.query.trim())}”</h3>
        <p>Try a shorter title, or clear the search to see the whole workspace.</p>
        <button type="button" class="dash-quiet" data-dash="clear-search">Clear search</button>`;
    }
    if (this.filter === "trash") {
      return `
        ${emptyArt()}
        <h3>Trash is empty</h3>
        <p>Archived designs will wait here until you restore or remove them.</p>
        <button type="button" class="dash-quiet" data-filter="all">Back to designs</button>`;
    }
    if (this.filter === "recent") {
      return `
        ${emptyArt()}
        <h3>Nothing edited recently</h3>
        <p>Your last seven days are clear. All of your work is still in All designs.</p>
        <button type="button" class="dash-quiet" data-filter="all">See all designs</button>`;
    }
    return `
      ${emptyArt()}
      <h3>Your first design starts here</h3>
      <p>Describe a launch post, a brand board, a poster, anything with a layout.</p>
      <button type="button" class="dash-empty-cta" data-dash="focus">Write a brief <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`;
  }

  documentMetaMarkup(row) {
    const format = formatForCanvas(row.canvas_width, row.canvas_height);
    const size = dimensionsLabel(row);
    if (!format && !size) return "";
    return `
      <div class="dash-doc-meta">
        ${format ? `<span class="dash-doc-format">${escapeHtml(format)}</span>` : ""}
        ${size ? `<span class="dash-doc-size">${size}</span>` : ""}
      </div>`;
  }

  editedMarkup(row, archived = false) {
    const date = fullDate(row.updated_at);
    const stamp = archived ? `Archived ${timeAgo(row.updated_at)}` : `Edited ${timeAgo(row.updated_at)}`;
    return `<span class="dash-doc-edited"${date ? ` title="${escapeHtml(date)}"` : ""}>${stamp}</span>`;
  }

  cardMarkup(row) {
    const title = row.title || "Untitled design";
    const thumb = row.thumbnail
      ? `<img src="${escapeHtml(row.thumbnail)}" alt="" loading="lazy" draggable="false" />`
      : `<span class="dash-thumb-empty">${this.thumbPlaceholder()}<span>Preview pending</span></span>`;
    return `
      <article class="dash-card" data-card-id="${escapeHtml(row.id)}" data-trash="0">
        <div class="dash-card-body">
          <div class="dash-card-title-row">
            <span class="dash-title" title="Double-click to rename">${escapeHtml(title)}</span>
            <button type="button" class="dash-title-rename" data-act="rename" title="Rename" aria-label="Rename ${escapeHtml(title)}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
          </div>
          <div class="dash-thumb-wrap">
            <button type="button" class="dash-thumb" data-open aria-label="Open ${escapeHtml(title)} in a new tab">
              ${thumb}
            </button>
          </div>
          ${this.documentMetaMarkup(row)}
          <div class="dash-doc-footer">
            ${this.editedMarkup(row)}
            <div class="dash-doc-actions">
              <button type="button" class="dash-doc-open" data-act="open">Open <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
              <button type="button" class="dash-doc-icon" data-act="duplicate" title="Duplicate" aria-label="Duplicate ${escapeHtml(title)}"><i class="fa-solid fa-copy" aria-hidden="true"></i></button>
              <button type="button" class="dash-doc-icon" data-act="archive" title="Move to trash" aria-label="Move ${escapeHtml(title)} to trash"><i class="fa-solid fa-box-archive" aria-hidden="true"></i></button>
            </div>
          </div>
        </div>
      </article>`;
  }

  trashCardMarkup(row) {
    const title = row.title || "Untitled design";
    const thumb = row.thumbnail
      ? `<img src="${escapeHtml(row.thumbnail)}" alt="" loading="lazy" draggable="false" />`
      : `<span class="dash-thumb-empty">${this.thumbPlaceholder()}<span>Preview pending</span></span>`;
    return `
      <article class="dash-card dash-card-trash" data-card-id="${escapeHtml(row.id)}" data-trash="1">
        <div class="dash-card-body">
          <div class="dash-card-title-row"><span class="dash-title">${escapeHtml(title)}</span></div>
          <div class="dash-thumb-wrap">
            <div class="dash-thumb dash-thumb-static">${thumb}</div>
          </div>
          ${this.documentMetaMarkup(row)}
          <div class="dash-doc-footer">
            ${this.editedMarkup(row, true)}
            <div class="dash-doc-actions">
              <button type="button" class="dash-quiet" data-act="restore"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Restore</button>
              <button type="button" class="dash-quiet danger" data-act="destroy"><i class="fa-solid fa-trash-can" aria-hidden="true"></i> Delete</button>
            </div>
          </div>
        </div>
      </article>`;
  }

  thumbPlaceholder() {
    return `
      <span class="dash-empty-art mini" aria-hidden="true">
        <span></span><span></span><span></span>
      </span>`;
  }

  presetCanvas() {
    if (this.presetId === "custom") {
      const width = Number(this.widthInput.value);
      const height = Number(this.heightInput.value);
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width < MIN_CANVAS ||
        height < MIN_CANVAS ||
        width > MAX_CANVAS ||
        height > MAX_CANVAS
      ) {
        return { error: `Custom dimensions must be between ${MIN_CANVAS} and ${MAX_CANVAS} px.` };
      }
      return { id: "custom", label: "Custom", width: Math.round(width), height: Math.round(height) };
    }
    return presetFor(this.presetId) || getPreset(DEFAULT_PRESET_ID);
  }

  async create() {
    const preset = this.presetCanvas();
    if (preset.error) {
      this.setComposerStatus(preset.error, "error");
      this.widthInput.focus();
      return;
    }

    const prompt = this.prompt.value.trim();
    const title = titleFromPrompt(prompt);
    this.generateBtn.disabled = true;
    this.setComposerStatus("Creating your design…", "busy");

    try {
      const row = await projects.create({
        title,
        canvas: { width: preset.width, height: preset.height, background: "#F5F5F7" },
      });
      if (prompt) {
        try {
          window.sessionStorage.setItem(PENDING_KEY, prompt);
        } catch {
          // private mode: editor simply starts with the example prompt
        }
      }
      this.setComposerStatus("Opening the editor…", "busy");
      const target = window.open(editorUrl(row.id), "_blank", "noopener");
      if (!target) window.location.hash = editorUrl(row.id);
      this.setComposerStatus("");
      this.refresh();
    } catch (error) {
      this.setComposerStatus(`Couldn't create: ${error.message}`, "error");
      notify(`Couldn't create: ${error.message}`, "error");
    } finally {
      this.generateBtn.disabled = false;
    }
  }

  setComposerStatus(message, kind = "") {
    this.composerStatus.textContent = message;
    this.composerStatus.className = `dash-composer-status${kind ? ` is-${kind}` : ""}`;
  }

  open(id) {
    const target = window.open(editorUrl(id), "_blank", "noopener");
    if (!target) window.location.hash = editorUrl(id);
  }

  async cardAction(action, id, trashed) {
    if (action === "open") {
      this.open(id);
      return;
    }
    if (action === "duplicate") {
      try {
        await projects.duplicate(id);
        notify("Design duplicated.", "success");
        this.refresh();
      } catch (error) {
        notify(`Couldn't duplicate: ${error.message}`, "error");
      }
      return;
    }
    if (action === "archive") {
      if (!window.confirm("Move this design to trash? You can restore it later.")) return;
      try {
        await projects.remove(id);
        notify("Design moved to trash.", "success");
        this.refresh();
      } catch (error) {
        notify(`Couldn't archive: ${error.message}`, "error");
      }
      return;
    }
    if (action === "restore") {
      try {
        await projects.restore(id);
        notify("Design restored.", "success");
        this.refresh();
      } catch (error) {
        notify(`Couldn't restore: ${error.message}`, "error");
      }
      return;
    }
    if (action === "destroy") {
      if (!window.confirm("Delete this design forever? This cannot be undone.")) return;
      try {
        await projects.destroy(id);
        notify("Design deleted forever.", "success");
        this.refresh();
      } catch (error) {
        notify(`Couldn't delete: ${error.message}`, "error");
      }
    }
  }

  rename(card, id) {
    if (card.querySelector(".dash-rename")) return;
    const titleEl = card.querySelector(".dash-title");
    if (!titleEl) return;
    const row = [...this.list, ...this.trash].find((item) => item.id === id);
    if (!row) return;

    const input = document.createElement("input");
    input.className = "dash-rename";
    input.value = row.title || "Untitled design";
    input.maxLength = 120;
    input.setAttribute("aria-label", "Rename design");
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (commit && value && value !== row.title) {
        try {
          await projects.update(id, { title: value.slice(0, 120) });
          notify("Design renamed.", "success");
        } catch (error) {
          notify(`Couldn't rename: ${error.message}`, "error");
        }
      }
      this.refresh();
    };

    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  async emptyTrash() {
    if (!this.trash.length) return;
    if (!window.confirm(`Permanently delete ${this.trash.length} trashed design(s)? This cannot be undone.`)) return;
    try {
      await projects.emptyTrash();
      notify("Trash emptied.", "success");
      this.refresh();
    } catch (error) {
      notify(`Couldn't empty trash: ${error.message}`, "error");
    }
  }
}
