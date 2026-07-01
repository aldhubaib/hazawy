// Audit / history log.
//
// A single, central description of "what each mutating API call means" so the
// history log can record every change a user makes without sprinkling logging
// calls through every route handler. `describeChange()` runs in a global
// middleware (before route-level multer), so it only decides *whether* a request
// is auditable and what entity it touches. The human-readable label is built
// lazily by `buildActionLabel()` from the finish handler, by which point
// multipart bodies have been parsed and the response payload is available.

const dec = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Each rule: { m: method, re: path regex, entity, id(match, req)?, action(match, req) }.
// Order matters — more specific paths must come before generic "/:id" catch-alls.
const RULES = [
  // --- Settings -------------------------------------------------------------
  { m: "PUT", re: /^\/api\/settings\/?$/, entity: "settings", action: () => "Updated settings" },

  // --- Access / team --------------------------------------------------------
  {
    m: "POST",
    re: /^\/api\/access\/users\/?$/,
    entity: "access",
    id: (_mt, req) => (req.body?.email || "").trim().toLowerCase() || null,
    action: (_mt, req) => `Invited ${req.body?.email || "a user"}`,
  },
  {
    m: "PUT",
    re: /^\/api\/access\/users\/([^/]+)$/,
    entity: "access",
    id: (mt) => dec(mt[1]),
    action: (mt) => `Updated access for ${dec(mt[1])}`,
  },
  {
    m: "DELETE",
    re: /^\/api\/access\/users\/([^/]+)$/,
    entity: "access",
    id: (mt) => dec(mt[1]),
    action: (mt) => `Removed access for ${dec(mt[1])}`,
  },

  // --- Stories (specific sub-routes before the generic /:id) ----------------
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/scenes\/?$/, entity: "story", id: (mt) => mt[1], action: () => "Added scene images" },
  { m: "PUT", re: /^\/api\/stories\/([^/]+)\/scenes\/order$/, entity: "story", id: (mt) => mt[1], action: () => "Reordered pages" },
  { m: "DELETE", re: /^\/api\/stories\/([^/]+)\/scenes\/([^/]+)$/, entity: "story", id: (mt) => mt[1], action: () => "Deleted a page" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/cells\/copy-language$/, entity: "story", id: (mt) => mt[1], action: () => "Copied pages to the other language" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/cells\/([^/]+)\/image$/, entity: "story", id: (mt) => mt[1], action: () => "Uploaded a page image" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/cells\/([^/]+)\/background$/, entity: "story", id: (mt) => mt[1], action: () => "Set a page background" },
  { m: "DELETE", re: /^\/api\/stories\/([^/]+)\/cells\/([^/]+)\/background$/, entity: "story", id: (mt) => mt[1], action: () => "Removed a page background" },
  { m: "PUT", re: /^\/api\/stories\/([^/]+)\/cells\/([^/]+)$/, entity: "story", id: (mt) => mt[1], action: () => "Edited a page" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/cells\/?$/, entity: "story", id: (mt) => mt[1], action: () => "Added a page" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/analyze$/, entity: "story", id: (mt) => mt[1], action: () => "Ran AI analysis" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/kid\/([^/]+)\/restore$/, entity: "story", id: (mt) => mt[1], action: () => "Restored a test photo" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/kid\/([^/]+)\/anchor$/, entity: "story", id: (mt) => mt[1], action: () => "Anchored a test photo" },
  { m: "DELETE", re: /^\/api\/stories\/([^/]+)\/kid\/([^/]+)$/, entity: "story", id: (mt) => mt[1], action: () => "Deleted a test photo" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/kid\/?$/, entity: "story", id: (mt) => mt[1], action: () => "Uploaded a test photo" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/generate$/, entity: "story", id: (mt) => mt[1], action: () => "Generated images" },
  {
    m: "POST",
    re: /^\/api\/stories\/([^/]+)\/results\/([^/]+)\/([^/]+)\/approve$/,
    entity: "story",
    id: (mt) => mt[1],
    action: (_mt, req) => (req.body?.approved === false ? "Unapproved a result" : "Approved a result"),
  },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/publish$/, entity: "story", id: (mt) => mt[1], action: () => "Published the story" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/unpublish$/, entity: "story", id: (mt) => mt[1], action: () => "Unpublished the story" },
  { m: "PUT", re: /^\/api\/stories\/([^/]+)\/title$/, entity: "story", id: (mt) => mt[1], action: () => "Renamed the story" },
  { m: "PUT", re: /^\/api\/stories\/([^/]+)\/characters$/, entity: "story", id: (mt) => mt[1], action: () => "Updated the cast" },
  {
    m: "PUT",
    re: /^\/api\/stories\/([^/]+)\/gender$/,
    entity: "story",
    id: (mt) => mt[1],
    action: (_mt, req) => `Changed the child to "${req.body?.gender || "?"}"`,
  },
  { m: "PUT", re: /^\/api\/stories\/([^/]+)\/style$/, entity: "story", id: (mt) => mt[1], action: () => "Updated style settings" },
  { m: "POST", re: /^\/api\/stories\/([^/]+)\/extract-style$/, entity: "story", id: (mt) => mt[1], action: () => "Extracted style from an image" },
  { m: "DELETE", re: /^\/api\/stories\/([^/]+)$/, entity: "story", id: (mt) => mt[1], action: () => "Deleted the story" },
  { m: "POST", re: /^\/api\/stories\/?$/, entity: "story", action: () => "Created a story" },

  // --- Pricing --------------------------------------------------------------
  {
    m: "PUT",
    re: /^\/api\/pricing\/([^/]+)$/,
    entity: "story",
    id: (mt) => mt[1],
    action: (_mt, req) => `Updated pricing for ${req.body?.country || "a country"}`,
  },

  // --- Orders ---------------------------------------------------------------
  { m: "POST", re: /^\/api\/orders\/([^/]+)\/kid\/restore$/, entity: "order", id: (mt) => mt[1], action: () => "Restored the kid photo" },
  { m: "POST", re: /^\/api\/orders\/([^/]+)\/kid\/anchor$/, entity: "order", id: (mt) => mt[1], action: () => "Anchored the kid photo" },
  { m: "POST", re: /^\/api\/orders\/([^/]+)\/kid\/?$/, entity: "order", id: (mt) => mt[1], action: () => "Uploaded the kid photo" },
  { m: "POST", re: /^\/api\/orders\/([^/]+)\/generate$/, entity: "order", id: (mt) => mt[1], action: () => "Generated order images" },
  { m: "DELETE", re: /^\/api\/orders\/([^/]+)$/, entity: "order", id: (mt) => mt[1], action: () => "Deleted the order" },
  { m: "POST", re: /^\/api\/orders\/?$/, entity: "order", action: () => "Created an order" },

  // --- Countries (markets) --------------------------------------------------
  {
    m: "POST",
    re: /^\/api\/countries\/?$/,
    entity: "country",
    id: (_mt, req) => String(req.body?.code || "").toUpperCase() || null,
    action: (_mt, req) => `Added country ${req.body?.code ? String(req.body.code).toUpperCase() : ""}`.trim(),
  },
  { m: "PUT", re: /^\/api\/countries\/([^/]+)$/, entity: "country", id: (mt) => mt[1].toUpperCase(), action: () => "Updated a country" },
  { m: "DELETE", re: /^\/api\/countries\/([^/]+)$/, entity: "country", id: (mt) => mt[1].toUpperCase(), action: () => "Removed a country" },

  // --- Customers ------------------------------------------------------------
  {
    m: "POST",
    re: /^\/api\/customers\/?$/,
    entity: "customer",
    action: (_mt, req) => `Created customer ${req.body?.name ? `"${req.body.name}"` : ""}`.trim(),
  },
  { m: "PUT", re: /^\/api\/customers\/([^/]+)$/, entity: "customer", id: (mt) => mt[1], action: () => "Updated a customer" },
  { m: "DELETE", re: /^\/api\/customers\/([^/]+)$/, entity: "customer", id: (mt) => mt[1], action: () => "Deleted a customer" },

  // --- Variables ------------------------------------------------------------
  {
    m: "POST",
    re: /^\/api\/variables\/?$/,
    entity: "variable",
    action: (_mt, req) => `Created variable ${req.body?.name ? `"${req.body.name}"` : ""}`.trim(),
  },
  { m: "DELETE", re: /^\/api\/variables\/([^/]+)$/, entity: "variable", id: (mt) => mt[1], action: () => "Deleted a variable" },

  // --- Custom symbols -------------------------------------------------------
  {
    m: "POST",
    re: /^\/api\/symbols\/?$/,
    entity: "symbol",
    action: (_mt, req) => `Created symbol ${req.body?.name ? `"${req.body.name}"` : ""}`.trim(),
  },
  { m: "DELETE", re: /^\/api\/symbols\/([^/]+)$/, entity: "symbol", id: (mt) => mt[1], action: () => "Deleted a symbol" },

  // --- Test-image library ---------------------------------------------------
  {
    m: "POST",
    re: /^\/api\/test-images\/?$/,
    entity: "test-image",
    action: (_mt, req) => `Added a ${req.body?.gender || ""} test image`.replace(/\s+/g, " ").trim(),
  },
  { m: "DELETE", re: /^\/api\/test-images\/([^/]+)$/, entity: "test-image", id: (mt) => mt[1], action: () => "Deleted a test image" },
];

// Decide whether a request should be recorded. Returns a lightweight descriptor
// (no human label yet) or null. Path-based ids are resolved here; created-entity
// ids are filled in later from the response body.
export function describeChange(req) {
  const rule = RULES.find((r) => r.m === req.method && r.re.test(req.path));
  if (!rule) return null;
  const mt = rule.re.exec(req.path);
  return {
    entity: rule.entity,
    entityId: rule.id ? rule.id(mt, req) || null : null,
    _rule: rule,
    _mt: mt,
  };
}

// Build the final human-readable label. Called from the response 'finish'
// handler, so req.body (multipart included) is fully populated.
export function buildActionLabel(desc, req) {
  try {
    return desc._rule.action(desc._mt, req) || "Made a change";
  } catch {
    return "Made a change";
  }
}
