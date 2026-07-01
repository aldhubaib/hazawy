import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SignedIn, SignedOut, SignIn, UserButton, useAuth } from "@clerk/clerk-react";
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from "libphonenumber-js";
import { api, setAuthTokenGetter, clientId, eventsUrl } from "./api.js";
import { SYMBOL_LIBRARY, SYMBOL_CATEGORIES, sanitizeSvg, tintSvg } from "./symbols.js";
import { MODULES, MODULE_IDS } from "./shared/access.js";
import {
  PAGE_AREA_RATIO_CSS,
  PRINT_SIZE_RECT,
  PRINT_LEFT_RECT,
  PRINT_RIGHT_RECT,
  DESIGN_LEFT_RECT,
  DESIGN_RIGHT_RECT,
  PRINT_HALF_RATIO_CSS,
  DESIGN_IN_HALF_LEFT,
  DESIGN_IN_HALF_RIGHT,
} from "./shared/print.js";
import {
  ISO_CATALOG,
  ISO_CODES,
  enabledCountries,
  formatMoney,
  currencyDecimals,
  computeOrderPricing,
  effectivePrice,
} from "./shared/countries.js";

// Human-readable label for a module id (falls back to the id itself).
const moduleLabel = (id) => MODULES[id]?.label || id;

// Parse the current URL hash into a section + optional id, e.g. "#/orders/123".
function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [section = "", id = ""] = raw.split("/");
  return { section, id };
}

// Build the URL hash that represents the current navigation state.
function buildHash(nav, story, order, pricingId) {
  if (nav === "stories") return story ? `#/stories/${story.id}` : "#/stories";
  if (nav === "orders") return order ? `#/orders/${order.id}` : "#/orders";
  if (nav === "pricing") return pricingId ? `#/pricing/${pricingId}` : "#/pricing";
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
  // The server already resolved exactly which modules this user can open
  // (via the shared can()/visibleModules); the client just trusts that list.
  const allowedModules = me.modules || [];
  const canAccess = (moduleId) => allowedModules.includes(moduleId);

  const [config, setConfig] = useState(null);
  const [error, setError] = useState("");
  // Auto-save status shown in the story header: "idle" | "saving" | "saved" | "error".
  const [saveState, setSaveState] = useState("idle");
  // Set briefly when a live update from the other editor is pulled in.
  const [livePing, setLivePing] = useState(0);
  const [nav, setNav] = useState(() => {
    const saved = localStorage.getItem("hazawy.nav");
    return saved && allowedModules.includes(saved) ? saved : allowedModules[0] || "orders";
  }); // "stories" | "orders" | "settings"

  // Which tab the Settings page opens on. Lifted here so legacy #/variables and
  // #/access links can deep-link straight to their tab inside Settings.
  const [settingsTab, setSettingsTab] = useState("general");

  // Collapsible sidebar (Cursor-style). Persisted so it stays where the user left it.
  const [navOpen, setNavOpen] = useState(() => {
    return localStorage.getItem("hazawy.navOpen") !== "0";
  });
  useEffect(() => {
    localStorage.setItem("hazawy.navOpen", navOpen ? "1" : "0");
  }, [navOpen]);

  const [stories, setStories] = useState([]);
  const [orders, setOrders] = useState([]);

  const [story, setStory] = useState(null); // selected story detail (null = table)
  const [order, setOrder] = useState(null); // selected order detail (null = table)
  const [pricingId, setPricingId] = useState(null); // selected story id in Pricing (null = table)

  // Create modals
  const [creatingStory, setCreatingStory] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [newOrderStoryId, setNewOrderStoryId] = useState("");
  const [newOrderLanguage, setNewOrderLanguage] = useState("en"); // "en" | "ar" | "both"
  const [newOrderVars, setNewOrderVars] = useState({}); // variable name -> value
  const [newOrderCountry, setNewOrderCountry] = useState(""); // market the order belongs to
  const [newOrderCustomerId, setNewOrderCustomerId] = useState(""); // who the order is for

  // Order generation controls
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [mode, setMode] = useState("compose");

  // Per-character intake stage: characterId -> null|"uploading"|"restoring"|"anchoring".
  const [kidStages, setKidStages] = useState({});
  const kidBusy = Object.values(kidStages).some(Boolean);
  const setStageFor = (cid, s) =>
    setKidStages((m) => {
      const next = { ...m };
      if (s == null) delete next[cid];
      else next[cid] = s;
      return next;
    });
  const [cellBusy, setCellBusy] = useState({}); // cellId -> bool (image upload)
  const [editorCellId, setEditorCellId] = useState(null); // open full-screen editor
  const [editorSide, setEditorSide] = useState("right"); // which side (left/right) is being designed
  const [analyzing, setAnalyzing] = useState(false); // analyzing scene scoring
  const [busy, setBusy] = useState({}); // sceneId -> bool
  const [generatingAll, setGeneratingAll] = useState(false);

  // Customers (people directory; phone is unique + country-validated)
  const [customers, setCustomers] = useState([]);
  const [editingCustomer, setEditingCustomer] = useState(null); // null = closed, {} = new, {…} = edit

  // Pricing module: each story with its per-country price map. Owned here so the
  // Pricing screen and its country-scoped editor read from one source.
  const [pricing, setPricing] = useState([]);

  // Countries (markets). The dynamic registry drives every selector/label.
  const [countries, setCountries] = useState([]);
  // Current country context for the header selector: "all" | <code>. Persisted.
  // Today this is the source of "current country"; a hostname mapping can replace
  // it later without touching anything else.
  const [country, setCountry] = useState(() => localStorage.getItem("hazawy.country") || "all");
  useEffect(() => {
    localStorage.setItem("hazawy.country", country);
  }, [country]);
  // Orders are country-scoped: refetch whenever the header selector changes.
  useEffect(() => {
    api.listOrders(country).then(setOrders).catch(() => {});
  }, [country]);

  // Variables (admin-managed text placeholders)
  const [variables, setVariables] = useState([]);
  const [creatingVariable, setCreatingVariable] = useState(false);
  const [newVarName, setNewVarName] = useState("");
  const [newVarLabel, setNewVarLabel] = useState("");
  const [newVarDefault, setNewVarDefault] = useState("");

  // User-uploaded SVG symbols, persisted so they can be reused across pages.
  const [customSymbols, setCustomSymbols] = useState([]);

  useEffect(() => {
    api.config().then((c) => {
      setConfig(c);
      setPrompt(c.defaultPrompt);
    });
    refreshStories();
    refreshOrders();
    refreshCustomers();
    refreshCountries();
    refreshPricing();
    refreshVariables();
    refreshSymbols();

    // Restore the open page: prefer the URL hash, then fall back to localStorage.
    const { section, id } = parseHash();
    if (section === "variables" || section === "access") {
      // Legacy links: these now live as tabs inside Settings.
      if (canAccess("settings")) {
        setNav("settings");
        setSettingsTab(section);
      }
    } else if (
      section === "stories" ||
      section === "pricing" ||
      section === "orders" ||
      section === "customers" ||
      section === "settings"
    ) {
      if (canAccess(section)) setNav(section);
      if (section === "stories" && id) api.getStory(id).then(setStory).catch(() => {});
      else if (section === "orders" && id) api.getOrder(id).then(setOrder).catch(() => {});
      else if (section === "pricing" && id) setPricingId(id);
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
    const h = buildHash(nav, story, order, pricingId);
    if (window.location.hash !== h) window.location.hash = h;
  }, [nav, story, order, pricingId]);

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
      } else if (section === "customers") {
        setNav("customers");
        setStory(null);
        setOrder(null);
      } else if (section === "pricing") {
        setNav("pricing");
        setStory(null);
        setOrder(null);
        setPricingId(id || null);
      } else if (section === "variables" || section === "access") {
        // Legacy links: these now live as tabs inside Settings.
        setNav("settings");
        setSettingsTab(section);
        setStory(null);
        setOrder(null);
      } else if (section === "settings") {
        setNav("settings");
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

  // The pricing list only contains published stories; refresh on entry so a
  // story published elsewhere shows up (and an unpublished one drops off).
  useEffect(() => {
    if (nav === "pricing") refreshPricing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav]);

  // Never sit on a page the user can't access (e.g. after a hash change).
  useEffect(() => {
    if (!canAccess(nav)) setNav(allowedModules[0] || "orders");
  }, [nav]);
  useEffect(() => {
    if (story) localStorage.setItem("hazawy.storyId", story.id);
    else localStorage.removeItem("hazawy.storyId");
  }, [story]);
  useEffect(() => {
    if (order) localStorage.setItem("hazawy.orderId", order.id);
    else localStorage.removeItem("hazawy.orderId");
  }, [order]);

  // Live collaboration: subscribe to the server's change stream so two people
  // editing the same story/order see each other's saves within ~a second.
  // Refs keep the EventSource handler reading the latest open item without
  // re-opening the connection on every keystroke.
  const storyRef = useRef(null);
  const orderRef = useRef(null);
  useEffect(() => {
    storyRef.current = story;
  }, [story]);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);

  useEffect(() => {
    let pingTimer = null;
    const flashLive = () => {
      setLivePing((n) => n + 1);
      clearTimeout(pingTimer);
      pingTimer = setTimeout(() => setLivePing(0), 1500);
    };

    const es = new EventSource(eventsUrl());
    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      // Ignore our own writes — we already have that state locally.
      if (!msg || msg.clientId === clientId) return;

      if (msg.type === "story-changed") {
        refreshStories();
        const open = storyRef.current;
        if (open && (msg.id === open.id || msg.id == null)) {
          if (msg.id === open.id) {
            api
              .getStory(open.id)
              .then((fresh) => {
                setStory(fresh);
                flashLive();
              })
              .catch(() => {});
          }
        }
      } else if (msg.type === "order-changed") {
        refreshOrders();
        const open = orderRef.current;
        if (open && msg.id === open.id) {
          api
            .getOrder(open.id)
            .then((fresh) => {
              setOrder(fresh);
              flashLive();
            })
            .catch(() => {});
        }
      }
    };
    // EventSource auto-reconnects on error; nothing to do but keep it open.
    return () => {
      clearTimeout(pingTimer);
      es.close();
    };
  }, []);

  // Wrap a save-causing promise so the header can show "Saving…/Saved".
  const saveTimer = useRef(null);
  function trackSave(promise) {
    setSaveState("saving");
    return Promise.resolve(promise)
      .then((result) => {
        setSaveState("saved");
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => setSaveState("idle"), 1800);
        return result;
      })
      .catch((err) => {
        setSaveState("error");
        throw err;
      });
  }

  function refreshStories() {
    api.listStories().then(setStories).catch((e) => setError(e.message));
  }
  function refreshOrders() {
    api.listOrders(country).then(setOrders).catch((e) => setError(e.message));
  }
  function refreshCountries() {
    api.listCountries(Boolean(me.isAdmin)).then(setCountries).catch((e) => setError(e.message));
  }
  function refreshVariables() {
    api.listVariables().then(setVariables).catch((e) => setError(e.message));
  }
  function refreshCustomers() {
    api.listCustomers().then(setCustomers).catch((e) => setError(e.message));
  }
  function refreshPricing() {
    api.listPricing().then(setPricing).catch((e) => setError(e.message));
  }
  // Set/clear one story's price in one country (the Pricing module). Members can
  // only price the countries they're assigned to — the server enforces it too.
  async function savePricing(storyId, { country: cc, price, discountPrice }) {
    await api.updatePricing(storyId, { country: cc, price, discountPrice });
    refreshPricing();
  }
  // Create or update a customer from the modal. `country` is the ISO code used to
  // validate numbers typed without a leading "+". Throws on validation failure so
  // the modal can keep itself open and surface the message.
  async function saveCustomer({ id, name, phone, country }) {
    if (id) await api.updateCustomer(id, { name, phone, country });
    else await api.createCustomer(name, phone, country);
    setEditingCustomer(null);
    refreshCustomers();
  }
  async function deleteCustomer(id) {
    if (!confirm("Delete this customer?")) return;
    try {
      await api.deleteCustomer(id);
      refreshCustomers();
    } catch (e) {
      setError(e.message);
    }
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
    setPricingId(null);
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
      setStory(await trackSave(api.updateStoryTitle(story.id, titles)));
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveStoryGender(gender) {
    if (!story) return;
    setError("");
    try {
      setStory(await trackSave(api.updateStoryGender(story.id, gender)));
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveStoryCharacters(characters) {
    if (!story) return;
    setError("");
    try {
      setStory(await trackSave(api.updateStoryCharacters(story.id, characters)));
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
      setStory(await trackSave(api.updateCell(story.id, cellId, { type: "text", text, style })));
      refreshStories();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveCellElements(
    cellId,
    { elements, bgUrl, bgFalUrl, bgColor, bgBlur, safeZones, kidSlots, aiPrompt },
    side = "right"
  ) {
    if (!story) return;
    setError("");
    try {
      // Write the editor's working design into the chosen side; leave the other
      // side untouched. getSides() also migrates any legacy single-design cell.
      const cell = story.scenes.find((s) => s.id === cellId);
      const sides = getSides(cell);
      sides[side === "left" ? "left" : "right"] = {
        elements: elements ?? [],
        bgUrl: bgUrl ?? null,
        bgFalUrl: bgFalUrl ?? null,
        // null = no background color (transparent); preserve it as-is.
        bgColor: bgColor ?? null,
        bgBlur: bgBlur ?? 0,
        kidSlots: kidSlots ?? [],
        safeZones: safeZones ?? [],
        aiPrompt: aiPrompt ?? "",
      };
      setStory(await trackSave(api.updateCell(story.id, cellId, { sides })));
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
    if (!newOrderStoryId) return setError("Pick a story for this order.");
    if (!newOrderCustomerId) return setError("Pick a customer for this order.");
    if (!newOrderCountry) return setError("Pick a country for this order.");
    // Fill in defaults for any variable the user left blank.
    const vars = {};
    for (const v of variables) {
      const val = newOrderVars[v.name];
      vars[v.name] = val != null && val !== "" ? val : v.defaultValue || "";
    }
    // Auto-name the order: use the first filled variable (typically the child's
    // name), falling back to the story title.
    const story = stories.find((s) => s.id === newOrderStoryId);
    const childName = Object.values(vars).find((x) => String(x).trim());
    const title = String(childName || story?.title || "Order").trim();
    try {
      const o = await api.createOrder(title, newOrderStoryId, {
        variables: vars,
        language: newOrderLanguage,
        country: newOrderCountry,
        customerId: newOrderCustomerId,
      });
      setNewOrderStoryId("");
      setNewOrderLanguage("en");
      setNewOrderVars({});
      setNewOrderCustomerId("");
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

  // Read the kid object for a character (primary falls back to legacy order.kid).
  function kidFor(o, characterId) {
    if (!o) return null;
    const primId = o.characters?.[0]?.id;
    return o.kids?.[characterId] || (characterId === primId ? o.kid : null) || null;
  }

  async function onUploadKid(e, characterId) {
    const file = e.target.files?.[0];
    if (!file || !order) return;
    const cid = characterId || order.characters?.[0]?.id;
    setError("");
    try {
      setStageFor(cid, "uploading");
      let o = await api.uploadOrderKid(order.id, file, characterId);
      setOrder(o);
      refreshOrders();
      // Photo intake gate: an identity-unsafe photo stops here — no restore/anchor.
      let k = kidFor(o, cid);
      if (k?.photoStatus === "needs_new_photo") {
        setError(k.photoFailureReason || "Photo is not suitable. Please upload a clearer front-facing photo.");
        return;
      }
      // accepted / fixable / review → enhance. Fixable photos are re-validated
      // server-side during restore, so re-check the status afterwards.
      setStageFor(cid, "restoring");
      o = await api.restoreOrderKid(order.id, characterId);
      setOrder(o);
      refreshOrders();
      k = kidFor(o, cid);
      if (k?.photoStatus === "needs_new_photo") {
        setError(k.photoFailureReason || "Photo could not be improved enough. Please upload a clearer photo.");
        return;
      }
      setStageFor(cid, "anchoring");
      o = await api.anchorOrderKid(order.id, characterId);
      setOrder(o);
      refreshOrders();
    } catch (err) {
      setError(err.message);
    } finally {
      setStageFor(cid, null);
    }
  }

  async function regenerateAnchor(characterId) {
    if (!order) return;
    const cid = characterId || order.characters?.[0]?.id;
    if (!kidFor(order, cid)) return;
    setError("");
    try {
      setStageFor(cid, "anchoring");
      setOrder(await api.anchorOrderKid(order.id, characterId));
    } catch (err) {
      setError(err.message);
    } finally {
      setStageFor(cid, null);
    }
  }

  async function saveKidName(characterId, payload) {
    if (!order) return;
    setError("");
    try {
      setOrder(await api.setOrderKidName(order.id, characterId, payload));
      refreshOrders();
    } catch (err) {
      setError(err.message);
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
    // Pages sharing one base image (e.g. an English page and its Arabic twin) are
    // generated once; the server fills the twin's result, so we skip it here.
    const done = new Set();
    for (const scene of order.scenes.filter(sceneHasAiBase)) {
      if (done.has(scene.id)) continue;
      setBusy((b) => ({ ...b, [scene.id]: true }));
      try {
        const res = await api.generateOrder(order.id, scene.id, prompt, { mode });
        (res?.filledIds?.length ? res.filledIds : [scene.id]).forEach((id) => done.add(id));
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

  // Enabled countries this user may act in (admins -> all). Drives the header
  // selector and the order-create picker.
  const allowedCountryCodes =
    me.countries && me.countries.length ? me.countries : enabledCountries(countries).map((c) => c.code);
  const myCountries = enabledCountries(countries).filter((c) => allowedCountryCodes.includes(c.code));

  return (
    <div className="flex h-full flex-col overflow-x-hidden">
      <AppHeader
        navOpen={navOpen}
        onToggle={() => setNavOpen((v) => !v)}
        country={country}
        onCountryChange={setCountry}
        countryOptions={myCountries}
      />

      <div className="flex min-h-0 flex-1">
        <NavSidebar
          nav={nav}
          onNav={switchNav}
          config={config}
          me={me}
          open={navOpen}
        />

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
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

          {nav === "pricing" && !pricingId && (
            <PricingTable
              rows={pricing}
              myCountries={myCountries}
              country={country}
              isAdmin={Boolean(me.isAdmin)}
              onOpen={(id) => {
                setError("");
                setPricingId(id);
              }}
            />
          )}

          {nav === "pricing" && pricingId && (
            <PricingDetail
              row={pricing.find((r) => r.id === pricingId) || null}
              countries={countries}
              myCountries={myCountries}
              isAdmin={Boolean(me.isAdmin)}
              onBack={() => setPricingId(null)}
              onSave={savePricing}
              onError={setError}
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
              onSaveCharacters={saveStoryCharacters}
              onUploadCellImage={uploadCellImage}
              onUploadCellBackground={uploadCellBackground}
              onRemoveCellBackground={removeCellBackground}
              onSaveCellText={saveCellText}
              onOpenEditor={(id) => {
                setEditorCellId(id);
                setEditorSide("right");
              }}
              onDeleteCell={deleteScene}
              onReorderCells={reorderScenes}
              onAnalyze={analyzeStory}
              analyzing={analyzing}
              onSetCellScoring={setCellScoring}
              cellBusy={cellBusy}
              config={config}
              onStoryChange={setStory}
              saveState={saveState}
              livePing={livePing}
            />
          )}

          {nav === "stories" && story && editorCellId && (() => {
            const c = story.scenes.find((s) => s.id === editorCellId);
            if (!c) return null;
            const idx = story.scenes.findIndex((s) => s.id === editorCellId);
            const isCover = idx === 0;
            // The page is one sheet; we edit one side at a time. The cover sheet
            // is the wrap: back cover (left) + front cover (right).
            const sideLabel = isCover
              ? editorSide === "left"
                ? "Back cover"
                : "Front cover"
              : editorSide === "left"
              ? `Page ${idx * 2}`
              : `Page ${idx * 2 + 1}`;
            // Feed the editor just the active side's design (as a cell-shaped
            // object) and remount it whenever the side changes. Legacy
            // single-design fields are cleared so an empty side stays empty.
            const sides = getSides(c);
            const sideCell = {
              id: c.id,
              lang: c.lang,
              type: "text",
              localUrl: null,
              text: "",
              style: null,
              ...sides[editorSide],
            };
            return (
              <CellEditor
                key={`${c.id}:${editorSide}`}
                cell={sideCell}
                label={sideLabel}
                side={editorSide}
                onSwitchSide={(targetSide, design) => {
                  if (targetSide === editorSide) return;
                  saveCellElements(c.id, design, editorSide);
                  setEditorSide(targetSide);
                }}
                aspect={story.aspect || "3:4"}
                variables={variables}
                characters={story.characters || []}
                customSymbols={customSymbols}
                onSaveSymbol={saveSymbol}
                onDeleteSymbol={deleteCustomSymbol}
                onUploadMedia={(file) => api.uploadMedia(file)}
                onSave={(cellId, design) => saveCellElements(cellId, design, editorSide)}
                onClose={() => setEditorCellId(null)}
              />
            );
          })()}

          {nav === "settings" && canAccess("settings") && (
            <SettingsPage
              me={me}
              tab={settingsTab}
              onTabChange={setSettingsTab}
              variables={variables}
              onDeleteVariable={deleteVariable}
              onCreateVariable={() => {
                setError("");
                setCreatingVariable(true);
              }}
              onError={setError}
              onSaved={() => api.config().then(setConfig).catch(() => {})}
            />
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
                // Default the order's country to the header selection (when a
                // specific one is active), else the first country the user can act in.
                setNewOrderCountry(country !== "all" ? country : myCountries[0]?.code || "");
                setCreatingOrder(true);
              }}
            />
          )}

          {nav === "orders" && order && (
            <OrderDetail
              order={order}
              countries={countries}
              kid={kid}
              results={results}
              onBack={() => {
                setOrder(null);
                refreshOrders();
              }}
              onDelete={() => deleteOrder(order.id)}
              onUploadKid={onUploadKid}
              kidStages={kidStages}
              kidBusy={kidBusy}
              regenerateAnchor={regenerateAnchor}
              onSaveName={saveKidName}
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

          {nav === "customers" && (
            <CustomersTable
              customers={customers}
              onCreate={() => {
                setError("");
                setEditingCustomer({});
              }}
              onEdit={(c) => {
                setError("");
                setEditingCustomer(c);
              }}
              onDelete={deleteCustomer}
            />
          )}
        </div>
      </main>
      </div>

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

      {creatingOrder && (() => {
        const selStory = stories.find((s) => s.id === newOrderStoryId);
        const enCount = (selStory?.scenes || []).filter((s) => (s.lang || "en") === "en").length;
        const arCount = (selStory?.scenes || []).filter((s) => (s.lang || "en") === "ar").length;
        const langOpts = [
          { id: "en", label: "English", count: enCount },
          { id: "ar", label: "العربية", count: arCount },
          { id: "both", label: "Both", count: enCount + arCount },
        ];
        const emptyLang =
          selStory &&
          ((newOrderLanguage === "en" && enCount === 0) ||
            (newOrderLanguage === "ar" && arCount === 0) ||
            (newOrderLanguage === "both" && enCount + arCount === 0));
        return (
        <Modal title="Create order" onClose={() => setCreatingOrder(false)}>
          <label className="block text-xs uppercase tracking-wide text-zinc-500">Story</label>
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

          <label className="mt-3 block text-xs uppercase tracking-wide text-zinc-500">Customer</label>
          <select
            value={newOrderCustomerId}
            onChange={(e) => setNewOrderCustomerId(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
          >
            <option value="">Choose a customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.phone}
              </option>
            ))}
          </select>
          {customers.length === 0 && (
            <p className="mt-1 text-xs text-amber-300">
              No customers yet. Add one in the Customers tab before taking orders.
            </p>
          )}

          <label className="mt-3 block text-xs uppercase tracking-wide text-zinc-500">Country</label>
          <select
            value={newOrderCountry}
            onChange={(e) => setNewOrderCountry(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
          >
            <option value="">Choose a country…</option>
            {myCountries.map((c) => {
              const eff = selStory && effectivePrice(selStory.prices?.[c.code]);
              return (
                <option key={c.code} value={c.code} disabled={!eff}>
                  {c.flag} {c.name}
                  {eff ? ` — ${formatMoney(eff.effective, c.currency)}` : " (waiting for price)"}
                </option>
              );
            })}
          </select>
          {(() => {
            const rec = myCountries.find((c) => c.code === newOrderCountry);
            const eff = rec && effectivePrice(selStory?.prices?.[rec.code]);
            if (!rec || !eff) return null;
            const p = computeOrderPricing(eff.effective, rec);
            return (
              <p className="mt-1 text-xs text-zinc-400">
                {p.taxEnabled
                  ? `${formatMoney(p.base, p.currency)} + ${p.taxLabel} ${p.taxRate}% = `
                  : "Total: "}
                <span className="font-medium text-zinc-200">{formatMoney(p.total, p.currency)}</span>
                {eff.discountPrice != null && (
                  <span className="ml-1 text-zinc-500 line-through">
                    {formatMoney(eff.price, rec.currency)}
                  </span>
                )}
              </p>
            );
          })()}

          <label className="mt-3 block text-xs uppercase tracking-wide text-zinc-500">Language</label>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {langOpts.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setNewOrderLanguage(opt.id)}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition ${
                  newOrderLanguage === opt.id
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                    : "border-[var(--color-border)] bg-[var(--color-panel-2)] text-zinc-300 hover:bg-[#242838]"
                }`}
              >
                {opt.label}
                {selStory && <span className="ml-1 text-xs opacity-70">({opt.count})</span>}
              </button>
            ))}
          </div>
          {emptyLang && (
            <p className="mt-1 text-xs text-amber-300">
              This story has no{" "}
              {newOrderLanguage === "ar" ? "Arabic" : newOrderLanguage === "en" ? "English" : ""} pages
              yet — there will be nothing to generate.
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
              disabled={!newOrderStoryId || !newOrderCustomerId || !newOrderCountry}
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              Create
            </button>
          </div>
        </Modal>
        );
      })()}

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

      {editingCustomer && (
        <CustomerModal
          customer={editingCustomer}
          onClose={() => setEditingCustomer(null)}
          onSave={saveCustomer}
        />
      )}
    </div>
  );
}

/* ============================ VARIABLES TABLE ============================ */
function VariablesTable({ variables, onDelete, onCreate }) {
  const columns = [
    {
      key: "token",
      header: "Token",
      hideable: false,
      sortValue: (v) => v.name,
      render: (v) => <span className="font-mono text-[var(--color-accent)]">{`{{${v.name}}}`}</span>,
    },
    {
      key: "label",
      header: "Label",
      sortValue: (v) => v.label,
      render: (v) => <span className="text-zinc-300">{v.label}</span>,
    },
    {
      key: "default",
      header: "Default",
      sortValue: (v) => v.defaultValue || "",
      render: (v) => <span className="text-zinc-400">{v.defaultValue || "—"}</span>,
    },
    {
      key: "created",
      header: "Created",
      sortValue: (v) => v.createdAt || 0,
      render: (v) => <span className="text-zinc-400">{fmtDate(v.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      hideable: false,
      align: "right",
      render: (v) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(v.id);
          }}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
        >
          Delete
        </button>
      ),
    },
  ];
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
        <DataTable storageKey="variables" columns={columns} data={variables} rowKey={(v) => v.id} />
      )}
    </>
  );
}

/* ============================ CUSTOMERS ============================ */

// Localized English country names so the picker reads "Saudi Arabia" not "SA".
const REGION_NAMES =
  typeof Intl !== "undefined" && Intl.DisplayNames
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

// Turn an ISO country code into its flag emoji (regional indicator symbols).
function isoToFlag(iso) {
  if (!iso || iso.length !== 2) return "🏳️";
  return iso
    .toUpperCase()
    .replace(/./g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt(0)));
}

function countryName(iso) {
  return (iso && REGION_NAMES?.of(iso)) || iso || "—";
}

// All dialable countries: ISO, English name, calling code, flag — sorted by name.
const COUNTRY_OPTIONS = getCountries()
  .map((iso) => ({ iso, name: countryName(iso), code: getCountryCallingCode(iso), flag: isoToFlag(iso) }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Default to Saudi Arabia (Hazawy's home market).
const DEFAULT_COUNTRY = "SA";

// Pretty-print a stored E.164 number as international format, e.g. +966 50 123 4567.
function fmtPhone(e164) {
  const p = parsePhoneNumberFromString(e164 || "");
  return p ? p.formatInternational() : e164 || "—";
}

// A compact, searchable country picker. Replaces a native <select> (whose
// OS-drawn list filled the whole screen with no way to search). Shows the
// selected flag + calling code; opening it reveals a search box and a
// height-capped, scrollable list filtered by country name or calling code.
function CountrySelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef(null);
  const searchRef = useRef(null);

  const selected = COUNTRY_OPTIONS.find((c) => c.iso === value);

  const q = query.trim().toLowerCase();
  const matches = q
    ? COUNTRY_OPTIONS.filter(
        (c) => c.name.toLowerCase().includes(q) || `+${c.code}`.includes(q) || c.code.includes(q)
      )
    : COUNTRY_OPTIONS;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Focus the search box when the menu opens; reset the query when it closes.
  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery("");
  }, [open]);

  function pick(iso) {
    onChange(iso);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative sm:w-52">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-2 text-left text-sm focus:border-[var(--color-accent)] focus:outline-none"
      >
        <span className="text-base leading-none">{selected?.flag || "🏳️"}</span>
        <span className="min-w-0 flex-1 truncate text-zinc-200">{selected?.name || "Select"}</span>
        <span className="font-mono text-xs text-zinc-500">+{selected?.code}</span>
        <span className="text-zinc-500">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-full min-w-[16rem] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] shadow-xl">
          <div className="border-b border-[var(--color-border)] p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && matches[0]) {
                  e.preventDefault();
                  pick(matches[0].iso);
                }
              }}
              placeholder="Search country or code…"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <ul className="max-h-60 overflow-y-auto py-1">
            {matches.length === 0 ? (
              <li className="px-3 py-2 text-sm text-zinc-500">No matches</li>
            ) : (
              matches.map((c) => (
                <li key={c.iso}>
                  <button
                    type="button"
                    onClick={() => pick(c.iso)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-[var(--color-panel-2)] ${
                      c.iso === value ? "text-[var(--color-accent)]" : "text-zinc-200"
                    }`}
                  >
                    <span className="w-5 shrink-0 text-center">{c.iso === value ? "✓" : ""}</span>
                    <span className="text-base leading-none">{c.flag}</span>
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="font-mono text-xs text-zinc-500">+{c.code}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// Phone entry: a country picker (sets the calling code) + the local number. The
// number is validated against the chosen country's real length/format, so a too
// short / too long number is rejected before it can be saved.
function PhoneField({ country, national, onCountryChange, onNationalChange, valid, autoFocus }) {
  const opt = COUNTRY_OPTIONS.find((c) => c.iso === country);
  const showError = national.trim().length > 0 && !valid;
  return (
    <div>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <CountrySelect value={country} onChange={onCountryChange} />
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-zinc-500">
            +{opt?.code}
          </span>
          <input
            autoFocus={autoFocus}
            inputMode="tel"
            value={national}
            onChange={(e) => onNationalChange(e.target.value)}
            placeholder="50 123 4567"
            className={`w-full rounded-md border bg-[var(--color-panel-2)] py-2 pl-14 pr-9 font-mono text-sm focus:outline-none ${
              showError
                ? "border-rose-500/60 focus:border-rose-500"
                : "border-[var(--color-border)] focus:border-[var(--color-accent)]"
            }`}
          />
          {national.trim().length > 0 && (
            <span
              className={`absolute right-3 top-1/2 -translate-y-1/2 text-sm ${
                valid ? "text-[var(--color-accent-2)]" : "text-rose-400"
              }`}
            >
              {valid ? "✓" : "✕"}
            </span>
          )}
        </div>
      </div>
      <p className={`mt-1 text-[11px] ${showError ? "text-rose-400" : "text-zinc-600"}`}>
        {showError
          ? `That's not a valid ${countryName(country)} number — check the length.`
          : `Number length is validated for ${countryName(country)}.`}
      </p>
    </div>
  );
}

// Create / edit a customer. Owns its own draft so validation feedback is instant
// and the parent only hears about a successful, validated save.
function CustomerModal({ customer, onClose, onSave }) {
  const isEdit = Boolean(customer?.id);
  const initial = useMemo(() => {
    if (customer?.phone) {
      const p = parsePhoneNumberFromString(customer.phone);
      if (p) return { country: p.country || customer.country || DEFAULT_COUNTRY, national: p.nationalNumber };
    }
    return { country: customer?.country || DEFAULT_COUNTRY, national: "" };
  }, [customer]);

  const [name, setName] = useState(customer?.name || "");
  const [country, setCountry] = useState(initial.country);
  const [national, setNational] = useState(initial.national);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const parsed = national.trim() ? parsePhoneNumberFromString(national, country) : null;
  const phoneValid = Boolean(parsed && parsed.isValid());
  const canSave = name.trim().length > 0 && phoneValid && !saving;

  async function submit() {
    if (!name.trim()) return setError("Enter the customer's name.");
    if (!phoneValid) return setError("Enter a valid phone number for the selected country.");
    setSaving(true);
    setError("");
    try {
      await onSave({ id: customer?.id, name: name.trim(), phone: parsed.number, country });
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit customer" : "Add customer"} onClose={onClose}>
      <label className="block text-xs uppercase tracking-wide text-zinc-500">Name</label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Sara Al-Otaibi"
        className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
      />

      <label className="mt-4 block text-xs uppercase tracking-wide text-zinc-500">Phone number</label>
      <PhoneField
        country={country}
        national={national}
        onCountryChange={setCountry}
        onNationalChange={setNational}
        valid={phoneValid}
      />

      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm text-zinc-300 hover:bg-[var(--color-panel-2)]"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!canSave}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : isEdit ? "Save" : "Add customer"}
        </button>
      </div>
    </Modal>
  );
}

function CustomersTable({ customers, onCreate, onEdit, onDelete }) {
  const columns = [
    {
      key: "name",
      header: "Name",
      hideable: false,
      filterType: "text",
      sortValue: (c) => c.name,
      render: (c) => <span className="font-medium text-zinc-100">{c.name}</span>,
    },
    {
      key: "phone",
      header: "Phone",
      filterType: "text",
      sortValue: (c) => c.phone,
      filterValue: (c) => fmtPhone(c.phone),
      render: (c) => <span className="font-mono text-zinc-300">{fmtPhone(c.phone)}</span>,
    },
    {
      key: "country",
      header: "Country",
      filterType: "select",
      sortValue: (c) => countryName(c.country),
      filterValue: (c) => countryName(c.country),
      render: (c) => (
        <span className="text-zinc-400">
          {isoToFlag(c.country)} {countryName(c.country)}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      filterType: "date",
      sortValue: (c) => c.createdAt || 0,
      filterValue: (c) => fmtDate(c.createdAt),
      render: (c) => <span className="text-zinc-400">{fmtDate(c.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      hideable: false,
      align: "right",
      render: (c) => (
        <div className="flex justify-end gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit(c);
            }}
            className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-zinc-400 hover:bg-[var(--color-panel-2)] hover:text-zinc-200"
          >
            Edit
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(c.id);
            }}
            className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];
  return (
    <>
      <PageHeader title="Customers" actionLabel="+ Add customer" onAction={onCreate} />
      {customers.length === 0 ? (
        <EmptyTable text="No customers yet. Add one with their name and phone number." />
      ) : (
        <DataTable
          storageKey="customers"
          columns={columns}
          data={customers}
          rowKey={(c) => c.id}
          onRowClick={(c) => onEdit(c)}
        />
      )}
    </>
  );
}

/* ============================ NAV SIDEBAR ============================ */
// Slim top bar shown only while the sidebar is collapsed — its sole job is the
// reopen button. When the sidebar is open, the collapse control lives inside it.
function AppHeader({ navOpen, onToggle, country, onCountryChange, countryOptions = [] }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-4">
      <button
        onClick={onToggle}
        title={navOpen ? "Collapse sidebar" : "Expand sidebar"}
        aria-label={navOpen ? "Collapse sidebar" : "Expand sidebar"}
        aria-pressed={navOpen}
        className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition hover:bg-[var(--color-panel-2)] hover:text-zinc-200"
      >
        <PanelIcon open={navOpen} />
      </button>

      {countryOptions.length > 0 && (
        <div className="ml-auto flex items-center gap-2">
          <GlobeIcon />
          <select
            value={country}
            onChange={(e) => onCountryChange(e.target.value)}
            title="Country"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1.5 text-sm text-zinc-200 focus:border-[var(--color-accent)] focus:outline-none"
          >
            <option value="all">All countries</option>
            {countryOptions.map((c) => (
              <option key={c.code} value={c.code}>
                {c.flag} {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </header>
  );
}

function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-zinc-500">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

// Sidebar / panel toggle glyph (mirrors Cursor's top-left panel icon).
function PanelIcon({ open }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
      {open && <rect x="2.5" y="3.5" width="2.5" height="9" rx="0.5" fill="currentColor" opacity="0.5" />}
    </svg>
  );
}

function NavSidebar({ nav, onNav, config, me, open = true }) {
  // Render straight from the modules the server granted, in their declared
  // order, using the shared MODULES metadata for label + icon.
  const allowed = me?.modules || [];
  const items = MODULE_IDS.filter((id) => allowed.includes(id) && !MODULES[id].hideFromNav).map((id) => ({
    id,
    label: MODULES[id].label,
    icon: MODULES[id].icon,
  }));

  return (
    <aside
      className={`flex shrink-0 flex-col overflow-hidden bg-[var(--color-panel)] transition-[width] duration-200 ease-in-out ${
        open ? "w-64 border-r border-[var(--color-border)]" : "w-0 border-r-0"
      }`}
    >
      {/* Fixed-width inner wrapper so content doesn't reflow while the width animates. */}
      <div className="flex h-full w-64 flex-col">
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
      </div>
    </aside>
  );
}

/* ============================ ACCESS ============================ */
function AccessPage({ me, onError }) {
  const [data, setData] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [modules, setModules] = useState(["stories", "orders"]);
  const [inviteCountries, setInviteCountries] = useState([]);
  const [countryOpts, setCountryOpts] = useState([]);
  const [inviting, setInviting] = useState(false);

  const assignable = data?.assignableModules || ["stories", "orders", "variables"];

  function load() {
    api
      .listAccessUsers()
      .then(setData)
      .catch((e) => onError?.(e.message));
    api
      .listCountries()
      .then(setCountryOpts)
      .catch(() => {});
  }

  useEffect(() => {
    load();
  }, []);

  function toggleModule(set, setter, moduleId) {
    setter(set.includes(moduleId) ? set.filter((p) => p !== moduleId) : [...set, moduleId]);
  }

  async function invite() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return onError?.("Enter an email address.");
    onError?.("");
    setInviting(true);
    try {
      await api.inviteAccessUser(trimmed, {
        role,
        modules: role === "admin" ? assignable : modules,
        countries: role === "admin" ? [] : inviteCountries,
      });
      setEmail("");
      setRole("member");
      setModules(["stories", "orders"]);
      setInviteCountries([]);
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
                  label={moduleLabel(p)}
                  active={modules.includes(p)}
                  onClick={() => toggleModule(modules, setModules, p)}
                />
              ))}
            </div>
          )}

          {role === "member" && countryOpts.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                Countries {inviteCountries.length === 0 && <span className="normal-case text-zinc-600">(none = all)</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {countryOpts.map((c) => (
                  <PageChip
                    key={c.code}
                    label={`${c.flag} ${c.name}`}
                    active={inviteCountries.includes(c.code)}
                    onClick={() => toggleModule(inviteCountries, setInviteCountries, c.code)}
                  />
                ))}
              </div>
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
                      <div className="text-xs text-zinc-500">Full access to all modules and countries.</div>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Modules</div>
                          <div className="flex flex-wrap gap-2">
                            {assignable.map((p) => (
                              <PageChip
                                key={p}
                                label={moduleLabel(p)}
                                active={(u.modules || []).includes(p)}
                                onClick={() => {
                                  const current = u.modules || [];
                                  const nextModules = current.includes(p)
                                    ? current.filter((x) => x !== p)
                                    : [...current, p];
                                  changeUser(u.email, { modules: nextModules });
                                }}
                              />
                            ))}
                          </div>
                        </div>
                        {countryOpts.length > 0 && (
                          <div>
                            <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                              Countries{" "}
                              {(u.countries || []).length === 0 && (
                                <span className="normal-case text-zinc-600">(none = all)</span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {countryOpts.map((c) => (
                                <PageChip
                                  key={c.code}
                                  label={`${c.flag} ${c.name}`}
                                  active={(u.countries || []).includes(c.code)}
                                  onClick={() => {
                                    const current = u.countries || [];
                                    const next = current.includes(c.code)
                                      ? current.filter((x) => x !== c.code)
                                      : [...current, c.code];
                                    changeUser(u.email, { countries: next });
                                  }}
                                />
                              ))}
                            </div>
                          </div>
                        )}
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

/* ============================ COUNTRIES (SETTINGS) ============================ */

// Admin registry of operating countries (markets). Add/edit/remove, set currency
// and per-country tax. Drives every selector, label, and pricing input in the app.
function CountriesSettings({ onError, onChanged }) {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null); // null | {} (new) | record (edit)
  const [busy, setBusy] = useState(false);

  function load() {
    api.listCountries(true).then(setList).catch((e) => onError?.(e.message));
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(form) {
    setBusy(true);
    onError?.("");
    try {
      if (editing?.code) {
        await api.updateCountry(form.code, {
          name: form.name,
          currency: form.currency,
          enabled: form.enabled,
          tax: form.tax,
        });
      } else {
        await api.createCountry(form);
      }
      setEditing(null);
      load();
      onChanged?.();
    } catch (e) {
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(c) {
    if (!confirm(`Remove ${c.name}? Existing orders keep their saved price; new pricing/selectors will drop it.`))
      return;
    try {
      await api.deleteCountry(c.code);
      load();
      onChanged?.();
    } catch (e) {
      onError?.(e.message);
    }
  }

  async function toggleEnabled(c) {
    try {
      await api.updateCountry(c.code, { enabled: !c.enabled });
      load();
      onChanged?.();
    } catch (e) {
      onError?.(e.message);
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">
          Markets you operate in. Each has its own currency, tax, and per-story pricing.
        </p>
        <button
          onClick={() => setEditing({})}
          className="shrink-0 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-black"
        >
          + Add country
        </button>
      </div>

      {list.length === 0 ? (
        <EmptyTable text="No countries yet. Add one to start pricing and taking orders." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
          {list.map((c) => (
            <div
              key={c.code}
              className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3 last:border-b-0"
            >
              <span className="text-lg">{c.flag}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-100">{c.name}</span>
                  <span className="text-xs text-zinc-500">
                    {c.code} · {c.currency}
                  </span>
                  {!c.enabled && (
                    <span className="rounded bg-zinc-700/40 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
                      Disabled
                    </span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  {c.tax?.enabled
                    ? `${c.tax.label} ${c.tax.rate}% ${c.tax.inclusive ? "(inclusive)" : "(added on top)"}`
                    : "No tax"}
                </div>
              </div>
              <button
                onClick={() => toggleEnabled(c)}
                className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-zinc-400 hover:bg-[var(--color-panel-2)]"
              >
                {c.enabled ? "Disable" : "Enable"}
              </button>
              <button
                onClick={() => setEditing(c)}
                className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-zinc-400 hover:bg-[var(--color-panel-2)] hover:text-zinc-200"
              >
                Edit
              </button>
              <button
                onClick={() => remove(c)}
                className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <CountryModal
          existing={editing.code ? editing : null}
          taken={list.map((c) => c.code)}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function CountryModal({ existing, taken = [], busy, onClose, onSave }) {
  const isEdit = Boolean(existing);
  const available = ISO_CODES.filter((code) => !taken.includes(code) || code === existing?.code);

  const [code, setCode] = useState(existing?.code || available[0] || "");
  const meta = ISO_CATALOG[code] || {};
  const [name, setName] = useState(existing?.name || meta.name || "");
  const [currency, setCurrency] = useState(existing?.currency || meta.currency || "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [taxEnabled, setTaxEnabled] = useState(existing?.tax?.enabled ?? false);
  const [taxRate, setTaxRate] = useState(existing?.tax?.rate != null ? String(existing.tax.rate) : "15");
  const [taxInclusive, setTaxInclusive] = useState(existing?.tax?.inclusive ?? false);
  const [taxLabel, setTaxLabel] = useState(existing?.tax?.label || "VAT");

  function pick(newCode) {
    setCode(newCode);
    const m = ISO_CATALOG[newCode] || {};
    setName(m.name || "");
    setCurrency(m.currency || "");
  }

  function submit() {
    onSave({
      code,
      name: name.trim(),
      currency: currency.trim().toUpperCase(),
      enabled,
      tax: {
        enabled: taxEnabled,
        rate: Number(taxRate) || 0,
        inclusive: taxInclusive,
        label: taxLabel.trim() || "VAT",
      },
    });
  }

  const inputCls =
    "mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none";

  return (
    <Modal title={isEdit ? `Edit ${existing.name}` : "Add country"} onClose={onClose}>
      {!isEdit &&
        (available.length === 0 ? (
          <p className="text-sm text-amber-300">Every supported country has already been added.</p>
        ) : (
          <>
            <label className="block text-xs uppercase tracking-wide text-zinc-500">Country</label>
            <select value={code} onChange={(e) => pick(e.target.value)} className={inputCls}>
              {available.map((cc) => (
                <option key={cc} value={cc}>
                  {ISO_CATALOG[cc].flag} {ISO_CATALOG[cc].name}
                </option>
              ))}
            </select>
          </>
        ))}

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs uppercase tracking-wide text-zinc-500">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wide text-zinc-500">Currency</label>
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="SAR"
            className={`${inputCls} font-mono uppercase`}
          />
        </div>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled (shown in selectors and available for new orders)
      </label>

      <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <input type="checkbox" checked={taxEnabled} onChange={(e) => setTaxEnabled(e.target.checked)} />
          Charge tax in this country
        </label>
        {taxEnabled && (
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wide text-zinc-500">Label</label>
              <input value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-zinc-500">Rate %</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                className={`${inputCls} tabular-nums`}
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-zinc-500">Mode</label>
              <select
                value={taxInclusive ? "inc" : "exc"}
                onChange={(e) => setTaxInclusive(e.target.value === "inc")}
                className={inputCls}
              >
                <option value="exc">Added on top</option>
                <option value="inc">Included in price</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm text-zinc-300 hover:bg-[var(--color-panel-2)]"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || !code || !name.trim() || !currency.trim()}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Saving…" : isEdit ? "Save" : "Add country"}
        </button>
      </div>
    </Modal>
  );
}

function SettingsPage({
  me,
  tab: controlledTab,
  onTabChange,
  variables = [],
  onDeleteVariable,
  onCreateVariable,
  onError,
  onSaved,
}) {
  const [localTab, setLocalTab] = useState("general");
  const tab = controlledTab ?? localTab;
  const setTab = onTabChange ?? setLocalTab;
  const [settings, setSettings] = useState(null);
  const [falKey, setFalKey] = useState("");
  const [showFal, setShowFal] = useState(false);
  const [model, setModel] = useState("nano_banana");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok: boolean, msg: string }

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

  async function testKey() {
    setTesting(true);
    setTestResult(null);
    try {
      await api.testFalKey(falKey.trim() || undefined);
      setTestResult({
        ok: true,
        msg: falKey.trim() ? "This key works ✓" : "Saved key works ✓",
      });
    } catch (e) {
      setTestResult({ ok: false, msg: e.message });
    } finally {
      setTesting(false);
    }
  }

  const selectedModel = FAL_MODELS.find((m) => m.id === model);

  return (
    <>
      <PageHeader title="Settings" subtitle="fal.ai key, the model, test images, variables, and access." />

      <div className="mb-6 flex gap-1 border-b border-[var(--color-border)]">
        {[
          { id: "general", label: "General" },
          { id: "countries", label: "Countries" },
          { id: "test-images", label: "Test images" },
          { id: "variables", label: "Variables" },
          { id: "access", label: "Access" },
          { id: "history", label: "History" },
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

      {tab === "countries" ? (
        <CountriesSettings onError={onError} onChanged={onSaved} />
      ) : tab === "test-images" ? (
        <TestImagesSettings onError={onError} />
      ) : tab === "variables" ? (
        <VariablesTable
          variables={variables}
          onDelete={onDeleteVariable}
          onCreate={onCreateVariable}
        />
      ) : tab === "access" ? (
        <AccessPage me={me} onError={onError} />
      ) : tab === "history" ? (
        <HistoryLog onError={onError} />
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
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={testKey}
              disabled={testing || (!falKey.trim() && !settings?.falKey?.set)}
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-[var(--color-panel)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {testing && <Spinner />}
              {falKey.trim() ? "Test this key" : "Test key"}
            </button>
            {testResult && (
              <span
                className={`text-sm ${
                  testResult.ok ? "text-[var(--color-accent-2)]" : "text-rose-400"
                }`}
              >
                {testResult.msg}
              </span>
            )}
          </div>
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

/* ============================ HISTORY LOG ============================ */
// Per-entity-type metadata for the history log (icon + readable label).
const HISTORY_ENTITY_META = {
  story: { icon: "📖", label: "Story" },
  order: { icon: "🧾", label: "Order" },
  variable: { icon: "🔤", label: "Variable" },
  symbol: { icon: "✳️", label: "Symbol" },
  "test-image": { icon: "🖼️", label: "Test image" },
  settings: { icon: "⚙️", label: "Settings" },
  access: { icon: "👥", label: "Access" },
};

const HISTORY_FILTERS = [
  { id: "", label: "All" },
  { id: "story", label: "Stories" },
  { id: "order", label: "Orders" },
  { id: "variable", label: "Variables" },
  { id: "access", label: "Access" },
  { id: "settings", label: "Settings" },
];

function fmtWhen(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Admin-only activity feed. Lists every recorded change newest-first; clicking a
// row expands the full related timeline for that same item (its `target`).
function HistoryLog({ onError }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [entity, setEntity] = useState("");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  function load() {
    setLoading(true);
    api
      .listHistory({ limit: 1000 })
      .then((res) => setEntries(Array.isArray(res?.entries) ? res.entries : []))
      .catch((e) => onError?.(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  // All entries that share a target, newest-first — an item's related history.
  function relatedFor(target) {
    return entries.filter((e) => e.target === target);
  }

  const q = query.trim().toLowerCase();
  const filtered = entries.filter((e) => {
    if (entity && e.entity !== entity) return false;
    if (!q) return true;
    return (
      (e.action || "").toLowerCase().includes(q) ||
      (e.name || "").toLowerCase().includes(q) ||
      (e.actor || "").toLowerCase().includes(q)
    );
  });

  return (
    <>
      <PageHeader
        title="History"
        subtitle="Every change made in the system. Click a row to see the full timeline for that item."
        actionLabel="Refresh"
        onAction={load}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {HISTORY_FILTERS.map((f) => (
            <PageChip
              key={f.id || "all"}
              label={f.label}
              active={entity === f.id}
              onClick={() => setEntity(f.id)}
            />
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search action, item, or person…"
          className="ml-auto min-w-[220px] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none"
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-zinc-500">
          <Spinner /> Loading history…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyTable text="No history yet. Changes you make across the app will show up here." />
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => {
            const meta = HISTORY_ENTITY_META[e.entity] || { icon: "•", label: e.entity };
            const related = relatedFor(e.target);
            const isOpen = expandedId === e.id;
            return (
              <div
                key={e.id}
                className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40"
              >
                <button
                  onClick={() => setExpandedId(isOpen ? null : e.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--color-panel-2)]/70"
                >
                  <span className="text-base" title={meta.label}>
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-zinc-100">
                      {e.action}
                      {e.name && (
                        <span className="text-zinc-400">
                          {" — "}
                          <span className="text-zinc-300">{e.name}</span>
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                      <span className="text-zinc-400">{e.actor || "local"}</span>
                      <span>·</span>
                      <span>{fmtWhen(e.at)}</span>
                      <span className="rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                        {meta.label}
                      </span>
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-zinc-500">
                    {related.length > 1 ? `${related.length} related` : ""}
                    <span className="ml-2 inline-block">{isOpen ? "▾" : "▸"}</span>
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t border-[var(--color-border)] bg-[var(--color-panel)]/40 px-4 py-3">
                    <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                      Related history ({related.length})
                    </div>
                    <ol className="space-y-0">
                      {related.map((r, i) => (
                        <li key={r.id} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <span
                              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                                r.id === e.id ? "bg-[var(--color-accent)]" : "bg-zinc-600"
                              }`}
                            />
                            {i < related.length - 1 && (
                              <span className="w-px flex-1 bg-[var(--color-border)]" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 pb-3">
                            <div className="truncate text-sm text-zinc-200">{r.action}</div>
                            <div className="text-xs text-zinc-500">
                              {r.actor || "local"} · {fmtWhen(r.at)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            );
          })}
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
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
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
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
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

const genderLabelOf = (g) => (g === "male" ? "Boy" : g === "non-binary" ? "Child" : "Girl");

function StoriesTable({ stories, onOpen, onDelete, onCreate }) {
  const columns = [
    {
      key: "title",
      header: "Title",
      hideable: false,
      filterType: "text",
      sortValue: (s) => s.title,
      render: (s) => <span className="font-medium text-zinc-100">{s.title}</span>,
    },
    {
      key: "status",
      header: "Status",
      filterType: "select",
      sortValue: (s) => s.status,
      filterValue: (s) => (s.status === "published" ? "Published" : "Draft"),
      render: (s) => <StatusPill status={s.status} />,
    },
    {
      key: "child",
      header: "Child",
      filterType: "select",
      sortValue: (s) => genderLabelOf(s.gender),
      filterValue: (s) => genderLabelOf(s.gender),
      render: (s) => <span className="text-zinc-400">{genderLabelOf(s.gender)}</span>,
    },
    {
      key: "scenes",
      header: "Scenes",
      align: "right",
      filterType: "number",
      sortValue: (s) => s.scenes.length,
      render: (s) => s.scenes.length,
    },
    {
      key: "created",
      header: "Created",
      filterType: "date",
      sortValue: (s) => s.createdAt || 0,
      filterValue: (s) => fmtDate(s.createdAt),
      render: (s) => <span className="text-zinc-400">{fmtDate(s.createdAt)}</span>,
    },
  ];
  return (
    <>
      <PageHeader
        title="Stories"
        actionLabel="+ Create story"
        onAction={onCreate}
      />
      {stories.length === 0 ? (
        <EmptyTable text="No stories yet. Create one and upload its scene templates." />
      ) : (
        <DataTable
          storageKey="stories"
          columns={columns}
          data={stories}
          rowKey={(s) => s.id}
          onRowClick={(s) => onOpen(s.id)}
        />
      )}
    </>
  );
}

// Human-facing order reference derived from the order's unique id.
function orderRef(id) {
  return `ORD-${String(id || "").toUpperCase()}`;
}

function OrdersTable({ orders, onOpen, onDelete, onCreate }) {
  const generatedCount = (o) => Object.keys(o.results || {}).length;
  const columns = [
    {
      key: "order",
      header: "Order",
      hideable: false,
      sortValue: (o) => o.title,
      render: (o) => <span className="font-medium text-zinc-100">{o.title}</span>,
    },
    {
      key: "orderId",
      header: "Order ID",
      sortValue: (o) => orderRef(o.id),
      render: (o) => <span className="font-mono text-xs text-zinc-500">{orderRef(o.id)}</span>,
    },
    {
      key: "child",
      header: "Child",
      sortValue: (o) => genderLabelOf(o.gender),
      render: (o) => <span className="text-zinc-400">{genderLabelOf(o.gender)}</span>,
    },
    {
      key: "story",
      header: "Story",
      sortValue: (o) => o.storyTitle,
      render: (o) => <span className="text-zinc-400">{o.storyTitle}</span>,
    },
    {
      key: "customer",
      header: "Customer",
      filterType: "text",
      sortValue: (o) => o.customer?.name || "",
      filterValue: (o) => o.customer?.name || "",
      render: (o) =>
        o.customer ? (
          <span className="text-zinc-400">{o.customer.name}</span>
        ) : (
          <span className="text-zinc-600">—</span>
        ),
    },
    {
      key: "country",
      header: "Country",
      filterType: "select",
      sortValue: (o) => countryName(o.country),
      filterValue: (o) => countryName(o.country),
      render: (o) => (
        <span className="text-zinc-400">
          {isoToFlag(o.country)} {countryName(o.country)}
        </span>
      ),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      filterType: "number",
      sortValue: (o) => o.pricing?.total ?? 0,
      render: (o) =>
        o.pricing ? (
          <span className="tabular-nums text-zinc-200">{formatMoney(o.pricing.total, o.pricing.currency)}</span>
        ) : (
          <span className="text-zinc-600">—</span>
        ),
    },
    {
      key: "photo",
      header: "Photo",
      sortValue: (o) => (o.kid ? 1 : 0),
      render: (o) =>
        o.kid ? (
          <span className="text-[var(--color-accent-2)]">✓</span>
        ) : (
          <span className="text-zinc-600">—</span>
        ),
    },
    {
      key: "generated",
      header: "Generated",
      align: "right",
      sortValue: (o) => generatedCount(o),
      render: (o) => `${generatedCount(o)}/${o.scenes.length}`,
    },
    {
      key: "created",
      header: "Created",
      sortValue: (o) => o.createdAt || 0,
      render: (o) => <span className="text-zinc-400">{fmtDate(o.createdAt)}</span>,
    },
  ];
  return (
    <>
      <PageHeader
        title="Orders"
        actionLabel="+ Create order"
        onAction={onCreate}
      />
      {orders.length === 0 ? (
        <EmptyTable text="No orders yet. Create one, choose a story, and upload a kid's photo." />
      ) : (
        <DataTable
          storageKey="orders"
          columns={columns}
          data={orders}
          rowKey={(o) => o.id}
          onRowClick={(o) => onOpen(o.id)}
        />
      )}
    </>
  );
}

// ── Reusable data table ──────────────────────────────────────────────────────
// Column-driven table with click-to-sort headers, a gear menu to show/hide
// columns, and page-size based pagination. Per-table user preferences (sort,
// hidden columns, page size) are remembered in localStorage via `storageKey`.
//
// columns: [{
//   key, header,
//   render?(row) -> node,        // defaults to row[key]
//   sortValue?(row) -> primitive,// defaults to render-less row[key]
//   sortable?: boolean,          // default true
//   hideable?: boolean,          // default true (false keeps it always shown)
//   align?: "left" | "right" | "center",
//   thClassName?, tdClassName?,
// }]
const TABLE_PREFS_KEY = "hazawy.tablePrefs";
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200];

function loadTablePrefs(storageKey) {
  if (!storageKey) return {};
  try {
    const all = JSON.parse(localStorage.getItem(TABLE_PREFS_KEY) || "{}");
    return all[storageKey] || {};
  } catch {
    return {};
  }
}

function saveTablePrefs(storageKey, prefs) {
  if (!storageKey) return;
  try {
    const all = JSON.parse(localStorage.getItem(TABLE_PREFS_KEY) || "{}");
    all[storageKey] = prefs;
    localStorage.setItem(TABLE_PREFS_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/* ===================== TABLE FILTERS ===================== */
// Operator catalog per data type. `arity` = how many value inputs the operator
// needs (0 = none, 1 = single, 2 = range). Used to build a small query-builder.
const FILTER_OPS = {
  text: [
    { id: "contains", label: "contains", arity: 1 },
    { id: "notContains", label: "does not contain", arity: 1 },
    { id: "eq", label: "is", arity: 1 },
    { id: "neq", label: "is not", arity: 1 },
    { id: "startsWith", label: "starts with", arity: 1 },
    { id: "endsWith", label: "ends with", arity: 1 },
    { id: "empty", label: "is empty", arity: 0 },
    { id: "notEmpty", label: "is not empty", arity: 0 },
  ],
  number: [
    { id: "eq", label: "=", arity: 1 },
    { id: "neq", label: "≠", arity: 1 },
    { id: "gt", label: ">", arity: 1 },
    { id: "gte", label: "≥", arity: 1 },
    { id: "lt", label: "<", arity: 1 },
    { id: "lte", label: "≤", arity: 1 },
    { id: "between", label: "between", arity: 2 },
    { id: "empty", label: "is empty", arity: 0 },
    { id: "notEmpty", label: "is not empty", arity: 0 },
  ],
  date: [
    { id: "on", label: "is", arity: 1 },
    { id: "before", label: "before", arity: 1 },
    { id: "after", label: "after", arity: 1 },
    { id: "between", label: "between", arity: 2 },
    { id: "empty", label: "is empty", arity: 0 },
    { id: "notEmpty", label: "is not empty", arity: 0 },
  ],
  select: [
    { id: "is", label: "is", arity: 1 },
    { id: "isNot", label: "is not", arity: 1 },
    { id: "empty", label: "is empty", arity: 0 },
    { id: "notEmpty", label: "is not empty", arity: 0 },
  ],
  boolean: [
    { id: "true", label: "is true", arity: 0 },
    { id: "false", label: "is false", arity: 0 },
  ],
};

const opsForType = (type) => FILTER_OPS[type] || FILTER_OPS.text;
const opMeta = (type, opId) => opsForType(type).find((o) => o.id === opId) || opsForType(type)[0];

// Raw (comparable) and string accessors for a cell.
const rawFilterValue = (col, row) => (col.sortValue ? col.sortValue(row) : row[col.key]);
const strFilterValue = (col, row) => {
  const v = col.filterValue ? col.filterValue(row) : rawFilterValue(col, row);
  return v == null ? "" : String(v);
};

// A column's filter data type: explicit `filterType`, else inferred from values.
function resolveFilterType(col, data) {
  if (col.filterType && FILTER_OPS[col.filterType]) return col.filterType;
  for (const row of data) {
    const v = rawFilterValue(col, row);
    if (v == null || v === "") continue;
    if (typeof v === "number") return "number";
    if (typeof v === "boolean") return "boolean";
    break;
  }
  return "text";
}

// A filter is "complete" (worth applying) once its operator has the values it needs.
function isFilterComplete(type, f) {
  const meta = opMeta(type, f.op);
  if (meta.arity === 0) return true;
  if (meta.arity === 1) return f.v1 != null && f.v1 !== "";
  return f.v1 != null && f.v1 !== "" && f.v2 != null && f.v2 !== "";
}

const startOfDay = (d) => {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};

// Evaluate one filter against one row.
function rowMatchesFilter(col, type, f, row) {
  const op = f.op;
  const raw = col.filterValue ? col.filterValue(row) : rawFilterValue(col, row);
  const isEmpty = raw == null || String(raw).trim() === "";
  if (op === "empty") return isEmpty;
  if (op === "notEmpty") return !isEmpty;

  if (type === "boolean") {
    const b = Boolean(rawFilterValue(col, row));
    return op === "true" ? b : !b;
  }

  if (type === "number") {
    const n = Number(rawFilterValue(col, row));
    if (Number.isNaN(n)) return false;
    const a = parseFloat(f.v1);
    const b = parseFloat(f.v2);
    switch (op) {
      case "eq": return n === a;
      case "neq": return n !== a;
      case "gt": return n > a;
      case "gte": return n >= a;
      case "lt": return n < a;
      case "lte": return n <= a;
      case "between": return n >= Math.min(a, b) && n <= Math.max(a, b);
      default: return true;
    }
  }

  if (type === "date") {
    const cell = startOfDay(Number(rawFilterValue(col, row)) || rawFilterValue(col, row));
    if (cell == null) return false;
    const a = f.v1 ? startOfDay(f.v1) : null;
    const b = f.v2 ? startOfDay(f.v2) : null;
    switch (op) {
      case "on": return a != null && cell === a;
      case "before": return a != null && cell < a;
      case "after": return a != null && cell > a;
      case "between": return a != null && b != null && cell >= Math.min(a, b) && cell <= Math.max(a, b);
      default: return true;
    }
  }

  // text + select
  const cell = strFilterValue(col, row).toLowerCase();
  const val = String(f.v1 ?? "").toLowerCase();
  switch (op) {
    case "contains": return cell.includes(val);
    case "notContains": return !cell.includes(val);
    case "eq":
    case "is": return cell === val;
    case "neq":
    case "isNot": return cell !== val;
    case "startsWith": return cell.startsWith(val);
    case "endsWith": return cell.endsWith(val);
    default: return true;
  }
}

const newFilterId = () => Math.random().toString(36).slice(2, 9);

// Popup query-builder. Edits a local draft; commits via onApply.
function TableFilterModal({ columns, typeOf, optionsOf, initial, onApply, onClose }) {
  const makeRow = () => {
    const col = columns[0];
    if (!col) return null;
    const type = typeOf(col);
    return { id: newFilterId(), key: col.key, op: opsForType(type)[0].id, v1: "", v2: "" };
  };
  // Open straight into one ready-to-fill row (no separate "add" step).
  const [draft, setDraft] = useState(() =>
    initial.length ? initial.map((f) => ({ ...f })) : [makeRow()].filter(Boolean),
  );

  const FIELD =
    "rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1.5 text-sm text-zinc-200 focus:border-[var(--color-accent)] focus:outline-none";

  const addRow = () => {
    const row = makeRow();
    if (row) setDraft((d) => [...d, row]);
  };
  const update = (id, patch) => setDraft((d) => d.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const remove = (id) => setDraft((d) => d.filter((f) => f.id !== id));
  const changeColumn = (id, key) => {
    const col = columns.find((c) => c.key === key);
    const type = typeOf(col);
    update(id, { key, op: opsForType(type)[0].id, v1: "", v2: "" });
  };

  const valueInput = (f, type, which) => {
    const k = which === 2 ? "v2" : "v1";
    const inputType = type === "number" ? "number" : type === "date" ? "date" : "text";
    if (type === "select") {
      const options = optionsOf(columns.find((c) => c.key === f.key));
      return (
        <select className={FIELD} value={f[k]} onChange={(e) => update(f.id, { [k]: e.target.value })}>
          <option value="">Select…</option>
          {options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
    }
    return (
      <input
        type={inputType}
        className={`${FIELD} min-w-0 flex-1`}
        value={f[k]}
        placeholder="Value"
        onChange={(e) => update(f.id, { [k]: e.target.value })}
      />
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Filters</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200" aria-label="Close">×</button>
        </div>

        {draft.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-zinc-500">
            No filters yet. Add one to narrow the table.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {draft.map((f) => {
              const col = columns.find((c) => c.key === f.key) || columns[0];
              const type = typeOf(col);
              const meta = opMeta(type, f.op);
              return (
                <div key={f.id} className="flex flex-wrap items-center gap-2">
                  <select className={FIELD} value={f.key} onChange={(e) => changeColumn(f.id, e.target.value)}>
                    {columns.map((c) => (
                      <option key={c.key} value={c.key}>{c.header}</option>
                    ))}
                  </select>
                  <select className={FIELD} value={f.op} onChange={(e) => update(f.id, { op: e.target.value, v1: "", v2: "" })}>
                    {opsForType(type).map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                  {meta.arity >= 1 && valueInput(f, type, 1)}
                  {meta.arity === 2 && (
                    <>
                      <span className="text-xs text-zinc-500">and</span>
                      {valueInput(f, type, 2)}
                    </>
                  )}
                  <button
                    onClick={() => remove(f.id)}
                    className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-[var(--color-panel-2)] hover:text-rose-300"
                    aria-label="Remove filter"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={addRow}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-[#242838]"
        >
          <FunnelIcon /> Add filter
        </button>

        <div className="mt-5 flex items-center justify-between">
          <button onClick={() => setDraft([])} className="text-sm text-zinc-400 hover:text-zinc-200">
            Clear all
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-2 text-sm text-zinc-200 hover:bg-[#242838]"
            >
              Cancel
            </button>
            <button
              onClick={() => onApply(draft)}
              className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DataTable({
  columns,
  data,
  rowKey = (row) => row.id,
  onRowClick,
  storageKey,
  initialPageSize = 25,
}) {
  const prefs = useMemo(() => loadTablePrefs(storageKey), [storageKey]);
  const [sort, setSort] = useState(prefs.sort || null); // { key, dir: "asc" | "desc" }
  const [hidden, setHidden] = useState(() => new Set(prefs.hidden || []));
  const [pageSize, setPageSize] = useState(prefs.pageSize || initialPageSize);
  const [page, setPage] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [filters, setFilters] = useState([]); // [{ id, key, op, v1, v2 }]

  useEffect(() => {
    saveTablePrefs(storageKey, { sort, hidden: [...hidden], pageSize });
  }, [storageKey, sort, hidden, pageSize]);

  const visibleColumns = columns.filter((c) => !hidden.has(c.key));

  // Columns that can be filtered + helpers the filter modal needs.
  const filterableColumns = columns.filter((c) => c.header && c.filterable !== false);
  const typeOf = (col) => resolveFilterType(col, data);
  const optionsOf = (col) => {
    const set = new Set();
    for (const row of data) {
      const s = strFilterValue(col, row).trim();
      if (s) set.add(s);
    }
    return [...set].sort((a, b) => compareValues(a, b));
  };

  // Only filters whose operator has its required values actually constrain rows.
  const activeFilters = filters.filter((f) => {
    const col = columns.find((c) => c.key === f.key);
    return col && isFilterComplete(typeOf(col), f);
  });
  const activeFilterCount = activeFilters.length;

  // Reset to the first page whenever the active filters change.
  useEffect(() => {
    setPage(0);
  }, [filters]);

  const filteredData = useMemo(() => {
    if (activeFilters.length === 0) return data;
    return data.filter((row) =>
      activeFilters.every((f) => {
        const col = columns.find((c) => c.key === f.key);
        if (!col) return true;
        return rowMatchesFilter(col, resolveFilterType(col, data), f, row);
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filters, columns]);

  const sortedData = useMemo(() => {
    if (!sort) return filteredData;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return filteredData;
    const valueOf = col.sortValue || ((row) => row[col.key]);
    const arr = [...filteredData].sort((a, b) => compareValues(valueOf(a), valueOf(b)));
    if (sort.dir === "desc") arr.reverse();
    return arr;
  }, [filteredData, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const pageData = sortedData.slice(start, start + pageSize);

  function toggleSort(col) {
    if (col.sortable === false) return;
    setSort((prev) => {
      if (!prev || prev.key !== col.key) return { key: col.key, dir: "asc" };
      if (prev.dir === "asc") return { key: col.key, dir: "desc" };
      return null; // third click clears the sort
    });
  }

  function toggleColumn(key) {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const alignClass = (a) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex items-center justify-between gap-2 rounded-t-xl border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-xs text-zinc-500">
          {sortedData.length} {sortedData.length === 1 ? "row" : "rows"}
        </span>
        <div className="flex items-center gap-2">
        {/* Filter by column (opens the query-builder popup) */}
        <button
          type="button"
          title="Filter rows"
          onClick={() => setFilterModalOpen(true)}
          className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs hover:bg-[#242838] ${
            activeFilterCount > 0
              ? "border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
              : "border-[var(--color-border)] bg-[var(--color-panel-2)] text-zinc-300"
          }`}
        >
          <FunnelIcon />
          Filter
          {activeFilterCount > 0 && (
            <span className="ml-0.5 rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-semibold text-black">
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Show / hide columns */}
        <div className="relative">
          <button
            type="button"
            title="Show / hide columns"
            onClick={() => {
              setMenuOpen((v) => !v);
              setFilterOpen(false);
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] text-zinc-300 hover:bg-[#242838]"
          >
            <GearIcon />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-30 mt-1 w-52 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-xl">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  Columns
                </div>
                {columns
                  .filter((c) => c.hideable !== false && c.header)
                  .map((c) => (
                    <label
                      key={c.key}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-200 hover:bg-[var(--color-panel-2)]"
                    >
                      <input
                        type="checkbox"
                        checked={!hidden.has(c.key)}
                        onChange={() => toggleColumn(c.key)}
                        className="accent-[var(--color-accent)]"
                      />
                      {c.header}
                    </label>
                  ))}
              </div>
            </>
          )}
        </div>
        </div>
      </div>

      {/* Mobile (< sm): each row as a stacked card so nothing is cut off. */}
      <div className="divide-y divide-[var(--color-border)] sm:hidden">
        {pageData.map((row) => {
          const [first, ...rest] = visibleColumns;
          return (
            <div
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`px-4 py-3 ${onRowClick ? "cursor-pointer active:bg-[var(--color-panel-2)]/40" : ""}`}
            >
              {first && (
                <div className="mb-2 text-sm font-medium text-zinc-100">
                  {first.render ? first.render(row) : row[first.key]}
                </div>
              )}
              <dl className="flex flex-col gap-1.5">
                {rest.map((c) => (
                  <div key={c.key} className="flex items-center justify-between gap-3">
                    <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{c.header}</dt>
                    <dd className="text-right text-sm text-zinc-300">
                      {c.render ? c.render(row) : row[c.key]}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
        {pageData.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">No rows to show.</div>
        )}
      </div>

      {/* Desktop (sm+): full table, horizontally scrollable if needed. */}
      <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
            {visibleColumns.map((c) => {
              const active = sort?.key === c.key;
              const sortable = c.sortable !== false;
              return (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c)}
                  className={`px-4 py-3 font-medium ${alignClass(c.align)} ${
                    sortable ? "cursor-pointer select-none hover:text-zinc-300" : ""
                  } ${c.thClassName || ""}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.header}
                    {sortable && c.header && (
                      <SortIndicator dir={active ? sort.dir : null} />
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {pageData.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-t border-[var(--color-border)] ${
                onRowClick ? "cursor-pointer hover:bg-[var(--color-panel-2)]/40" : ""
              }`}
            >
              {visibleColumns.map((c) => (
                <td key={c.key} className={`px-4 py-3 ${alignClass(c.align)} ${c.tdClassName || ""}`}>
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
          {pageData.length === 0 && (
            <tr>
              <td colSpan={visibleColumns.length} className="px-4 py-8 text-center text-sm text-zinc-500">
                No rows to show.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t border-[var(--color-border)] px-3 py-2 text-xs text-zinc-400">
        <div className="flex items-center gap-2">
          <span>Rows per page</span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-zinc-200 focus:outline-none"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="inline-flex items-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={currentPage === 0}
            aria-label="Previous page"
            className="flex h-8 w-9 items-center justify-center text-base text-blue-500 hover:bg-[#242838] disabled:text-zinc-600 disabled:hover:bg-transparent"
          >
            ‹
          </button>
          <span className="min-w-[4.5rem] px-2 text-center text-sm font-medium tabular-nums text-zinc-200">
            {sortedData.length === 0 ? 0 : start + 1} - {Math.min(start + pageSize, sortedData.length)}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={currentPage >= pageCount - 1}
            aria-label="Next page"
            className="flex h-8 w-9 items-center justify-center text-base text-blue-500 hover:bg-[#242838] disabled:text-zinc-600 disabled:hover:bg-transparent"
          >
            ›
          </button>
        </div>
      </div>

      {filterModalOpen && (
        <TableFilterModal
          columns={filterableColumns}
          typeOf={typeOf}
          optionsOf={optionsOf}
          initial={filters}
          onApply={(next) => {
            setFilters(next);
            setFilterModalOpen(false);
          }}
          onClose={() => setFilterModalOpen(false)}
        />
      )}
    </div>
  );
}

function SortIndicator({ dir }) {
  return (
    <span className={`text-[10px] ${dir ? "text-[var(--color-accent)]" : "text-zinc-600"}`}>
      {dir === "asc" ? "▲" : dir === "desc" ? "▼" : "↕"}
    </span>
  );
}

function FunnelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
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
  // Auto-save while typing: persist ~800ms after the user pauses, so a title is
  // never lost if they navigate away without blurring the field.
  useEffect(() => {
    if (val.trim() === (value || "").trim()) return;
    const t = setTimeout(commit, 800);
    return () => clearTimeout(t);
  }, [val]); // eslint-disable-line react-hooks/exhaustive-deps
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

// Small live-status pill: shows auto-save progress and flashes when a change
// from the other editor is pulled in.
function SaveIndicator({ saveState, livePing }) {
  if (livePing) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2.5 py-0.5 text-xs font-medium text-[var(--color-accent)]">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
        Updated live
      </span>
    );
  }
  const map = {
    saving: { text: "Saving…", cls: "text-amber-300 border-amber-400/30 bg-amber-400/10" },
    saved: { text: "Saved", cls: "text-emerald-300 border-emerald-400/30 bg-emerald-400/10" },
    error: { text: "Save failed", cls: "text-rose-300 border-rose-400/30 bg-rose-400/10" },
  };
  const m = map[saveState];
  if (!m) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${m.cls}`}
    >
      {m.text}
    </span>
  );
}

// Per-country pricing status pill. "Live" once a story is published AND priced;
// "Waiting for price" when no usable price; "Priced · draft" when priced but the
// story itself isn't published yet.
function PriceStatusPill({ eff, published }) {
  if (!eff) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-0.5 text-xs font-medium text-amber-200">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        Waiting for price
      </span>
    );
  }
  if (!published) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-0.5 text-xs font-medium text-zinc-300">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
        Priced · draft
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-0.5 text-xs font-medium text-emerald-200">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
      Live
    </span>
  );
}

// The raw price / discount strings stored for one country (handles the legacy
// numeric shape as well as the current { price, discountPrice } object).
function rawPriceFields(entry) {
  if (entry == null) return { price: "", discount: "" };
  if (typeof entry === "number") return { price: entry > 0 ? String(entry) : "", discount: "" };
  return {
    price: entry.price != null ? String(entry.price) : "",
    discount: entry.discountPrice != null ? String(entry.discountPrice) : "",
  };
}

// Human-readable per-country price status (used for the table's select filter).
function priceStatusLabel(entry, published) {
  if (!effectivePrice(entry)) return "Waiting for price";
  return published ? "Live" : "Priced · draft";
}

// Pricing list — same DataTable component as Stories. Click a row to open its
// price detail. Columns adapt to context: a specific header country shows that
// market's price + status; "All" shows how many of the viewer's markets are
// priced. Members only ever see their own countries (server enforces this too).
function PricingTable({ rows = [], myCountries = [], country, isAdmin, onOpen }) {
  const specific = country && country !== "all" ? myCountries.find((c) => c.code === country) : null;
  const countPriced = (s) => myCountries.filter((c) => effectivePrice(s.prices?.[c.code])).length;

  const columns = [
    {
      key: "title",
      header: "Title",
      hideable: false,
      filterType: "text",
      sortValue: (s) => s.title,
      render: (s) => <span className="font-medium text-zinc-100">{s.title}</span>,
    },
    {
      key: "status",
      header: "Status",
      filterType: "select",
      sortValue: (s) => s.status,
      filterValue: (s) => (s.status === "published" ? "Published" : "Draft"),
      render: (s) => <StatusPill status={s.status} />,
    },
  ];

  if (specific) {
    columns.push(
      {
        key: "price",
        header: `Price (${specific.currency})`,
        align: "right",
        filterType: "number",
        sortValue: (s) => effectivePrice(s.prices?.[specific.code])?.effective ?? -1,
        render: (s) => {
          const eff = effectivePrice(s.prices?.[specific.code]);
          if (!eff) return <span className="text-amber-400/80">—</span>;
          return (
            <span className="tabular-nums text-zinc-200">
              {formatMoney(eff.effective, specific.currency)}
              {eff.discountPrice != null && (
                <span className="ml-1 text-[11px] text-zinc-500 line-through">
                  {formatMoney(eff.price, specific.currency)}
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: "pstatus",
        header: "Pricing",
        filterType: "select",
        sortValue: (s) => priceStatusLabel(s.prices?.[specific.code], s.status === "published"),
        filterValue: (s) => priceStatusLabel(s.prices?.[specific.code], s.status === "published"),
        render: (s) => (
          <PriceStatusPill
            eff={effectivePrice(s.prices?.[specific.code])}
            published={s.status === "published"}
          />
        ),
      }
    );
  } else {
    columns.push({
      key: "priced",
      header: isAdmin ? "Priced markets" : "Pricing",
      align: "right",
      filterType: "number",
      sortValue: (s) => countPriced(s),
      render: (s) => {
        const n = countPriced(s);
        const total = myCountries.length;
        if (n === 0) return <span className="text-amber-400/80">Waiting</span>;
        return (
          <span className="tabular-nums text-zinc-300">
            {n}/{total} priced
          </span>
        );
      },
    });
  }

  return (
    <>
      <PageHeader
        title="Pricing"
        subtitle={
          specific
            ? `Editing ${specific.flag} ${specific.name} (${specific.currency}). Open a story to set its price.`
            : "Open a story to set its price per country."
        }
      />
      {rows.length === 0 ? (
        <EmptyTable text="No stories yet. Create a story first, then price it here." />
      ) : (
        <DataTable
          storageKey="pricing"
          columns={columns}
          data={rows}
          rowKey={(s) => s.id}
          onRowClick={(s) => onOpen(s.id)}
        />
      )}
    </>
  );
}

// One country's editable price card (regular + discounted), with a live tax/total
// preview and per-country save.
function PricingCountryEditor({ row, rec, onSave, onError }) {
  const entry = row.prices?.[rec.code];
  const init = rawPriceFields(entry);
  const [price, setPrice] = useState(init.price);
  const [discount, setDiscount] = useState(init.discount);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const f = rawPriceFields(entry);
    setPrice(f.price);
    setDiscount(f.discount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, rec.code, JSON.stringify(entry)]);

  const step = 1 / 10 ** currencyDecimals(rec.currency);
  const priceNum = Number(price);
  const discNum = Number(discount);
  const hasPrice = price !== "" && Number.isFinite(priceNum) && priceNum > 0;
  const hasDiscount = discount !== "" && Number.isFinite(discNum) && discNum > 0;
  const badDiscount = hasDiscount && (!hasPrice || discNum >= priceNum);

  const eff = effectivePrice(
    hasPrice ? { price: priceNum, discountPrice: hasDiscount ? discNum : null } : null
  );
  const preview = eff ? computeOrderPricing(eff.effective, rec) : null;
  const dirty = price !== init.price || discount !== init.discount;

  async function save() {
    if (badDiscount) return;
    setSaving(true);
    try {
      await onSave(row.id, {
        country: rec.code,
        price: hasPrice ? priceNum : "",
        discountPrice: hasDiscount ? discNum : "",
      });
    } catch (e) {
      onError?.(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-100">
          {rec.flag} {rec.name}
        </span>
        <PriceStatusPill eff={effectivePrice(entry)} published={row.status === "published"} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-zinc-500">
            Price ({rec.currency})
          </span>
          <input
            type="number"
            min="0"
            step={step}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0"
            className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm tabular-nums focus:border-[var(--color-accent)] focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-zinc-500">
            Discounted
          </span>
          <input
            type="number"
            min="0"
            step={step}
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            placeholder="—"
            className={`w-32 rounded-md border bg-[var(--color-panel)] px-3 py-2 text-sm tabular-nums focus:outline-none ${
              badDiscount
                ? "border-rose-500/60 focus:border-rose-500"
                : "border-[var(--color-border)] focus:border-[var(--color-accent)]"
            }`}
          />
        </label>
        <button
          onClick={save}
          disabled={!dirty || saving || badDiscount}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {preview && preview.taxEnabled && (
        <p className="mt-2 text-[11px] text-zinc-500">
          {preview.taxInclusive ? "incl." : "+"} {preview.taxLabel} {preview.taxRate}% →{" "}
          {formatMoney(preview.total, rec.currency)} total
          {eff.discountPrice != null && (
            <span className="ml-1 line-through">{formatMoney(eff.price, rec.currency)}</span>
          )}
        </p>
      )}
      {badDiscount && (
        <p className="mt-2 text-[11px] text-rose-400">
          Discounted price must be below the regular price.
        </p>
      )}
    </div>
  );
}

// Price detail for one story. Admins edit every market; members only see + edit
// the countries they're assigned to ("based on the country he is in").
function PricingDetail({ row, countries = [], myCountries = [], isAdmin, onBack, onSave, onError }) {
  if (!row) {
    return (
      <>
        <BackButton onClick={onBack} />
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-8 text-center text-sm text-zinc-500">
          This story is no longer available.
        </div>
      </>
    );
  }

  // Admins price every enabled market; members are scoped to their own.
  const editable = isAdmin ? enabledCountries(countries) : myCountries;

  return (
    <>
      <BackButton onClick={onBack} />
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-zinc-100">{row.title}</h1>
          <StatusPill status={row.status} />
        </div>
        <p className="mt-1 text-sm text-zinc-400">
          {isAdmin
            ? "Set the price (and optional discounted price) for each market. "
            : "Set the price (and optional discounted price) for your market. "}
          A market with no price is{" "}
          <span className="text-amber-300">waiting for price</span> and won't go live there.
        </p>
      </header>

      {editable.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-8 text-center text-sm text-zinc-500">
          No countries assigned to you. Ask an admin to grant a market in Access.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {editable.map((rec) => (
            <PricingCountryEditor
              key={rec.code}
              row={row}
              rec={rec}
              onSave={onSave}
              onError={onError}
            />
          ))}
        </div>
      )}
    </>
  );
}

// The story's cast: the children it features. One character by default; add more
// for multi-kid stories, then pin each to a face slot per scene in the editor.
const GENDER_OPTS = [
  { id: "female", label: "Girl" },
  { id: "male", label: "Boy" },
  { id: "non-binary", label: "Child" },
];

function CastEditor({ characters = [], onSave }) {
  const [draft, setDraft] = useState(characters);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(characters);
  }, [JSON.stringify(characters)]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(characters);
  const multi = draft.length > 1;

  function patch(i, p) {
    setDraft((d) => d.map((c, idx) => (idx === i ? { ...c, ...p } : c)));
  }
  function add() {
    setDraft((d) => [
      ...d,
      { id: `new-${nid()}`, key: `child${d.length + 1}`, label: `Child ${d.length + 1}`, gender: "female" },
    ]);
  }
  function remove(i) {
    setDraft((d) => d.filter((_, idx) => idx !== i));
  }
  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          Cast {multi ? `· ${draft.length} children` : ""}
        </span>
        <button
          type="button"
          onClick={add}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-[#242838]"
        >
          + Add child
        </button>
      </div>
      <div className="space-y-2">
        {draft.map((c, i) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2">
            {multi && (
              <input
                value={c.label}
                onChange={(e) => patch(i, { label: e.target.value })}
                placeholder={`Child ${i + 1}`}
                className="w-40 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
              />
            )}
            <div className="flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-1">
              {GENDER_OPTS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => patch(i, { gender: g.id })}
                  className={`rounded px-3 py-1 text-xs font-medium transition ${
                    (c.gender || "female") === g.id
                      ? "bg-[var(--color-accent)] text-black"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
            {multi && (
              <button
                type="button"
                onClick={() => remove(i)}
                title="Remove child"
                className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs text-zinc-500 hover:bg-rose-600/20 hover:text-rose-200"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      {dirty && (
        <div className="mt-3">
          <button
            onClick={save}
            disabled={saving || draft.length === 0}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save cast"}
          </button>
        </div>
      )}
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
  onSaveCharacters,
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
  saveState = "idle",
  livePing = 0,
}) {
  // Each story holds two independent books — English and Arabic. The tab below
  // scopes the Book layout to the active language; every cell is tagged with
  // `lang` and only the active language's pages are shown/edited here.
  const [bookLang, setBookLang] = useState("en");
  const [publishing, setPublishing] = useState(false);
  const [copyingLang, setCopyingLang] = useState(false);
  const [printCells, setPrintCells] = useState(null);
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
        <SaveIndicator saveState={saveState} livePing={livePing} />
      </PageHeader>
      <CastEditor
        characters={story.characters || []}
        onSave={onSaveCharacters}
        onSaveGender={onSaveGender}
      />
      {(() => {
        const chars = story.characters || [];
        if (chars.length <= 1) return null;
        const warns = [];
        const slotCharIds = new Set();
        (story.scenes || []).forEach((sc) =>
          (sc.kidSlots || []).forEach((k) => k.characterId && slotCharIds.add(k.characterId))
        );
        const validIds = new Set(chars.map((c) => c.id));
        chars.forEach((c) => {
          if (!slotCharIds.has(c.id)) warns.push(`“${c.label}” has no face slot on any page.`);
        });
        (story.scenes || []).forEach((sc, i) =>
          (sc.kidSlots || []).forEach((k) => {
            if (!k.characterId || !validIds.has(k.characterId))
              warns.push(`A face slot on page ${i + 1} isn't assigned to a child.`);
          })
        );
        if (!warns.length) return null;
        return (
          <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-200">
            <div className="mb-1 font-semibold">Cast setup needs attention</div>
            <ul className="list-inside list-disc space-y-0.5">
              {warns.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        );
      })()}
      <Section step="" title="Book layout">
        <BookPrint cells={printCells} onDone={() => setPrintCells(null)} />
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
            + Add page
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
          {langCells.length > 0 && (
            <button
              onClick={() => setPrintCells(langCells)}
              disabled={!!printCells}
              title="Export this book to a print-ready PDF (one A3 landscape page per sheet)"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
            >
              {printCells ? "Preparing…" : "⬇ Export PDF (A3)"}
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
  // Every page is the printing press's Page Area sheet (10629.9 × 7559.1 px).
  const ratio = PAGE_AREA_RATIO_CSS;

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

  // Explicit reorder via the up/down buttons (dir = -1 up, +1 down).
  function moveBy(id, dir) {
    const ids = cells.map((s) => s.id);
    const from = ids.indexOf(id);
    const to = from + dir;
    if (from === -1 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
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

  // Each page IS one printed sheet — two book pages the press prints together
  // (left + right halves). The first sheet is the cover wrap.
  return (
    <div className="space-y-4">
      {cells.map((cell, i) => {
        return (
          <Cell
            key={cell.id}
            cell={cell}
            ratio={ratio}
            label={`Page ${i + 1}`}
            variables={variables}
            busy={!!cellBusy[cell.id]}
            canMoveUp={i > 0}
            canMoveDown={i < cells.length - 1}
            onMoveUp={() => moveBy(cell.id, -1)}
            onMoveDown={() => moveBy(cell.id, 1)}
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

// ── Custom (user-uploaded) fonts ─────────────────────────────────────────────
// Persisted in localStorage as { id, label, script, dataUrl } and registered
// with the browser via the FontFace API so they render anywhere fontStack() is
// used. The id doubles as the CSS font-family name.
const CUSTOM_FONTS_KEY = "hazawy.customFonts";

function readCustomFontsFromStorage() {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_FONTS_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// In-memory cache so fontStack() (called on every text render) stays cheap.
let customFontCache = readCustomFontsFromStorage();
function getCustomFonts() {
  return customFontCache;
}

const registeredFontIds = new Set();
function registerCustomFont(f) {
  if (!f || !f.dataUrl || registeredFontIds.has(f.id) || typeof FontFace === "undefined") return;
  registeredFontIds.add(f.id);
  try {
    const face = new FontFace(f.id, `url(${f.dataUrl})`);
    face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
  } catch {
    /* ignore unsupported font files */
  }
}

// Register everything we already have on first load.
customFontCache.forEach(registerCustomFont);

function persistCustomFonts(list) {
  customFontCache = list;
  try {
    localStorage.setItem(CUSTOM_FONTS_KEY, JSON.stringify(list));
  } catch {
    /* storage may be full / unavailable */
  }
  window.dispatchEvent(new Event("hazawy:customfonts"));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Read a font file, persist it for later use, and register it for rendering.
async function addCustomFont(file, script) {
  const dataUrl = await fileToDataUrl(file);
  const label = file.name.replace(/\.(ttf|otf|woff2?|woff)$/i, "").trim() || "Custom font";
  const id = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const font = { id, label, script: script === "arabic" ? "arabic" : "latin", dataUrl, custom: true };
  registerCustomFont(font);
  persistCustomFonts([...getCustomFonts(), font]);
  return font;
}

function removeCustomFont(id) {
  persistCustomFonts(getCustomFonts().filter((f) => f.id !== id));
}

// React binding: re-render consumers when the custom-font list changes.
function useCustomFonts() {
  const [fonts, setFonts] = useState(getCustomFonts);
  useEffect(() => {
    const sync = () => setFonts(getCustomFonts());
    window.addEventListener("hazawy:customfonts", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("hazawy:customfonts", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return fonts;
}

// Whether a font belongs to the active language tab. "both" fonts show in either.
function fontMatchesLang(f, isArabic) {
  if (f.script === "both") return true;
  return isArabic ? f.script === "arabic" : f.script !== "arabic";
}

function fontStack(id) {
  if (FONT_MAP[id]) return FONT_MAP[id].stack;
  const custom = getCustomFonts().find((f) => f.id === id);
  if (custom) return `'${id}', ${custom.script === "arabic" ? "'Cairo', sans-serif" : "sans-serif"}`;
  return FONT_MAP.sans.stack;
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

// Apply {{tokens}} → values for read-only rendering (orders).
// `names` (optional) maps a character key -> { name, nameAr } for the
// {{name:<key>}} / {{nameAr:<key>}} tokens; `names.__primary__` lets the legacy
// {{Child_Name}} fall back to the primary child's name. Mirrors server applyVars.
function applyVarsClient(text, values, names) {
  if (!text) return "";
  let out = text;
  if (names) {
    out = out.replace(/\{\{\s*(name|nameAr)\s*:\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, kind, key) => {
      const rec = names[key];
      const v = rec && (kind === "nameAr" ? rec.nameAr : rec.name);
      return v != null && v !== "" ? v : m;
    });
  }
  out = out.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name) => {
    let v = values && values[name];
    if ((v == null || v === "") && name === "Child_Name" && names?.__primary__) v = names.__primary__.name;
    return v != null && v !== "" ? v : m;
  });
  return out;
}

// Build the per-character name map an order needs for applyVarsClient.
function orderNameMap(order) {
  const names = {};
  const chars = order?.characters || [];
  for (const c of chars) {
    const k = order?.kids?.[c.id] || (c.id === chars[0]?.id ? order?.kid : null);
    names[c.key] = { name: k?.name || "", nameAr: k?.nameAr || "" };
  }
  names.__primary__ = chars[0] ? names[chars[0].key] : null;
  return names;
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

// ── Per-side design model ────────────────────────────────────────────────────
// Each page (sheet) holds two independent designs — a LEFT and a RIGHT side —
// the press prints together. Each side owns its own background, content, kid
// slots, safe zones and AI prompt: one square Design Area apiece.
const DEFAULT_SIDE_BG = "#faf7ef";

function emptySide() {
  return {
    elements: [],
    bgUrl: null,
    bgFalUrl: null,
    bgColor: DEFAULT_SIDE_BG,
    bgBlur: 0,
    kidSlots: [],
    safeZones: [],
    aiPrompt: "",
  };
}

// Pull a legacy single-design cell into one side object. cellLayers() also
// covers legacy image/text cells (not yet migrated to elements).
function legacyToSide(cell) {
  return {
    elements: cellLayers(cell),
    bgUrl: cell?.bgUrl || null,
    bgFalUrl: cell?.bgFalUrl || null,
    bgColor: cell?.bgColor || DEFAULT_SIDE_BG,
    bgBlur: cell?.bgBlur || 0,
    kidSlots: Array.isArray(cell?.kidSlots) ? cell.kidSlots : [],
    safeZones: Array.isArray(cell?.safeZones) ? cell.safeZones : [],
    aiPrompt: cell?.aiPrompt || "",
  };
}

// Normalize a cell into { left, right } sides, migrating legacy single-design
// cells: the old whole-cell design becomes the RIGHT side (front cover / right
// page), and the LEFT side starts empty.
function getSides(cell) {
  if (cell?.sides && cell.sides.left && cell.sides.right) {
    return {
      left: { ...emptySide(), ...cell.sides.left },
      right: { ...emptySide(), ...cell.sides.right },
    };
  }
  const hasLegacy =
    cellLayers(cell).length > 0 ||
    !!cell?.bgUrl ||
    (typeof cell?.bgColor === "string" && cell.bgColor !== DEFAULT_SIDE_BG);
  return { left: emptySide(), right: hasLegacy ? legacyToSide(cell) : emptySide() };
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

// CSS box for a print-spec rectangle (percent of the Page Area canvas).
function rectStyle(r, extra) {
  return {
    position: "absolute",
    left: `${r.leftPct}%`,
    top: `${r.topPct}%`,
    width: `${r.widthPct}%`,
    height: `${r.heightPct}%`,
    ...extra,
  };
}

// Visual guides for the printing-press geometry, nested on the Page Area canvas:
//   • Print Size — the inked region, split into a left/right half. Each half can
//     hold a color or a stretched image (tinted here so it's visible).
//   • Design Area — the two safe 4962.5² squares, side by side (bold borders).
// Pointer-events-none and editor-only: never part of the printed output.
function PrintSpecGuides({ solid = false }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[6000]" aria-hidden>
      {/* Page Area — the full sheet (this whole canvas). Only filled in `solid`
          mode; otherwise outline-only so the design shows through. */}
      <div
        className="absolute inset-0"
        style={{ background: solid ? "#ffffff" : undefined, outline: "2px solid rgba(255,255,255,0.7)" }}
      >
        <span className="absolute bottom-1 right-1 bg-white px-1 text-[9px] font-semibold text-black">
          Page area
        </span>
      </div>
      {/* Print Size halves — the color / stretched-image region. */}
      <div
        style={rectStyle(PRINT_LEFT_RECT, {
          background: solid ? "rgba(132,204,22,0.16)" : undefined,
          outline: "1px dashed rgba(132,204,22,0.8)",
        })}
      />
      <div
        style={rectStyle(PRINT_RIGHT_RECT, {
          background: solid ? "rgba(236,72,153,0.16)" : undefined,
          outline: "1px dashed rgba(236,72,153,0.8)",
        })}
      />
      {/* Print Size outer outline. */}
      <div style={rectStyle(PRINT_SIZE_RECT, { outline: "2px solid rgba(255,255,255,0.55)" })}>
        <span className="absolute left-0 top-0 -translate-y-full bg-black/70 px-1 text-[9px] font-medium text-white">
          Print size
        </span>
      </div>
      {/* Design Area squares — the safe content region. */}
      <div style={rectStyle(DESIGN_LEFT_RECT, { border: "3px solid #84cc16" })}>
        <span className="absolute left-1 top-1 bg-[#84cc16] px-1 text-[9px] font-semibold text-black">
          Design L
        </span>
      </div>
      <div style={rectStyle(DESIGN_RIGHT_RECT, { border: "3px solid #ec4899" })}>
        <span className="absolute left-1 top-1 bg-[#ec4899] px-1 text-[9px] font-semibold text-white">
          Design R
        </span>
      </div>
      <CutLines />
    </div>
  );
}

// Dashed CUT lines: they run edge-to-edge across the whole sheet, aligned to the
// Design-Area (trim) edges, so the press knows exactly where to cut. The final
// pages are the Design squares; everything outside is bleed that gets trimmed.
// `print` mode uses solid dark dashes (visible on paper) and drops the label.
function CutLines({ print = false }) {
  // Trim edges as % of the Page Area, taken straight from the design rects.
  const designTop = DESIGN_LEFT_RECT.topPct;
  const designBottom = DESIGN_LEFT_RECT.topPct + DESIGN_LEFT_RECT.heightPct;
  const ys = [designTop, designBottom];
  // Only the two OUTER vertical cuts run the full height.
  const xs = [
    DESIGN_LEFT_RECT.leftPct,
    DESIGN_RIGHT_RECT.leftPct + DESIGN_RIGHT_RECT.widthPct,
  ];
  // The two INNER edges (the center gutter / fold) are marked ONLY in the white
  // margins above and below the pages — never across the artwork.
  const innerXs = [
    DESIGN_LEFT_RECT.leftPct + DESIGN_LEFT_RECT.widthPct,
    DESIGN_RIGHT_RECT.leftPct,
  ];
  const stroke = print ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.95)";
  const glow = print ? undefined : "drop-shadow(0 0 1px rgba(0,0,0,0.9))";
  return (
    <div className="pointer-events-none absolute inset-0 z-[6100]" aria-hidden>
      {ys.map((y, i) => (
        <div
          key={`h${i}`}
          className="absolute left-0 right-0"
          style={{ top: `${y}%`, height: 0, borderTop: `1px dashed ${stroke}`, filter: glow }}
        />
      ))}
      {xs.map((x, i) => (
        <div
          key={`v${i}`}
          className="absolute top-0 bottom-0"
          style={{ left: `${x}%`, width: 0, borderLeft: `1px dashed ${stroke}`, filter: glow }}
        />
      ))}
      {innerXs.map((x, i) => (
        <div key={`c${i}`}>
          {/* top margin segment */}
          <div
            className="absolute"
            style={{ left: `${x}%`, top: 0, height: `${designTop}%`, width: 0, borderLeft: `1px dashed ${stroke}`, filter: glow }}
          />
          {/* bottom margin segment */}
          <div
            className="absolute"
            style={{ left: `${x}%`, top: `${designBottom}%`, height: `${100 - designBottom}%`, width: 0, borderLeft: `1px dashed ${stroke}`, filter: glow }}
          />
        </div>
      ))}
      {!print && (
        <span className="absolute right-1 top-1 rounded bg-black/70 px-1 text-[9px] font-semibold text-white">
          ✂ Cut lines
        </span>
      )}
    </div>
  );
}

// Positioned layers (image / svg / text) for a page or a side. Container-query
// units (cqh) make text scale with whatever size the stack is shown at, so the
// parent must set `containerType: size`.
function LayerStack({ layers, resolve, aiResultUrl }) {
  const r = (text) => (resolve ? resolve(text) : text);
  return layers.map((el) => {
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
  });
}

// One side of a sheet, composited onto the Page Area:
//   • background (color / stretched image) fills the PRINT-half rect — this is
//     the auto-bleed: the background extends past the Design square.
//   • content (elements) is clipped to the DESIGN square rect.
function SideLayer({ side, printRect, designRect, resolve, aiResultUrl }) {
  if (!side) return null;
  const layers = Array.isArray(side.elements) ? side.elements : [];
  return (
    <>
      <div
        style={rectStyle(printRect, {
          background: side.bgColor || undefined,
          overflow: "hidden",
          containerType: "size",
        })}
      >
        {side.bgUrl && (
          <img
            src={side.bgUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={
              side.bgBlur
                ? { filter: `blur(${side.bgBlur}cqw)`, transform: "scale(1.08)" }
                : undefined
            }
          />
        )}
      </div>
      <div style={rectStyle(designRect, { overflow: "hidden", containerType: "size" })}>
        <LayerStack layers={layers} resolve={resolve} aiResultUrl={aiResultUrl} />
      </div>
    </>
  );
}

// Read-only render of a full sheet: the Page Area with both independent sides
// (left + right) composited at the press's exact geometry.
function SheetCanvas({ cell, resolve, results, spreadGuide = false, cutLines = false, className = "" }) {
  const sides = getSides(cell);
  return (
    <div
      className={`relative isolate overflow-hidden bg-white ${className}`}
      style={{ aspectRatio: PAGE_AREA_RATIO_CSS, containerType: "size" }}
    >
      <SideLayer
        side={sides.left}
        printRect={PRINT_LEFT_RECT}
        designRect={DESIGN_LEFT_RECT}
        resolve={resolve}
        aiResultUrl={results?.[`${cell.id}:left`]?.url}
      />
      <SideLayer
        side={sides.right}
        printRect={PRINT_RIGHT_RECT}
        designRect={DESIGN_RIGHT_RECT}
        resolve={resolve}
        aiResultUrl={results?.[`${cell.id}:right`]?.url}
      />
      {spreadGuide && <PrintSpecGuides />}
      {cutLines && <CutLines print />}
    </div>
  );
}

// Export the book to PDF: one A3 landscape page per sheet. Rendered into a
// body-level portal so the print stylesheet (index.css) can hide the app and
// print only these sheets. Set `cells` to trigger a print; `onDone` clears it.
function BookPrint({ cells, resolve, onDone }) {
  const ref = useRef(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!cells || !cells.length) return;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("afterprint", finish);
      doneRef.current?.();
    };
    const node = ref.current;
    const imgs = node ? Array.from(node.querySelectorAll("img")) : [];
    const waitImg = (im) =>
      im.complete
        ? Promise.resolve()
        : new Promise((r) => {
            im.onload = r;
            im.onerror = r;
          });
    Promise.all(imgs.map(waitImg)).then(() => {
      // Give the browser a beat to lay out fonts and container-query sizes.
      setTimeout(() => {
        window.addEventListener("afterprint", finish);
        window.print();
        // Safety net if afterprint never fires (varies by browser).
        setTimeout(finish, 1500);
      }, 250);
    });
  }, [cells]);

  if (!cells || !cells.length) return null;
  return createPortal(
    <div id="book-print-root" ref={ref} aria-hidden>
      {cells.map((cell) => (
        <div className="book-print-page" key={cell.id}>
          <SheetCanvas cell={cell} resolve={resolve} cutLines className="book-print-sheet" />
        </div>
      ))}
    </div>,
    document.body
  );
}

// Read-only render of a page: background + positioned layers. Container-query
// units (cqh) make text scale with whatever size the page is shown at.
function CellCanvas({ cell, ratio, resolve, aiResultUrl, className = "", spreadGuide = false }) {
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
      {/* Print Size + Design Area guides (Page Area is the canvas itself). */}
      {spreadGuide && <PrintSpecGuides />}
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
function CellEditor({ cell, label, aspect, side = "right", onSwitchSide, variables, characters = [], customSymbols = [], onSaveSymbol, onDeleteSymbol, onClose, onSave, onUploadMedia }) {
  const [elements, setElements] = useState(() =>
    cellLayers(cell).map((el) => ({
      ...el,
      id: el.id?.startsWith("el_") ? el.id : nid(),
      ...(el.html ? { html: sanitizeTextHtml(el.html) } : {}),
    }))
  );
  const [bgUrl, setBgUrl] = useState(cell.bgUrl || null);
  const [bgFalUrl, setBgFalUrl] = useState(cell.bgFalUrl || null);
  // Background-image blur, in cqw (% of the print-half width) so it looks the
  // same in the editor and the book preview regardless of render size.
  const [bgBlur, setBgBlur] = useState(cell.bgBlur || 0);
  // null = no background color (transparent). Distinguish it from "unset".
  const [bgColor, setBgColor] = useState(cell.bgColor === null ? null : cell.bgColor || "#faf7ef");
  // Per-page generation prompt (used only when the page has an AI image).
  const [aiPrompt, setAiPrompt] = useState(cell.aiPrompt || "");
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const [snapLines, setSnapLines] = useState({ v: false, h: false });
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [symbolPicker, setSymbolPicker] = useState(false);
  const [bgMenuOpen, setBgMenuOpen] = useState(false);
  const [zones, setZones] = useState(() => (Array.isArray(cell.safeZones) ? cell.safeZones : []));
  const [selectedZoneId, setSelectedZoneId] = useState(null);
  // Kid slots: face regions pinned to cast characters, used for composite-per-face
  // generation. Each is { id, xPct, yPct, wPct, hPct, characterId, label }.
  const [kidSlots, setKidSlots] = useState(() => (Array.isArray(cell.kidSlots) ? cell.kidSlots : []));
  const [selectedSlotId, setSelectedSlotId] = useState(null);
  // The book this page belongs to scopes which fonts are offered: the English
  // tab shows Latin fonts, the Arabic tab shows Arabic fonts.
  const isArabic = (cell.lang || "en") === "ar";
  const customFonts = useCustomFonts();
  const langFonts = FONTS.filter((f) => fontMatchesLang(f, isArabic));
  const langCustomFonts = customFonts.filter((f) => fontMatchesLang(f, isArabic));

  const canvasRef = useRef(null);
  const areaRef = useRef(null);
  const dragRef = useRef(null);
  const imgInputRef = useRef(null);
  const svgInputRef = useRef(null);
  const fontInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const bgImgInputRef = useRef(null);
  // Live contentEditable node + last selection range, for rich-text coloring.
  const editRef = useRef(null);
  const savedRange = useRef(null);
  // Color of the current text selection, shown in the color picker while editing.
  const [selectionColor, setSelectionColor] = useState(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  // True while a file is being dragged over the canvas, for the drop highlight.
  const [dropActive, setDropActive] = useState(false);

  // The editing canvas is one full Print-half so the BLEED is visible while you
  // design. The Design square is inset inside it; the margin around the square is
  // the bleed (it gets trimmed off). Background fills the whole half (bleeds);
  // content lives inside the inset square.
  const [rw, rh] = PRINT_HALF_RATIO_CSS.split(" / ").map(Number);
  const designInHalf = side === "left" ? DESIGN_IN_HALF_LEFT : DESIGN_IN_HALF_RIGHT;

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
      if (d.target === "kidslot") {
        setKidSlots((ks) => ks.map((k) => (k.id === d.id ? { ...k, ...dragGeom(k, d, dxPct, dyPct) } : k)));
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
      if (selectedSlotId) {
        e.preventDefault();
        removeKidSlot(selectedSlotId);
      } else if (selectedZoneId) {
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
  }, [editingId, selectedZoneId, selectedSlotId, selectedIds, zones]);

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

  // Kid slots mirror safe-zone mechanics but bind to a cast character and feed
  // composite-per-face generation. New slots default to the first unassigned
  // character (or the first character) so a single-kid story stays trivial.
  function addKidSlot() {
    const taken = new Set(kidSlots.map((k) => k.characterId));
    const free = (characters || []).find((c) => !taken.has(c.id)) || characters?.[0] || null;
    const k = {
      id: nid(),
      xPct: 34,
      yPct: 22,
      wPct: 32,
      hPct: 32,
      characterId: free?.id || null,
      label: free?.label || "Kid",
    };
    setKidSlots((a) => [...a, k]);
    setSelectedSlotId(k.id);
    setSelectedZoneId(null);
    setSelectedIds([]);
    setEditingId(null);
  }
  function removeKidSlot(id) {
    setKidSlots((a) => a.filter((k) => k.id !== id));
    setSelectedSlotId((s) => (s === id ? null : s));
  }
  function setKidSlotCharacter(id, characterId) {
    const ch = (characters || []).find((c) => c.id === characterId) || null;
    setKidSlots((a) =>
      a.map((k) => (k.id === id ? { ...k, characterId, label: ch?.label || k.label } : k))
    );
  }
  function startMoveSlot(e, k) {
    e.stopPropagation();
    setSelectedSlotId(k.id);
    setSelectedZoneId(null);
    setSelectedIds([]);
    setEditingId(null);
    const rect = canvasRef.current.getBoundingClientRect();
    dragRef.current = { target: "kidslot", mode: "move", id: k.id, startX: e.clientX, startY: e.clientY, ox: k.xPct, oy: k.yPct, ow: k.wPct, oh: k.hPct, rectW: rect.width, rectH: rect.height };
  }
  function startResizeSlot(e, k, corner) {
    e.stopPropagation();
    setSelectedSlotId(k.id);
    const rect = canvasRef.current.getBoundingClientRect();
    dragRef.current = { target: "kidslot", mode: "resize", corner, id: k.id, startX: e.clientX, startY: e.clientY, ox: k.xPct, oy: k.yPct, ow: k.wPct, oh: k.hPct, rectW: rect.width, rectH: rect.height };
  }

  const maxZ = () => elements.reduce((m, el) => Math.max(m, el.z || 1), 0);
  const minZ = () => elements.reduce((m, el) => Math.min(m, el.z || 1), 99);

  function addText() {
    const el = newTextElement();
    el.z = maxZ() + 1;
    // Default to a script-appropriate font for the active book.
    el.font = isArabic ? "cairo" : "sans";
    setElements((e) => [...e, el]);
    setSelectedIds([el.id]);
  }

  // Upload a custom font file, tag it for the active language tab, and apply it
  // to the current selection. It is saved for reuse across sessions.
  async function handleFontUpload(file) {
    if (!file) return;
    try {
      const font = await addCustomFont(file, isArabic ? "arabic" : "latin");
      patchSel({ font: font.id });
    } catch {
      /* ignore invalid font files */
    }
  }
  // `at` (optional) centers the new image on a drop point, given as { xPct, yPct }.
  async function addImageFile(file, at) {
    if (!file) return;
    setBusy(true);
    try {
      const { url, falUrl } = await onUploadMedia(file);
      const el = newImageElement(url, falUrl);
      el.z = maxZ() + 1;
      if (at) {
        el.xPct = clamp(at.xPct - el.wPct / 2, 0, 100 - el.wPct);
        el.yPct = clamp(at.yPct - el.hPct / 2, 0, 100 - el.hPct);
      }
      setElements((e) => [...e, el]);
      setSelectedIds([el.id]);
    } finally {
      setBusy(false);
    }
  }

  // Set the side BACKGROUND to an uploaded image. The background fills the
  // whole Print-half (including the bleed past the Design square), so this is
  // how you make the bleed an image rather than a flat color.
  async function setBackgroundImageFile(file) {
    if (!file) return;
    setBusy(true);
    try {
      const { url, falUrl } = await onUploadMedia(file);
      setBgUrl(url);
      setBgFalUrl(falUrl || null);
    } finally {
      setBusy(false);
    }
  }

  // Drop image files from the OS straight onto the canvas at the cursor.
  async function handleCanvasDrop(e) {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (!files.length) return;
    e.preventDefault();
    setDropActive(false);
    const rect = canvasRef.current?.getBoundingClientRect();
    const xPct = rect ? clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100) : 50;
    const yPct = rect ? clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100) : 50;
    // Add sequentially so each image stacks on top with a fresh z and a small
    // offset, instead of landing exactly on top of the previous one.
    for (let i = 0; i < files.length; i++) {
      await addImageFile(files[i], {
        xPct: clamp(xPct + i * 4, 0, 100),
        yPct: clamp(yPct + i * 4, 0, 100),
      });
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
  function insertToken(token) {
    if (!selected || selected.type !== "text") return;
    patchSel({ text: `${selected.text || ""}${token}`, html: null });
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

  function currentDesign() {
    return { elements, bgUrl, bgFalUrl, bgColor, bgBlur, safeZones: zones, kidSlots, aiPrompt };
  }

  function save() {
    onSave(cell.id, currentDesign());
    onClose();
  }

  // Save the current side's work, then switch the editor to the other side.
  function switchTo(target) {
    if (!onSwitchSide || target === side) return;
    onSwitchSide(target, currentDesign());
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
          {/* Side switcher: design the left and right pages independently. */}
          <div className="flex overflow-hidden rounded-md border border-[var(--color-border)] text-[11px] font-medium">
            <button
              onClick={() => switchTo("left")}
              className={`px-2.5 py-1 ${side === "left" ? "bg-[var(--color-accent)] text-black" : "text-zinc-300 hover:bg-[#242838]"}`}
            >
              ◀ Left
            </button>
            <button
              onClick={() => switchTo("right")}
              className={`px-2.5 py-1 ${side === "right" ? "bg-[var(--color-accent)] text-black" : "text-zinc-300 hover:bg-[#242838]"}`}
            >
              Right ▶
            </button>
          </div>
          <span className="text-[11px] text-zinc-500">Dashed line = trim · dark margin = bleed</span>
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
          {characters.length > 1 && (
            <button
              onClick={addKidSlot}
              title="Pin a child to a face region for composite generation"
              className="rounded-md border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-400/20"
            >
              + Kid
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setBgMenuOpen((v) => !v)}
              title="Set this side's background (color or image). The background bleeds past the design square."
              className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838]"
            >
              Background
              <span
                className="h-5 w-7 shrink-0 overflow-hidden rounded border border-[var(--color-border)]"
                style={
                  bgUrl
                    ? undefined
                    : bgColor
                    ? { background: bgColor }
                    : {
                        backgroundImage:
                          "linear-gradient(45deg,#555 25%,transparent 25%),linear-gradient(-45deg,#555 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#555 75%),linear-gradient(-45deg,transparent 75%,#555 75%)",
                        backgroundSize: "8px 8px",
                        backgroundPosition: "0 0,0 4px,4px -4px,-4px 0",
                      }
                }
              >
                {bgUrl && <img src={bgUrl} alt="" className="h-full w-full object-cover" />}
              </span>
              <span className="text-zinc-500">▾</span>
            </button>
            {bgMenuOpen && (
              <>
                <div className="fixed inset-0 z-[6500]" onClick={() => setBgMenuOpen(false)} />
                <div className="absolute left-0 top-full z-[6501] mt-1 w-56 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-xl">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                    Color
                  </div>
                  <div className="mb-3 flex items-center gap-2">
                    <input
                      type="color"
                      value={bgColor || "#ffffff"}
                      onChange={(e) => setBgColor(e.target.value)}
                      className="h-7 w-9 cursor-pointer rounded border border-[var(--color-border)] bg-transparent p-0"
                    />
                    <button
                      onClick={() => setBgColor(null)}
                      className={`rounded-md border px-2.5 py-1 text-xs ${
                        bgColor
                          ? "border-[var(--color-border)] text-zinc-300 hover:bg-rose-600/20 hover:text-rose-200"
                          : "border-[var(--color-accent)] text-[var(--color-accent)]"
                      }`}
                    >
                      No color
                    </button>
                  </div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                    Image
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => bgImgInputRef.current?.click()}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1 text-xs font-medium hover:bg-[#242838]"
                    >
                      {bgUrl ? "Change image" : "Upload image"}
                    </button>
                    {bgUrl && (
                      <button
                        onClick={() => {
                          setBgUrl(null);
                          setBgFalUrl(null);
                        }}
                        className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {bgUrl && (
                    <div className="mt-3">
                      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                        <span>Blur</span>
                        <span className="font-mono text-zinc-500">{bgBlur.toFixed(1)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0}
                          max={8}
                          step={0.25}
                          value={bgBlur}
                          onChange={(e) => setBgBlur(Number(e.target.value))}
                          className="h-1 flex-1 cursor-pointer accent-[var(--color-accent)]"
                        />
                        {bgBlur > 0 && (
                          <button
                            onClick={() => setBgBlur(0)}
                            className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-[#242838]"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <p className="mt-2 text-[10px] leading-snug text-zinc-500">
                    The background fills the full print area and bleeds past the design square.
                  </p>
                </div>
              </>
            )}
          </div>
          <input
            ref={bgImgInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setBackgroundImageFile(f);
              e.target.value = "";
            }}
          />
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
          kidSlots={kidSlots}
          characters={characters}
          selectedSlotId={selectedSlotId}
          onSelectSlot={(id) => {
            setSelectedSlotId(id);
            setSelectedZoneId(null);
            setSelectedIds([]);
            setEditingId(null);
          }}
          onDeleteSlot={removeKidSlot}
          onSetSlotCharacter={setKidSlotCharacter}
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
              className="relative isolate overflow-hidden shadow-2xl shadow-black/50"
              style={{ width: cw, height: ch, background: bgColor, containerType: "size" }}
            >
              {/* Outer canvas = one full Print-half. The background (color or
                  image) fills it edge to edge and BLEEDS past the design square.
                  The dimmed margin around the square is what the press trims off. */}
              {bgUrl && (
                <img
                  src={bgUrl}
                  alt=""
                  className="absolute inset-0 z-0 h-full w-full object-cover"
                  style={
                    bgBlur
                      ? { filter: `blur(${bgBlur}cqw)`, transform: "scale(1.08)" }
                      : undefined
                  }
                />
              )}

              <span className="pointer-events-none absolute left-1 top-1 z-[6000] rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-amber-200">
                Bleed · trimmed off
              </span>

              {/* Inner canvas = the Design square (safe content area), inset at
                  its real position inside the print-half. Content lives here. */}
              <div
                ref={canvasRef}
                onPointerDown={() => {
                  setSelectedIds([]);
                  setEditingId(null);
                  setSelectedZoneId(null);
                  setSelectedSlotId(null);
                }}
                onDragOver={(e) => {
                  if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  if (!dropActive) setDropActive(true);
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget)) return;
                  setDropActive(false);
                }}
                onDrop={handleCanvasDrop}
                className="absolute"
                style={{
                  left: `${designInHalf.leftPct}%`,
                  top: `${designInHalf.topPct}%`,
                  width: `${designInHalf.widthPct}%`,
                  height: `${designInHalf.heightPct}%`,
                  containerType: "size",
                }}
              >
                {/* Trim line + dimmed bleed: the dashed box is the cut line;
                    everything outside it (darkened) bleeds and is trimmed. */}
                <div
                  className="pointer-events-none absolute inset-0 z-[5500] border border-dashed border-white/70"
                  style={{ boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)" }}
                />
                <span className="pointer-events-none absolute bottom-1 right-1 z-[6000] rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-white">
                  Design area · 4962.5²
                </span>

              {dropActive && (
                <div
                  className="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                  style={{ zIndex: 7000 }}
                >
                  <span className="rounded-md bg-black/70 px-3 py-1.5 text-sm font-medium text-zinc-100">
                    Drop image to add
                  </span>
                </div>
              )}

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

              {/* Kid slots: face regions bound to cast characters. Editor-only
                  guides that drive composite-per-face generation. */}
              {kidSlots.map((k) => {
                const sel = k.id === selectedSlotId;
                const ch = characters.find((c) => c.id === k.characterId) || null;
                return (
                  <div
                    key={k.id}
                    style={{
                      position: "absolute",
                      left: `${k.xPct}%`,
                      top: `${k.yPct}%`,
                      width: `${k.wPct}%`,
                      height: `${k.hPct}%`,
                      zIndex: 5001,
                    }}
                    className={`pointer-events-none border-2 ${
                      sel ? "border-cyan-300" : "border-cyan-400/60"
                    }`}
                  >
                    <span
                      onPointerDown={(e) => startMoveSlot(e, k)}
                      className="pointer-events-auto absolute left-0 top-0 flex max-w-full -translate-y-full cursor-move items-center gap-1 truncate bg-cyan-400 px-1 text-[9px] font-semibold text-black"
                    >
                      {ch?.label || "Unassigned"}
                    </span>
                    {characters.length > 1 && (
                      <select
                        value={k.characterId || ""}
                        onPointerDown={(e) => e.stopPropagation()}
                        onChange={(e) => setKidSlotCharacter(k.id, e.target.value)}
                        className="pointer-events-auto absolute bottom-0 left-0 max-w-full translate-y-full cursor-pointer rounded-b border border-cyan-400/50 bg-[var(--color-panel)] px-1 py-0.5 text-[9px] text-cyan-100 focus:outline-none"
                      >
                        <option value="">Unassigned</option>
                        {characters.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        removeKidSlot(k.id);
                      }}
                      title="Remove kid slot"
                      className="pointer-events-auto absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-cyan-400 text-[10px] font-bold text-black"
                    >
                      ×
                    </button>
                    {sel &&
                      ["nw", "ne", "sw", "se"].map((c) => (
                        <span
                          key={c}
                          onPointerDown={(e) => startResizeSlot(e, k, c)}
                          className={`pointer-events-auto absolute z-30 h-3 w-3 rounded-sm border border-white bg-cyan-400 ${handlePos[c]}`}
                        />
                      ))}
                  </div>
                );
              })}
              </div>
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
              <div className="flex flex-wrap items-center gap-1">
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
                  <optgroup label={isArabic ? "العربية / Arabic" : "English"}>
                    {langFonts.map((f) => (
                      <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                        {f.label}
                      </option>
                    ))}
                  </optgroup>
                  {langCustomFonts.length > 0 && (
                    <optgroup label={isArabic ? "خطوط مخصصة / Custom" : "Custom"}>
                      {langCustomFonts.map((f) => (
                        <option key={f.id} value={f.id} style={{ fontFamily: fontStack(f.id) }}>
                          {f.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {/* Keep a font picked for the other script selectable so the
                      value still renders correctly instead of going blank. */}
                  {selected.font &&
                    !langFonts.some((f) => f.id === selected.font) &&
                    !langCustomFonts.some((f) => f.id === selected.font) && (
                      <optgroup label="Current">
                        <option value={selected.font} style={{ fontFamily: fontStack(selected.font) }}>
                          {FONT_MAP[selected.font]?.label ||
                            customFonts.find((f) => f.id === selected.font)?.label ||
                            selected.font}
                        </option>
                      </optgroup>
                    )}
                </select>
                <input
                  ref={fontInputRef}
                  type="file"
                  accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
                  className="hidden"
                  onChange={(e) => {
                    handleFontUpload(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  title={isArabic ? "رفع خط مخصص" : "Upload a custom font"}
                  onClick={() => fontInputRef.current?.click()}
                  className="shrink-0 rounded bg-[var(--color-panel-2)] px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-[#242838]"
                >
                  + Font
                </button>
                {selected.font && customFonts.some((f) => f.id === selected.font) && (
                  <button
                    type="button"
                    title={isArabic ? "حذف الخط المخصص" : "Delete this custom font"}
                    onClick={() => {
                      removeCustomFont(selected.font);
                      patchSel({ font: isArabic ? "cairo" : "sans" });
                    }}
                    className="shrink-0 rounded bg-[var(--color-panel-2)] px-2 py-1 text-xs font-medium text-zinc-400 hover:bg-rose-600/20 hover:text-rose-200"
                  >
                    ✕
                  </button>
                )}
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
              {characters.length > 1 && (
                <div>
                  <PanelLabel>Insert child name</PanelLabel>
                  <div className="flex flex-wrap gap-1">
                    {characters.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => insertToken(`{{name:${c.key}}}`)}
                        title={`${c.label}'s name`}
                        className="rounded border border-cyan-400/40 bg-cyan-400/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200 hover:bg-cyan-400/20"
                      >
                        {`{{name:${c.key}}}`}
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
                    The primary description of what this page should show — it leads the generation
                    while the child's identity, hair and proportions stay locked. Saved with the page.
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

function LayersPanel({ elements, selectedIds, onSelect, onToggleLock, onReorder, onSetPlane, onDelete, zones = [], selectedZoneId, onSelectZone, onDeleteZone, onToggleZoneLock, kidSlots = [], characters = [], selectedSlotId, onSelectSlot, onDeleteSlot, bgUrl, onClearBg }) {
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
        {characters.length > 1 && (
          <div>
            <div className="flex items-center justify-between px-1 pb-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Kids</span>
              <span className="text-[9px] text-zinc-600">face slots</span>
            </div>
            {kidSlots.length === 0 ? (
              <p className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-2 text-[10px] leading-relaxed text-zinc-600">
                Pin each child to a face region. Add one with “+ Kid” in the toolbar.
              </p>
            ) : (
              <div className="space-y-1">
                {kidSlots.map((k, i) => {
                  const ch = characters.find((c) => c.id === k.characterId) || null;
                  return (
                    <div
                      key={k.id}
                      onPointerDown={() => onSelectSlot?.(k.id)}
                      className={`group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs ${
                        k.id === selectedSlotId
                          ? "bg-cyan-400/15 text-cyan-200"
                          : "text-zinc-300 hover:bg-[var(--color-panel-2)]"
                      }`}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-cyan-400/70 text-[9px] text-cyan-300/80">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{ch?.label || "Unassigned"}</span>
                      <button
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          onDeleteSlot?.(k.id);
                        }}
                        title="Delete kid slot"
                        className="rounded px-1 text-[11px] text-zinc-500 hover:text-rose-300"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
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
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
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
  const sides = getSides(cell);
  const sideHasContent = (s) =>
    (Array.isArray(s.elements) && s.elements.length > 0) ||
    !!s.bgUrl ||
    (typeof s.bgColor === "string" && s.bgColor !== DEFAULT_SIDE_BG);
  const isEmpty = !sideHasContent(sides.left) && !sideHasContent(sides.right);

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
      className={`${frame} bg-white cursor-grab active:cursor-grabbing`}
    >
      {/* Full sheet: both independent sides composited at the print geometry. */}
      <SheetCanvas cell={cell} className="w-full" spreadGuide />

      {/* One label for the whole sheet (page). */}
      {label && (
        <span className="absolute left-1 top-1 z-[6001] rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {label}
        </span>
      )}

      {isEmpty && (
        <div className="absolute inset-0 z-[6002] flex flex-col items-center justify-center gap-2 text-zinc-600">
          {busy ? (
            <Spinner />
          ) : (
            <button
              onClick={() => onOpenEditor(cell.id)}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-black"
            >
              Design page
            </button>
          )}
        </div>
      )}

      {busy && !isEmpty && (
        <div className="absolute inset-0 z-[6002] flex items-center justify-center bg-black/40">
          <Spinner />
        </div>
      )}

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
          className={`absolute bottom-1 left-1 z-[6002] cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-semibold outline-none ${scoringTagClass(
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
      <div className="absolute right-1 top-1 z-[6002] flex gap-1 opacity-0 transition group-hover:opacity-100">
        {onMoveUp && (
          <button
            onClick={onMoveUp}
            disabled={!canMoveUp}
            title="Move page up"
            className="flex h-6 w-6 items-center justify-center rounded bg-black/70 text-[11px] font-medium text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-30"
          >
            ↑
          </button>
        )}
        {onMoveDown && (
          <button
            onClick={onMoveDown}
            disabled={!canMoveDown}
            title="Move page down"
            className="flex h-6 w-6 items-center justify-center rounded bg-black/70 text-[11px] font-medium text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-30"
          >
            ↓
          </button>
        )}
        {!isEmpty && (
          <button
            onClick={() => onOpenEditor(cell.id)}
            title="Edit this page"
            className="flex h-6 items-center justify-center rounded bg-black/70 px-2 text-[10px] font-medium text-white hover:bg-black"
          >
            Edit
          </button>
        )}
        <button
          onClick={() => {
            if (window.confirm("Delete this page? This can't be undone.")) onDelete(cell.id);
          }}
          title="Delete page"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-sm text-white hover:bg-rose-600"
        >
          ×
        </button>
      </div>
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
// One child's intake pipeline (upload → restore → anchor). Rendered once per
// cast character; for single-kid stories there is exactly one of these.
function KidIntakePanel({ character, showLabel, kid, stage, kidBusy, onUploadKid, regenerateAnchor, onSaveName }) {
  const inputRef = useRef(null);
  const busy = stage !== null;
  const anchorCheck = kid?.identityAnchorCheck || kid?.anchorCheck;
  const [name, setName] = useState(kid?.name || "");
  const [nameAr, setNameAr] = useState(kid?.nameAr || "");
  useEffect(() => {
    setName(kid?.name || "");
    setNameAr(kid?.nameAr || "");
  }, [kid?.name, kid?.nameAr]);
  const nameDirty = (kid?.name || "") !== name || (kid?.nameAr || "") !== nameAr;
  return (
    <div className={showLabel ? "rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3" : ""}>
      {showLabel && (
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-md bg-cyan-400/15 px-2 py-0.5 text-xs font-semibold text-cyan-200">
            {character.label}
          </span>
          {kid?.photoStatus && kid.photoStatus !== "needs_new_photo" && (
            <span className="text-[11px] text-emerald-400">✓ photo ready</span>
          )}
        </div>
      )}
      <div className="flex items-center gap-4">
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-2 text-sm font-medium hover:bg-[#242838] disabled:opacity-40"
        >
          {kid ? "Change photo" : "Upload photo"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            onUploadKid(e);
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
        {busy && (
          <span className="text-sm text-[var(--color-accent)]">
            {stage === "uploading"
              ? "Uploading…"
              : stage === "restoring"
              ? "Step 2 of 3 · Restoring photo…"
              : "Step 3 of 3 · Painting character anchor…"}
          </span>
        )}
      </div>

      {(kid || busy) && (
        <>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Stage label="1 · Original" url={kid?.localUrl} loading={stage === "uploading"} loadingLabel="Uploading…" />
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
              disabled={busy || !kid}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs font-medium hover:bg-[#242838] disabled:opacity-40"
            >
              ↻ Regenerate anchor
            </button>
            {!busy && anchorCheck && (
              <span className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">Anchor identity:</span>
                <ScoreBadge check={anchorCheck} size="lg" />
              </span>
            )}
            {!busy && kid?.identityAnchorWeak && (
              <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                ⚠ Weak anchor — using the photo for likeness
              </span>
            )}
            {!busy && kid?.featuresStruct && <FeatureBadges features={kid.featuresStruct} />}
          </div>
          {!busy && anchorCheck?.score != null && anchorCheck.score < 70 && (
            <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2.5 text-xs text-amber-200">
              Weak match — regenerate the anchor before generating pages.
              <Mismatches check={anchorCheck} />
            </div>
          )}
          {onSaveName && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Sara"
                  className="w-40 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
                Arabic name
                <input
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                  dir="rtl"
                  placeholder="مثال: سارة"
                  className="w-40 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
                />
              </label>
              <button
                onClick={() => onSaveName({ name, nameAr })}
                disabled={!nameDirty}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save name
              </button>
              <span className="font-mono text-[10px] text-zinc-600">{`{{name:${character.key}}}`}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function OrderDetail({
  order,
  kid,
  results,
  onBack,
  onDelete,
  onUploadKid,
  kidStages,
  kidBusy,
  regenerateAnchor,
  onSaveName,
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
  countries,
}) {
  const [showPreview, setShowPreview] = useState(true);
  const p = order.pricing;
  // The cast for this order's story (one character for single-kid stories).
  const characters = order.characters?.length ? order.characters : [{ id: "child", label: "Child" }];
  const primaryId = characters[0].id;
  const kidOf = (cid) => order.kids?.[cid] || (cid === primaryId ? kid : null) || null;
  // Every cast member must have an accepted photo before pages can generate.
  const allKidsReady = characters.every((c) => {
    const k = kidOf(c.id);
    return k && k.photoStatus !== "needs_new_photo";
  });
  // Per-character names for the page preview ({{name:<key>}} resolution).
  const orderNames = orderNameMap(order);
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
            {order.language === "ar"
              ? "العربية"
              : order.language === "both"
              ? "English + العربية"
              : "English"}
            {" · "}
            {order.gender === "male" ? "Boy" : order.gender === "non-binary" ? "Child" : "Girl"}
            {order.age ? `, age ${order.age}` : ""}
            {" · "}
            {isoToFlag(order.country)} {countryName(order.country)}
            {order.customer && (
              <>
                {" · "}
                {order.customer.name}{" "}
                <span className="font-mono text-xs text-zinc-500">{order.customer.phone}</span>
              </>
            )}
          </p>
          {p && (
            <p className="mt-1 text-sm">
              <span className="font-semibold text-zinc-100">{formatMoney(p.total, p.currency)}</span>
              {p.discountPrice != null && p.listPrice != null && (
                <span className="ml-2 text-zinc-500 line-through">
                  {formatMoney(p.listPrice, p.currency)}
                </span>
              )}
              {p.taxEnabled && (
                <span className="text-zinc-500">
                  {"  ("}
                  {formatMoney(p.base, p.currency)} + {p.taxLabel} {p.taxRate}%
                  {p.taxInclusive ? ", incl." : ""}
                  {")"}
                </span>
              )}
            </p>
          )}
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

      {/* Step 1 - kid photos (one panel per cast character) */}
      <Section
        step="1"
        title={
          characters.length > 1
            ? "Upload each child's photo (auto restore + anchor)"
            : "Upload the kid's photo (auto restore + anchor)"
        }
      >
        <div className="space-y-5">
          {characters.map((c) => (
            <KidIntakePanel
              key={c.id}
              character={c}
              showLabel={characters.length > 1}
              kid={kidOf(c.id)}
              stage={kidStages?.[c.id] || null}
              kidBusy={kidBusy}
              onUploadKid={(e) => onUploadKid(e, c.id)}
              regenerateAnchor={() => regenerateAnchor(c.id)}
              onSaveName={characters.length > 1 ? (payload) => onSaveName(c.id, payload) : null}
            />
          ))}
        </div>
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
          disabled={!allKidsReady || kidBusy || generatingAll || order.scenes.length === 0}
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
                  names={orderNames}
                  canGenerate={allKidsReady}
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
function OrderPageRow({ scene, label, result, busy, aspect, variables, names, canGenerate, onRegenerate }) {
  const ratio = (aspect || "3:4").replace(":", " / ");
  const hasAi = sceneHasAiBase(scene);
  const changes = hasAi || textChanges(scene, variables);
  const identity = (t) => t;
  const resolved = (t) => applyVarsClient(t, variables || {}, names);

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
