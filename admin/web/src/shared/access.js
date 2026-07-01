// Single source of truth for the access model.
//
// This module is imported by BOTH the Express server (to authorize requests)
// and the React client (to render the menu), so the two can never drift. It is
// pure, isomorphic JavaScript: no Node APIs, no DOM, no React — safe to load in
// either runtime.
//
// Concepts:
//   - MODULE: a top-level section of the app (a sidebar entry + its API routes).
//   - ROLE:   "admin" (everything) or "member" (only granted, assignable modules).
//   - can():  THE single authorization decision, used by the server gate AND the
//             client's rendering. If it returns false in one place it returns
//             false in the other.

export const MODULES = {
  stories: { label: "Stories", icon: "📖", assignable: true },
  pricing: { label: "Pricing", icon: "💵", assignable: true },
  orders: { label: "Orders", icon: "🧾", assignable: true },
  customers: { label: "Customers", icon: "👤", assignable: true },
  // Variables + Access live inside the Settings page now, so they're hidden from
  // the sidebar (hideFromNav) but keep their own module ids for route gating.
  variables: { label: "Variables", icon: "🔤", assignable: true, hideFromNav: true },
  settings: { label: "Settings", icon: "⚙️", adminOnly: true },
  access: { label: "Access", icon: "👥", adminOnly: true, hideFromNav: true },
  // Audit/history log — admin-only, surfaced as a tab inside Settings.
  history: { label: "History", icon: "🕘", adminOnly: true, hideFromNav: true },
};

// Declared order is the order the sidebar renders in.
export const MODULE_IDS = Object.keys(MODULES);

// Modules an admin may grant to a member.
export const ASSIGNABLE_MODULES = MODULE_IDS.filter((id) => MODULES[id].assignable);

// Modules only admins ever see (never assignable to members).
export const ADMIN_ONLY_MODULES = MODULE_IDS.filter((id) => MODULES[id].adminOnly);

export const ROLES = {
  admin: { label: "Admin", allModules: true },
  member: { label: "Member", allModules: false },
};

export const DEFAULT_ROLE = "member";

export function isValidRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

export function normalizeRole(role) {
  return isValidRole(role) ? role : DEFAULT_ROLE;
}

// Normalize an email into a stable, comparable key. Trimming + lowercasing here
// (in one place) is what prevents "Hello@x.com " from being treated as a
// different person than "hello@x.com".
export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Keep only real, grantable module ids (drops admin-only ids, unknown ids and
// duplicates). Accepts the legacy "pages" arrays unchanged.
export function sanitizeModules(modules) {
  if (!Array.isArray(modules)) return [];
  return [...new Set(modules)].filter((id) => ASSIGNABLE_MODULES.includes(id));
}

// THE authorization decision. `user` is { role, modules }.
export function can(user, moduleId) {
  const mod = MODULES[moduleId];
  if (!user || !mod) return false;
  const role = ROLES[user.role] ?? ROLES[DEFAULT_ROLE];
  if (role.allModules) return true; // admins: every module
  if (mod.adminOnly) return false; // members: never admin-only modules
  return (user.modules || []).includes(moduleId);
}

// The ordered list of modules a user can open. This is what the client renders
// its sidebar from, and it's computed by the same can() the server enforces.
export function visibleModules(user) {
  return MODULE_IDS.filter((id) => can(user, id));
}
