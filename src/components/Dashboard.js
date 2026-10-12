/**
 * Home dashboard (screen, self-sufficient like App).
 *
 * Prompt-first hero ("What would you like to create?"), quick-start
 * sizes, recents grid with thumbnails, rename/duplicate/delete, empty
 * and backend-down states. Cards open the editor in a NEW tab.
 */

import { projects } from "../storage/projects";
import { DESIGN_PRESETS, DEFAULT_PRESET_ID, getPreset } from "../design/presets";
import { editorUrl } from "../ui/router";

const PENDING_KEY = "oovi.pendingPrompt";

export class Dashboard {
  constructor(container) {
    this.container = container;
    this.list = [];
    this.state = "loading";
    this.container.classList.add("dash");
    this.container.innerHTML = `
      <header class="dash-top">
        <span class="dash-brand"><span class="logo" aria-hidden="true"><i class="fa-solid fa-pen-nib"></i></span> Oovi Studio</span>
        <button class="btn btn-sm btn-primary" data-dash="focus">New design</button>
      </header>
      <section class="dash-hero">
        <h1>What would you like to create?</h1>
        <div class="dash-prompt-row">
          <input id="dash-prompt" type="text" maxlength="500" placeholder="A product announcement for our AI assistant…" aria-label="Design idea" />
          <select id="dash-size" aria-label="Size"></select>
          <button class="btn btn-primary" data-dash="create">Create</button>
        </div>
        <div class="dash-sizes" id="dash-sizes"></div>
      </section>
      <section class="dash-recents">
        <h2>Recent designs</h2>
        <div id="dash-status" class="muted"></div>
        <div class="dash-grid" id="dash-grid"></div>
      </section>
      <section class="dash-recents dash-trash-wrap">
        <details class="dash-trash" id="dash-trash">
          <summary>Trash (<span id="dash-trash-count">0</span>)</summary>
          <div class="dash-grid" id="dash-trash-grid"></div>
          <button class="btn btn-sm btn-light border" data-dash="empty-trash">Empty trash</button>
        </details>
      </section>
    `;
    this.sizeSelect = this.container.querySelector("#dash-size");
    for (const p of DESIGN_PRESETS) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.label} · ${p.width} × ${p.height}`;
      if (p.id === DEFAULT_PRESET_ID) opt.selected = true;
      this.sizeSelect.appendChild(opt);
    }
    const chips = this.container.querySelector("#dash-sizes");
    for (const p of DESIGN_PRESETS.slice(0, 4)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm btn-light border";
      b.textContent = p.label;
      b.addEventListener("click", () => this.create("", p.id));
      chips.appendChild(b);
    }
    this.container.querySelector('[data-dash="focus"]').addEventListener("click", () => {
      this.container.querySelector("#dash-prompt").focus();
    });
    this.container.querySelector('[data-dash="create"]').addEventListener("click", () => {
      this.create(
        this.container.querySelector("#dash-prompt").value.trim(),
        this.sizeSelect.value,
      );
    });
    this.container.querySelector("#dash-prompt").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.create(event.target.value.trim(), this.sizeSelect.value);
      }
    });
    this.container.querySelector('[data-dash="empty-trash"]').addEventListener("click", async () => {
      const count = this.container.querySelectorAll("#dash-trash-grid .dash-card").length;
      if (!count) return;
      if (!window.confirm(`Permanently delete ${count} trashed design(s)? This cannot be undone.`)) return;
      try {
        await projects.emptyTrash();
      } catch (error) {
        this.fail(error);
      }
      this.refresh();
    });
    this.refresh();
  }

  titleFromPrompt(prompt) {
    const words = String(prompt || "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
    return words || "Untitled design";
  }

  async create(prompt, presetId) {
    const preset = getPreset(presetId);
    const status = this.container.querySelector("#dash-status");
    status.textContent = "Creating…";
    try {
      const row = await projects.create({
        title: this.titleFromPrompt(prompt),
        canvas: { width: preset.width, height: preset.height, background: "#F5F5F7" },
      });
      if (prompt) {
        try {
          window.sessionStorage.setItem(PENDING_KEY, prompt);
        } catch {
          // private mode: editor simply starts with the example prompt
        }
      }
      status.textContent = "";
      window.open(editorUrl(row.id), "_blank", "noopener");
      this.refresh();
    } catch (error) {
      status.textContent = `Couldn't create: ${error.message}`;
    }
  }

  async refresh() {
    const grid = this.container.querySelector("#dash-grid");
    const status = this.container.querySelector("#dash-status");
    status.textContent = "Loading…";
    grid.innerHTML = "";
    try {
      this.list = await projects.list();
    } catch (error) {
      status.textContent = `Backend unreachable — start it with: npm run dev:api. (${error.message})`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btn-sm btn-light border";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => this.refresh());
      status.appendChild(retry);
      return;
    }
    if (!this.list.length) {
      status.textContent = "No designs yet — describe one above to start.";
    } else {
      status.textContent = "";
      for (const row of this.list) grid.appendChild(this.card(row));
    }
    try {
      const trashed = await projects.trash();
      this.container.querySelector("#dash-trash-count").textContent = String(trashed.length);
      const tgrid = this.container.querySelector("#dash-trash-grid");
      tgrid.innerHTML = "";
      for (const row of trashed) tgrid.appendChild(this.trashCard(row));
    } catch {
      // trash is best-effort; recents already rendered
    }
  }

  card(row) {
    const el = document.createElement("div");
    el.className = "dash-card";
    const thumb = row.thumbnail
      ? `<img src="${row.thumbnail}" alt="" loading="lazy" draggable="false" />`
      : `<span class="dash-thumb-empty"><i class="fa-solid fa-image"></i></span>`;
    el.innerHTML = `
      <button class="dash-thumb" data-open title="Open in a new tab">${thumb}</button>
      <div class="dash-meta">
        <span class="dash-title" title="Double-click to rename">${escapeHtml(row.title)}</span>
        <small class="muted">${timeAgo(row.updated_at)}</small>
      </div>
      <div class="dash-btns">
        <button class="btn btn-sm btn-light border" data-act="duplicate" title="Duplicate" aria-label="Duplicate design"><i class="fa-solid fa-copy"></i></button>
        <button class="btn btn-sm btn-light border" data-act="delete" title="Delete" aria-label="Delete design"><i class="fa-solid fa-trash"></i></button>
      </div>`;
    el.querySelector("[data-open]").addEventListener("click", () => {
      window.open(editorUrl(row.id), "_blank", "noopener");
    });
    el.querySelector('[data-act="duplicate"]').addEventListener("click", async () => {
      try {
        await projects.duplicate(row.id);
        this.refresh();
      } catch (error) {
        this.fail(error);
      }
    });
    el.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      if (!window.confirm(`Move "${row.title}" to trash? You can restore it later.`)) return;
      try {
        await projects.remove(row.id);
        this.refresh();
      } catch (error) {
        this.fail(error);
      }
    });
    el.querySelector(".dash-title").addEventListener("dblclick", () => this.rename(el, row));
    return el;
  }

  rename(el, row) {
    const titleEl = el.querySelector(".dash-title");
    if (el.querySelector(".dash-rename")) return;
    const input = document.createElement("input");
    input.className = "dash-rename";
    input.value = row.title;
    input.setAttribute("aria-label", "Rename design");
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      if (commit && input.value.trim() && input.value.trim() !== row.title) {
        try {
          await projects.update(row.id, { title: input.value.trim().slice(0, 120) });
        } catch (error) {
          this.fail(error);
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

  trashCard(row) {
    const el = document.createElement("div");
    el.className = "dash-card";
    const thumb = row.thumbnail
      ? `<img src="${row.thumbnail}" alt="" loading="lazy" draggable="false" />`
      : `<span class="dash-thumb-empty"><i class="fa-solid fa-image"></i></span>`;
    el.innerHTML = `
      <div class="dash-thumb dash-thumb-static">${thumb}</div>
      <div class="dash-meta">
        <span class="dash-title">${escapeHtml(row.title)}</span>
        <small class="muted">${timeAgo(row.updated_at)}</small>
      </div>
      <div class="dash-btns">
        <button class="btn btn-sm btn-light border" data-act="restore" title="Restore" aria-label="Restore design"><i class="fa-solid fa-rotate-left"></i> Restore</button>
        <button class="btn btn-sm btn-light border" data-act="destroy" title="Delete forever" aria-label="Delete forever"><i class="fa-solid fa-trash"></i></button>
      </div>`;
    el.querySelector('[data-act="restore"]').addEventListener("click", async () => {
      try {
        await projects.restore(row.id);
      } catch (error) {
        this.fail(error);
      }
      this.refresh();
    });
    el.querySelector('[data-act="destroy"]').addEventListener("click", async () => {
      if (!window.confirm(`Delete "${row.title}" forever? This cannot be undone.`)) return;
      try {
        await projects.destroy(row.id);
      } catch (error) {
        this.fail(error);
      }
      this.refresh();
    });
    return el;
  }

  fail(error) {
    const status = this.container.querySelector("#dash-status");
    status.textContent = String(error.message || error);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
