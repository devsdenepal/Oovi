/**
 * Projects storage interface (dashboard persistence).
 *
 * Today: REST against the local Express + Postgres backend
 * (server/index.js, same-origin /api/designs via the Vite proxy).
 * The interface is deliberately narrow so a future IndexedDB provider
 * can slot in without touching callers:
 *   list() / create() / get() / update() / duplicate() / remove()
 * All methods throw with human-readable messages on failure.
 */

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch {
    throw new Error("projects backend is not running (npm run dev:api)");
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON (proxy 404 page when backend is down)
  }
  if (!res.ok) throw new Error(data?.error || `projects request ${res.status}`);
  return data;
}

export const projects = {
  /** @returns {Promise<Array<{id,title,thumbnail,created_at,updated_at,canvas_width,canvas_height}>>} */
  async list() {
    const data = await request("/api/designs");
    return data?.designs || [];
  },

  /** @returns {Promise<{id,title,created_at,updated_at}>} */
  async create({ title, canvas, design, memory } = {}) {
    const data = await request("/api/designs", {
      method: "POST",
      body: JSON.stringify({ title, canvas, design, ai_memory: memory }),
    });
    if (!data?.design) throw new Error("create returned nothing");
    return data.design;
  },

  /** @returns {Promise<{id,title,design,thumbnail,created_at,updated_at}>} */
  async get(id) {
    const data = await request(`/api/designs/${encodeURIComponent(id)}`);
    if (!data?.design) throw new Error("design not found");
    return data.design;
  },

  /** Partial update; returns {id,title,updated_at}. */
  async update(id, patch) {
    const body = { ...(patch || {}) };
    if ("memory" in body) {
      body.ai_memory = body.memory;
      delete body.memory;
    }
    const data = await request(`/api/designs/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (!data?.design) throw new Error("update returned nothing");
    return data.design;
  },

  /** @returns {Promise<{id,title,...}>} the copy */
  async duplicate(id) {
    const data = await request(`/api/designs/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
    if (!data?.design) throw new Error("duplicate returned nothing");
    return data.design;
  },

  async remove(id) {
    await request(`/api/designs/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  /** @returns {Promise<Array>} trashed designs (soft-deleted). */
  async trash() {
    const data = await request("/api/designs?deleted=1");
    return data?.designs || [];
  },

  /** Restores a trashed design. */
  async restore(id) {
    const data = await request(`/api/designs/${encodeURIComponent(id)}/restore`, { method: "POST" });
    if (!data?.design) throw new Error("restore returned nothing");
    return data.design;
  },

  /** Permanently deletes (no recovery). */
  async destroy(id) {
    await request(`/api/designs/${encodeURIComponent(id)}/permanent`, { method: "DELETE" });
  },

  /** Permanently deletes everything in trash. @returns {number} count. */
  async emptyTrash() {
    const data = await request("/api/designs/empty-trash", { method: "POST" });
    return data?.deleted || 0;
  },
};
