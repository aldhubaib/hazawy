const nativeFetch = window.fetch.bind(window);

// App registers a Clerk token getter here so every request carries the user's
// session as a Bearer token (the backend verifies it for access control).
let tokenGetter = null;
export function setAuthTokenGetter(fn) {
  tokenGetter = fn;
}

async function authFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  if (tokenGetter) {
    try {
      const token = await tokenGetter();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    } catch {
      /* not signed in yet */
    }
  }
  return nativeFetch(input, { ...init, headers });
}

async function json(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  config: () => authFetch("/api/config").then(json),

  // --- Access / team ----------------------------------------------------------
  getMe: () => authFetch("/api/access/me").then(json),
  listAccessUsers: () => authFetch("/api/access/users").then(json),
  inviteAccessUser: (email, opts = {}) =>
    authFetch("/api/access/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, ...opts }),
    }).then(json),
  updateAccessUser: (email, patch) =>
    authFetch(`/api/access/users/${encodeURIComponent(email)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json),
  deleteAccessUser: (email) =>
    authFetch(`/api/access/users/${encodeURIComponent(email)}`, { method: "DELETE" }).then(json),
  getSettings: () => authFetch("/api/settings").then(json),
  saveSettings: (patch) =>
    authFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json),
  // --- Test-image library -----------------------------------------------------
  getTestImages: () => authFetch("/api/test-images").then(json),
  uploadTestImage: (gender, file) => {
    const fd = new FormData();
    fd.append("gender", gender);
    fd.append("image", file);
    return authFetch("/api/test-images", { method: "POST", body: fd }).then(json);
  },
  deleteTestImage: (id) => authFetch(`/api/test-images/${id}`, { method: "DELETE" }).then(json),

  listStories: () => authFetch("/api/stories").then(json),
  getStory: (id) => authFetch(`/api/stories/${id}`).then(json),
  createStory: (title, opts = {}) =>
    authFetch("/api/stories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, ...opts }),
    }).then(json),
  deleteStory: (id) => authFetch(`/api/stories/${id}`, { method: "DELETE" }).then(json),

  uploadScenes: (id, files) => {
    const fd = new FormData();
    for (const f of files) fd.append("scenes", f);
    return authFetch(`/api/stories/${id}/scenes`, { method: "POST", body: fd }).then(json);
  },

  deleteScene: (id, sceneId) =>
    authFetch(`/api/stories/${id}/scenes/${sceneId}`, { method: "DELETE" }).then(json),

  reorderScenes: (id, order) =>
    authFetch(`/api/stories/${id}/scenes/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    }).then(json),

  analyzeStory: (id) => authFetch(`/api/stories/${id}/analyze`, { method: "POST" }).then(json),

  // --- Cells (book pages) -----------------------------------------------------
  addCell: (id, { type, size, text, lang } = {}) =>
    authFetch(`/api/stories/${id}/cells`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, size, text, lang }),
    }).then(json),

  copyCellLanguage: (id, from, to) =>
    authFetch(`/api/stories/${id}/cells/copy-language`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    }).then(json),

  updateCell: (id, cellId, patch) =>
    authFetch(`/api/stories/${id}/cells/${cellId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json),

  uploadCellImage: (id, cellId, file) => {
    const fd = new FormData();
    fd.append("image", file);
    return authFetch(`/api/stories/${id}/cells/${cellId}/image`, {
      method: "POST",
      body: fd,
    }).then(json);
  },

  uploadCellBackground: (id, cellId, file) => {
    const fd = new FormData();
    fd.append("image", file);
    return authFetch(`/api/stories/${id}/cells/${cellId}/background`, {
      method: "POST",
      body: fd,
    }).then(json);
  },

  removeCellBackground: (id, cellId) =>
    authFetch(`/api/stories/${id}/cells/${cellId}/background`, {
      method: "DELETE",
    }).then(json),

  uploadMedia: (file) => {
    const fd = new FormData();
    fd.append("image", file);
    return authFetch("/api/media", { method: "POST", body: fd }).then(json);
  },

  // --- Variables --------------------------------------------------------------
  listVariables: () => authFetch("/api/variables").then(json),
  createVariable: (name, opts = {}) =>
    authFetch("/api/variables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...opts }),
    }).then(json),
  deleteVariable: (id) => authFetch(`/api/variables/${id}`, { method: "DELETE" }).then(json),

  // --- Custom symbols ---------------------------------------------------------
  listSymbols: () => authFetch("/api/symbols").then(json),
  createSymbol: (name, svg) =>
    authFetch("/api/symbols", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, svg }),
    }).then(json),
  deleteSymbol: (id) => authFetch(`/api/symbols/${id}`, { method: "DELETE" }).then(json),

  uploadKid: (id, file) => {
    const fd = new FormData();
    fd.append("kid", file);
    return authFetch(`/api/stories/${id}/kid`, { method: "POST", body: fd }).then(json);
  },

  restoreKid: (id, kidId) =>
    authFetch(`/api/stories/${id}/kid/${kidId}/restore`, { method: "POST" }).then(json),

  anchorKid: (id, kidId) =>
    authFetch(`/api/stories/${id}/kid/${kidId}/anchor`, { method: "POST" }).then(json),

  generate: (id, sceneId, kidId, prompt, opts = {}) =>
    authFetch(`/api/stories/${id}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sceneId, kidId, prompt, ...opts }),
    }).then(json),

  deleteKid: (id, kidId) =>
    authFetch(`/api/stories/${id}/kid/${kidId}`, { method: "DELETE" }).then(json),

  // --- Test approval + publishing ---------------------------------------------
  approveResult: (id, kidId, sceneId, approved = true) =>
    authFetch(`/api/stories/${id}/results/${kidId}/${sceneId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    }).then(json),

  updateStoryGender: (id, gender) =>
    authFetch(`/api/stories/${id}/gender`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gender }),
    }).then(json),

  updateStoryTitle: (id, titles) =>
    authFetch(`/api/stories/${id}/title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(titles),
    }).then(json),

  updateStoryStyle: (id, styleSettings) =>
    authFetch(`/api/stories/${id}/style`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(styleSettings),
    }).then(json),

  extractStyle: (id, sceneId) =>
    authFetch(`/api/stories/${id}/extract-style`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sceneId }),
    }).then(json),

  publishStory: (id) =>
    authFetch(`/api/stories/${id}/publish`, { method: "POST" }).then(json),

  unpublishStory: (id) =>
    authFetch(`/api/stories/${id}/unpublish`, { method: "POST" }).then(json),

  // --- Orders -----------------------------------------------------------------
  listOrders: () => authFetch("/api/orders").then(json),
  getOrder: (id) => authFetch(`/api/orders/${id}`).then(json),
  createOrder: (title, storyId, opts = {}) =>
    authFetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, storyId, ...opts }),
    }).then(json),
  deleteOrder: (id) => authFetch(`/api/orders/${id}`, { method: "DELETE" }).then(json),

  uploadOrderKid: (id, file) => {
    const fd = new FormData();
    fd.append("kid", file);
    return authFetch(`/api/orders/${id}/kid`, { method: "POST", body: fd }).then(json);
  },
  restoreOrderKid: (id) =>
    authFetch(`/api/orders/${id}/kid/restore`, { method: "POST" }).then(json),
  anchorOrderKid: (id) =>
    authFetch(`/api/orders/${id}/kid/anchor`, { method: "POST" }).then(json),
  generateOrder: (id, sceneId, prompt, opts = {}) =>
    authFetch(`/api/orders/${id}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sceneId, prompt, ...opts }),
    }).then(json),
};
