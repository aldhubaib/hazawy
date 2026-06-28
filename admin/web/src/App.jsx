import { useEffect, useRef, useState } from "react";
import { SignedIn, SignedOut, SignIn, UserButton, useAuth } from "@clerk/clerk-react";
import { api, setAuthTokenGetter } from "./api.js";
import { SYMBOL_LIBRARY, SYMBOL_CATEGORIES, sanitizeSvg, tintSvg } from "./symbols.js";

// Page ids that can be granted to members; admins additionally see these.
const ADMIN_ONLY_PAGES = ["settings", "access"];
const PAGE_LABELS = {
  stories: "Stories",
  orders: "Orders",
  variables: "Variables",
  settings: "Settings",
  access: "Access",
};

// Parse the current URL hash into a section + optional id, e.g. "#/orders/123".
function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [section = "", id = ""] = raw.split("/");
  return { section, id };
}

// Build the URL hash that represents the current navigation state.
function buildHash(nav, story, order) {
  if (nav === "stories") return story ? `#/stories/${story.id}` : "#/stories";
  if (nav === "orders") return order ? `#/orders/${order.id}` : "#/orders";
  return `#/${nav}`;
}

export default function App({ authDisabled = false }) {
  // Open mode (no Clerk key): skip all Clerk components/hooks entirely.
  if (authDisabled) return <OpenApp />;

  return (
    <>
      <SignedOut>
        <SignInScreen />
      </SignedOut>
      <SignedIn>
        <AuthedApp />
      </SignedIn>
    </>
  );
}

// Centered Clerk sign-in for signed-out visitors.
function SignInScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="text-center">
        <div className="mb-6 text-2xl font-semibold">
          Hazawy <span className="text-[var(--color-accent)]">Studio</span>
        </div>
        <SignIn routing="hash" />
      </div>
    </div>
  );
}

// Clerk mode: wire the session token into the API layer, then load permissions.
function AuthedApp() {
  const { getToken, isLoaded } = useAuth();
  useEffect(() => {
    setAuthTokenGetter(getToken);
  }, [getToken]);
  return <StudioLoader ready={isLoaded} withUserButton />;
}

// Open mode: no token, backend treats the caller as an admin.
function OpenApp() {
  useEffect(() => {
    setAuthTokenGetter(null);
  }, []);
  return <StudioLoader ready withUserButton={false} />;
}

// Loads the current user's access, then renders the studio.
function StudioLoader({ ready, withUserButton }) {
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState("");

  useEffect(() => {
    if (!ready) return;
    api
      .getMe()
      .then(setMe)
      .catch((e) => setMeError(e.message));
  }, [ready]);

  if (meError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4 text-center">
        <div className="max-w-sm">
          <p className="mb-3 text-sm text-rose-300">Couldn't load your access: {meError}</p>
          {withUserButton && <UserButton afterSignOutUrl="/" />}
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] text-sm text-zinc-400">
        Loading…
      </div>
    );
  }

  return <Studio me={me} />;
}

function Studio({ me }) {
  const allowedPages = me.isAdmin
    ? [...new Set([...(me.pages || []), ...ADMIN_ONLY_PAGES])]
    : me.pages || [];
  const canAccess = (page) => allowedPages.includes(page);

  const [config, setConfig] = useState(null);
  const [error, setError] = useState("");
  const [nav, setNav] = useState(() => {
    const saved = localStorage.getItem("hazawy.nav");
    return saved && allowedPages.includes(saved) ? saved : allowedPages[0] || "orders";
  }); // "stories" | "orders"

  const [stories, setStories] = useState([]);
  const [orders, setOrders] = useState([]);

  const [story, setStory] = useState(null); // selected story detail (null = table)
  const [order, setOrder] = useState(null); // selected order detail (null = table)

  // Create modals
  const [creatingStory, setCreatingStory] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [newOrderTitle, setNewOrderTitle] = useState("");
  const [newOrderStoryId, setNewOrderStoryId] = useState("");
  const [newOrderVars, setNewOrderVars] = useState({}); // variable name -> value

  // Order generation controls
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [mode, setMode] = useState("compose");

  const [stage, setStage] = useState(null); // null | "uploading" | "restoring" | "anchoring"
  const kidBusy = stage !== null;
  const [cellBusy, setCellBusy] = useState({}); // cellId -> bool (image upload)
  const [editorCellId, setEditorCellId] = useState(null); // open full-screen editor
  const [analyzing, setAnalyzing] = useState(false); // analyzing scene scoring
  const [busy, setBusy] = useState({}); // sceneId -> bool
  const [generatingAll, setGeneratingAll] = useState(false);

  // Variables (admin-managed text placeholders)
  const [variables, setVariables] = useState([]);
  const [creatingVariable, setCreatingVariable] = useState(false);
  const [newVarName, setNewVarName] = useState("");
  const [newVarLabel, setNewVarLabel] = useState("");
  const [newVarDefault, setNewVarDefault] = useState("");

  // User-uploaded SVG symbols, persisted so they can be reused across pages.
  const [customSymbols, setCustomSymbols] = useState([]);

  const kidInput = useRef(null);

  useEffect(() => {
    api.config().then((c) => {
      setConfig(c);
      setPrompt(c.defaultPrompt);
    });
    refreshStories();
    refreshOrders();
    refreshVariables();
    refreshSymbols();

    // Restore the open page: prefer the URL hash, then fall back to localStorage.
    const { section, id } = parseHash();
    if (
      section === "stories" ||
      section === "orders" ||
      section === "variables" ||
      section === "settings" ||
      section === "access"
    ) {
      if (canAccess(section)) setNav(section);
      if (section === "stories" && id) api.getStory(id).then(setStory).catch(() => {});
      else if (section === "orders" && id) api.getOrder(id).then(setOrder).catch(() => {});
    } else {
      const sId = localStorage.getItem("hazawy.storyId");
      const oId = localStorage.getItem("hazawy.orderId");
      if (sId) api.getStory(sId).then(setStory).catch(() => localStorage.removeItem("hazawy.storyId"));
      if (oId)
        api
          .getOrder(oId)
          .then(setOrder)
          .catch(() => localStorage.removeItem("hazawy.orderId"));
    }
  }, []);

  // Keep the URL hash in sync with the current view so links are shareable.
  useEffect(() => {
    const h = buildHash(nav, story, order);
    if (window.location.hash !== h) window.location.hash = h;
  }, [nav, story, order]);

  // Respond to browser Back/Forward by reading the hash back into state.
  useEffect(() => {
    function onHashChange() {
      const { section, id } = parseHash();
      if (section === "stories") {
        setNav("stories");
        if (id) {
          if (!story || story.id !== id) api.getStory(id).then(setStory).catch(() => setStory(null));
        } else setStory(null);
      } else if (section === "orders") {
        setNav("orders");
        if (id) {
          if (!order || order.id !== id) api.getOrder(id).then(setOrder).catch(() => setOrder(null));
        } else setOrder(null);
      } else if (section === "variables") {
        setNav("variables");
        setStory(null);
        setOrder(null);
      } else if (section === "settings") {
        setNav("settings");
        setStory(null);
        setOrder(null);
      } else if (section === "access") {
        setNav("access");
        setStory(null);
        setOrder(null);
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [story, order]);

  // Persist navigation + open detail so a refresh stays put.
  useEffect(() => {
    localStorage.setItem("hazawy.nav", nav);
  }, [nav]);

  // Never sit on a page the user can't access (e.g. after a hash change).
  useEffect(() => {
    if (!canAccess(nav)) setNav(allowedPages[0] || "orders");
  }, [nav]);
  useEffect(() => {
    if (story) localStorage.setItem("hazawy.storyId", story.id);
    else localStorage.removeItem("hazawy.storyId");
  }, [story]);
  useEffect(() => {
    if (order) localStorage.setItem("hazawy.orderId", order.id);
    else localStorage.removeItem("hazawy.orderId");
  }, [order]);

  function refreshStories() {
    api.listStories().then(setStories).catch((e) => setError(e.message));
  }
  function refreshOrders() {
    api.listOrders().then(setOrders).catch((e) => setError(e.message));
  }
  function refreshVariables() {
    api.listVariables().then(setVariables).catch((e) => setError(e.message));
  }
  function refreshSymbols() {
    api.listSymbols().then(setCustomSymbols).catch((e) => setError(e.message));
  }
  // Persist a freshly uploaded symbol and return the saved record so the editor
  // can add it to the canvas immediately.
  async function saveSymbol(name, svg) {
    const saved = await api.createSymbol(name, svg);
    setCustomSymbols((list) => [...list, saved]);
    return saved;
  }
  async function deleteCustomSymbol(id) {
    await api.deleteSymbol(id);
    setCustomSymbols((list) => list.filter((s) => s.id !== id));
  }

  function switchNav(n) {
    setNav(n);
    setStory(null);
    setOrder(null);
    setError("");
  }

  // ---- Stories ----
  async function openStory(id) {
    setError("");
    try {
      setStory(await api.getStory(id));
    } catch (e) {
      setError(e.message);
    }
  }

  async function createStory() {
    try {
      // Title, child gender, and pages are all set later on the story page.
      const s = await api.createStory("", { gender: "female", aspect: "1:1" });
      setCreatingStory(false);
      refreshStories();
      setStory(s);
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteStory(id) {
    if (!confirm("Delete this story and its scenes?")) return;
    try {
      await api.deleteStory(id);
      if (story?.id === id) setStory(null);
      refreshStories();
    } catch (e) {
      setError(e.message);
    }
  }

  // ---- Story cells ----
  async function addCell(lang) {
    if (!story) return;
    setError("");
    try {
      setStory(await api.addCell(story.id, { lang: lang === "ar" ? "ar" : "en" }));
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveStoryTitle(titles) {
    if (!story) return;
    setError("");
    try {
      setStory(await api.updateStoryTitle(story.id, titles));
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveStoryGender(gender) {
    if (!story) return;
    setError("");
    try {
      setStory(await api.updateStoryGender(story.id, gender));
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function uploadCellImage(cellId, file) {
    if (!story || !file) return;
    setError("");
    setCellBusy((b) => ({ ...b, [cellId]: true }));
    try {
      setStory(await api.uploadCellImage(story.id, cellId, file));
      refreshStories();
    } catch (err) {
      setError(err.message);
    } finally {
      setCellBusy((b) => ({ ...b, [cellId]: false }));
    }
  }

  async function saveCellText(cellId, text, style) {
    if (!story) return;
    setError("");
    try {
      setStory(await api.updateCell(story.id, cellId, { type: "text", text, style }));
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveCellElements(cellId, { elements, bgUrl, bgFalUrl, bgColor, safeZones, aiPrompt }) {
    if (!story) return;
    setError("");
    try {
      setStory(
        await api.updateCell(story.id, cellId, {
          type: "text",
          elements,
          safeZones: safeZones ?? [],
          bgUrl: bgUrl ?? null,
          bgFalUrl: bgFalUrl ?? null,
          bgColor: bgColor ?? "#faf7ef",
          ...(aiPrompt !== undefined ? { aiPrompt } : {}),
        })
      );
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function uploadCellBackground(cellId, file) {
    if (!story || !file) return;
    setError("");
    setCellBusy((b) => ({ ...b, [cellId]: true }));
    try {
      setStory(await api.uploadCellBackground(story.id, cellId, file));
      refreshStories();
    } catch (err) {
      setError(err.message);
    } finally {
      setCellBusy((b) => ({ ...b, [cellId]: false }));
    }
  }

  async function removeCellBackground(cellId) {
    if (!story) return;
    setError("");
    try {
      setStory(await api.removeCellBackground(story.id, cellId));
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteScene(sceneId) {
    if (!story) return;
    try {
      setStory(await api.deleteScene(story.id, sceneId));
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reorderScenes(orderedIds) {
    if (!story) return;
    const prev = story;
    // Optimistically reflect the new order so the drag feels instant.
    const byId = new Map(story.scenes.map((s) => [s.id, s]));
    setStory({ ...story, scenes: orderedIds.map((id) => byId.get(id)).filter(Boolean) });
    try {
      setStory(await api.reorderScenes(story.id, orderedIds));
    } catch (err) {
      setStory(prev);
      setError(err.message);
    }
  }

  async function analyzeStory() {
    if (!story) return;
    setError("");
    setAnalyzing(true);
    try {
      setStory(await api.analyzeStory(story.id));
      refreshStories();
    } catch (err) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  }

  // Manual per-page override of the identity-scoring level (strict/advisory/none).
  async function setCellScoring(cellId, level) {
    if (!story) return;
    setError("");
    try {
      setStory(
        await api.updateCell(story.id, cellId, {
          identityScoring: level,
          identityScoringManual: true,
        })
      );
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  // ---- Variables ----
  async function createVariable() {
    if (!newVarName.trim()) return setError("Give the variable a name.");
    try {
      await api.createVariable(newVarName.trim(), {
        label: newVarLabel,
        defaultValue: newVarDefault,
      });
      setNewVarName("");
      setNewVarLabel("");
      setNewVarDefault("");
      setCreatingVariable(false);
      refreshVariables();
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteVariable(id) {
    if (!confirm("Delete this variable?")) return;
    try {
      await api.deleteVariable(id);
      refreshVariables();
    } catch (e) {
      setError(e.message);
    }
  }

  // ---- Orders ----
  async function openOrder(id) {
    setError("");
    try {
      setOrder(await api.getOrder(id));
    } catch (e) {
      setError(e.message);
    }
  }

  async function createOrder() {
    if (!newOrderTitle.trim()) return setError("Give the order a name.");
    if (!newOrderStoryId) return setError("Pick a story for this order.");
    // Fill in defaults for any variable the user left blank.
    const vars = {};
    for (const v of variables) {
      const val = newOrderVars[v.name];
      vars[v.name] = val != null && val !== "" ? val : v.defaultValue || "";
    }
    try {
      const o = await api.createOrder(newOrderTitle.trim(), newOrderStoryId, { variables: vars });
      setNewOrderTitle("");
      setNewOrderStoryId("");
      setNewOrderVars({});
      setCreatingOrder(false);
      refreshOrders();
      setOrder(o);
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteOrder(id) {
    if (!confirm("Delete this order?")) return;
    try {
      await api.deleteOrder(id);
      if (order?.id === id) setOrder(null);
      refreshOrders();
    } catch (e) {
      setError(e.message);
    }
  }

  async function onUploadKid(e) {
    const file = e.target.files?.[0];
    if (!file || !order) return;
    setError("");
    try {
      setStage("uploading");
      let o = await api.uploadOrderKid(order.id, file);
      setOrder(o);
      refreshOrders();
      // Photo intake gate: an identity-unsafe photo stops here — no restore/anchor.
      if (o?.kid?.photoStatus === "needs_new_photo") {
        setError(o.kid.photoFailureReason || "Photo is not suitable. Please upload a clearer front-facing photo.");
        return;
      }
      // accepted / fixable / review → enhance. Fixable photos are re-validated
      // server-side during restore, so re-check the status afterwards.
      setStage("restoring");
      o = await api.restoreOrderKid(order.id);
      setOrder(o);
      refreshOrders();
      if (o?.kid?.photoStatus === "needs_new_photo") {
        setError(o.kid.photoFailureReason || "Photo could not be improved enough. Please upload a clearer photo.");
        return;
      }
      setStage("anchoring");
      o = await api.anchorOrderKid(order.id);
      setOrder(o);
      refreshOrders();
    } catch (err) {
      setError(err.message);
    } finally {
      setStage(null);
      if (kidInput.current) kidInput.current.value = "";
    }
  }

  async function regenerateAnchor() {
    if (!order?.kid) return;
    setError("");
    try {
      setStage("anchoring");
      setOrder(await api.anchorOrderKid(order.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setStage(null);
    }
  }

  async function generateOne(sceneId) {
    if (!order?.kid) return setError("Upload a kid photo first.");
    setBusy((b) => ({ ...b, [sceneId]: true }));
    try {
      await api.generateOrder(order.id, sceneId, prompt, { mode });
      setOrder(await api.getOrder(order.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => ({ ...b, [sceneId]: false }));
    }
  }

  async function generateAll() {
    if (!order?.kid) return setError("Upload a kid photo first.");
    setGeneratingAll(true);
    setError("");
    for (const scene of order.scenes.filter(sceneHasAiBase)) {
      setBusy((b) => ({ ...b, [scene.id]: true }));
      try {
        await api.generateOrder(order.id, scene.id, prompt, { mode });
        setOrder(await api.getOrder(order.id));
      } catch (e) {
        setError(`Scene failed: ${e.message}`);
      } finally {
        setBusy((b) => ({ ...b, [scene.id]: false }));
      }
    }
    setGeneratingAll(false);
  }

  const kid = order?.kid || null;
  const results = order?.results || {};

  return (
    <div className="flex h-full">
      <NavSidebar nav={nav} onNav={switchNav} config={config} me={me} />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">
          {error && (
            <div className="mb-4 flex items-center justify-between rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              <span>{error}</span>
              <button onClick={() => setError("")} className="text-rose-300 hover:text-white">
                ×
              </button>
            </div>
          )}

          {nav === "stories" && !story && (
            <StoriesTable
              stories={stories}
              onOpen={openStory}
              onDelete={deleteStory}
              onCreate={() => {
                setError("");
                setCreatingStory(true);
              }}
            />
          )}

          {nav === "stories" && story && !editorCellId && (
            <StoryDetail
              story={story}
              variables={variables}
              onBack={() => {
                setStory(null);
                refreshStories();
              }}
              onAddCell={addCell}
              onSaveTitle={saveStoryTitle}
              onSaveGender={saveStoryGender}
              onUploadCellImage={uploadCellImage}
              onUploadCellBackground={uploadCellBackground}
              onRemoveCellBackground={removeCellBackground}
              onSaveCellText={saveCellText}
              onOpenEditor={setEditorCellId}
              onDeleteCell={deleteScene}
              onReorderCells={reorderScenes}
              onAnalyze={analyzeStory}
              analyzing={analyzing}
              onSetCellScoring={setCellScoring}
              cellBusy={cellBusy}
              config={config}
              onStoryChange={setStory}
            />
          )}

          {nav === "stories" && story && editorCellId && (() => {
            const c = story.scenes.find((s) => s.id === editorCellId);
            if (!c) return null;
            const idx = story.scenes.findIndex((s) => s.id === editorCellId);
            const label =
              idx === 0 ? "Cover" : idx === story.scenes.length - 1 ? "Back cover" : `Page ${idx + 1}`;
            return (
              <CellEditor
                cell={c}
                label={label}
                aspect={story.aspect || "3:4"}
                variables={variables}
                customSymbols={customSymbols}
                onSaveSymbol={saveSymbol}
                onDeleteSymbol={deleteCustomSymbol}
                onUploadMedia={(file) => api.uploadMedia(file)}
                onSave={saveCellElements}
                onClose={() => setEditorCellId(null)}
              />
            );
          })()}

          {nav === "variables" && (
            <VariablesTable
              variables={variables}
              onDelete={deleteVariable}
              onCreate={() => {
                setError("");
                setCreatingVariable(true);
              }}
            />
          )}

          {nav === "settings" && canAccess("settings") && (
            <SettingsPage
              onError={setError}
              onSaved={() => api.config().then(setConfig).catch(() => {})}
            />
          )}

          {nav === "access" && canAccess("access") && (
            <AccessPage me={me} onError={setError} />
          )}

          {nav === "orders" && !order && (
            <OrdersTable
              orders={orders}
              onOpen={openOrder}
              onDelete={deleteOrder}
              onCreate={() => {
                setError("");
                if (stories.length === 0) {
                  setError("Create a story first, then you can make an order.");
                  return;
                }
                setCreatingOrder(true);
              }}
            />
          )}

          {nav === "orders" && order && (
            <OrderDetail
              order={order}
              kid={kid}
              results={results}
              onBack={() => {
                setOrder(null);
                refreshOrders();
              }}
              onDelete={() => deleteOrder(order.id)}
              kidInput={kidInput}
              onUploadKid={onUploadKid}
              stage={stage}
              kidBusy={kidBusy}
              regenerateAnchor={regenerateAnchor}
              mode={mode}
              setMode={setMode}
              prompt={prompt}
              setPrompt={setPrompt}
              showPrompt={showPrompt}
              setShowPrompt={setShowPrompt}
              generateAll={generateAll}
              generateOne={generateOne}
              generatingAll={generatingAll}
              busy={busy}
              config={config}
            />
          )}
        </div>
      </main>

      {creatingStory && (
        <Modal title="Create story" onClose={() => setCreatingStory(false)}>
          <p className="text-sm text-zinc-400">
            A new draft story will be created. You can set its title, child, and pages on the next
            screen.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setCreatingStory(false)}
              className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm text-zinc-300 hover:bg-[var(--color-panel-2)]"
            >
              Cancel
            </button>
            <button
              onClick={createStory}
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black"
            >
              Create
            </button>
          </div>
        </Modal>
      )}

      {creatingOrder && (
        <Modal title="Create order" onClose={() => setCreatingOrder(false)}>
          <label className="block text-xs uppercase tracking-wide text-zinc-500">Order name</label>
          <input
            autoFocus
            value={newOrderTitle}
            onChange={(e) => setNewOrderTitle(e.target.value)}
            placeholder="e.g. Hessa"
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
          />
          <label className="mt-3 block text-xs uppercase tracking-wide text-zinc-500">Story</label>
          <select
            value={newOrderStoryId}
            onChange={(e) => setNewOrderStoryId(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
          >
            <option value="">Choose a story…</option>
            {stories
              .filter((s) => s.status === "published")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.scenes.length} cells)
                </option>
              ))}
          </select>
          {stories.filter((s) => s.status === "published").length === 0 && (
            <p className="mt-1 text-xs text-amber-300">
              No published stories yet. Open a story, test it, and publish it before taking orders.
            </p>
          )}
          {variables.length > 0 && (
            <div className="mt-3">
              <label className="block text-xs uppercase tracking-wide text-zinc-500">
                Variable values
              </label>
              <div className="mt-1 space-y-2">
                {variables.map((v) => (
                  <div key={v.id} className="flex items-center gap-2">
                    <span className="w-32 shrink-0 truncate font-mono text-xs text-[var(--color-accent)]">
                      {`{{${v.name}}}`}
                    </span>
                    <input
                      value={newOrderVars[v.name] ?? ""}
                      onChange={(e) =>
                        setNewOrderVars((m) => ({ ...m, [v.name]: e.target.value }))
                      }
                      placeholder={v.defaultValue || v.label}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setCreatingOrder(false)}
              className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm text-zinc-300 hover:bg-[var(--color-panel-2)]"
            >
              Cancel
            </button>
            <button
              onClick={createOrder}
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black"
            >
              Create
            </button>
          </div>
        </Modal>
      )}

      {creatingVariable && (
        <Modal title="Create variable" onClose={() => setCreatingVariable(false)}>
          <label className="block text-xs uppercase tracking-wide text-zinc-500">
            Name (used as {"{{Name}}"})
          </label>
          <input
            autoFocus
            value={newVarName}
            onChange={(e) => setNewVarName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createVariable()}
            placeholder="e.g. Child_Name"
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 font-mono text-sm focus:border-[var(--color-accent)] focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-zinc-600">
            Letters, numbers and underscores only. Spaces become underscores.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wide text-zinc-500">
                Label (optional)
              </label>
              <input
                value={newVarLabel}
                onChange={(e) => setNewVarLabel(e.target.value)}
                placeholder="Child's name"
                className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-zinc-500">
                Default (optional)
              </label>
              <input
                value={newVarDefault}
                onChange={(e) => setNewVarDefault(e.target.value)}
                placeholder="e.g. friend"
                className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setCreatingVariable(false)}
              className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm text-zinc-300 hover:bg-[var(--color-panel-2)]"
            >
              Cancel
            </button>
            <button
              onClick={createVariable}
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black"
            >
              Create
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ============================ VARIABLES TABLE ============================ */
function VariablesTable({ variables, onDelete, onCreate }) {
  return (
    <>
      <PageHeader
        title="Variables"
        subtitle={`${variables.length} variable${variables.length === 1 ? "" : "s"} · insert into text cells as {{Name}}`}
        actionLabel="+ Create variable"
        onAction={onCreate}
      />
      {variables.length === 0 ? (
        <EmptyTable text="No variables yet. Create one (e.g. Child_Name) and use it in story text cells." />
      ) : (
        <Table head={["Token", "Label", "Default", "Created", ""]}>
          {variables.map((v) => (
            <tr key={v.id} className="border-t border-[var(--color-border)]">
              <Td className="font-mono text-[var(--color-accent)]">{`{{${v.name}}}`}</Td>
              <Td className="text-zinc-300">{v.label}</Td>
              <Td className="text-zinc-400">{v.defaultValue || "—"}</Td>
              <Td className="text-zinc-400">{fmtDate(v.createdAt)}</Td>
              <Td className="text-right">
                <button
                  onClick={() => onDelete(v.id)}
                  className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
                >
                  Delete
                </button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

/* ============================ NAV SIDEBAR ============================ */
function NavSidebar({ nav, onNav, config, me }) {
  const allItems = [
    { id: "stories", label: "Stories", icon: "📖" },
    { id: "orders", label: "Orders", icon: "🧾" },
    { id: "variables", label: "Variables", icon: "🔤" },
    { id: "settings", label: "Settings", icon: "⚙️", adminOnly: true },
    { id: "access", label: "Access", icon: "👥", adminOnly: true },
  ];
  const allowed = me?.isAdmin
    ? [...new Set([...(me?.pages || []), ...ADMIN_ONLY_PAGES])]
    : me?.pages || [];
  const items = allItems.filter((it) => allowed.includes(it.id));

  return (
    <aside className="flex w-64 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="border-b border-[var(--color-border)] px-5 py-4">
        <div className="text-lg font-semibold">
          Hazawy <span className="text-[var(--color-accent)]">Studio</span>
        </div>
        <div className="mt-1 text-xs text-zinc-500">personalized storybooks</div>
      </div>

      <nav className="flex-1 p-3">
        {items.map((it) => (
          <button
            key={it.id}
            onClick={() => onNav(it.id)}
            className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
              nav === it.id
                ? "bg-[var(--color-panel-2)] text-white"
                : "text-zinc-400 hover:bg-[var(--color-panel-2)]/60 hover:text-zinc-200"
            }`}
          >
            <span className="text-base">{it.icon}</span>
            {it.label}
          </button>
        ))}
      </nav>

      {me?.email && (
        <div className="flex items-center gap-3 border-t border-[var(--color-border)] px-4 py-3">
          <UserButton afterSignOutUrl="/" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-zinc-300">{me.email}</div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">{me.role}</div>
          </div>
        </div>
      )}

      <div className="border-t border-[var(--color-border)] px-4 py-3 text-xs">
        <StatusDot ok={config?.falConfigured} label="fal.ai" />
        <StatusDot ok={config?.checkerEnabled} label="AI checker" muted />
      </div>
    </aside>
  );
}

/* ============================ ACCESS ============================ */
function AccessPage({ me, onError }) {
  const [data, setData] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [pages, setPages] = useState(["stories", "orders"]);
  const [inviting, setInviting] = useState(false);

  const assignable = data?.assignablePages || ["stories", "orders", "variables"];

  function load() {
    api
      .listAccessUsers()
      .then(setData)
      .catch((e) => onError?.(e.message));
  }

  useEffect(() => {
    load();
  }, []);

  function togglePage(set, setter, page) {
    setter(set.includes(page) ? set.filter((p) => p !== page) : [...set, page]);
  }

  async function invite() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return onError?.("Enter an email address.");
    onError?.("");
    setInviting(true);
    try {
      await api.inviteAccessUser(trimmed, {
        role,
        pages: role === "admin" ? assignable : pages,
      });
      setEmail("");
      setRole("member");
      setPages(["stories", "orders"]);
      load();
    } catch (e) {
      onError?.(e.message);
    } finally {
      setInviting(false);
    }
  }

  async function changeUser(userEmail, patch) {
    onError?.("");
    try {
      await api.updateAccessUser(userEmail, patch);
      load();
    } catch (e) {
      onError?.(e.message);
    }
  }

  async function removeUser(userEmail) {
    if (!confirm(`Remove access for ${userEmail}?`)) return;
    onError?.("");
    try {
      await api.deleteAccessUser(userEmail);
      load();
    } catch (e) {
      onError?.(e.message);
    }
  }

  const users = data?.users || [];

  return (
    <>
      <PageHeader
        title="Access"
        subtitle="Invite people and choose which pages they can open."
      />

      {data && data.authEnabled === false && (
        <div className="mb-6 rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          Login is not enabled yet — everyone currently has full access. Add{" "}
          <code className="font-mono">CLERK_SECRET_KEY</code> to <code className="font-mono">server/.env</code>{" "}
          and <code className="font-mono">VITE_CLERK_PUBLISHABLE_KEY</code> to{" "}
          <code className="font-mono">web/.env.local</code> to turn on sign-in and enforce these
          permissions.
        </div>
      )}

      <div className="max-w-3xl space-y-6">
        <Section title="Invite someone">
          <p className="mb-3 text-sm text-zinc-400">
            They sign in with this email (via the login screen). New people get the pages you pick
            below.
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              autoComplete="off"
              className="min-w-[220px] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none"
            >
              <option value="member">Member</option>
              <option value="admin">Admin (full access)</option>
            </select>
          </div>

          {role === "member" && (
            <div className="mb-3 flex flex-wrap gap-2">
              {assignable.map((p) => (
                <PageChip
                  key={p}
                  label={PAGE_LABELS[p] || p}
                  active={pages.includes(p)}
                  onClick={() => togglePage(pages, setPages, p)}
                />
              ))}
            </div>
          )}

          <button
            onClick={invite}
            disabled={inviting}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-60"
          >
            {inviting && <Spinner />}
            Invite
          </button>
        </Section>

        <Section title={`People with access (${users.length})`}>
          {users.length === 0 ? (
            <p className="text-sm text-zinc-500">No one yet. Invite someone above.</p>
          ) : (
            <div className="space-y-3">
              {users.map((u) => {
                const isMe = me?.email && u.email === me.email;
                return (
                  <div
                    key={u.email}
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 p-4"
                  >
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-zinc-100">
                          {u.email} {isMe && <span className="text-xs text-zinc-500">(you)</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          value={u.role}
                          disabled={isMe}
                          onChange={(e) => changeUser(u.email, { role: e.target.value })}
                          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button
                          onClick={() => removeUser(u.email)}
                          disabled={isMe}
                          className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    {u.role === "admin" ? (
                      <div className="text-xs text-zinc-500">Full access to all pages.</div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {assignable.map((p) => (
                          <PageChip
                            key={p}
                            label={PAGE_LABELS[p] || p}
                            active={(u.pages || []).includes(p)}
                            onClick={() => {
                              const current = u.pages || [];
                              const nextPages = current.includes(p)
                                ? current.filter((x) => x !== p)
                                : [...current, p];
                              changeUser(u.email, { pages: nextPages });
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

function PageChip({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          : "border-[var(--color-border)] text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );
}

/* ============================ SETTINGS ============================ */
const FAL_MODELS = [
  { id: "nano_banana", label: "Nano Banana 2", endpoint: "fal-ai/nano-banana-2" },
  { id: "gpt_image_2", label: "GPT Image 2", endpoint: "openai/gpt-image-2" },
];

function SettingsPage({ onError, onSaved }) {
  const [tab, setTab] = useState("general");
  const [settings, setSettings] = useState(null);
  const [falKey, setFalKey] = useState("");
  const [showFal, setShowFal] = useState(false);
  const [model, setModel] = useState("nano_banana");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        setModel(s.anchorProvider || "nano_banana");
      })
      .catch((e) => onError?.(e.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    onError?.("");
    setSaving(true);
    setSaved(false);
    try {
      const patch = { anchorProvider: model };
      if (falKey.trim()) patch.falKey = falKey.trim();
      const s = await api.saveSettings(patch);
      setSettings(s);
      setModel(s.anchorProvider || "nano_banana");
      setFalKey("");
      setShowFal(false);
      setSaved(true);
      onSaved?.();
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      onError?.(e.message);
    } finally {
      setSaving(false);
    }
  }

  const selectedModel = FAL_MODELS.find((m) => m.id === model);

  return (
    <>
      <PageHeader title="Settings" subtitle="fal.ai key, the model, and test images for this server." />

      <div className="mb-6 flex gap-1 border-b border-[var(--color-border)]">
        {[
          { id: "general", label: "General" },
          { id: "test-images", label: "Test images" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-[var(--color-accent)] text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "test-images" ? (
        <TestImagesSettings onError={onError} />
      ) : (
      <div className="max-w-2xl space-y-6">
        <Section title="fal.ai API key">
          <p className="mb-3 text-sm text-zinc-400">
            Used for all image generation, photo restore, and the AI checker. Get one from{" "}
            <a
              href="https://fal.ai/dashboard/keys"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] hover:underline"
            >
              fal.ai/dashboard/keys
            </a>
            .
          </p>
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span
              className={`h-2 w-2 rounded-full ${
                settings?.falKey?.set ? "bg-[var(--color-accent-2)]" : "bg-rose-500"
              }`}
            />
            <span className="text-zinc-400">
              {settings?.falKey?.set
                ? `Configured (${settings.falKey.masked})`
                : "Not configured"}
            </span>
          </div>
          <KeyInput
            value={falKey}
            onChange={setFalKey}
            show={showFal}
            onToggle={() => setShowFal((v) => !v)}
            placeholder={settings?.falKey?.set ? "Enter a new key to replace" : "Paste your FAL_KEY"}
          />
        </Section>

        <Section title="Model">
          <p className="mb-3 text-sm text-zinc-400">
            The fal.ai model used for image generation.
          </p>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none"
          >
            {FAL_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {selectedModel && (
            <p className="mt-2 font-mono text-xs text-zinc-500">{selectedModel.endpoint}</p>
          )}
        </Section>

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving && <Spinner />}
            Save settings
          </button>
          {saved && <span className="text-sm text-[var(--color-accent-2)]">Saved ✓</span>}
        </div>
      </div>
      )}
    </>
  );
}

// Settings → Test images tab. A shared panel of up to 4 girl + 4 boy reference
// photos. Stories test against the set that matches their gender.
function TestImagesSettings({ onError }) {
  const [lib, setLib] = useState({ girl: [], boy: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const girlRef = useRef(null);
  const boyRef = useRef(null);

  useEffect(() => {
    api
      .getTestImages()
      .then(setLib)
      .catch((e) => onError?.(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function onUpload(gender, e) {
    const files = Array.from(e.target.files || []);
    if (gender === "girl" && girlRef.current) girlRef.current.value = "";
    if (gender === "boy" && boyRef.current) boyRef.current.value = "";
    if (!files.length) return;
    onError?.("");
    setBusy(true);
    try {
      let next = lib;
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        next = await api.uploadTestImage(gender, file);
      }
      setLib(next);
    } catch (e2) {
      onError?.(e2.message);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id) {
    onError?.("");
    setBusy(true);
    try {
      setLib(await api.deleteTestImage(id));
    } catch (e2) {
      onError?.(e2.message);
    } finally {
      setBusy(false);
    }
  }

  const groups = [
    { gender: "girl", label: "Girls", ref: girlRef },
    { gender: "boy", label: "Boys", ref: boyRef },
  ];

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-zinc-400">
        Upload up to 4 girl and 4 boy reference photos. When you test a story, it automatically runs
        against the set that matches the story's gender — no need to upload test children each time.
      </p>
      {groups.map(({ gender, label, ref }) => {
        const items = lib[gender] || [];
        const full = items.length >= 4;
        return (
          <Section key={gender} title={`${label} (${items.length}/4)`}>
            <div className="grid grid-cols-4 gap-3">
              {items.map((img) => (
                <div
                  key={img.id}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]"
                >
                  <img src={img.localUrl} alt="" className="h-full w-full object-cover" />
                  <button
                    onClick={() => onDelete(img.id)}
                    disabled={busy}
                    title="Remove"
                    className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white opacity-0 transition-opacity hover:bg-rose-600 group-hover:opacity-100 disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              ))}
              {!full && !loading && (
                <button
                  onClick={() => ref.current?.click()}
                  disabled={busy}
                  className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-panel-2)] text-2xl text-zinc-500 hover:border-[var(--color-accent)] hover:text-zinc-300 disabled:opacity-40"
                >
                  +
                </button>
              )}
            </div>
            <input
              ref={ref}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => onUpload(gender, e)}
            />
          </Section>
        );
      })}
      {busy && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Spinner /> Saving…
        </div>
      )}
    </div>
  );
}

function KeyInput({ value, onChange, show, onToggle, placeholder }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none"
      />
      <button
        onClick={onToggle}
        type="button"
        className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-zinc-300 hover:bg-[var(--color-panel-2)]"
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

/* ============================ TABLES ============================ */
function PageHeader({ title, subtitle, actionLabel, onAction, actionDisabled, headerAction, children }) {
  return (
    <header className="mb-6 flex items-center justify-between">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {children}
        </div>
        {subtitle && <p className="text-sm text-zinc-400">{subtitle}</p>}
      </div>
      {headerAction
        ? headerAction
        : actionLabel && (
            <button
              onClick={onAction}
              disabled={actionDisabled}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-60"
            >
              {actionDisabled && <Spinner />}
              {actionLabel}
            </button>
          )}
    </header>
  );
}

// Draft / Published lifecycle chip.
function StatusPill({ status }) {
  const published = status === "published";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
        published
          ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
          : "border-amber-400/40 bg-amber-400/10 text-amber-200"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${published ? "bg-emerald-300" : "bg-amber-300"}`} />
      {published ? "Published" : "Draft"}
    </span>
  );
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StoriesTable({ stories, onOpen, onDelete, onCreate }) {
  return (
    <>
      <PageHeader
        title="Stories"
        subtitle={`${stories.length} stor${stories.length === 1 ? "y" : "ies"}`}
        actionLabel="+ Create story"
        onAction={onCreate}
      />
      {stories.length === 0 ? (
        <EmptyTable text="No stories yet. Create one and upload its scene templates." />
      ) : (
        <Table head={["Title", "Status", "Child", "Scenes", "Created"]}>
          {stories.map((s) => {
            const genderLabel =
              s.gender === "male" ? "Boy" : s.gender === "non-binary" ? "Child" : "Girl";
            return (
            <tr
              key={s.id}
              onClick={() => onOpen(s.id)}
              className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-panel-2)]/40"
            >
              <Td className="font-medium text-zinc-100">{s.title}</Td>
              <Td>
                <StatusPill status={s.status} />
              </Td>
              <Td className="text-zinc-400">{genderLabel}</Td>
              <Td>{s.scenes.length}</Td>
              <Td className="text-zinc-400">{fmtDate(s.createdAt)}</Td>
            </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}

// Human-facing order reference derived from the order's unique id.
function orderRef(id) {
  return `ORD-${String(id || "").toUpperCase()}`;
}

function OrdersTable({ orders, onOpen, onDelete, onCreate }) {
  return (
    <>
      <PageHeader
        title="Orders"
        subtitle={`${orders.length} order${orders.length === 1 ? "" : "s"}`}
        actionLabel="+ Create order"
        onAction={onCreate}
      />
      {orders.length === 0 ? (
        <EmptyTable text="No orders yet. Create one, choose a story, and upload a kid's photo." />
      ) : (
        <Table head={["Order", "Order ID", "Child", "Story", "Photo", "Generated", "Created"]}>
          {orders.map((o) => {
            const generated = Object.keys(o.results || {}).length;
            const genderLabel =
              o.gender === "male" ? "Boy" : o.gender === "non-binary" ? "Child" : "Girl";
            return (
              <tr
                key={o.id}
                onClick={() => onOpen(o.id)}
                className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-panel-2)]/40"
              >
                <Td className="font-medium text-zinc-100">{o.title}</Td>
                <Td className="font-mono text-xs text-zinc-500">{orderRef(o.id)}</Td>
                <Td className="text-zinc-400">{genderLabel}</Td>
                <Td className="text-zinc-400">{o.storyTitle}</Td>
                <Td>
                  {o.kid ? (
                    <span className="text-[var(--color-accent-2)]">✓</span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </Td>
                <Td>
                  {generated}/{o.scenes.length}
                </Td>
                <Td className="text-zinc-400">{fmtDate(o.createdAt)}</Td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}

function Table({ head, children }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, className = "" }) {
  return <td className={`px-4 py-3 ${className}`}>{children}</td>;
}

function RowActions({ onOpen, onDelete }) {
  return (
    <span className="inline-flex gap-2">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1 text-xs hover:bg-[#242838]"
      >
        Open
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
      >
        Delete
      </button>
    </span>
  );
}

function EmptyTable({ text }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-panel)] px-6 py-16 text-center text-sm text-zinc-500">
      {text}
    </div>
  );
}

function BackButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
    >
      ← Back
    </button>
  );
}

/* ============================ STORY DETAIL ============================ */
// Per-language title input shown under the active Book-layout tab. Buffers
// locally and commits on blur / Enter so typing stays smooth.
function StoryTitleField({ lang, value, onSave }) {
  const [val, setVal] = useState(value || "");
  const isRtl = lang === "ar";
  useEffect(() => {
    setVal(value || "");
  }, [value, lang]);
  const commit = () => {
    const t = val.trim();
    if (t === (value || "").trim()) return;
    onSave(isRtl ? { titleAr: t } : { titleEn: t });
  };
  return (
    <div className="mb-3 max-w-md">
      <label className="block text-xs uppercase tracking-wide text-zinc-500">
        {isRtl ? "العنوان (بالعربية)" : "Title (English)"}
      </label>
      <input
        dir={isRtl ? "rtl" : "ltr"}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        placeholder={isRtl ? "مثال: تاج الأميرة" : "e.g. The Princess Crown"}
        className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
      />
    </div>
  );
}

function StoryDetail({
  story,
  variables,
  onBack,
  onAddCell,
  onSaveTitle,
  onSaveGender,
  onUploadCellImage,
  onUploadCellBackground,
  onRemoveCellBackground,
  onSaveCellText,
  onOpenEditor,
  onDeleteCell,
  onReorderCells,
  onAnalyze,
  analyzing,
  onSetCellScoring,
  cellBusy,
  config,
  onStoryChange,
}) {
  // Each story holds two independent books — English and Arabic. The tab below
  // scopes the Book layout to the active language; every cell is tagged with
  // `lang` and only the active language's pages are shown/edited here.
  const [bookLang, setBookLang] = useState("en");
  const [publishing, setPublishing] = useState(false);
  const [copyingLang, setCopyingLang] = useState(false);
  const langCells = (story.scenes || []).filter((s) => (s.lang || "en") === bookLang);
  const isRtl = bookLang === "ar";
  const isPublished = story.status === "published";

  // The opposite language book — the source when copying pages across languages.
  const otherLang = bookLang === "ar" ? "en" : "ar";
  const otherLangLabel = otherLang === "ar" ? "Arabic" : "English";
  const otherLangCount = (story.scenes || []).filter((s) => (s.lang || "en") === otherLang).length;

  async function copyFromOtherLang() {
    if (otherLangCount === 0) return;
    if (
      langCells.length > 0 &&
      !confirm(
        `Replace the ${isRtl ? "Arabic" : "English"} book (${langCells.length} page${
          langCells.length === 1 ? "" : "s"
        }) with a copy of the ${otherLangLabel} book?`
      )
    )
      return;
    setCopyingLang(true);
    try {
      onStoryChange(await api.copyCellLanguage(story.id, otherLang, bookLang));
    } catch (e) {
      alert(e.message);
    } finally {
      setCopyingLang(false);
    }
  }

  async function togglePublish() {
    setPublishing(true);
    try {
      onStoryChange(
        await (isPublished ? api.unpublishStory(story.id) : api.publishStory(story.id))
      );
    } catch (e) {
      // Surface as an alert; the detailed test/error UI lives in the panel below.
      alert(e.message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <>
      <BackButton onClick={onBack} />
      <PageHeader
        title={story.title}
        subtitle={`${story.scenes.length} cell${story.scenes.length === 1 ? "" : "s"} · ${
          story.gender === "male" ? "Boy" : story.gender === "non-binary" ? "Child" : "Girl"
        }${story.age ? `, age ${story.age}` : ""} · ${story.aspect || "3:4"}`}
        headerAction={
          <button
            onClick={togglePublish}
            disabled={publishing}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
              isPublished
                ? "border border-[var(--color-border)] bg-[var(--color-panel-2)] text-zinc-200 hover:bg-[#242838]"
                : "bg-[var(--color-accent)] text-black hover:opacity-90"
            }`}
          >
            {publishing && <Spinner />}
            {isPublished ? "Unpublish" : publishing ? "Publishing…" : "Publish story"}
          </button>
        }
      >
        <StatusPill status={story.status} />
      </PageHeader>
      <div className="mb-4 flex items-center gap-3">
        <span className="text-xs uppercase tracking-wide text-zinc-500">Child</span>
        <div className="flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-1">
          {[
            { id: "female", label: "Girl" },
            { id: "male", label: "Boy" },
          ].map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onSaveGender(g.id)}
              className={`rounded px-4 py-1 text-xs font-medium transition ${
                (story.gender || "female") === g.id
                  ? "bg-[var(--color-accent)] text-black"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>
      <Section step="" title="Book layout">
        <div className="mb-4 flex w-full max-w-xs gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-1">
          {[
            { id: "en", label: "English" },
            { id: "ar", label: "العربية" },
          ].map((t) => {
            const count = (story.scenes || []).filter((s) => (s.lang || "en") === t.id).length;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setBookLang(t.id)}
                className={`flex-1 rounded px-2 py-1.5 text-xs font-medium transition ${
                  bookLang === t.id
                    ? "bg-[var(--color-accent)] text-black"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {t.label}
                <span className={bookLang === t.id ? "opacity-70" : "opacity-50"}> · {count}</span>
              </button>
            );
          })}
        </div>
        <StoryTitleField
          lang={bookLang}
          value={isRtl ? story.titleAr || "" : story.titleEn || ""}
          onSave={onSaveTitle}
        />
        <p className="mb-3 text-xs text-zinc-600">
          The first cell is the front cover (alone), the last is the back cover (alone), and the
          inner cells pair up into two-page spreads. Fill each cell with a photo or text and drag to
          rearrange. In text, type a variable like{" "}
          <span className="font-mono text-[var(--color-accent)]">{"{{Child_Name}}"}</span> and it
          will be filled in per order. This is the{" "}
          <span className="font-semibold text-zinc-400">{isRtl ? "Arabic" : "English"}</span> book —
          its pages are independent from the other language.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => onAddCell(bookLang)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838]"
          >
            + Add cell
          </button>
          {otherLangCount > 0 && (
            <button
              onClick={copyFromOtherLang}
              disabled={copyingLang}
              title={`Replace this book with a copy of the ${otherLangLabel} book (${otherLangCount} page${
                otherLangCount === 1 ? "" : "s"
              })`}
              className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
            >
              {copyingLang && <Spinner />}
              {copyingLang ? "Copying…" : `⧉ Copy from ${otherLangLabel}`}
            </button>
          )}
          {langCells.length > 0 && (
            <button
              onClick={() => onAnalyze()}
              disabled={analyzing}
              title="Scan each page and decide how its identity match should be scored per order"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
            >
              {analyzing ? "Analyzing…" : "✦ Analyze scenes"}
            </button>
          )}
          <span className="text-[11px] text-zinc-600">
            Analyze sets each page to{" "}
            <span className="text-emerald-300/80">strict</span> /{" "}
            <span className="text-amber-300/80">advisory</span> /{" "}
            <span className="text-zinc-400">none</span> for per-order identity scoring.
          </span>
        </div>
        {langCells.length > 0 ? (
          <div dir={isRtl ? "rtl" : "ltr"}>
            <CellBook
              cells={langCells}
              aspect={story.aspect || "3:4"}
              variables={variables}
              cellBusy={cellBusy}
              onUploadImage={onUploadCellImage}
              onUploadBackground={onUploadCellBackground}
              onRemoveBackground={onRemoveCellBackground}
              onSaveText={onSaveCellText}
              onOpenEditor={onOpenEditor}
              onDelete={onDeleteCell}
              onReorder={onReorderCells}
              onSetCellScoring={onSetCellScoring}
            />
          </div>
        ) : (
          <p className="text-sm text-zinc-500">
            No {isRtl ? "Arabic" : "English"} cells yet. Add your first cell — it becomes the cover
            for this language.
          </p>
        )}
      </Section>

      <TestPanel story={story} config={config} onStoryChange={onStoryChange} />
    </>
  );
}

/* ============================ TEST & PUBLISH ============================ */
const DEFAULT_STYLE = {
  artStyle: "illustration",
  faceColorMatch: "normal",
  colorNote: "",
  notes: "",
  childFaceStyle: "match_story",
};

// Story-wide AI generation knobs (art style/realism, face-color match, palette,
// free-text directives). Applied to every page and replayed by orders.
function StoryStyleSettings({ value, onSave, busy, sources = [], onExtract }) {
  const initial = { ...DEFAULT_STYLE, ...(value || {}) };
  const [form, setForm] = useState(initial);
  const [open, setOpen] = useState(false);
  const [srcId, setSrcId] = useState(sources[0]?.id || "");
  const [extracting, setExtracting] = useState(false);
  // Re-seed when the story's saved settings change underneath us.
  useEffect(() => {
    setForm({ ...DEFAULT_STYLE, ...(value || {}) });
  }, [value?.artStyle, value?.childFaceStyle, value?.faceColorMatch, value?.colorNote, value?.notes]);
  useEffect(() => {
    if (!srcId && sources[0]?.id) setSrcId(sources[0].id);
  }, [sources, srcId]);

  const dirty = JSON.stringify(form) !== JSON.stringify({ ...DEFAULT_STYLE, ...(value || {}) });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function doExtract() {
    if (!srcId || !onExtract) return;
    setExtracting(true);
    try {
      const got = await onExtract(srcId);
      if (got)
        setForm((f) => ({
          ...f,
          artStyle: got.artStyle || f.artStyle,
          colorNote: got.colorNote ?? f.colorNote,
          notes: got.notes ? got.notes : f.notes,
        }));
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div className="mb-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left text-sm font-semibold text-zinc-200"
      >
        <span>Story AI style {dirty && <span className="text-amber-300">· unsaved</span>}</span>
        <span className="text-xs text-zinc-500">{open ? "▾ hide" : "▸ show"}</span>
      </button>
      {open && (
        <div className="mt-4 space-y-4">
          {sources.length > 0 && onExtract && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-panel)]/40 p-2.5">
              <span className="text-xs text-zinc-400">Auto-fill style from a page:</span>
              <select
                value={srcId}
                onChange={(e) => setSrcId(e.target.value)}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-xs focus:border-[var(--color-accent)] focus:outline-none"
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button
                onClick={doExtract}
                disabled={extracting || !srcId}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
              >
                {extracting ? "Reading…" : "✦ Extract style"}
              </button>
              <span className="text-[11px] text-zinc-600">
                Reads art style + palette from the approved render (or template).
              </span>
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Art style / realism
              </span>
              <select
                value={form.artStyle}
                onChange={(e) => set("artStyle", e.target.value)}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
              >
                <option value="illustration">Illustration (storybook)</option>
                <option value="semi_real">Semi-real (painterly)</option>
                <option value="photoreal">Photoreal (lifelike photo)</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Child face style
              </span>
              <select
                value={form.childFaceStyle}
                onChange={(e) => set("childFaceStyle", e.target.value)}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
              >
                <option value="match_story">Match story style</option>
                <option value="semi_realistic">Semi-realistic child face</option>
                <option value="realistic">Realistic child face</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Face / skin-tone match
              </span>
              <select
                value={form.faceColorMatch}
                onChange={(e) => set("faceColorMatch", e.target.value)}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
              >
                <option value="normal">Normal</option>
                <option value="strong">Strong (fix pale / washed-out faces)</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
              Color / palette note
            </span>
            <input
              value={form.colorNote}
              onChange={(e) => set("colorNote", e.target.value)}
              placeholder="e.g. warm golden-hour tones, soft pastels"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
              Global directives (applied to every page)
            </span>
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
              placeholder="e.g. keep the child's full hair length; soft cinematic lighting"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onSave(form)}
              disabled={busy}
              className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Saving…" : dirty ? "Save style" : "Saved ✓"}
            </button>
            {dirty && (
              <button
                onClick={() => setForm({ ...DEFAULT_STYLE, ...(value || {}) })}
                disabled={busy}
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                Reset
              </button>
            )}
            <span className="text-[11px] text-zinc-600">
              Changing style returns the story to draft for re-testing.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const GEN_CHOICE_LABELS = [
  ["", "Default (face likeness)"],
  ["face", "Face likeness (keeps hair)"],
  ["compose", "Compose"],
  ["headswap", "Head swap"],
  ["identity", "Identity"],
  ["faceswap", "Face swap"],
];

// Validate a story before publishing: upload a small panel of test children, run
// the same generation pipeline orders use, and approve every AI page for every
// child. Any regenerate or edit drops the story back to draft.
function TestPanel({ story, config, onStoryChange }) {
  const [stageByKid, setStageByKid] = useState({}); // kidId -> "uploading"|"restoring"|"anchoring"
  const [genBusy, setGenBusy] = useState({}); // `${kidId}:${sceneId}` -> bool
  const [working, setWorking] = useState(false); // publish/unpublish/delete
  const [err, setErr] = useState("");
  const [draftCorr, setDraftCorr] = useState({}); // sceneId -> in-progress correction text
  // Batch upload of test children: a visible queue processed sequentially.
  const [batch, setBatch] = useState([]); // queue items (see onSelectFiles)
  const [batchRunning, setBatchRunning] = useState(false);
  const [libLoading, setLibLoading] = useState(false);
  const cancelRef = useRef(false);

  // The Settings test-image bucket that matches this story's gender.
  const genderBucket = story.gender === "male" ? "boy" : "girl";

  const kids = Object.values(story.kids || {});
  const aiScenes = (story.scenes || []).filter(sceneHasAiBase);
  const sceneLabel = (sceneId) => {
    const i = story.scenes.findIndex((s) => s.id === sceneId);
    if (i === 0) return "Cover";
    if (i === story.scenes.length - 1) return "Back cover";
    return `Page ${i + 1}`;
  };

  const totalCells = kids.length * aiScenes.length;
  const approvedCells = kids.reduce(
    (n, k) => n + aiScenes.filter((s) => isPageApproved(story.results?.[k.id]?.[s.id])).length,
    0
  );
  async function refresh() {
    const s = await api.getStory(story.id);
    onStoryChange(s);
    return s;
  }

  const updateItem = (id, patch) =>
    setBatch((b) => b.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  // Process one queued child through the full pipeline: upload → photo check →
  // (conditional) restore → anchor → generate every AI page. Never throws; a
  // failure is recorded on the item so the batch keeps going.
  async function processOne(item) {
    const id = item.id;
    const set = (patch) => updateItem(id, patch);
    try {
      set({ status: "uploading", progress: "Uploading…", error: "" });
      const { kidId, kid } = await api.uploadKid(story.id, item.file);
      set({ kidId, status: "checking", progress: "Checking photo…", photoStatus: kid?.photoStatus });
      await refresh();
      if (kid?.photoStatus === "needs_new_photo") {
        set({ status: "needs_new_photo", progress: "Needs new photo", error: kid.photoFailureReason || "Photo is not suitable." });
        return;
      }
      // "review" (e.g. side/profile) must not auto-process — the anchor must not invent a face.
      if (kid?.photoStatus === "review") {
        set({ status: "needs_review", progress: "Needs review", error: kid.photoFailureReason || "" });
        return;
      }
      set({ status: "restoring", progress: "Restoring…" });
      const restored = await api.restoreKid(story.id, kidId);
      await refresh();
      set({ photoStatus: restored?.kid?.photoStatus });
      if (restored?.kid?.photoStatus === "needs_new_photo") {
        set({ status: "needs_new_photo", progress: "Needs new photo", error: restored.kid.photoFailureReason || "Could not improve photo." });
        return;
      }
      if (restored?.kid?.photoStatus === "review") {
        set({ status: "needs_review", progress: "Needs review", error: restored.kid.photoFailureReason || "" });
        return;
      }
      set({ status: "anchoring", progress: "Anchoring…" });
      await api.anchorKid(story.id, kidId);
      let s = await refresh();
      // Generate every AI page sequentially so we don't overload fal.ai.
      for (let i = 0; i < aiScenes.length; i++) {
        if (cancelRef.current) break;
        set({ status: "generating", progress: `Generating pages… ${i + 1}/${aiScenes.length}` });
        // eslint-disable-next-line no-await-in-loop
        await api.generate(story.id, aiScenes[i].id, kidId, config?.defaultPrompt || "", { mode: "compose" });
        // eslint-disable-next-line no-await-in-loop
        s = await refresh();
      }
      const results = (s || story).results?.[kidId] || {};
      const allApproved =
        aiScenes.length === 0 || aiScenes.every((sc) => isPageApproved(results[sc.id]));
      if (allApproved) set({ status: "approved", progress: "Approved" });
      else set({ status: "needs_review", progress: "Needs review" });
    } catch (e2) {
      set({ status: "failed", progress: "Failed", error: e2.message });
    }
  }

  async function runBatch(items) {
    cancelRef.current = false;
    setBatchRunning(true);
    try {
      for (const item of items) {
        if (cancelRef.current) {
          updateItem(item.id, { status: "cancelled", progress: "Cancelled" });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await processOne(item);
      }
    } finally {
      setBatchRunning(false);
    }
  }

  // Pull the gender-matched panel from Settings → Test images and run every one
  // through the same pipeline as a manually-uploaded test child.
  async function testWithLibrary() {
    setErr("");
    setLibLoading(true);
    try {
      const lib = await api.getTestImages();
      const imgs = lib?.[genderBucket] || [];
      if (!imgs.length) {
        setErr(
          `No ${genderBucket} test images yet. Add them in Settings → Test images, then try again.`
        );
        return;
      }
      const items = [];
      for (const img of imgs) {
        // eslint-disable-next-line no-await-in-loop
        const blob = await (await fetch(img.localUrl)).blob();
        const name = img.localUrl.split("/").pop() || `${genderBucket}.jpg`;
        const file = new File([blob], name, { type: blob.type || "image/jpeg" });
        items.push({
          id: `lib-${img.id}-${Date.now()}`,
          file,
          name,
          thumbUrl: img.localUrl,
          status: "queued",
          progress: "Queued",
          error: "",
          kidId: null,
          photoStatus: null,
        });
      }
      setBatch((b) => [...b, ...items]);
      await runBatch(items);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setLibLoading(false);
    }
  }

  function cancelBatch() {
    cancelRef.current = true;
  }

  function clearBatch() {
    batch.forEach((it) => it.thumbUrl && URL.revokeObjectURL(it.thumbUrl));
    setBatch([]);
  }

  async function regenAnchor(kidId) {
    setErr("");
    setStageByKid((m) => ({ ...m, [kidId]: "anchoring" }));
    try {
      await api.anchorKid(story.id, kidId);
      await refresh();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setStageByKid((m) => {
        const c = { ...m };
        delete c[kidId];
        return c;
      });
    }
  }

  async function removeKid(kidId) {
    if (!confirm("Remove this test child and its generated pages?")) return;
    setWorking(true);
    setErr("");
    try {
      onStoryChange(await api.deleteKid(story.id, kidId));
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setWorking(false);
    }
  }

  async function generate(kidId, sceneId) {
    const key = `${kidId}:${sceneId}`;
    setGenBusy((b) => ({ ...b, [key]: true }));
    setErr("");
    try {
      await api.generate(story.id, sceneId, kidId, config?.defaultPrompt || "", { mode: "compose" });
      await refresh();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setGenBusy((b) => ({ ...b, [key]: false }));
    }
  }

  async function generateAllFor(kidId) {
    for (const scene of aiScenes) {
      // eslint-disable-next-line no-await-in-loop
      await generate(kidId, scene.id);
    }
  }

  async function setApproved(kidId, sceneId, approved) {
    setErr("");
    try {
      onStoryChange(await api.approveResult(story.id, kidId, sceneId, approved));
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function saveStyle(next) {
    setWorking(true);
    setErr("");
    try {
      onStoryChange(await api.updateStoryStyle(story.id, next));
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setWorking(false);
    }
  }

  async function setSceneField(sceneId, patch) {
    setErr("");
    try {
      onStoryChange(await api.updateCell(story.id, sceneId, patch));
    } catch (e2) {
      setErr(e2.message);
    }
  }

  return (
    <Section step="" title="Test & publish">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-zinc-500">
          Run the gender-matched test panel to check every AI page before going live. Editing a page
          or regenerating a render returns the story to draft. Publishing is available any time from
          the button in the header — testing is recommended but not required.
        </p>
      </div>

      {err && (
        <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {err}
        </div>
      )}

      {aiScenes.length > 0 && (
        <div className="mb-4 flex items-center gap-3 text-xs text-zinc-400">
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
            <div
              className="h-full bg-[var(--color-accent-2)] transition-all"
              style={{ width: totalCells ? `${(approvedCells / totalCells) * 100}%` : "0%" }}
            />
          </div>
          <span>
            {approvedCells} / {totalCells} approved
            {kids.length > 0 ? ` · ${kids.length} test child${kids.length === 1 ? "" : "ren"}` : ""}
          </span>
        </div>
      )}

      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={testWithLibrary}
          disabled={libLoading || batchRunning || aiScenes.length === 0}
          title={`Run the ${genderBucket === "boy" ? "boys" : "girls"} test panel from Settings`}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {libLoading && <Spinner />}
          Test with {genderBucket === "boy" ? "boys" : "girls"} library
        </button>
        <span className="text-xs text-zinc-600">
          Photos are managed in Settings → Test images.
        </span>
        {!config?.falConfigured && (
          <span className="text-xs text-amber-300">FAL_KEY not detected — add it to server/.env.</span>
        )}
      </div>

      {batch.length > 0 && (
        <BatchQueue
          items={batch}
          running={batchRunning}
          onCancel={cancelBatch}
          onClear={clearBatch}
        />
      )}

      {aiScenes.length === 0 && (
        <p className="text-sm text-zinc-500">
          This story has no AI pages yet. Add an image page (with an AI layer) to test it.
        </p>
      )}

      <div className="space-y-6">
        {kids.map((kid) => {
          const stage = stageByKid[kid.id];
          const busy = Boolean(stage);
          const showSceneControls = kids[0]?.id === kid.id; // page settings shown once
          const kidApproved = aiScenes.filter((s) => isPageApproved(story.results?.[kid.id]?.[s.id])).length;
          return (
            <div
              key={kid.id}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 p-4"
            >
              <div className="mb-3 grid grid-cols-3 gap-3">
                <Stage label="1 · Original" url={kid.localUrl} loading={stage === "uploading"} loadingLabel="Uploading…" />
                <Stage
                  label="2 · Restored"
                  url={kid.restoreOutcome === "used" ? kid.restoredLocal : kid.restoreOutcome ? kid.localUrl : kid.restoredLocal}
                  loading={stage === "restoring"}
                  loadingLabel="Restoring…"
                  caption={restoreOutcomeLabel(kid.restoreOutcome)}
                />
                <Stage label="3 · Portrait" url={kid.presentationLocal || kid.anchorLocal} highlight loading={stage === "anchoring"} loadingLabel="Painting anchor…" />
              </div>

              {kid.photoStatus && (
                <div className="mb-3">
                  <PhotoCheckPanel kid={kid} />
                </div>
              )}

              <div className="mb-3 flex flex-wrap items-center gap-3">
                {(kid.identityAnchorCheck || kid.anchorCheck) && (
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">Identity anchor:</span>
                    <ScoreBadge check={kid.identityAnchorCheck || kid.anchorCheck} />
                  </span>
                )}
                {kid.identityAnchorWeak && (
                  <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                    ⚠ Weak anchor — using the photo for likeness
                  </span>
                )}
                {kid.featuresStruct && <FeatureBadges features={kid.featuresStruct} />}
                <span className="text-xs text-zinc-500">
                  {kidApproved}/{aiScenes.length} pages approved
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => regenAnchor(kid.id)}
                    disabled={busy}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
                  >
                    ↻ Anchor
                  </button>
                  <button
                    onClick={() => generateAllFor(kid.id)}
                    disabled={busy || aiScenes.length === 0}
                    className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-black disabled:opacity-40"
                  >
                    Generate all
                  </button>
                  <button
                    onClick={() => removeKid(kid.id)}
                    disabled={working || busy}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1 text-xs font-medium text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200 disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                {aiScenes.map((scene) => {
                  const result = story.results?.[kid.id]?.[scene.id];
                  const key = `${kid.id}:${scene.id}`;
                  const sBusy = genBusy[key];
                  const approved = isPageApproved(result);
                  return (
                    <div
                      key={scene.id}
                      className="grid grid-cols-[120px_120px_1fr] items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3"
                    >
                      <div>
                        <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">
                          {sceneLabel(scene.id)}
                        </span>
                        <ZoomableImg src={scene.localUrl} className="w-full rounded object-cover" />
                      </div>
                      <div>
                        <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">
                          Generated
                        </span>
                        {sBusy ? (
                          <div className="flex aspect-square items-center justify-center rounded bg-[var(--color-panel-2)]">
                            <Spinner />
                          </div>
                        ) : result ? (
                          <ZoomableImg src={result.url} className="w-full rounded object-cover" />
                        ) : (
                          <div className="flex aspect-square items-center justify-center rounded border border-dashed border-[var(--color-border)] text-[10px] text-zinc-600">
                            none
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {result?.check && <ScoreBadge check={result.check} />}
                          {result && <DecisionBadge result={result} />}
                          {approved && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-xs font-semibold text-emerald-200">
                              ✓ approved
                            </span>
                          )}
                        </div>
                        {result?.check && <Mismatches check={result.check} />}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => generate(kid.id, scene.id)}
                            disabled={sBusy || busy}
                            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
                          >
                            {sBusy ? "Generating…" : result ? "Regenerate" : "Generate"}
                          </button>
                          {result && (
                            <button
                              onClick={() => setApproved(kid.id, scene.id, !approved)}
                              disabled={sBusy}
                              className={`rounded-md px-3 py-1 text-xs font-semibold disabled:opacity-40 ${
                                approved
                                  ? "border border-[var(--color-border)] bg-[var(--color-panel-2)] text-zinc-300 hover:bg-[#242838]"
                                  : "bg-[var(--color-accent-2)] text-black"
                              }`}
                            >
                              {approved ? "Unapprove" : "Approve"}
                            </button>
                          )}
                        </div>
                        {showSceneControls && (
                          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-2">
                            <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                              page · applies to all
                            </span>
                            <select
                              value={scene.genChoice || ""}
                              onChange={(e) =>
                                setSceneField(scene.id, { genChoice: e.target.value || null })
                              }
                              className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-xs focus:border-[var(--color-accent)] focus:outline-none"
                            >
                              {GEN_CHOICE_LABELS.map(([v, l]) => (
                                <option key={v} value={v}>
                                  {l}
                                </option>
                              ))}
                            </select>
                            <input
                              value={draftCorr[scene.id] ?? (scene.correction || "")}
                              onChange={(e) =>
                                setDraftCorr((m) => ({ ...m, [scene.id]: e.target.value }))
                              }
                              onBlur={() => {
                                const v = draftCorr[scene.id];
                                if (v !== undefined && v !== (scene.correction || ""))
                                  setSceneField(scene.id, { correction: v });
                              }}
                              placeholder="fix note for this page (e.g. use long hair, not a bob)"
                              className="min-w-[180px] flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-xs focus:border-[var(--color-accent)] focus:outline-none"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/* ============================ CELL BOOK ============================ */
function CellBook({
  cells,
  aspect,
  variables,
  cellBusy,
  onUploadImage,
  onUploadBackground,
  onRemoveBackground,
  onSaveText,
  onOpenEditor,
  onDelete,
  onReorder,
  onSetCellScoring,
}) {
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const ratio = (aspect || "3:4").replace(":", " / ");

  function moveBefore(targetId) {
    if (!dragId || dragId === targetId) return;
    const ids = cells.map((s) => s.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    onReorder(ids);
  }

  const dragProps = (id) => ({
    isDragging: dragId === id,
    isOver: overId === id && dragId !== id,
    onDragStart: () => setDragId(id),
    onDragEnd: () => {
      setDragId(null);
      setOverId(null);
    },
    onDragOver: (e) => {
      e.preventDefault();
      setOverId(id);
    },
    onDrop: (e) => {
      e.preventDefault();
      moveBefore(id);
      setDragId(null);
      setOverId(null);
    },
  });

  const page = (cell, label) => (
    <Cell
      cell={cell}
      ratio={ratio}
      label={label}
      variables={variables}
      busy={!!cellBusy[cell.id]}
      onUploadImage={onUploadImage}
      onUploadBackground={onUploadBackground}
      onRemoveBackground={onRemoveBackground}
      onSaveText={onSaveText}
      onOpenEditor={onOpenEditor}
      onDelete={onDelete}
      onSetCellScoring={onSetCellScoring}
      {...dragProps(cell.id)}
    />
  );

  // Cover (1, alone right) · middle spreads (2) · back cover (1, alone left).
  const rows = buildBookRows(cells);

  return (
    <div className="space-y-4">
      {rows.map((row) => {
        if (row.kind === "cover") {
          return (
            <Spread key={row.cell.id}>
              <div className="hidden sm:block" />
              {page(row.cell, row.label)}
            </Spread>
          );
        }
        if (row.kind === "back") {
          return (
            <Spread key={row.cell.id}>
              {page(row.cell, row.label)}
              <div className="hidden sm:block" />
            </Spread>
          );
        }
        return (
          <Spread key={row.cells[0].id + (row.cells[1]?.id || "")}>
            {page(row.cells[0], row.labels[0])}
            {row.cells[1] ? page(row.cells[1], row.labels[1]) : <div className="hidden sm:block" />}
          </Spread>
        );
      })}
    </div>
  );
}

// Font library: English/Latin + Arabic. Loaded via Google Fonts in index.html.
const FONTS = [
  { id: "sans", label: "DM Sans", stack: "'DM Sans', system-ui, sans-serif", script: "latin" },
  { id: "poppins", label: "Poppins", stack: "'Poppins', sans-serif", script: "latin" },
  { id: "quicksand", label: "Quicksand", stack: "'Quicksand', sans-serif", script: "latin" },
  { id: "fredoka", label: "Fredoka", stack: "'Fredoka', system-ui, sans-serif", script: "latin" },
  { id: "baloo2", label: "Baloo 2", stack: "'Baloo 2', system-ui, cursive", script: "both" },
  { id: "playfair", label: "Playfair Display", stack: "'Playfair Display', Georgia, serif", script: "latin" },
  { id: "merriweather", label: "Merriweather", stack: "'Merriweather', Georgia, serif", script: "latin" },
  { id: "lobster", label: "Lobster", stack: "'Lobster', cursive", script: "latin" },
  { id: "pacifico", label: "Pacifico", stack: "'Pacifico', cursive", script: "latin" },
  { id: "serif", label: "Serif", stack: "Georgia, 'Times New Roman', serif", script: "latin" },
  { id: "mono", label: "Mono", stack: "'JetBrains Mono', ui-monospace, monospace", script: "latin" },
  { id: "cairo", label: "Cairo · القاهرة", stack: "'Cairo', sans-serif", script: "arabic" },
  { id: "tajawal", label: "Tajawal · تجوال", stack: "'Tajawal', sans-serif", script: "arabic" },
  { id: "almarai", label: "Almarai · المراعي", stack: "'Almarai', sans-serif", script: "arabic" },
  { id: "ibmplexar", label: "IBM Plex Arabic", stack: "'IBM Plex Sans Arabic', sans-serif", script: "arabic" },
  { id: "notokufi", label: "Noto Kufi Arabic", stack: "'Noto Kufi Arabic', sans-serif", script: "arabic" },
  { id: "amiri", label: "Amiri · أميري", stack: "'Amiri', serif", script: "arabic" },
  { id: "markazi", label: "Markazi · مركزي", stack: "'Markazi Text', serif", script: "arabic" },
  { id: "reemkufi", label: "Reem Kufi · ريم", stack: "'Reem Kufi', sans-serif", script: "arabic" },
  { id: "arefruqaa", label: "Aref Ruqaa · رقعة", stack: "'Aref Ruqaa', serif", script: "arabic" },
];
const FONT_MAP = Object.fromEntries(FONTS.map((f) => [f.id, f]));
function fontStack(id) {
  return (FONT_MAP[id] || FONT_MAP.sans).stack;
}

// Text elements may carry rich HTML (for per-selection color). Fall back to
// the plain `text` field (escaped) for legacy elements.
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
// Inline styles we allow inside rich text. Everything else (notably font-size,
// font-family, line-height — which browsers bake into spans on execCommand) is
// stripped so the element-level size/font/line-height stay in control.
const ALLOWED_TEXT_STYLES = new Set(["color", "font-weight", "font-style", "text-decoration", "text-decoration-line"]);

function sanitizeTextHtml(html) {
  if (!html) return html;
  return html.replace(/\sstyle="([^"]*)"/g, (_m, css) => {
    const kept = css
      .split(";")
      .map((r) => r.trim())
      .filter(Boolean)
      .filter((r) => ALLOWED_TEXT_STYLES.has(r.split(":")[0].trim().toLowerCase()));
    return kept.length ? ` style="${kept.join("; ")}"` : "";
  });
}

// Remove baked font-size/font-family/line-height from a live contentEditable
// node, in place (keeps the caret/selection intact).
function stripBakedFontStyles(root) {
  if (!root) return;
  root.querySelectorAll("[style]").forEach((n) => {
    n.style.removeProperty("font-size");
    n.style.removeProperty("font-family");
    n.style.removeProperty("line-height");
    if (!n.getAttribute("style")) n.removeAttribute("style");
  });
}

function textHtml(el) {
  return sanitizeTextHtml(el.html != null && el.html !== "" ? el.html : escapeHtml(el.text || ""));
}
// Normalize a CSS color (rgb()/hex/name) to #rrggbb for <input type="color">.
function rgbToHex(c) {
  if (!c) return null;
  if (c[0] === "#") return c.length === 4 ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c;
  const m = c.match(/\d+/g);
  if (!m || m.length < 3) return null;
  return "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}
function placeCaretEnd(node) {
  if (!node) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

const DEFAULT_TEXT_STYLE = {
  align: "center",
  fontSize: 18,
  color: "#f4f4f5",
  bold: false,
  font: "serif",
};

function textStyleToCss(style) {
  const s = { ...DEFAULT_TEXT_STYLE, ...(style || {}) };
  return {
    textAlign: s.align,
    fontSize: `${s.fontSize}px`,
    color: s.color,
    fontWeight: s.bold ? 700 : 400,
    fontFamily: fontStack(s.font),
    lineHeight: 1.4,
  };
}

// Render plain text with {{tokens}} highlighted.
function renderWithVars(text) {
  if (!text) return null;
  return text.split(/(\{\{\s*[A-Za-z0-9_]+\s*\}\})/g).map((part, i) =>
    /^\{\{\s*[A-Za-z0-9_]+\s*\}\}$/.test(part) ? (
      <span key={i} className="rounded bg-[var(--color-accent)]/15 px-1 font-mono text-[var(--color-accent)]">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function TextToolbar({ style, setS }) {
  const s = { ...DEFAULT_TEXT_STYLE, ...style };
  const btn = (active) =>
    `rounded px-1.5 py-0.5 text-[11px] font-medium transition ${
      active ? "bg-[var(--color-accent)] text-black" : "text-zinc-300 hover:bg-[var(--color-panel)]"
    }`;
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-1">
      {[
        { id: "left", icon: "⇤" },
        { id: "center", icon: "↔" },
        { id: "right", icon: "⇥" },
      ].map((a) => (
        <button key={a.id} title={`Align ${a.id}`} onClick={() => setS({ align: a.id })} className={btn(s.align === a.id)}>
          {a.icon}
        </button>
      ))}
      <span className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />
      <button title="Bold" onClick={() => setS({ bold: !s.bold })} className={btn(s.bold)}>
        B
      </button>
                <button
        title="Toggle serif / sans"
        onClick={() => setS({ font: s.font === "serif" ? "sans" : "serif" })}
        className={btn(s.font === "serif")}
                >
        {s.font === "serif" ? "Serif" : "Sans"}
                </button>
      <span className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />
      <select
        title="Font size"
        value={s.fontSize}
        onChange={(e) => setS({ fontSize: Number(e.target.value) })}
        className="rounded bg-[var(--color-panel)] px-1 py-0.5 text-[11px] text-zinc-200 focus:outline-none"
      >
        {[12, 14, 16, 18, 22, 28, 36, 48, 64].map((n) => (
          <option key={n} value={n}>
            {n}px
          </option>
        ))}
      </select>
                <input
        type="color"
        title="Text color"
        value={s.color}
        onChange={(e) => setS({ color: e.target.value })}
        className="h-5 w-6 cursor-pointer rounded border border-[var(--color-border)] bg-transparent p-0"
      />
    </div>
  );
}

/* ===================== FREE-FORM PAGE (CANVA-STYLE) ===================== */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function ratioNums(aspect) {
  const [w, h] = (aspect || "3:4").split(":").map(Number);
  return [w || 3, h || 4];
}

// Apply {{tokens}} → values for read-only rendering (orders).
function applyVarsClient(text, values) {
  if (!text) return "";
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name) =>
    values && values[name] != null && values[name] !== "" ? values[name] : m
  );
}

// A blank text layer dropped at the center of the page.
function newTextElement() {
  return {
    id: nid(),
    type: "text",
    text: "Double-tap to edit",
    xPct: 15,
    yPct: 40,
    wPct: 70,
    hPct: 20,
    z: 1,
    fontSizePct: 6,
    color: "#1f2937",
    bold: false,
    italic: false,
    align: "center",
    valign: "center",
    font: "sans",
  };
}

function newImageElement(url, falUrl) {
  return {
    id: nid(),
    type: "image",
    url,
    falUrl: falUrl || null,
    xPct: 25,
    yPct: 25,
    wPct: 50,
    hPct: 50,
    z: 1,
    rotation: 0,
    fit: "contain",
    // Layer group. "overlay" = composited as-is (never touched by AI);
    // "ai" = this image is the scene base regenerated with the child.
    plane: "overlay",
  };
}

// Only images can live in the AI plane; text/SVG are always overlay.
function isAiLayer(el) {
  return el.type === "image" && el.plane === "ai";
}

// True when a page has something the AI can regenerate: an AI-plane image
// element, or a legacy image cell. Overlay/text-only pages are skipped.
function sceneHasAiBase(scene) {
  if (Array.isArray(scene.elements) && scene.elements.some(isAiLayer)) return true;
  return scene.type !== "text" && Boolean(scene.falUrl || scene.localUrl);
}

// Stacking: the whole AI plane sits beneath the whole overlay plane,
// then by the element's own z within its plane.
function layerZ(el) {
  return 10 + (isAiLayer(el) ? 0 : 1000) + (el.z || 1);
}

// Shared move/resize geometry for draggable items (elements and safe zones).
// `item` provides current wPct/hPct (and type for text auto-height handling),
// `d` is the active drag state captured at pointer-down.
function dragGeom(item, d, dxPct, dyPct) {
  const isText = item.type === "text";
  if (d.mode === "move") {
    const maxY = isText ? 95 : 100 - item.hPct;
    return {
      xPct: clamp(d.ox + dxPct, 0, 100 - item.wPct),
      yPct: clamp(d.oy + dyPct, 0, maxY),
    };
  }
  let { ox: xPct, oy: yPct, ow: wPct, oh: hPct } = d;
  const c = d.corner;
  const minPct = isText ? 5 : 1;
  if (c.includes("e")) wPct = clamp(d.ow + dxPct, minPct, 100 - d.ox);
  if (c.includes("s")) hPct = clamp(d.oh + dyPct, minPct, 100 - d.oy);
  if (c.includes("w")) {
    wPct = clamp(d.ow - dxPct, minPct, d.ox + d.ow);
    xPct = d.ox + d.ow - wPct;
  }
  if (c.includes("n")) {
    hPct = clamp(d.oh - dyPct, minPct, d.oy + d.oh);
    yPct = d.oy + d.oh - hPct;
  }
  return { xPct, yPct, wPct, hPct };
}

function newSvgElement(svg, name) {
  return {
    id: nid(),
    type: "svg",
    svg,
    name: name || "Symbol",
    xPct: 38,
    yPct: 38,
    wPct: 24,
    hPct: 24,
    z: 1,
    rotation: 0,
    color: "#fbbf24",
    tint: true,
  };
}

// Markup for an svg element, tinted to its color when `tint` is enabled.
function svgMarkup(el) {
  return el.tint === false ? el.svg : tintSvg(el.svg, true);
}

// Tailwind utilities that force an inlined <svg> to fill its element box.
const SVG_FILL = "[&>svg]:block [&>svg]:h-full [&>svg]:w-full";

let _nidc = 0;
function nid() {
  _nidc += 1;
  return `el_${Date.now().toString(36)}_${_nidc}`;
}

// Elements for a cell, synthesizing a layer from legacy text/image cells so
// older pages still render until they are opened and re-saved in the editor.
function cellLayers(cell) {
  if (Array.isArray(cell.elements) && cell.elements.length) return cell.elements;
  if (cell.type === "image" && cell.localUrl) {
    return [{ id: "legacy-img", type: "image", url: cell.localUrl, fit: "contain", xPct: 0, yPct: 0, wPct: 100, hPct: 100, z: 1 }];
  }
  if (cell.type === "text" && (cell.text || cell.style)) {
    const st = { ...DEFAULT_TEXT_STYLE, ...(cell.style || {}) };
    return [
      {
        id: "legacy-text",
        type: "text",
        text: cell.text || "",
        xPct: 8,
        yPct: 8,
        wPct: 84,
        hPct: 84,
        z: 1,
        fontSizePct: 6,
        color: st.color,
        bold: st.bold,
        align: st.align,
        valign: "center",
        font: st.font,
      },
    ];
  }
  return [];
}

function elementTextCss(el) {
  return {
    fontSize: `${el.fontSizePct || 6}cqh`,
    color: el.color || "#1f2937",
    fontWeight: el.bold ? 700 : 400,
    fontStyle: el.italic ? "italic" : "normal",
    fontFamily: fontStack(el.font),
    textAlign: el.align || "center",
    letterSpacing: el.letterSpacing ? `${el.letterSpacing}em` : undefined,
    lineHeight: el.lineHeight || 1.3,
    width: "100%",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };
}

// Read-only render of a page: background + positioned layers. Container-query
// units (cqh) make text scale with whatever size the page is shown at.
function CellCanvas({ cell, ratio, resolve, aiResultUrl, className = "" }) {
  const layers = cellLayers(cell);
  const r = (text) => (resolve ? resolve(text) : text);
  return (
    <div
      className={`relative isolate overflow-hidden ${className}`}
      style={{ aspectRatio: ratio, containerType: "size", background: cell.bgColor || undefined }}
    >
      {cell.bgUrl && (
        <img src={cell.bgUrl} alt="" className="absolute inset-0 z-0 h-full w-full object-cover" />
      )}
      {layers.map((el) => {
        const box = {
          position: "absolute",
          left: `${el.xPct}%`,
          top: `${el.yPct}%`,
          width: `${el.wPct}%`,
          height: `${el.hPct}%`,
          zIndex: layerZ(el),
          transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
        };
        if (el.type === "image") {
          // The AI-plane image is replaced by this order's generated result.
          const src = aiResultUrl && isAiLayer(el) ? aiResultUrl : el.url;
          return (
            <img
              key={el.id}
              src={src}
              alt=""
              style={box}
              className={el.fit === "cover" ? "object-cover" : "object-contain"}
            />
          );
        }
        if (el.type === "svg") {
          return (
            <div
              key={el.id}
              style={{ ...box, color: el.color }}
              className={SVG_FILL}
              dangerouslySetInnerHTML={{ __html: svgMarkup(el) }}
            />
          );
        }
        // Text auto-fits its height to the content (no fixed box height).
        return (
          <div
            key={el.id}
            style={{
              position: "absolute",
              left: `${el.xPct}%`,
              top: `${el.yPct}%`,
              width: `${el.wPct}%`,
              zIndex: layerZ(el),
            }}
          >
            <div
              dir="auto"
              style={elementTextCss(el)}
              dangerouslySetInnerHTML={{ __html: r(textHtml(el)) || "&nbsp;" }}
            />
          </div>
        );
      })}
      {layers.length === 0 && !cell.bgUrl && (
        <div className="flex h-full w-full items-center justify-center bg-[var(--color-panel-2)] text-xs text-zinc-600">
          Empty page
        </div>
      )}
    </div>
  );
}

/* ===================== FULL-SCREEN PAGE EDITOR ===================== */
function CellEditor({ cell, label, aspect, variables, customSymbols = [], onSaveSymbol, onDeleteSymbol, onClose, onSave, onUploadMedia }) {
  const [elements, setElements] = useState(() =>
    cellLayers(cell).map((el) => ({
      ...el,
      id: el.id?.startsWith("el_") ? el.id : nid(),
      ...(el.html ? { html: sanitizeTextHtml(el.html) } : {}),
    }))
  );
  const [bgUrl, setBgUrl] = useState(cell.bgUrl || null);
  const [bgFalUrl, setBgFalUrl] = useState(cell.bgFalUrl || null);
  const [bgColor, setBgColor] = useState(cell.bgColor || "#faf7ef");
  // Per-page generation prompt (used only when the page has an AI image).
  const [aiPrompt, setAiPrompt] = useState(cell.aiPrompt || "");
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const [snapLines, setSnapLines] = useState({ v: false, h: false });
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [symbolPicker, setSymbolPicker] = useState(false);
  const [zones, setZones] = useState(() => (Array.isArray(cell.safeZones) ? cell.safeZones : []));
  const [selectedZoneId, setSelectedZoneId] = useState(null);

  const canvasRef = useRef(null);
  const areaRef = useRef(null);
  const dragRef = useRef(null);
  const imgInputRef = useRef(null);
  const svgInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  // Live contentEditable node + last selection range, for rich-text coloring.
  const editRef = useRef(null);
  const savedRange = useRef(null);
  // Color of the current text selection, shown in the color picker while editing.
  const [selectionColor, setSelectionColor] = useState(null);
  const [area, setArea] = useState({ w: 0, h: 0 });

  const [rw, rh] = ratioNums(aspect);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Window-level pointer handlers (attached once) drive move/resize via dragRef.
  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dxPct = ((e.clientX - d.startX) / d.rectW) * 100;
      const dyPct = ((e.clientY - d.startY) / d.rectH) * 100;
      if (d.target === "zone") {
        setZones((zs) => zs.map((z) => (z.id === d.id ? { ...z, ...dragGeom(z, d, dxPct, dyPct) } : z)));
        return;
      }
      // Group move: shift every selected element by the same delta.
      if (d.mode === "move" && d.items && d.items.length > 1) {
        const offs = new Map(d.items.map((it) => [it.id, it]));
        setElements((els) =>
          els.map((el) => {
            const it = offs.get(el.id);
            if (!it) return el;
            const maxY = el.type === "text" ? 95 : 100 - el.hPct;
            return {
              ...el,
              xPct: clamp(it.ox + dxPct, 0, 100 - el.wPct),
              yPct: clamp(it.oy + dyPct, 0, maxY),
            };
          })
        );
        return;
      }
      // Single move with center snapping (size captured at drag start).
      if (d.mode === "move") {
        let xPct = clamp(d.ox + dxPct, 0, 100 - d.ow);
        let yPct = clamp(d.oy + dyPct, 0, d.isText ? 95 : 100 - d.oh);
        const SNAP = 1.4;
        let v = false;
        let h = false;
        if (Math.abs(xPct + d.ow / 2 - 50) <= SNAP) {
          xPct = 50 - d.ow / 2;
          v = true;
        }
        if (Math.abs(yPct + (d.oh || 0) / 2 - 50) <= SNAP) {
          yPct = 50 - (d.oh || 0) / 2;
          h = true;
        }
        setSnapLines((s) => (s.v === v && s.h === h ? s : { v, h }));
        setElements((els) => els.map((el) => (el.id === d.id ? { ...el, xPct, yPct } : el)));
        return;
      }
      // Single resize.
      setElements((els) => els.map((el) => (el.id === d.id ? { ...el, ...dragGeom(el, d, dxPct, dyPct) } : el)));
    };
    const up = () => {
      dragRef.current = null;
      setSnapLines((s) => (s.v || s.h ? { v: false, h: false } : s));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  // Delete / Backspace removes the current selection (unless typing).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (editingId) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (selectedZoneId) {
        e.preventDefault();
        if (!zones.find((z) => z.id === selectedZoneId)?.locked) removeZone(selectedZoneId);
      } else if (selectedIds.length) {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, selectedZoneId, selectedIds, zones]);

  let cw = area.w;
  let ch = (cw * rh) / rw;
  if (ch > area.h) {
    ch = area.h;
    cw = (ch * rw) / rh;
  }

  useEffect(() => {
    if (!editingId) setSelectionColor(null);
  }, [editingId]);

  const selected = elements.find((el) => el.id === selectedId) || null;
  const selectedEls = elements.filter((el) => selectedIds.includes(el.id));
  const aiCount = elements.filter(isAiLayer).length;
  const patchSel = (patch) =>
    setElements((els) => els.map((el) => (el.id === selectedId ? { ...el, ...patch } : el)));

  function startMove(e, el) {
    if (editingId) return;
    e.stopPropagation();
    setSelectedZoneId(null);

    // Shift toggles membership in the selection without starting a drag.
    if (e.shiftKey) {
      setSelectedIds((ids) => (ids.includes(el.id) ? ids.filter((x) => x !== el.id) : [...ids, el.id]));
      return;
    }

    // Clicking an element keeps a multi-selection if it's part of it (group
    // drag); otherwise it becomes the sole selection.
    const groupIds = selectedIds.includes(el.id) && selectedIds.length > 1 ? selectedIds : [el.id];
    setSelectedIds(groupIds);
    if (el.locked) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const movers = elements.filter((m) => groupIds.includes(m.id) && !m.locked);
    dragRef.current = {
      target: "el",
      mode: "move",
      id: el.id,
      startX: e.clientX,
      startY: e.clientY,
      ox: el.xPct,
      oy: el.yPct,
      ow: el.wPct,
      oh: el.hPct,
      isText: el.type === "text",
      items: movers.map((m) => ({ id: m.id, ox: m.xPct, oy: m.yPct })),
      rectW: rect.width,
      rectH: rect.height,
    };
  }
  function startResize(e, el, corner) {
    e.stopPropagation();
    setSelectedIds([el.id]);
    if (el.locked) return;
    const rect = canvasRef.current.getBoundingClientRect();
    dragRef.current = { target: "el", mode: "resize", corner, id: el.id, startX: e.clientX, startY: e.clientY, ox: el.xPct, oy: el.yPct, ow: el.wPct, oh: el.hPct, rectW: rect.width, rectH: rect.height };
  }

  // Align/distribute the current multi-selection within its bounding box.
  function alignSelected(kind) {
    if (selectedEls.length < 2) return;
    const xs = selectedEls.map((e) => e.xPct);
    const ys = selectedEls.map((e) => e.yPct);
    const rights = selectedEls.map((e) => e.xPct + e.wPct);
    const bottoms = selectedEls.map((e) => e.yPct + (e.hPct || 0));
    const minX = Math.min(...xs);
    const maxR = Math.max(...rights);
    const minY = Math.min(...ys);
    const maxB = Math.max(...bottoms);
    const cx = (minX + maxR) / 2;
    const cy = (minY + maxB) / 2;
    const ids = new Set(selectedIds);
    setElements((els) =>
      els.map((el) => {
        if (!ids.has(el.id)) return el;
        switch (kind) {
          case "left":
            return { ...el, xPct: minX };
          case "centerH":
            return { ...el, xPct: cx - el.wPct / 2 };
          case "right":
            return { ...el, xPct: maxR - el.wPct };
          case "top":
            return { ...el, yPct: minY };
          case "middleV":
            return { ...el, yPct: cy - (el.hPct || 0) / 2 };
          case "bottom":
            return { ...el, yPct: maxB - (el.hPct || 0) };
          default:
            return el;
        }
      })
    );
  }

  // Center the single selected element on the page (works for one element).
  function centerOnPage(axis) {
    if (!selected) return;
    if (axis === "h") patchSel({ xPct: clamp(50 - selected.wPct / 2, 0, 100) });
    else patchSel({ yPct: clamp(50 - (selected.hPct || 0) / 2, 0, 100) });
  }
  function addZone() {
    const z = { id: nid(), xPct: 12, yPct: 10, wPct: 76, hPct: 26 };
    setZones((a) => [...a, z]);
    setSelectedZoneId(z.id);
    setSelectedIds([]);
    setEditingId(null);
  }
  function removeZone(id) {
    setZones((a) => a.filter((z) => z.id !== id));
    setSelectedZoneId((s) => (s === id ? null : s));
  }
  function toggleZoneLock(id) {
    setZones((a) => a.map((z) => (z.id === id ? { ...z, locked: !z.locked } : z)));
  }
  function startMoveZone(e, z) {
    e.stopPropagation();
    setSelectedZoneId(z.id);
    if (z.locked) return;
    setSelectedIds([]);
    setEditingId(null);
    const rect = canvasRef.current.getBoundingClientRect();
    dragRef.current = { target: "zone", mode: "move", id: z.id, startX: e.clientX, startY: e.clientY, ox: z.xPct, oy: z.yPct, ow: z.wPct, oh: z.hPct, rectW: rect.width, rectH: rect.height };
  }
  function startResizeZone(e, z, corner) {
    e.stopPropagation();
    setSelectedZoneId(z.id);
    if (z.locked) return;
    const rect = canvasRef.current.getBoundingClientRect();
    dragRef.current = { target: "zone", mode: "resize", corner, id: z.id, startX: e.clientX, startY: e.clientY, ox: z.xPct, oy: z.yPct, ow: z.wPct, oh: z.hPct, rectW: rect.width, rectH: rect.height };
  }

  const maxZ = () => elements.reduce((m, el) => Math.max(m, el.z || 1), 0);
  const minZ = () => elements.reduce((m, el) => Math.min(m, el.z || 1), 99);

  function addText() {
    const el = newTextElement();
    el.z = maxZ() + 1;
    setElements((e) => [...e, el]);
    setSelectedIds([el.id]);
  }
  async function addImageFile(file) {
    if (!file) return;
    setBusy(true);
    try {
      const { url, falUrl } = await onUploadMedia(file);
      const el = newImageElement(url, falUrl);
      el.z = maxZ() + 1;
      setElements((e) => [...e, el]);
      setSelectedIds([el.id]);
    } finally {
      setBusy(false);
    }
  }
  function addSymbol(svg, name) {
    const el = newSvgElement(svg, name);
    el.z = maxZ() + 1;
    setElements((e) => [...e, el]);
    setSelectedIds([el.id]);
    setSymbolPicker(false);
  }
  function addSvgFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const clean = sanitizeSvg(reader.result);
      if (!clean) {
        alert("That file didn't contain a valid <svg>.");
        return;
      }
      const name = file.name.replace(/\.svg$/i, "");
      // Drop it on the canvas right away, then persist it to the shared library
      // so it can be reused later. Adding still works if the save fails.
      addSymbol(clean, name);
      try {
        await onSaveSymbol?.(name, clean);
      } catch (e) {
        alert(`Couldn't save the symbol for reuse: ${e.message}`);
      }
    };
    reader.readAsText(file);
  }
  function toggleLock(id) {
    setElements((els) => els.map((el) => (el.id === id ? { ...el, locked: !el.locked } : el)));
  }
  function setPlane(id, plane) {
    setElements((els) =>
      els.map((el) => (el.id === id && el.type === "image" ? { ...el, plane } : el))
    );
  }
  // Move a layer up (toward front) or down (toward back) in the z-stack by
  // swapping z with its neighbour in render order.
  function reorderLayer(id, dir) {
    setElements((els) => {
      const sorted = [...els].sort((a, b) => (a.z || 1) - (b.z || 1));
      const i = sorted.findIndex((e) => e.id === id);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= sorted.length) return els;
      const zi = sorted[i].z || 1;
      const zj = sorted[j].z || 1;
      const az = zi === zj ? zi + dir : zj;
      return els.map((e) =>
        e.id === sorted[i].id ? { ...e, z: az } : e.id === sorted[j].id ? { ...e, z: zi } : e
      );
    });
  }
  async function replaceSelectedImage(file) {
    if (!file || !selected || selected.type !== "image") return;
    const id = selected.id;
    setBusy(true);
    try {
      const { url, falUrl } = await onUploadMedia(file);
      setElements((els) =>
        els.map((el) => (el.id === id ? { ...el, url, falUrl: falUrl || null } : el))
      );
    } finally {
      setBusy(false);
    }
  }
  function removeSelected() {
    const ids = new Set(selectedIds);
    setElements((e) => e.filter((el) => !ids.has(el.id)));
    setSelectedIds([]);
  }
  function deleteElement(id) {
    setElements((e) => e.filter((el) => el.id !== id));
    setSelectedIds((ids) => ids.filter((x) => x !== id));
  }
  function duplicateSelected() {
    if (!selected) return;
    const copy = { ...selected, id: nid(), xPct: clamp(selected.xPct + 4, 0, 100 - selected.wPct), yPct: clamp(selected.yPct + 4, 0, 100 - selected.hPct), z: maxZ() + 1 };
    setElements((e) => [...e, copy]);
    setSelectedIds([copy.id]);
  }
  function insertVar(name) {
    if (!selected || selected.type !== "text") return;
    patchSel({ text: `${selected.text || ""}{{${name}}}`, html: null });
  }

  // Remember the caret/selection inside the contentEditable so we can restore
  // it when the color picker steals focus.
  function saveRange() {
    const node = editRef.current;
    const sel = window.getSelection();
    if (!node || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (node.contains(range.commonAncestorContainer)) {
      savedRange.current = range.cloneRange();
      // Reflect the color of the current selection (or caret) in the picker.
      try {
        const hex = rgbToHex(document.queryCommandValue("foreColor"));
        if (hex) setSelectionColor(hex);
      } catch {
        /* queryCommandValue can throw in some browsers */
      }
    }
  }

  // Color the active selection (if any) or the whole text element.
  function applyTextColor(color) {
    const node = editRef.current;
    const range = savedRange.current;
    if (editingId && node && range && !range.collapsed) {
      node.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("foreColor", false, color);
      // Chrome bakes the computed font-size into the new spans; strip it so the
      // element's size keeps controlling the glyphs.
      stripBakedFontStyles(node);
      savedRange.current = sel.getRangeAt(0).cloneRange();
      setSelectionColor(color);
      const html = node.innerHTML;
      const text = node.textContent;
      setElements((els) => els.map((x) => (x.id === editingId ? { ...x, html, text } : x)));
      return;
    }
    patchSel({ color });
  }

  function save() {
    onSave(cell.id, { elements, bgUrl, bgFalUrl, bgColor, safeZones: zones, aiPrompt });
    onClose();
  }

  // Text boxes auto-fit their height to the content, so they only resize
  // horizontally (left/right). Images keep full 4-corner resize.
  const handlePos = {
    nw: "-left-1 -top-1 cursor-nwse-resize",
    ne: "-right-1 -top-1 cursor-nesw-resize",
    sw: "-left-1 -bottom-1 cursor-nesw-resize",
    se: "-right-1 -bottom-1 cursor-nwse-resize",
    e: "-right-1 top-1/2 -translate-y-1/2 cursor-ew-resize",
    w: "-left-1 top-1/2 -translate-y-1/2 cursor-ew-resize",
  };
  const handlesFor = (el) => (el.type === "text" ? ["w", "e"] : ["nw", "ne", "sw", "se"]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0b0d14]">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">Editing · {label}</span>
          <span className="text-xs text-zinc-500">{aspect}</span>
          <span
            title="Images in the AI group are regenerated with the child; everything else is composited as-is."
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              aiCount > 0
                ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                : "border border-[var(--color-border)] text-zinc-500"
            }`}
          >
            {aiCount > 0 ? `AI · ${aiCount} image${aiCount > 1 ? "s" : ""}` : "No AI layer"}
          </span>
          {busy && <Spinner />}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={addText}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838]"
          >
            + Text
          </button>
          <button
            onClick={() => imgInputRef.current?.click()}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838]"
          >
            + Image
          </button>
          <button
            onClick={() => setSymbolPicker(true)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838]"
          >
            + Symbol
          </button>
          <button
            onClick={addZone}
            title="Draw a region the AI must keep clear (guide only, not printed)"
            className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-400/20"
          >
            + Safe zone
          </button>
          <label
            title="Page background color"
            className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838]"
          >
            Background
            <input
              type="color"
              value={bgColor}
              onChange={(e) => setBgColor(e.target.value)}
              className="h-5 w-6 cursor-pointer rounded border border-[var(--color-border)] bg-transparent p-0"
            />
          </label>
          {bgUrl && (
            <button
              onClick={() => {
                setBgUrl(null);
                setBgFalUrl(null);
              }}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
              title="Remove the legacy background image on this page"
            >
              Clear BG image
            </button>
          )}
          <span className="mx-1 h-5 w-px bg-[var(--color-border)]" />
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-zinc-300 hover:bg-[var(--color-panel-2)]"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-black"
          >
            Save
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Layers panel */}
        <LayersPanel
          elements={elements}
          selectedIds={selectedIds}
          onSelect={(id, additive) =>
            setSelectedIds((ids) =>
              additive ? (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]) : [id]
            )
          }
          onToggleLock={toggleLock}
          onReorder={reorderLayer}
          onSetPlane={setPlane}
          onDelete={deleteElement}
          zones={zones}
          selectedZoneId={selectedZoneId}
          onSelectZone={(id) => {
            setSelectedZoneId(id);
            setSelectedIds([]);
            setEditingId(null);
          }}
          onDeleteZone={removeZone}
          onToggleZoneLock={toggleZoneLock}
          bgUrl={bgUrl}
          onClearBg={() => {
            setBgUrl(null);
            setBgFalUrl(null);
          }}
        />

        {/* Canvas area */}
        <div ref={areaRef} className="flex min-w-0 flex-1 items-center justify-center overflow-hidden p-6">
          {cw > 0 && (
            <div
              ref={canvasRef}
              onPointerDown={() => {
                setSelectedIds([]);
                setEditingId(null);
                setSelectedZoneId(null);
              }}
              className="relative isolate overflow-hidden shadow-2xl shadow-black/50"
              style={{ width: cw, height: ch, containerType: "size", background: bgColor }}
            >
              {bgUrl && <img src={bgUrl} alt="" className="absolute inset-0 z-0 h-full w-full object-cover" />}

              {/* Center snap guides */}
              {snapLines.v && (
                <div
                  className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-accent)]"
                  style={{ zIndex: 6000 }}
                />
              )}
              {snapLines.h && (
                <div
                  className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--color-accent)]"
                  style={{ zIndex: 6000 }}
                />
              )}

              {elements
                .slice()
                .sort((a, b) => layerZ(a) - layerZ(b))
                .map((el) => {
                  const isSel = selectedIds.includes(el.id);
                  const isPrimary = selectedIds.length === 1 && selectedIds[0] === el.id;
                  const isText = el.type === "text";
                  const box = {
                    position: "absolute",
                    left: `${el.xPct}%`,
                    top: `${el.yPct}%`,
                    width: `${el.wPct}%`,
                    // Text height follows its content; images use the stored height.
                    ...(isText ? {} : { height: `${el.hPct}%` }),
                    zIndex: layerZ(el),
                    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                  };
                  return (
                    <div
                      key={el.id}
                      style={box}
                      onPointerDown={(e) => startMove(e, el)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        if (isText) setEditingId(el.id);
                      }}
                      className={`group/el ${isSel ? "outline outline-2 outline-[var(--color-accent)]" : "outline outline-1 outline-transparent hover:outline-[var(--color-accent)]/40"} ${editingId === el.id ? "cursor-text" : "cursor-move"}`}
                    >
                      {el.type === "image" ? (
                        <img
                          src={el.url}
                          alt=""
                          draggable={false}
                          className={`pointer-events-none h-full w-full ${el.fit === "cover" ? "object-cover" : "object-contain"}`}
                        />
                      ) : el.type === "svg" ? (
                        <div
                          style={{ color: el.color }}
                          className={`pointer-events-none h-full w-full ${SVG_FILL}`}
                          dangerouslySetInnerHTML={{ __html: svgMarkup(el) }}
                        />
                      ) : editingId === el.id ? (
                        <div
                          key="edit"
                          contentEditable
                          suppressContentEditableWarning
                          dir="auto"
                          ref={(n) => {
                            editRef.current = n;
                            if (n && n.dataset.init !== "1") {
                              n.dataset.init = "1";
                              n.innerHTML = textHtml(el);
                              n.focus();
                              placeCaretEnd(n);
                            }
                          }}
                          onInput={(e) => {
                            const node = e.currentTarget;
                            const html = sanitizeTextHtml(node.innerHTML);
                            const text = node.textContent;
                            setElements((els) => els.map((x) => (x.id === el.id ? { ...x, html, text } : x)));
                          }}
                          onKeyUp={saveRange}
                          onMouseUp={saveRange}
                          onBlur={saveRange}
                          onPointerDown={(e) => e.stopPropagation()}
                          style={{ ...elementTextCss(el), display: "block", background: "transparent", border: "none", outline: "none", padding: 0, cursor: "text" }}
                          className="w-full"
                        />
                      ) : (
                        <div
                          key="view"
                          dir="auto"
                          style={elementTextCss(el)}
                          className="pointer-events-none select-none"
                          dangerouslySetInnerHTML={{ __html: textHtml(el) || "&nbsp;" }}
                        />
                      )}

                      {isPrimary &&
                        editingId !== el.id &&
                        !el.locked &&
                        handlesFor(el).map((c) => (
                          <span
                            key={c}
                            onPointerDown={(e) => startResize(e, el, c)}
                            className={`absolute z-30 h-3 w-3 rounded-sm border border-white bg-[var(--color-accent)] ${handlePos[c]}`}
                          />
                        ))}
                    </div>
                  );
                })}

              {/* Safe zones: editor-only guides. Never exported or sent as overlay. */}
              {zones.map((z) => {
                const sel = z.id === selectedZoneId;
                return (
                  // Body is click-through (pointer-events-none) so elements
                  // underneath stay selectable. Move/resize via the label tab
                  // and corner handles only. Border-only, no fill.
                  <div
                    key={z.id}
                    style={{
                      position: "absolute",
                      left: `${z.xPct}%`,
                      top: `${z.yPct}%`,
                      width: `${z.wPct}%`,
                      height: `${z.hPct}%`,
                      zIndex: 5000,
                    }}
                    className={`pointer-events-none border-2 border-dashed ${
                      sel ? "border-amber-400" : "border-amber-400/60"
                    }`}
                  >
                    <span
                      onPointerDown={(e) => startMoveZone(e, z)}
                      className={`pointer-events-auto absolute left-0 top-0 flex -translate-y-full items-center gap-1 bg-amber-400 px-1 text-[9px] font-semibold text-black ${
                        z.locked ? "cursor-default" : "cursor-move"
                      }`}
                    >
                      {z.locked && "🔒"} Safe zone
                    </span>
                    {!z.locked && (
                      <button
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          removeZone(z.id);
                        }}
                        title="Remove safe zone"
                        className="pointer-events-auto absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-amber-400 text-[10px] font-bold text-black"
                      >
                        ×
                      </button>
                    )}
                    {sel &&
                      !z.locked &&
                      ["nw", "ne", "sw", "se"].map((c) => (
                        <span
                          key={c}
                          onPointerDown={(e) => startResizeZone(e, z, c)}
                          className={`pointer-events-auto absolute z-30 h-3 w-3 rounded-sm border border-white bg-amber-400 ${handlePos[c]}`}
                        />
                      ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Properties panel */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-panel)] p-4">
          {selectedIds.length >= 2 ? (
            <AlignPanel count={selectedIds.length} onAlign={alignSelected} onDelete={removeSelected} />
          ) : !selected ? (
            <p className="text-xs leading-relaxed text-zinc-500">
              Select an element to edit it. Add text or images from the top bar, then drag to move and
              pull the corners to resize. Double-click text to type. Shift-click to select multiple and
              align them. Use a variable like{" "}
              <span className="font-mono text-[var(--color-accent)]">{"{{Child_Name}}"}</span> to fill
              in per order.
            </p>
          ) : selected.locked ? (
            <div className="space-y-3">
              <PanelLabel>{selected.type === "svg" ? "Symbol" : selected.type === "image" ? "Image" : "Text"}</PanelLabel>
              <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-200">
                This layer is locked. Unlock it from the Layers panel to edit, move, or resize it.
              </div>
            </div>
          ) : selected.type === "svg" ? (
            <div className="space-y-3">
              <PanelLabel>Symbol</PanelLabel>
              <div
                className={`mx-auto flex h-20 w-20 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] ${SVG_FILL}`}
                style={{ color: selected.color }}
                dangerouslySetInnerHTML={{ __html: svgMarkup(selected) }}
              />
              <div className="flex items-center gap-2">
                <PanelLabel>Color</PanelLabel>
                <input
                  type="color"
                  value={selected.color || "#fbbf24"}
                  onChange={(e) => patchSel({ color: e.target.value })}
                  disabled={selected.tint === false}
                  className="h-7 w-8 cursor-pointer rounded border border-[var(--color-border)] bg-transparent p-0 disabled:opacity-40"
                />
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={selected.tint !== false}
                    onChange={(e) => patchSel({ tint: e.target.checked })}
                  />
                  Tint
                </label>
              </div>
              <div>
                <PanelLabel>Size</PanelLabel>
                <RangeNum
                  value={selected.wPct || 24}
                  min={1}
                  max={90}
                  step={0.5}
                  onChange={(v) => patchSel({ wPct: v, hPct: v })}
                />
              </div>
              <div>
                <PanelLabel>Rotation (°)</PanelLabel>
                <RangeNum
                  value={Math.round(selected.rotation || 0)}
                  min={-180}
                  max={180}
                  step={1}
                  onChange={(v) => patchSel({ rotation: v })}
                />
                {(selected.rotation || 0) !== 0 && (
                  <button
                    onClick={() => patchSel({ rotation: 0 })}
                    className="mt-1 text-[10px] text-zinc-500 hover:text-zinc-300"
                  >
                    Reset rotation
                  </button>
                )}
              </div>
              <LayerActions
                onFront={() => patchSel({ z: maxZ() + 1 })}
                onBack={() => patchSel({ z: minZ() - 1 })}
                onDuplicate={duplicateSelected}
                onDelete={removeSelected}
                onCenterH={() => centerOnPage("h")}
                onCenterV={() => centerOnPage("v")}
              />
            </div>
          ) : selected.type === "text" ? (
            <div className="space-y-3">
              <PanelLabel>Text</PanelLabel>
              <textarea
                value={selected.text}
                onChange={(e) => patchSel({ text: e.target.value, html: escapeHtml(e.target.value) })}
                rows={3}
                dir="auto"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
              />
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Double-click the text on the page to edit it inline. Select part of it, then pick a color below to tint just that selection.
              </p>
              <div className="flex gap-1">
                {[
                  { id: "left", icon: "⇤" },
                  { id: "center", icon: "↔" },
                  { id: "right", icon: "⇥" },
                ].map((a) => (
                  <PanelBtn key={a.id} active={selected.align === a.id} onClick={() => patchSel({ align: a.id })}>
                    {a.icon}
                  </PanelBtn>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <PanelBtn active={selected.bold} onClick={() => patchSel({ bold: !selected.bold })}>
                  B
                </PanelBtn>
                <PanelBtn active={selected.italic} onClick={() => patchSel({ italic: !selected.italic })}>
                  <span className="italic">I</span>
                </PanelBtn>
                <select
                  value={selected.font || "sans"}
                  onChange={(e) => patchSel({ font: e.target.value })}
                  className="min-w-0 flex-1 rounded bg-[var(--color-panel-2)] px-1.5 py-1 text-xs text-zinc-200 focus:outline-none"
                  style={{ fontFamily: fontStack(selected.font) }}
                >
                  <optgroup label="English">
                    {FONTS.filter((f) => f.script !== "arabic").map((f) => (
                      <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                        {f.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="العربية / Arabic">
                    {FONTS.filter((f) => f.script === "arabic").map((f) => (
                      <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                        {f.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <input
                  type="color"
                  title="Color (selection while editing, else whole text)"
                  value={(editingId && selectionColor) || selected.color || "#1f2937"}
                  onMouseDown={saveRange}
                  onChange={(e) => applyTextColor(e.target.value)}
                  className="h-7 w-8 shrink-0 cursor-pointer rounded border border-[var(--color-border)] bg-transparent p-0"
                />
                <HexInput
                  value={(editingId && selectionColor) || selected.color || "#1f2937"}
                  onChange={(hex) => applyTextColor(hex)}
                />
              </div>
              <div>
                <PanelLabel>Size (% of page)</PanelLabel>
                <RangeNum
                  value={selected.fontSizePct || 6}
                  min={1}
                  max={40}
                  step={0.5}
                  onChange={(v) => patchSel({ fontSizePct: v })}
                />
              </div>
              <div>
                <PanelLabel>Letter spacing (em)</PanelLabel>
                <RangeNum
                  value={selected.letterSpacing || 0}
                  min={-0.1}
                  max={1}
                  step={0.01}
                  onChange={(v) => patchSel({ letterSpacing: v })}
                />
              </div>
              <div>
                <PanelLabel>Line height</PanelLabel>
                <RangeNum
                  value={selected.lineHeight || 1.3}
                  min={0.8}
                  max={3}
                  step={0.05}
                  onChange={(v) => patchSel({ lineHeight: v })}
                />
              </div>
              {variables.length > 0 && (
                <div>
                  <PanelLabel>Insert variable</PanelLabel>
                  <div className="flex flex-wrap gap-1">
                    {variables.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => insertVar(v.name)}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-accent)] hover:bg-[#242838]"
                      >
                        {`{{${v.name}}}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <LayerActions
                onFront={() => patchSel({ z: maxZ() + 1 })}
                onBack={() => patchSel({ z: minZ() - 1 })}
                onDuplicate={duplicateSelected}
                onDelete={removeSelected}
                onCenterH={() => centerOnPage("h")}
                onCenterV={() => centerOnPage("v")}
              />
            </div>
          ) : (
            <div className="space-y-3">
              <PanelLabel>Image</PanelLabel>
              <img src={selected.url} alt="" className="w-full rounded-md border border-[var(--color-border)] object-contain" />
              <button
                onClick={() => replaceInputRef.current?.click()}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838]"
              >
                Replace image
              </button>
              <div>
                <PanelLabel>Layer group</PanelLabel>
                <div className="flex gap-1">
                  <PanelBtn active={selected.plane === "ai"} onClick={() => patchSel({ plane: "ai" })}>
                    AI
                  </PanelBtn>
                  <PanelBtn active={selected.plane !== "ai"} onClick={() => patchSel({ plane: "overlay" })}>
                    Overlay
                  </PanelBtn>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
                  {selected.plane === "ai"
                    ? "Sent to the AI and regenerated with the child. Sits behind overlay layers."
                    : "Composited as-is and never touched by the AI."}
                </p>
              </div>
              {selected.plane === "ai" && (
                <div>
                  <PanelLabel>Generation prompt</PanelLabel>
                  <textarea
                    rows={4}
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="Describe what this page's image should show — e.g. the child riding a friendly dragon over a candy forest at sunset."
                    className="mt-1 w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-xs leading-relaxed focus:border-[var(--color-accent)] focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                    Extra guidance for generating this page, added on top of the story style. Saved
                    with the page.
                  </p>
                </div>
              )}
              <div className="flex gap-1">
                <PanelBtn active={(selected.fit || "contain") === "contain"} onClick={() => patchSel({ fit: "contain" })}>
                  Fit
                </PanelBtn>
                <PanelBtn active={selected.fit === "cover"} onClick={() => patchSel({ fit: "cover" })}>
                  Fill
                </PanelBtn>
              </div>
              <button
                onClick={() => patchSel({ xPct: 0, yPct: 0, wPct: 100, hPct: 100, rotation: 0, fit: "cover" })}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838]"
              >
                Fill page
              </button>
              <div>
                <PanelLabel>Rotation (°)</PanelLabel>
                <RangeNum
                  value={Math.round(selected.rotation || 0)}
                  min={-180}
                  max={180}
                  step={1}
                  onChange={(v) => patchSel({ rotation: v })}
                />
              </div>
              <LayerActions
                onFront={() => patchSel({ z: maxZ() + 1 })}
                onBack={() => patchSel({ z: minZ() - 1 })}
                onDuplicate={duplicateSelected}
                onDelete={removeSelected}
                onCenterH={() => centerOnPage("h")}
                onCenterV={() => centerOnPage("v")}
              />
            </div>
          )}
        </div>
      </div>

      <input
        ref={imgInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) addImageFile(f);
          e.target.value = "";
        }}
      />
      <input
        ref={svgInputRef}
        type="file"
        accept=".svg,image/svg+xml"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) addSvgFile(f);
          e.target.value = "";
        }}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) replaceSelectedImage(f);
          e.target.value = "";
        }}
      />

      {symbolPicker && (
        <SymbolPicker
          customSymbols={customSymbols}
          onClose={() => setSymbolPicker(false)}
          onPick={(s) => addSymbol(s.svg, s.name)}
          onUpload={() => svgInputRef.current?.click()}
          onDeleteSymbol={onDeleteSymbol}
        />
      )}
    </div>
  );
}

function SymbolPicker({ onClose, onPick, onUpload, customSymbols = [], onDeleteSymbol }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const query = q.trim().toLowerCase();

  // Uploaded symbols live in a "Custom" category shown first, ahead of the
  // built-in library.
  const hasCustom = customSymbols.length > 0;
  const categories = hasCustom ? ["Custom", ...SYMBOL_CATEGORIES] : SYMBOL_CATEGORIES;
  const library = hasCustom ? [...customSymbols, ...SYMBOL_LIBRARY] : SYMBOL_LIBRARY;
  const customIds = new Set(customSymbols.map((s) => s.id));

  const filtered = library.filter(
    (s) =>
      (cat === "All" || s.category === cat) &&
      (!query || s.name.toLowerCase().includes(query) || s.category.toLowerCase().includes(query))
  );
  // When searching, show a flat result list; otherwise group by category.
  const groups =
    query || cat !== "All"
      ? [{ category: cat === "All" ? "Results" : cat, items: filtered }]
      : categories.map((c) => ({
          category: c,
          items: filtered.filter((s) => s.category === c),
        }));

  async function handleDelete(e, s) {
    e.stopPropagation();
    if (!onDeleteSymbol) return;
    if (!confirm(`Remove “${s.name}” from your saved symbols?`)) return;
    try {
      await onDeleteSymbol(s.id);
    } catch (err) {
      alert(`Couldn't delete that symbol: ${err.message}`);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onPointerDown={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <span className="text-sm font-semibold">Symbols · {library.length}</span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="space-y-2 border-b border-[var(--color-border)] px-4 py-3">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search symbols…"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
          />
          <div className="flex flex-wrap gap-1">
            {["All", ...categories].map((c) => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                  cat === c
                    ? "bg-[var(--color-accent)] text-black"
                    : "border border-[var(--color-border)] bg-[var(--color-panel-2)] text-zinc-300 hover:bg-[#242838]"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {filtered.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-zinc-500">No symbols match “{q}”.</p>
          ) : (
            groups
              .filter((g) => g.items.length)
              .map((g) => (
                <div key={g.category} className="mb-4 last:mb-0">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    {g.category}
                  </p>
                  <div className="grid grid-cols-6 gap-2">
                    {g.items.map((s) => {
                      const isCustom = customIds.has(s.id);
                      return (
                        <div key={s.id} className="group relative">
                          <button
                            title={s.name}
                            onClick={() => onPick(s)}
                            className={`flex aspect-square w-full items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-2.5 text-zinc-200 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] ${SVG_FILL}`}
                            dangerouslySetInnerHTML={{ __html: s.svg }}
                          />
                          {isCustom && onDeleteSymbol && (
                            <button
                              title="Delete symbol"
                              onClick={(e) => handleDelete(e, s)}
                              className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] text-[11px] leading-none text-zinc-400 shadow group-hover:flex hover:text-rose-400"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-4 py-3">
          <button
            onClick={onUpload}
            className="w-full rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-xs font-medium text-zinc-300 hover:bg-[#242838]"
          >
            Upload custom .svg
          </button>
        </div>
      </div>
    </div>
  );
}

function layerLabel(el) {
  return el.type === "text"
    ? (el.text || "Text").slice(0, 22) || "Text"
    : el.type === "svg"
    ? el.name || "Symbol"
    : "Image";
}

function LayerRow({ el, isSel, onSelect, onToggleLock, onReorder, onSetPlane, onDelete }) {
  return (
    <div
      onPointerDown={(e) => onSelect(el.id, e.shiftKey)}
      className={`group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs ${
        isSel ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]" : "text-zinc-300 hover:bg-[var(--color-panel-2)]"
      }`}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center text-zinc-500 ${SVG_FILL}`}
        style={el.type === "svg" ? { color: el.color } : undefined}
        dangerouslySetInnerHTML={el.type === "svg" ? { __html: svgMarkup(el) } : undefined}
      >
        {el.type === "svg" ? undefined : el.type === "image" ? "🖼" : "T"}
      </span>
      <span className="min-w-0 flex-1 truncate">{layerLabel(el)}</span>
      <div className="flex shrink-0 items-center gap-0.5">
        {el.type === "image" && (
          <button
            onPointerDown={(e) => {
              e.stopPropagation();
              onSetPlane(el.id, isAiLayer(el) ? "overlay" : "ai");
            }}
            title={isAiLayer(el) ? "Move to Overlay (don't generate)" : "Move to AI (generate with child)"}
            className="rounded px-1 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            ⇅
          </button>
        )}
        <button
          onPointerDown={(e) => {
            e.stopPropagation();
            onReorder(el.id, 1);
          }}
          title="Move forward"
          className="rounded px-1 text-[10px] text-zinc-500 hover:text-zinc-200"
        >
          ▲
        </button>
        <button
          onPointerDown={(e) => {
            e.stopPropagation();
            onReorder(el.id, -1);
          }}
          title="Move backward"
          className="rounded px-1 text-[10px] text-zinc-500 hover:text-zinc-200"
        >
          ▼
        </button>
        <button
          onPointerDown={(e) => {
            e.stopPropagation();
            onToggleLock(el.id);
          }}
          title={el.locked ? "Unlock" : "Lock"}
          className={`rounded px-1 text-[11px] ${
            el.locked ? "text-[var(--color-accent)]" : "text-zinc-500 hover:text-zinc-200"
          }`}
        >
          {el.locked ? "🔒" : "🔓"}
        </button>
        <button
          onPointerDown={(e) => {
            e.stopPropagation();
            onDelete(el.id);
          }}
          title="Delete layer"
          className="rounded px-1 text-[11px] text-zinc-500 hover:text-rose-300"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function LayersPanel({ elements, selectedIds, onSelect, onToggleLock, onReorder, onSetPlane, onDelete, zones = [], selectedZoneId, onSelectZone, onDeleteZone, onToggleZoneLock, bgUrl, onClearBg }) {
  // Front-most (highest z) first within each group.
  const byZDesc = (a, b) => (b.z || 1) - (a.z || 1);
  const aiLayers = elements.filter(isAiLayer).sort(byZDesc);
  const overlayLayers = elements.filter((el) => !isAiLayer(el)).sort(byZDesc);

  const rowProps = { onSelect, onToggleLock, onReorder, onSetPlane, onDelete };
  const Group = ({ title, hint, items, emptyHint }) => (
    <div>
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{title}</span>
        {hint && <span className="text-[9px] text-zinc-600">{hint}</span>}
      </div>
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-2 text-[10px] leading-relaxed text-zinc-600">
          {emptyHint}
        </p>
      ) : (
        <div className="space-y-1">
          {items.map((el) => (
            <LayerRow key={el.id} el={el} isSel={selectedIds.includes(el.id)} {...rowProps} />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex w-52 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="border-b border-[var(--color-border)] px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Layers</span>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
        <Group
          title="AI image"
          hint={`${aiLayers.length} sent`}
          items={aiLayers}
          emptyHint="No AI layer. Move an image here to regenerate it with the child."
        />
        <Group
          title="Overlay"
          hint="not generated"
          items={overlayLayers}
          emptyHint="Text, symbols, and static images go here."
        />
        <div>
          <div className="flex items-center justify-between px-1 pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Safe zones</span>
            <span className="text-[9px] text-zinc-600">guides only</span>
          </div>
          {zones.length === 0 ? (
            <p className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-2 text-[10px] leading-relaxed text-zinc-600">
              Editor-only guides that tell the AI to leave clear space. Add one from the toolbar.
            </p>
          ) : (
            <div className="space-y-1">
              {zones.map((z, i) => (
                <div
                  key={z.id}
                  onPointerDown={() => onSelectZone?.(z.id)}
                  className={`group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs ${
                    z.id === selectedZoneId
                      ? "bg-amber-400/15 text-amber-300"
                      : "text-zinc-300 hover:bg-[var(--color-panel-2)]"
                  }`}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-dashed border-amber-400/70 text-[9px] text-amber-400/80">
                    ⛶
                  </span>
                  <span className="min-w-0 flex-1 truncate">Safe zone {i + 1}</span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onToggleZoneLock?.(z.id);
                      }}
                      title={z.locked ? "Unlock" : "Lock"}
                      className={`rounded px-1 text-[11px] ${
                        z.locked ? "text-amber-300" : "text-zinc-500 hover:text-zinc-200"
                      }`}
                    >
                      {z.locked ? "🔒" : "🔓"}
                    </button>
                    <button
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onDeleteZone?.(z.id);
                      }}
                      title="Delete safe zone"
                      className="rounded px-1 text-[11px] text-zinc-500 hover:text-rose-300"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {bgUrl && (
          <div>
            <div className="px-1 pb-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Background</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-300">
              <img src={bgUrl} alt="" className="h-5 w-5 shrink-0 rounded-sm object-cover" />
              <span className="min-w-0 flex-1 truncate">Page background</span>
              <button
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onClearBg();
                }}
                title="Remove legacy background image"
                className="rounded px-1 text-[11px] text-zinc-500 hover:text-rose-300"
              >
                ×
              </button>
            </div>
            <p className="px-1 pt-1 text-[10px] leading-relaxed text-zinc-600">
              Legacy full-page image behind all layers. Remove if the AI image now covers the page.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function PanelLabel({ children }) {
  return <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{children}</p>;
}

// Hex text field with a fixed "#" prefix, so you only type the digits (the #
// is optional). Accepts 3- or 6-digit hex. Commits on Enter or blur; reverts
// to the current value if the input isn't valid hex.
function HexInput({ value, onChange }) {
  const strip = (v) => (v || "").replace(/^#/, "");
  const [draft, setDraft] = useState(strip(value));
  useEffect(() => setDraft(strip(value)), [value]);
  const commit = () => {
    let v = (draft || "").trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(v)) v = [...v].map((x) => x + x).join("");
    if (/^[0-9a-fA-F]{6}$/.test(v)) onChange("#" + v.toLowerCase());
    else setDraft(strip(value));
  };
  return (
    <div className="flex h-7 shrink-0 items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1 focus-within:border-[var(--color-accent)]">
      <span className="font-mono text-[11px] text-zinc-500">#</span>
      <input
        type="text"
        value={draft.toUpperCase()}
        spellCheck={false}
        maxLength={6}
        // Keep only hex characters as the user types.
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9a-fA-F]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="w-[60px] bg-transparent text-center font-mono text-[11px] uppercase text-zinc-200 focus:outline-none"
      />
    </div>
  );
}

// Slider paired with a number input so values can be dragged or typed exactly.
function RangeNum({ value, min, max, step = 1, onChange }) {
  const v = value ?? min;
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => {
          if (e.target.value === "") return;
          onChange(clamp(Number(e.target.value), min, max));
        }}
        className="w-16 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-1 text-right text-[11px] text-zinc-200 focus:border-[var(--color-accent)] focus:outline-none"
      />
    </div>
  );
}

function PanelBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-xs font-medium transition ${
        active ? "bg-[var(--color-accent)] text-black" : "border border-[var(--color-border)] bg-[var(--color-panel-2)] text-zinc-300 hover:bg-[#242838]"
      }`}
    >
      {children}
    </button>
  );
}

function LayerActions({ onFront, onBack, onDuplicate, onDelete, onCenterH, onCenterV }) {
  return (
    <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
      {(onCenterH || onCenterV) && (
        <>
          <PanelLabel>Center on page</PanelLabel>
          <div className="flex gap-1">
            <PanelBtn onClick={onCenterH}>↔ Horizontal</PanelBtn>
            <PanelBtn onClick={onCenterV}>↕ Vertical</PanelBtn>
          </div>
        </>
      )}
      <PanelLabel>Arrange</PanelLabel>
      <div className="flex flex-wrap gap-1">
        <PanelBtn onClick={onFront}>Front</PanelBtn>
        <PanelBtn onClick={onBack}>Back</PanelBtn>
        <PanelBtn onClick={onDuplicate}>Duplicate</PanelBtn>
        <button
          onClick={onDelete}
          className="flex h-7 items-center justify-center rounded border border-[var(--color-border)] px-2 text-xs text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function AlignPanel({ count, onAlign, onDelete }) {
  const Row = ({ label, items }) => (
    <div>
      <PanelLabel>{label}</PanelLabel>
      <div className="flex gap-1">
        {items.map((it) => (
          <PanelBtn key={it.kind} onClick={() => onAlign(it.kind)}>
            {it.icon}
          </PanelBtn>
        ))}
      </div>
    </div>
  );
  return (
    <div className="space-y-3">
      <PanelLabel>{count} selected</PanelLabel>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Align the selected layers to each other. Shift-click layers to add or remove them.
      </p>
      <Row
        label="Horizontal"
        items={[
          { kind: "left", icon: "⬅" },
          { kind: "centerH", icon: "↔" },
          { kind: "right", icon: "➡" },
        ]}
      />
      <Row
        label="Vertical"
        items={[
          { kind: "top", icon: "⬆" },
          { kind: "middleV", icon: "↕" },
          { kind: "bottom", icon: "⬇" },
        ]}
      />
      <div className="border-t border-[var(--color-border)] pt-3">
        <button
          onClick={onDelete}
          className="flex h-7 items-center justify-center rounded border border-[var(--color-border)] px-2 text-xs text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
        >
          Delete selected
        </button>
      </div>
    </div>
  );
}

function Cell({
  cell,
  ratio,
  label,
  variables,
  busy,
  isDragging,
  isOver,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onUploadImage,
  onUploadBackground,
  onRemoveBackground,
  onSaveText,
  onOpenEditor,
  onDelete,
  onSetCellScoring,
}) {
  const fileRef = useRef(null);
  const bgRef = useRef(null);

  const isText = cell.type === "text";
  const hasImage = cell.type === "image" && cell.localUrl;
  const hasElements = Array.isArray(cell.elements) && cell.elements.length > 0;
  const isEmpty = !isText && !hasImage && !hasElements;
  const hasBg = !!cell.bgUrl;
  // A background sits behind text/empty cells (a photo cell is its own content).
  const showBg = hasBg && !hasImage && !hasElements;

  const frame = `group relative overflow-hidden transition ${
    isDragging ? "opacity-40" : ""
  } ${isOver ? "ring-2 ring-[var(--color-accent)]" : ""}`;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`${frame} ${isText ? "bg-[var(--color-panel)]" : "bg-white"} cursor-grab active:cursor-grabbing`}
    >
      {/* Free-form page (elements) */}
      {hasElements && <CellCanvas cell={cell} ratio={ratio} className="w-full" />}

      {/* Background image (behind text/empty legacy content) */}
      {showBg && (
        <img src={cell.bgUrl} alt="" className="absolute inset-0 z-0 h-full w-full object-cover" />
      )}

      {/* Legacy content (cells not yet migrated to elements) */}
      {!hasElements && hasImage && (
        <img src={cell.localUrl} alt="" style={{ aspectRatio: ratio }} className="w-full object-contain" />
      )}
      {!hasElements && isText && (
        <div
          style={{ aspectRatio: ratio }}
          className="relative z-10 flex w-full items-center justify-center overflow-auto p-4"
        >
          <div style={textStyleToCss(cell.style)}>
            {cell.text ? renderWithVars(cell.text) : <span className="text-zinc-500">Empty text</span>}
          </div>
        </div>
      )}
      {isEmpty && (
        <div
          style={{ aspectRatio: ratio }}
          className={`relative z-10 flex w-full flex-col items-center justify-center gap-2 border border-dashed border-[var(--color-border)] text-zinc-400 ${
            showBg ? "bg-black/30" : "bg-[var(--color-panel-2)]"
          }`}
        >
          {busy ? (
            <Spinner />
          ) : (
            <>
              <button
                onClick={() => onOpenEditor(cell.id)}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-black"
              >
                Design page
              </button>
            </>
          )}
        </div>
      )}

      {busy && !isEmpty && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40">
          <Spinner />
        </div>
      )}

      {/* Label */}
      <span className="absolute left-1 top-1 z-20 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
        {label}
      </span>

      {/* Identity-scoring level (set by Analyze, manually overridable) */}
      {onSetCellScoring && (
        <select
          value={cell.identityScoring || ""}
          onChange={(e) => onSetCellScoring(cell.id, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          title={
            cell.identityNote
              ? `${cell.identityScoringManual ? "Manual · " : ""}${cell.identityNote}`
              : "How this page's identity match is scored per order"
          }
          className={`absolute bottom-1 left-1 z-20 cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-semibold outline-none ${scoringTagClass(
            cell.identityScoring
          )}`}
        >
          <option value="" disabled>
            unanalyzed
          </option>
          <option value="strict">★ strict</option>
          <option value="advisory">~ advisory</option>
          <option value="none">— none</option>
        </select>
      )}

      {/* Controls */}
      <div className="absolute right-1 top-1 z-20 flex gap-1 opacity-0 transition group-hover:opacity-100">
        {!isEmpty && (
          <button
            onClick={() => onOpenEditor(cell.id)}
            title="Open full editor"
            className="flex h-6 items-center justify-center rounded bg-black/70 px-1.5 text-[12px] font-medium text-white hover:bg-black"
          >
            ⛶
          </button>
        )}
        {!hasElements && isText && (
          <button
            onClick={() => onOpenEditor(cell.id)}
            title="Edit in page editor"
            className="flex h-6 items-center justify-center rounded bg-black/70 px-1.5 text-[10px] font-medium text-white hover:bg-black"
          >
            Edit
          </button>
        )}
        {showBg && (
          <button
            onClick={() => onRemoveBackground(cell.id)}
            title="Remove background image"
            className="flex h-6 items-center justify-center rounded bg-black/70 px-1.5 text-[10px] font-medium text-white hover:bg-rose-600"
          >
            BG×
          </button>
        )}
        {!hasElements && hasImage && (
          <button
            onClick={() => fileRef.current?.click()}
            title="Replace photo"
            className="flex h-6 items-center justify-center rounded bg-black/70 px-1.5 text-[10px] font-medium text-white hover:bg-black"
          >
            ⟳
          </button>
        )}
        <button
          onClick={() => onDelete(cell.id)}
          title="Delete cell"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-sm text-white hover:bg-rose-600"
        >
          ×
        </button>
      </div>

      <input
        ref={bgRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUploadBackground(cell.id, f);
          e.target.value = "";
        }}
      />

                  <input
        ref={fileRef}
                    type="file"
                    accept="image/*"
                    hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUploadImage(cell.id, f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Spread({ children }) {
  return (
    <div className="grid w-full grid-cols-2 gap-px overflow-hidden border border-[var(--color-border)] bg-[var(--color-border)] shadow-lg shadow-black/30">
      {children}
    </div>
  );
}

// Book structure: cover (1 page, alone) · middle spreads (2 pages each) ·
// back cover (1 page, alone). Each row carries page labels for display.
function buildBookRows(cells) {
  const n = cells.length;
  if (n === 0) return [];
  const rows = [{ kind: "cover", cell: cells[0], label: "Cover" }];
  if (n >= 2) {
    const middle = cells.slice(1, n - 1);
    for (let i = 0; i < middle.length; i += 2) {
      rows.push({
        kind: "spread",
        cells: middle.slice(i, i + 2),
        labels: [`Page ${i + 2}`, `Page ${i + 3}`],
      });
    }
    rows.push({ kind: "back", cell: cells[n - 1], label: "Back cover" });
  }
  return rows;
}

/* ============================ ORDER BOOK (read-only) ============================ */
function OrderBook({ cells, results, aspect, variables }) {
  const ratio = (aspect || "3:4").replace(":", " / ");
  const rows = buildBookRows(cells);
  const resolve = (t) => applyVarsClient(t, variables || {});

  const renderPage = (cell) => {
    const hasElements = Array.isArray(cell.elements) && cell.elements.length > 0;
    // Free-form pages (and legacy text) render via the canvas with vars filled.
    if (hasElements || cell.type === "text") {
      return (
        <CellCanvas
          cell={cell}
          ratio={ratio}
          resolve={resolve}
          aiResultUrl={results?.[cell.id]?.url}
          className="w-full bg-[var(--color-panel)]"
        />
      );
    }
    const url = results?.[cell.id]?.url || cell.localUrl;
    return url ? (
      <img src={url} alt="" style={{ aspectRatio: ratio }} className="w-full bg-white object-contain" />
    ) : (
      <div
        style={{ aspectRatio: ratio }}
        className="flex w-full items-center justify-center bg-[var(--color-panel-2)] text-xs text-zinc-600"
      >
        Not generated
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {rows.map((row) => {
        if (row.kind === "cover") {
          return (
            <Spread key={row.cell.id}>
              <div className="hidden sm:block" />
              {renderPage(row.cell)}
            </Spread>
          );
        }
        if (row.kind === "back") {
          return (
            <Spread key={row.cell.id}>
              {renderPage(row.cell)}
              <div className="hidden sm:block" />
            </Spread>
          );
        }
        return (
          <Spread key={row.cells[0].id + (row.cells[1]?.id || "")}>
            {renderPage(row.cells[0])}
            {row.cells[1] ? renderPage(row.cells[1]) : <div className="hidden sm:block" />}
          </Spread>
        );
      })}
    </div>
  );
}

/* ============================ ORDER DETAIL ============================ */
function OrderDetail({
  order,
  kid,
  results,
  onBack,
  onDelete,
  kidInput,
  onUploadKid,
  stage,
  kidBusy,
  regenerateAnchor,
  mode,
  setMode,
  prompt,
  setPrompt,
  showPrompt,
  setShowPrompt,
  generateAll,
  generateOne,
  generatingAll,
  busy,
  config,
}) {
  const [showPreview, setShowPreview] = useState(true);
  return (
    <>
      <BackButton onClick={onBack} />
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{order.title}</h1>
            <button
              onClick={() => navigator.clipboard?.writeText(orderRef(order.id))}
              title="Copy order ID"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-0.5 font-mono text-[11px] text-zinc-400 hover:text-zinc-200"
            >
              {orderRef(order.id)}
            </button>
          </div>
          <p className="text-sm text-zinc-400">
            Story: {order.storyTitle} · {order.scenes.length} scene
            {order.scenes.length === 1 ? "" : "s"}
            {" · "}
            {order.gender === "male" ? "Boy" : order.gender === "non-binary" ? "Child" : "Girl"}
            {order.age ? `, age ${order.age}` : ""}
          </p>
        </div>
        <button
          onClick={onDelete}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
        >
          Delete order
        </button>
      </header>

      {order.storyMissing && (
        <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2.5 text-xs text-amber-200">
          This order's story was deleted, so it has no scenes.
        </div>
      )}

      {/* Step 1 - kid */}
      <Section step="1" title="Upload the kid's photo (auto restore + anchor)">
        <div className="flex items-center gap-4">
          <button
            onClick={() => kidInput.current?.click()}
            disabled={kidBusy}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-2 text-sm font-medium hover:bg-[#242838] disabled:opacity-40"
          >
            {kid ? "Change photo" : "Upload photo"}
          </button>
          <input ref={kidInput} type="file" accept="image/*" hidden onChange={onUploadKid} />
                  {kidBusy && (
                    <span className="text-sm text-[var(--color-accent)]">
                      {stage === "uploading"
                        ? "Uploading…"
                        : stage === "restoring"
                        ? "Step 2 of 3 · Restoring photo…"
                        : "Step 3 of 3 · Painting character anchor…"}
                    </span>
                  )}
                </div>

                {(kid || kidBusy) && (
                  <>
                    <div className="mt-4 grid grid-cols-3 gap-4">
                      <Stage
                        label="1 · Original"
                        url={kid?.localUrl}
                        loading={stage === "uploading"}
                        loadingLabel="Uploading…"
                      />
                      <Stage
                        label="2 · Restored"
                        url={kid?.restoreOutcome === "used" ? kid?.restoredLocal : kid?.restoreOutcome ? kid?.localUrl : kid?.restoredLocal}
                        loading={stage === "restoring"}
                        loadingLabel="Restoring…"
                        caption={restoreOutcomeLabel(kid?.restoreOutcome)}
                      />
                      <Stage
                        label="3 · Portrait"
                        url={kid?.presentationLocal || kid?.anchorLocal}
                        highlight
                        loading={stage === "anchoring"}
                        loadingLabel="Painting anchor…"
                      />
                    </div>
                    {kid?.photoStatus && (
                      <div className="mt-3">
                        <PhotoCheckPanel kid={kid} />
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <button
                        onClick={regenerateAnchor}
                disabled={kidBusy || !kid}
                        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
                      >
                        ↻ Regenerate anchor
                      </button>
                      {!kidBusy && (kid?.identityAnchorCheck || kid?.anchorCheck) && (
                        <span className="flex items-center gap-2">
                          <span className="text-xs text-zinc-500">Anchor identity:</span>
                          <ScoreBadge check={kid.identityAnchorCheck || kid.anchorCheck} size="lg" />
                        </span>
                      )}
                      {!kidBusy && kid?.identityAnchorWeak && (
                        <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                          ⚠ Weak anchor — using the photo for likeness
                        </span>
                      )}
                      {!kidBusy && kid?.featuresStruct && (
                        <FeatureBadges features={kid.featuresStruct} />
                      )}
                    </div>
                    {!kidBusy &&
                      (kid?.identityAnchorCheck || kid?.anchorCheck)?.score != null &&
                      (kid?.identityAnchorCheck || kid?.anchorCheck).score < 70 && (
                        <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2.5 text-xs text-amber-200">
                          Weak match — regenerate the anchor before generating pages.
                          <Mismatches check={kid.identityAnchorCheck || kid.anchorCheck} />
                        </div>
                      )}
                  </>
                )}
              </Section>

      {/* Step 2 - generate */}
      <Section step="2" title="Generate scenes with this kid">
        <div className="mb-3 text-xs text-zinc-500">
          Child:{" "}
          <span className="text-zinc-300">
            {order.gender === "male" ? "Boy" : order.gender === "non-binary" ? "Child" : "Girl"}
            {order.age ? `, age ${order.age}` : ""}
          </span>{" "}
          <span className="text-zinc-600">— set on the story</span>
        </div>

                <div className="mb-3">
                  <button
                    onClick={() => setShowPrompt((v) => !v)}
                    className="text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    {showPrompt ? "▾ Hide" : "▸ Show"} swap instruction (advanced)
                  </button>
                  {showPrompt && (
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={4}
                      className="mt-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-sm text-zinc-200 focus:border-[var(--color-accent)] focus:outline-none"
                    />
                  )}
                </div>

                <button
                  onClick={generateAll}
          disabled={!kid || kidBusy || generatingAll || order.scenes.length === 0}
                  className="rounded-lg bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {generatingAll ? "Generating…" : "Generate all scenes"}
                </button>
        {order.scenes.length === 0 && !order.storyMissing && (
          <p className="mt-2 text-xs text-amber-300">
            This story has no scenes yet — add them in the “Stories” section.
          </p>
        )}
                {!config?.falConfigured && (
                  <p className="mt-2 text-xs text-amber-300">
                    FAL_KEY not detected on the server — add it to server/.env and restart.
                  </p>
                )}
              </Section>

      {order.scenes.length > 0 && (
        <Section step="" title="Pages · Original → Updated">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs text-zinc-600">
              Left is the original design. Right is this order's version — the child generated into the AI
              image and the name filled in. Pages the AI doesn't touch are marked{" "}
              <span className="text-zinc-400">Static</span>.
            </p>
            <button
              onClick={() => setShowPreview((v) => !v)}
              className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200"
            >
              {showPreview ? "Hide" : "Show"}
            </button>
          </div>
          {showPreview && (
            <div className="space-y-4">
              {order.scenes.map((scene, i) => (
                <OrderPageRow
                  key={scene.id}
                  scene={scene}
                  label={
                    i === 0
                      ? "Cover"
                      : i === order.scenes.length - 1
                      ? "Back cover"
                      : `Page ${i + 1}`
                  }
                  result={results[scene.id]}
                  busy={busy[scene.id]}
                  aspect={order.aspect}
                  variables={order.variables}
                  canGenerate={Boolean(kid)}
                  onRegenerate={() => generateOne(scene.id)}
                />
              ))}
            </div>
          )}
        </Section>
      )}
    </>
  );
}

/* ============================ SHARED UI ============================ */
function Modal({ title, children, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-lg font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function StatusDot({ ok, label, muted }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        className={`h-2 w-2 rounded-full ${
          ok ? "bg-[var(--color-accent-2)]" : muted ? "bg-zinc-600" : "bg-rose-500"
        }`}
      />
      <span className="text-zinc-400">{label}</span>
      <span className="ml-auto text-zinc-600">{ok ? "ready" : "off"}</span>
    </div>
  );
}

function Section({ step, title, children }) {
  return (
    <section className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
        {step ? (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-panel-2)] text-xs text-[var(--color-accent)]">
          {step}
        </span>
        ) : null}
        {title}
      </h2>
      {children}
    </section>
  );
}

function ResultRow({ scene, result, busy, onRegenerate, canGenerate }) {
  return (
    <div className="grid grid-cols-[1fr_1fr_220px] gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
      <LabeledBox label="Original scene">
        <img src={scene.localUrl} alt="" className="w-full rounded-lg object-cover" />
      </LabeledBox>

      <LabeledBox label="Regenerated">
        {busy ? (
          <div className="flex aspect-square items-center justify-center rounded-lg bg-[var(--color-panel-2)] text-sm text-zinc-400">
            Generating…
          </div>
        ) : result ? (
          <img src={result.url} alt="" className="w-full rounded-lg object-cover" />
        ) : (
          <div className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-sm text-zinc-600">
            Not generated
          </div>
        )}
      </LabeledBox>

      <div className="flex flex-col">
        <span className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Consistency</span>
        <div className="flex-1 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-panel-2)]/40 p-3 text-xs text-zinc-400">
          {!result ? (
            <span className="text-zinc-600">Generate to score.</span>
          ) : result.check ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <ScoreBadge check={result.check} />
                <DecisionBadge result={result} />
              </div>
              <Mismatches check={result.check} />
            </>
          ) : (
            <span className="text-zinc-600">No score recorded.</span>
          )}
        </div>
        <button
          onClick={onRegenerate}
          disabled={busy || !canGenerate}
          className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
        >
          {result ? "Regenerate" : "Generate"}
        </button>
      </div>
    </div>
  );
}

// True when the page's text has variables that resolve to a value (so the
// rendered text differs from the authored design).
function textChanges(scene, variables) {
  const vals = variables || {};
  const texts = [];
  if (Array.isArray(scene.elements))
    scene.elements.forEach((el) => {
      if (el.type === "text") texts.push(el.html || el.text || "");
    });
  if (scene.type === "text") texts.push(scene.text || "");
  return texts.some((t) => applyVarsClient(t, vals) !== t);
}

// One page of an order shown as Original → Updated.
//  • Original = the page as designed (template AI image, variable tokens shown).
//  • Updated  = the AI-plane image regenerated with the child + variables filled.
// Pages with no AI image and no variable changes render once, labeled "Static".
function OrderPageRow({ scene, label, result, busy, aspect, variables, canGenerate, onRegenerate }) {
  const ratio = (aspect || "3:4").replace(":", " / ");
  const hasAi = sceneHasAiBase(scene);
  const changes = hasAi || textChanges(scene, variables);
  const identity = (t) => t;
  const resolved = (t) => applyVarsClient(t, variables || {});

  const renderPage = ({ resolve, aiResultUrl }) => {
    const hasElements = Array.isArray(scene.elements) && scene.elements.length > 0;
    if (hasElements || scene.type === "text") {
      return <CellCanvas cell={scene} ratio={ratio} resolve={resolve} aiResultUrl={aiResultUrl} className="w-full" />;
    }
    const url = aiResultUrl || scene.localUrl;
    return url ? (
      <img src={url} alt="" style={{ aspectRatio: ratio }} className="w-full bg-white object-contain" />
    ) : (
      <div
        style={{ aspectRatio: ratio }}
        className="flex w-full items-center justify-center bg-[var(--color-panel-2)] text-xs text-zinc-600"
      >
        Empty page
      </div>
    );
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-zinc-300">{label}</span>
          {!changes && (
            <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
              Static
            </span>
          )}
          {hasAi && scene.identityScoring && !result?.check && (
            <span
              title={scene.identityNote || "Expected identity scoring for this page"}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${scoringTagClass(
                scene.identityScoring
              )}`}
            >
              {scene.identityScoring === "strict"
                ? "★ will score"
                : scene.identityScoring === "advisory"
                ? "~ review only"
                : "— not scored"}
            </span>
          )}
          {result?.check && <ScoreBadge check={result.check} />}
          {result && <DecisionBadge result={result} />}
        </div>
        {hasAi && (
          <button
            onClick={onRegenerate}
            disabled={busy || !canGenerate}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
          >
            {busy ? "Generating…" : result ? "Regenerate" : "Generate"}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6 p-4">
        <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">Original</div>
          {renderPage({ resolve: identity, aiResultUrl: undefined })}
        </div>
        <div className="relative overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
            {changes ? "Updated" : "No changes needed"}
          </div>
          {renderPage({ resolve: resolved, aiResultUrl: result?.url })}
          {hasAi && !result && !busy && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/55 px-3 py-1.5 text-center text-[11px] text-zinc-200">
              Character not generated yet — click Generate
            </div>
          )}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Spinner />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Identity-score color, aligned with the Auto-Decision Engine thresholds
// (minAutoApproveScore = 85, minReviewScore = 70):
//   >= 85 → pass (green) · 70–84 → review (amber) · < 70 → low (red)
function scoreColor(s) {
  if (s >= 85) return "text-[var(--color-accent-2)] border-[var(--color-accent-2)]/40 bg-[var(--color-accent-2)]/10";
  if (s >= 70) return "text-amber-300 border-amber-400/40 bg-amber-400/10";
  return "text-rose-300 border-rose-400/40 bg-rose-400/10";
}

// Pass/review/low glyph for a score, using the same 85/70 thresholds.
function scoreGlyph(s) {
  return s >= 85 ? "✓" : s >= 70 ? "!" : "✗";
}

// Tint for the per-page identity-scoring level chip (story editor).
function scoringTagClass(level) {
  if (level === "strict") return "border border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
  if (level === "advisory") return "border border-amber-400/40 bg-amber-400/10 text-amber-200";
  if (level === "none") return "border border-zinc-600 bg-zinc-700/50 text-zinc-300";
  return "border border-dashed border-zinc-600 bg-black/50 text-zinc-400";
}

const PHOTO_GUIDANCE =
  "Upload one clear front-facing or slight three-quarter photo where both eyes, nose, mouth, and the full face are visible.";

const GREEN = "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
const AMBER = "border-amber-400/40 bg-amber-400/10 text-amber-200";
const ROSE = "border-rose-400/40 bg-rose-400/10 text-rose-200";
const SLATE = "border-zinc-500/40 bg-zinc-500/10 text-zinc-300";

function PhotoStatusBadge({ status, improved }) {
  if (!status) return null;
  const map = {
    accepted: [improved ? "Photo improved automatically" : "Photo accepted", GREEN],
    fixable: ["Improving photo…", SLATE],
    review: ["Needs review", AMBER],
    needs_new_photo: ["Needs new photo", ROSE],
  };
  const entry = map[status];
  if (!entry) return null;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${entry[1]}`}>
      {entry[0]}
    </span>
  );
}

// Photo intake gate summary for a kid card: status badge + reasons + guidance.
function PhotoCheckPanel({ kid }) {
  if (!kid) return null;
  const st = kid.photoStatus;
  if (!st) return null; // legacy kids with no photoStatus → show nothing
  const improved = st === "accepted" && kid.photoFixAttempted;
  // Reasons: for rejections show the exact failure reason; for review surface
  // whatever the (restored, else raw) check flagged.
  const reviewCheck = kid.restoredPhotoCheck || kid.rawPhotoCheck;
  const reasons =
    st === "needs_new_photo"
      ? kid.photoFailureReason
        ? [kid.photoFailureReason]
        : reviewCheck?.reasons || []
      : st === "review"
        ? reviewCheck?.reasons || []
        : [];
  return (
    <div className="flex flex-col gap-1">
      <PhotoStatusBadge status={st} improved={improved} />
      {reasons.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-zinc-400">
          {reasons.map((r, i) => (
            <li key={i}>· {r}</li>
          ))}
        </ul>
      )}
      {(st === "needs_new_photo" || st === "review") && (
        <p className="text-[11px] text-zinc-500">{PHOTO_GUIDANCE}</p>
      )}
    </div>
  );
}

function ScoreBadge({ check, size = "sm" }) {
  if (!check) return null;
  const pad = size === "lg" ? "px-2.5 py-1 text-sm" : "px-2 py-0.5 text-xs";
  const neutral = `inline-flex items-center gap-1 rounded-full border border-zinc-600 bg-zinc-700/30 font-medium text-zinc-400 ${pad}`;

  // Page the story marked as "no character" — never an identity score here.
  if (check.level === "none") {
    return (
      <span title="This page has no clear character, so identity isn't scored." className={neutral}>
        no character
      </span>
    );
  }
  // Face isn't clear enough to judge identity (turned away, looking down, in
  // profile, hidden by hair) — don't show a misleading red fail score.
  if (check.face_visible === false) {
    return (
      <span
        title="The child's face is turned/obscured on this page, so identity can't be scored reliably."
        className={neutral}
      >
        face turned · not scored
      </span>
    );
  }
  if (check.score == null) {
    return <span className="text-xs text-zinc-500">{check.message || "no score"}</span>;
  }
  // Advisory pages: the face is partial/turned by design, so the score is shown
  // with a leading "~" to mark it advisory — but colored by the same 85/70
  // thresholds so a high advisory score reads as passing, not review.
  if (check.level === "advisory") {
    return (
      <span
        title="Advisory page — informational score, colored by the same thresholds but not a hard pass/fail."
        className={`inline-flex items-center gap-1 rounded-full border font-semibold ${pad} ${scoreColor(
          check.score
        )}`}
      >
        ~ {scoreGlyph(check.score)} {check.score}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-semibold ${pad} ${scoreColor(
        check.score
      )}`}
    >
      {scoreGlyph(check.score)} match {check.score}
    </span>
  );
}

// Auto-Decision Engine verdict shown next to the ScoreBadge. Purely informational
// (the manual Approve/Unapprove button is the source of truth for action).
const DECISION_BADGES = {
  auto_approved: { label: "Auto approved", cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" },
  needs_review: { label: "Needs review", cls: "border-amber-400/40 bg-amber-400/10 text-amber-200" },
  rejected: { label: "Rejected", cls: "border-rose-500/40 bg-rose-500/10 text-rose-200" },
  no_score: { label: "No score needed", cls: "border-zinc-600 bg-zinc-700/30 text-zinc-400" },
  failed: { label: "Failed", cls: "border-rose-500/40 bg-rose-500/10 text-rose-200" },
};

const DECISION_THRESHOLDS = { minAutoApproveScore: 85, minReviewScore: 70 };

// The verdict to display/act on. Prefers the backend-stored decision (Step 1+),
// and falls back to deriving it from the saved checker result for older renders
// that were generated before the Auto-Decision Engine existed.
function computeDecision(result) {
  if (!result) return null;
  if (result.decision) return result.decision;
  const check = result.check;
  const scoring = check?.level || "advisory";
  if (scoring === "none") return "no_score";
  if (!check || check.enabled === false || check.message) return "needs_review";
  if (check.face_visible === false) return "needs_review";
  if (scoring === "advisory") return "auto_approved";
  if (scoring === "strict") {
    const s = typeof check.score === "number" ? check.score : null;
    if (s == null) return "needs_review";
    if (s >= DECISION_THRESHOLDS.minAutoApproveScore && check.same_child !== false)
      return "auto_approved";
    if (s >= DECISION_THRESHOLDS.minReviewScore) return "needs_review";
    return "rejected";
  }
  return "needs_review";
}

// Whether a page counts as approved for progress/publishing. A manual override
// always wins; otherwise an auto-approved / no-score verdict counts.
function isPageApproved(result) {
  if (!result) return false;
  if (result.manualApprovalOverride === true) return result.approved === true;
  if (result.approved === true) return true;
  const d = computeDecision(result);
  return d === "auto_approved" || d === "no_score";
}

function DecisionBadge({ result }) {
  const meta = DECISION_BADGES[computeDecision(result)];
  if (!meta) return null;
  return (
    <span
      title={result.decisionReason || ""}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}

function Mismatches({ check }) {
  if (!check?.mismatches?.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-zinc-400">
      {check.mismatches.map((m, i) => (
        <li key={i}>· {m}</li>
      ))}
    </ul>
  );
}

// Compact chips for a child's structured features (skin tone, hair length, …).
function FeatureBadges({ features }) {
  if (!features) return null;
  const tidy = (v) => String(v).replace(/_/g, " ");
  const items = [];
  if (features.skin_tone) items.push(["skin", tidy(features.skin_tone)]);
  if (features.hair_length) items.push(["hair", tidy(features.hair_length)]);
  if (features.hair_color) items.push(["color", tidy(features.hair_color)]);
  if (features.hair_texture) items.push(["texture", tidy(features.hair_texture)]);
  if (features.eye_color) items.push(["eyes", tidy(features.eye_color)]);
  if (features.glasses != null) items.push(["glasses", features.glasses ? "yes" : "no"]);
  if (features.approx_age != null) items.push(["~age", String(features.approx_age)]);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-0.5 text-[11px] text-zinc-300"
        >
          <span className="text-zinc-500">{k}</span>
          <span className="font-medium">{v}</span>
        </span>
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-[var(--color-accent)]" />
  );
}

// An image that opens full-screen on click (Esc or click anywhere to close).
function ZoomableImg({ src, alt = "", className = "" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!src) return null;
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        className={`cursor-zoom-in ${className}`}
      />
      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-6"
          onClick={() => setOpen(false)}
        >
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full cursor-zoom-out rounded-lg object-contain shadow-2xl"
          />
          <button
            onClick={() => setOpen(false)}
            className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-xl text-zinc-200 hover:bg-black/80"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

// Batch test-child queue: per-item status metadata.
const BATCH_BUSY = "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]";
const BATCH_STATUS_META = {
  queued: { label: "Queued", cls: "border-zinc-600 bg-zinc-700/30 text-zinc-400" },
  uploading: { label: "Uploading", cls: BATCH_BUSY, spin: true },
  checking: { label: "Checking photo", cls: BATCH_BUSY, spin: true },
  restoring: { label: "Restoring", cls: BATCH_BUSY, spin: true },
  anchoring: { label: "Anchoring", cls: BATCH_BUSY, spin: true },
  generating: { label: "Generating pages", cls: BATCH_BUSY, spin: true },
  approved: { label: "Approved", cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" },
  needs_review: { label: "Needs review", cls: "border-amber-400/40 bg-amber-400/10 text-amber-200" },
  needs_new_photo: { label: "Needs new photo", cls: "border-rose-500/40 bg-rose-500/10 text-rose-200" },
  failed: { label: "Failed", cls: "border-rose-500/40 bg-rose-500/10 text-rose-200" },
  cancelled: { label: "Cancelled", cls: "border-zinc-600 bg-zinc-700/30 text-zinc-500" },
};
const BATCH_TERMINAL = ["approved", "needs_review", "needs_new_photo", "failed", "cancelled"];

function BatchQueue({ items, running, onCancel, onClear }) {
  const done = items.filter((it) => BATCH_TERMINAL.includes(it.status)).length;
  const summary = {
    accepted: items.filter((it) => it.photoStatus === "accepted").length,
    autoApproved: items.filter((it) => it.status === "approved").length,
    needsReview: items.filter((it) => it.status === "needs_review").length,
    rejected: items.filter((it) => it.status === "needs_new_photo").length,
    failed: items.filter((it) => it.status === "failed").length,
  };
  return (
    <div className="mb-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-200">
          Batch · {done} / {items.length} test children processed
        </span>
        <div className="flex items-center gap-2">
          {running ? (
            <button
              onClick={onCancel}
              className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-xs font-medium text-rose-200 hover:bg-rose-500/20"
            >
              Cancel batch
            </button>
          ) : (
            <button
              onClick={onClear}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1 text-xs font-medium hover:bg-[#242838]"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {!running && (
        <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
          <SummaryChip label="accepted" n={summary.accepted} cls="border-emerald-400/40 bg-emerald-400/10 text-emerald-200" />
          <SummaryChip label="auto-approved" n={summary.autoApproved} cls="border-emerald-400/40 bg-emerald-400/10 text-emerald-200" />
          <SummaryChip label="needs review" n={summary.needsReview} cls="border-amber-400/40 bg-amber-400/10 text-amber-200" />
          <SummaryChip label="needs new photo" n={summary.rejected} cls="border-rose-500/40 bg-rose-500/10 text-rose-200" />
          {summary.failed > 0 && (
            <SummaryChip label="failed" n={summary.failed} cls="border-rose-500/40 bg-rose-500/10 text-rose-200" />
          )}
        </div>
      )}

      <ul className="space-y-2">
        {items.map((it) => {
          const meta = BATCH_STATUS_META[it.status] || BATCH_STATUS_META.queued;
          return (
            <li
              key={it.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/40 p-2"
            >
              <img src={it.thumbUrl} alt="" className="h-10 w-10 flex-shrink-0 rounded object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-zinc-300">{it.name}</div>
                <div className="truncate text-[11px] text-zinc-500">
                  {it.progress}
                  {it.error ? ` — ${it.error}` : ""}
                </div>
              </div>
              <span
                className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}
              >
                {meta.spin && (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent opacity-70" />
                )}
                {meta.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SummaryChip({ label, n, cls }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${cls}`}>
      <span className="font-semibold">{n}</span> {label}
    </span>
  );
}

// Label for how the restore step resolved, shown under the "Restored" stage.
function restoreOutcomeLabel(outcome) {
  if (outcome === "used") return "Restored used";
  if (outcome === "skipped") return "Original used";
  if (outcome === "discarded") return "Restore discarded";
  return null;
}

function Stage({ label, url, highlight, loading, loadingLabel, caption }) {
  const showImage = url && !loading;
  return (
    <div>
      <span
        className={`mb-2 block text-xs uppercase tracking-wide ${
          highlight ? "text-[var(--color-accent)]" : "text-zinc-500"
        }`}
      >
        {label}
      </span>
      {showImage ? (
        <ZoomableImg
          src={url}
          className={`aspect-square w-full rounded-lg object-cover border ${
            highlight ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
          }`}
        />
      ) : loading ? (
        <div className="flex aspect-square flex-col items-center justify-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]">
          <Spinner />
          <span className="text-xs text-zinc-400">{loadingLabel}</span>
        </div>
      ) : (
        <div className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-xs text-zinc-600">
          waiting…
        </div>
      )}
      {caption && !loading && (
        <span className="mt-1 block text-[11px] text-zinc-500">{caption}</span>
      )}
    </div>
  );
}

function LabeledBox({ label, children }) {
  return (
    <div>
      <span className="mb-2 block text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </div>
  );
}
