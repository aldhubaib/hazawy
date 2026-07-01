// Single source of truth for the country (market) model.
//
// Imported by BOTH the Express server (to authorize + price) and the React
// client (to render selectors/labels), so the two can never drift. Pure,
// isomorphic JavaScript: no Node APIs, no DOM, no React.
//
// The *operating* set of countries is dynamic and stored in the database
// (db.countries) — admins add/edit/remove them in Settings. This module holds
// only (a) a reference catalog of selectable ISO countries used to pre-fill new
// entries, and (b) pure helpers that operate on whatever dynamic list is passed
// in. Nothing about the active set is hardcoded.

// Reference catalog: selectable countries with sensible defaults. `currency` is
// the ISO 4217 code, `dialCode` the international calling code, `flag` the emoji.
export const ISO_CATALOG = {
  SA: { name: "Saudi Arabia", currency: "SAR", dialCode: "966", flag: "🇸🇦" },
  AE: { name: "United Arab Emirates", currency: "AED", dialCode: "971", flag: "🇦🇪" },
  KW: { name: "Kuwait", currency: "KWD", dialCode: "965", flag: "🇰🇼" },
  QA: { name: "Qatar", currency: "QAR", dialCode: "974", flag: "🇶🇦" },
  BH: { name: "Bahrain", currency: "BHD", dialCode: "973", flag: "🇧🇭" },
  OM: { name: "Oman", currency: "OMR", dialCode: "968", flag: "🇴🇲" },
  // A broader pick list so the registry isn't limited to the GCC.
  EG: { name: "Egypt", currency: "EGP", dialCode: "20", flag: "🇪🇬" },
  JO: { name: "Jordan", currency: "JOD", dialCode: "962", flag: "🇯🇴" },
  IQ: { name: "Iraq", currency: "IQD", dialCode: "964", flag: "🇮🇶" },
  LB: { name: "Lebanon", currency: "LBP", dialCode: "961", flag: "🇱🇧" },
  US: { name: "United States", currency: "USD", dialCode: "1", flag: "🇺🇸" },
  GB: { name: "United Kingdom", currency: "GBP", dialCode: "44", flag: "🇬🇧" },
};

export const ISO_CODES = Object.keys(ISO_CATALOG);

// Countries seeded on first boot (GCC). Admins can edit/remove afterward.
export const SEED_COUNTRY_CODES = ["SA", "AE", "KW", "QA", "BH", "OM"];

export function isIsoCountry(code) {
  return Object.prototype.hasOwnProperty.call(ISO_CATALOG, code);
}

// Normalize a tax config from untrusted input. Rate is a percentage (e.g. 15).
export function normalizeTax(tax) {
  const t = tax && typeof tax === "object" ? tax : {};
  const rate = Number(t.rate);
  return {
    enabled: Boolean(t.enabled),
    rate: Number.isFinite(rate) && rate >= 0 ? rate : 0,
    inclusive: Boolean(t.inclusive),
    label: String(t.label || "VAT").trim() || "VAT",
  };
}

// Build a fresh country record from the catalog defaults + overrides. The tax
// block is always normalized so callers can't store a malformed config.
export function defaultCountryRecord(code, overrides = {}) {
  const meta = ISO_CATALOG[code];
  if (!meta) return null;
  return {
    code,
    name: meta.name,
    currency: meta.currency,
    dialCode: meta.dialCode,
    flag: meta.flag,
    enabled: true,
    order: 0,
    ...overrides,
    tax: normalizeTax(overrides.tax),
  };
}

// Turn the dynamic countries map (or array) into a sorted array.
export function countryList(countries) {
  const arr = Array.isArray(countries) ? countries : Object.values(countries || {});
  return arr
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.code || "").localeCompare(b.code || ""));
}

export function enabledCountries(countries) {
  return countryList(countries).filter((c) => c.enabled);
}

export function getCountry(countries, code) {
  if (!code) return null;
  if (Array.isArray(countries)) return countries.find((c) => c.code === code) || null;
  return countries?.[code] || null;
}

// Keep only valid, known codes (used when sanitizing member country grants).
export function sanitizeCountries(list, countries) {
  if (!Array.isArray(list)) return [];
  const valid = new Set(countryList(countries).map((c) => c.code));
  return [...new Set(list)].filter((code) => valid.has(code));
}

// The country codes a user may act in. Admins -> all enabled. Members -> their
// assigned codes; an empty/missing list is treated as "all" for back-compat.
export function allowedCountries(user, countries) {
  const all = enabledCountries(countries).map((c) => c.code);
  if (!user) return [];
  if (user.role === "admin" || user.isAdmin) return all;
  const assigned = Array.isArray(user.countries) ? user.countries.filter((c) => all.includes(c)) : [];
  return assigned.length ? assigned : all;
}

export function canCountry(user, code, countries) {
  return allowedCountries(user, countries).includes(code);
}

// Currencies with 3 minor units (most use 2). Drives rounding + input step.
const THREE_DECIMAL = new Set(["BHD", "KWD", "OMR", "TND", "IQD", "JOD", "LYD"]);

export function currencyDecimals(currency) {
  return THREE_DECIMAL.has(currency) ? 3 : 2;
}

function roundMoney(amount, currency) {
  const f = 10 ** currencyDecimals(currency);
  return Math.round((Number(amount) || 0) * f) / f;
}

// Currency formatting honoring each currency's minor units.
export function formatMoney(amount, currency) {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency || "USD" }).format(n);
  } catch {
    return `${n} ${currency || ""}`.trim();
  }
}

// Normalize a per-country price entry into { price, discountPrice, effective }
// or null when there's no usable price ("waiting for price"). Accepts the legacy
// numeric shape as well as the current { price, discountPrice } object.
//   - effective: the price actually charged (discount when valid, else price).
//   - a discount only counts when it's > 0 and strictly below the regular price.
export function effectivePrice(entry) {
  if (entry == null) return null;
  if (typeof entry === "number") {
    return entry > 0 ? { price: entry, discountPrice: null, effective: entry } : null;
  }
  const price = Number(entry.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const discount = Number(entry.discountPrice);
  const hasDiscount = Number.isFinite(discount) && discount > 0 && discount < price;
  return { price, discountPrice: hasDiscount ? discount : null, effective: hasDiscount ? discount : price };
}

// Per-country pricing status for a story. "live" once a usable price exists,
// otherwise "waiting" for a price to be set in that market.
export function priceStatus(entry) {
  return effectivePrice(entry) ? "live" : "waiting";
}

// THE pricing math. Given a base price and a country record, return the snapshot
// stored on an order. Single source so server + client always agree.
//   - tax disabled: total = base, taxAmount = 0
//   - exclusive:    base is net; tax added on top
//   - inclusive:    base is gross; net is derived
export function computeOrderPricing(base, country) {
  const currency = country?.currency || "USD";
  const amount = Number(base) || 0;
  const tax = normalizeTax(country?.tax);

  if (!tax.enabled || tax.rate <= 0) {
    const total = roundMoney(amount, currency);
    return { currency, base: total, taxEnabled: false, taxRate: 0, taxInclusive: false, taxLabel: tax.label, taxAmount: 0, total };
  }
  if (tax.inclusive) {
    const net = amount / (1 + tax.rate / 100);
    return {
      currency,
      base: roundMoney(net, currency),
      taxEnabled: true,
      taxRate: tax.rate,
      taxInclusive: true,
      taxLabel: tax.label,
      taxAmount: roundMoney(amount - net, currency),
      total: roundMoney(amount, currency),
    };
  }
  const taxAmount = amount * (tax.rate / 100);
  return {
    currency,
    base: roundMoney(amount, currency),
    taxEnabled: true,
    taxRate: tax.rate,
    taxInclusive: false,
    taxLabel: tax.label,
    taxAmount: roundMoney(taxAmount, currency),
    total: roundMoney(amount + taxAmount, currency),
  };
}
