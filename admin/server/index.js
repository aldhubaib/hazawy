import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import dotenv from "dotenv";
import express from "express";
import { clerkMiddleware, getAuth, clerkClient } from "@clerk/express";

const __dirnameEnv = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirnameEnv, ".env") });

import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { parsePhoneNumberFromString } from "libphonenumber-js";

import { readDb, writeDb } from "./db.js";
import {
  uploadToFal,
  restorePhoto,
  nanoEdit,
  gptImage2Edit,
  GPT_IMAGE_2_ENDPOINT,
  advancedFaceSwap,
  downscaleToFal,
  describeChildFeatures,
  describeChildFeaturesStruct,
  describeScene,
  extractStyleFromImage,
  fluxPulid,
  padToSquareFal,
  downloadToUploads,
  uploadBufferToFal,
  fetchImageBuffer,
  setFalKey,
  testFalKey,
} from "./fal.js";
import {
  checkConsistency,
  isCheckerEnabled,
  classifyFaceVisibility,
  validateKidPhoto,
  derivePhotoStatus,
} from "./checker.js";
import { describeChange, buildActionLabel } from "./audit.js";
// Shared access model — the single source of truth for modules/roles/can(),
// imported by the web client too (see web/src/shared/access.js).
import {
  MODULES,
  MODULE_IDS,
  ASSIGNABLE_MODULES,
  ADMIN_ONLY_MODULES,
  ROLES,
  normalizeRole,
  normalizeEmail,
  sanitizeModules,
  can,
  visibleModules,
} from "../web/src/shared/access.js";
// Shared country (market) model — dynamic registry + pricing/tax math, imported
// by the web client too (see web/src/shared/countries.js).
import {
  isIsoCountry,
  normalizeTax,
  defaultCountryRecord,
  SEED_COUNTRY_CODES,
  countryList,
  enabledCountries,
  getCountry,
  sanitizeCountries,
  allowedCountries,
  canCountry,
  computeOrderPricing,
  effectivePrice,
} from "../web/src/shared/countries.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_ROOT lets a host (e.g. Railway volume) point persistent storage at a
// mounted path. Falls back to the server folder for local development.
const DATA_ROOT = process.env.DATA_ROOT || __dirname;
const UPLOAD_DIR = path.join(DATA_ROOT, "uploads");
await fs.mkdir(UPLOAD_DIR, { recursive: true });

const PORT = process.env.PORT || 3001;

// Shared style direction so the anchor and the scenes look like the same premium book.
const STYLE =
  "photorealistic, lifelike real human child with natural, realistic facial proportions (normal-sized eyes, " +
  "NOT enlarged), real skin with fine natural texture and subtle pores, realistic individual strands of hair, " +
  "soft natural cinematic lighting and gentle depth of field, looking like a high-end DSLR portrait / photoreal " +
  "render that is indistinguishable from a real photograph. Absolutely NOT a cartoon, NOT anime, NOT a stylized " +
  "3D animation character, NOT Pixar or Disney style, NOT an illustration or painting";

// Scene swap: keep the scene's composition/lighting, but swap the child's whole
// HEAD identity (face + hair + skin tone) to match the reference child.
const DEFAULT_PROMPT =
  "The first image is a finished, correctly-lit storybook scene with the right composition, pose, body, " +
  "clothing, accessories (such as a crown or headband), colors and lighting. " +
  "The other image(s) are reference photos of ONE specific real child. " +
  "Replace the child's HEAD in the scene so it becomes UNMISTAKABLY that exact same child — the face must be " +
  "100% recognizable as the child in the reference photo. Copy the child's precise identity: exact face shape, " +
  "eye shape, spacing and color, eyebrows, nose, mouth and lips, jawline, cheeks, and their exact HAIR " +
  "(hairstyle, hair length, parting, hair color and texture) and skin tone. " +
  "Match the hair LENGTH and shape to the reference EXACTLY — neither longer nor shorter. If the reference " +
  "child has a chin-length rounded bob with a blunt straight fringe, the result must be the same chin-length " +
  "bob (hair ending at the jaw, fully covering the ears) with the same blunt fringe. Do NOT trim, shorten, " +
  "crop or tuck the hair, and do NOT lengthen, extend or thicken it. Do NOT let the hair drape down over the " +
  "shoulders or cover the clothing/costume, and do NOT change blunt bangs into a center part. Reproduce the " +
  "reference hair silhouette faithfully so the scene's outfit and composition stay unchanged. " +
  "Do NOT beautify, idealize, age up/down, slim, or alter the child's proportions or features in any way — " +
  "reproduce them faithfully so it is clearly the same individual on every scene. " +
  "CRITICAL — head-to-body proportion: keep the child's head EXACTLY the same size, position and angle as the " +
  "head already in the first scene image. The head must occupy the same area and sit on the neck and shoulders " +
  "with the same head-to-body ratio as the original scene — do NOT enlarge, widen or scale up the head or face. " +
  "The reference photos are tight close-up crops used ONLY for facial identity and hair; IGNORE their framing " +
  "and scale and never resize the scene's head to match them. Keep the same body, neck, shoulders, clothing, " +
  "accessories, pose, background, colors, lighting and art style. " +
  "IGNORE any headband, hairband, hair clip, hat or other accessory worn on the reference child's head — " +
  "do NOT copy it into the scene. Only the accessories already present in the first scene image (such as its " +
  "own crown or headband) may appear; if the scene has none, the child's head must be bare with nothing on it. " +
  "Relight the new face and hair with the scene's existing light — same direction, color temperature and " +
  "intensity, with matching highlights, shadows and catchlights — so it blends seamlessly and is not pale, " +
  "flat or pasted in. Keep any crown, headband or hat resting naturally on top of the new hair. " +
  "Do NOT change or re-render any text in the scene.";

// INVERTED / GUIDED composition. Here the CHILD is the master (must stay 100%
// consistent) and the scene is rebuilt around them: the surroundings only need
// to keep the same THEME and overall layout, not be pixel-identical. This frees
// the model to draw a correctly-proportioned child instead of grafting a head
// onto a fixed template body (which caused oversized heads / wrong proportions).
const COMPOSE_PROMPT =
  "IMAGE ROLES: the FIRST image is the LOCKED SCENE and controls everything EXCEPT who the child is. ALL OTHER " +
  "images are references of ONE specific real child and control ONLY the child's identity. " +
  "Recreate the first image as the SAME scene, preserving it strictly: same composition, camera angle, framing " +
  "and crop, background, props, room details, lighting, colors, mood, art style, the child's outfit/costume, " +
  "body pose, hand positions, head angle, gaze/eye direction and facial expression/emotion. Then replace ONLY " +
  "the child's identity with the child from the reference images. " +
  "IDENTITY (take from the child references only): face shape, skin tone, eye shape and color, eyebrows, nose, " +
  "lips, cheeks, ears, hairline, hair color, hair texture, hairstyle and hair length/volume, apparent age, " +
  "gender appearance and natural likeness — it must be unmistakably this same individual on every page. Match " +
  "the hair length and shape to the references EXACTLY (a chin-length bob stays a chin-length bob with the same " +
  "fringe; do not lengthen, shorten or restyle it). Do NOT beautify, idealize, or age the child up or down. " +
  "POSE & EXPRESSION come ONLY from the scene, NEVER from the child references: do NOT copy the reference " +
  "photo's neutral expression, camera angle, head orientation or background. Do NOT rotate the child to face " +
  "the camera, do NOT make them smile at the viewer, and do NOT change where they look or what they are doing — " +
  "if the scene child is turned, in profile, or looking down at something, the new child looks the same way at " +
  "the same thing. " +
  "PROPORTIONS: render a natural, anatomically-correct young child with a NORMAL-SIZED head proportionate to " +
  "the body (roughly one sixth to one fifth of standing height) — never an oversized big-head/bobblehead/chibi " +
  "look. If the scene's head is oversized, correct the head and body scale WITHOUT changing the pose, head " +
  "angle, gaze, framing or composition. " +
  "ACCESSORIES: the child's own personal items visible in the references — eyeglasses (same frame shape and " +
  "color), earrings, hearing aid — are part of their identity; keep them, adapted to the scene's art style and " +
  "head angle, unless completely hidden by the pose. Do NOT add such items if the references don't have them. " +
  "Decorative items belonging to the SCENE child (headband, bow, hair clip, hat, crown, scarf) should be kept " +
  "ONLY if the same type of item also appears in the references; otherwise drop them. Never mix accessories " +
  "from the two sources and never invent new ones. " +
  "Keep the scene's illustrated storybook art style, medium and lighting exactly as the first image — do NOT " +
  "make the result photographic; blend the child's likeness seamlessly into the illustration. " +
  "Keep any title text or logo from the scene exactly as-is; do NOT invent, garble or re-render text.";

// HARD hair requirement appended to every page edit: the child's hair comes
// from the identity anchor / reference photos, NEVER from the scene character.
const HAIR_PRESERVATION =
  "HAIR IS A HARD IDENTITY REQUIREMENT — copy the hair from the child reference images, NOT from the scene " +
  "character: keep the EXACT same hair COLOR (never recolor — never turn brown/dark hair blonde or any other " +
  "color), the same LENGTH, the same TEXTURE (straight/wavy/curly/coily), and the same HAIRSTYLE and silhouette, " +
  "including any bangs/fringe, parting, braids, buns, ponytails or curls the child has. If the child has loose " +
  "shoulder-length hair keep loose shoulder-length hair; if they have two buns keep two buns; if they have braids " +
  "keep braids. Do NOT invent a princess/fairytale hairstyle or restyle the hair to match the scene character. A " +
  "crown, tiara, hat, helmet, headband or other accessory from the scene may rest ON TOP of the child's own " +
  "hairstyle, but must NEVER replace, hide or redesign it.";

// IDENTITY anchor: the closest faithful version of the uploaded/restored child.
// This is the reference used for GENERATION and SCORING, so it must NOT become a
// new studio-model version of the child — only the technical photo quality
// improves. Faithfulness beats prettiness here.
const IDENTITY_ANCHOR_PROMPT =
  "Improve ONLY the technical quality of this photo of ONE specific real child. Keep it a real photograph of " +
  "the SAME child — do NOT redraw, re-render, stylize or reimagine them. " +
  "PRESERVE THE CHILD'S EXACT IDENTITY with zero idealization: keep the same face shape and any natural " +
  "asymmetry, the same eyes (shape, size, spacing, color, eyelids), the same eyebrows, nose, mouth and lips, " +
  "cheeks, chin and jawline exactly as in the photo. " +
  "Preserve the child's exact apparent AGE — do NOT age them up or down, do NOT make them look older or more " +
  "mature. Preserve their natural expression and smile as much as possible — do NOT replace it with a posed " +
  "studio smile. " +
  "HAIR: keep the same hairstyle, hairline, hair length, parting, texture and the way the hair frames the face; " +
  "tidy obvious stray flyaways only — do NOT restyle, straighten, smooth, lengthen, shorten or pull the hair " +
  "back. " +
  "Keep the EXACT skin tone and ethnicity. Do NOT beautify, do NOT airbrush or over-smooth skin, do NOT slim " +
  "the face, do NOT enlarge the eyes, and do NOT make the face more symmetrical than it really is. " +
  "ONLY improve: focus/sharpness, exposure and lighting evenness, color/white-balance accuracy, denoise, and " +
  "replace a cluttered background with a simple soft neutral light-gray background. " +
  "Keep the child's permanent personal items (eyeglasses with the same frame shape and color, earrings, hearing " +
  "aid). Remove only loose decorative head accessories (headband, hairband, clip, bow, hat, crown, scarf). " +
  "Output a square, head-and-shoulders photo at a natural angle (do NOT force them to rotate to face the " +
  "camera if the photo is at an angle). Real photographic skin texture, highly detailed.";

// PRESENTATION portrait: a prettier, parent-facing portrait. Shown in the UI as
// a premium photo but NEVER used as the generation/scoring identity source.
const PRESENTATION_PORTRAIT_PROMPT =
  "Create a clean, front-facing character reference portrait of THIS child for a premium children's storybook. " +
  `Style: ${STYLE}. ` +
  "Preserve the child's exact facial identity from the photo: face shape, eye shape and color, eyebrows, " +
  "nose, mouth, and skin tone, and approximate age. " +
  "HAIR — reproduce it EXACTLY as in the photo: same hair length, same parting, same texture and waviness, " +
  "same volume and the same way it falls and frames the face (including hair worn loose, draped over a " +
  "shoulder, or falling in front of the shoulders). Do NOT pull the hair back, do NOT tie it up, do NOT smooth, " +
  "straighten, shorten, lengthen or otherwise restyle it, and do NOT tuck it symmetrically behind both " +
  "shoulders unless it is already worn that way in the photo. The hairstyle must be unmistakably the same. " +
  "Remove only DECORATIVE / styling head accessories (headband, hairband, hair clip, bow, hat, crown, scarf) so " +
  "the portrait is a neutral reference for any scene — but KEEP the child's permanent personal items that are " +
  "part of their identity: eyeglasses (same frame shape and color), earrings, and any hearing aid, exactly as " +
  "in the photo. " +
  "FRAMING (keep consistent so reference portraits match): a square portrait, roughly centered and facing the " +
  "camera with the face clearly visible and not tilted. Frame it as a head-and-shoulders portrait at a fixed " +
  "distance so the head occupies roughly 45% of the frame height, the eyes sit on the upper-third line, with " +
  "even headroom above the hair. Keep the natural hair fall as priority over perfect shoulder symmetry — do " +
  "not move or restyle the hair just to make the shoulders symmetric. " +
  "Gentle natural smile, soft cinematic lighting, simple soft neutral light-gray background. " +
  "No text, no props, no border, and no decorative accessories on the head (but keep eyeglasses/earrings if the " +
  "child wears them). Highly detailed, high quality.";

// Legacy alias: older code/anchor prompts referenced ANCHOR_PROMPT. Keep it
// pointing at the faithful identity anchor (the safe default for generation).
const ANCHOR_PROMPT = IDENTITY_ANCHOR_PROMPT;

// Identity-anchor prompt used specifically by the GPT-Image-2 provider.
// gpt-image responds best to a concise, directive prompt; identity neutralizes
// makeup/filters inline so we don't need a separate stylized directive here.
const GPT_IMAGE_ANCHOR_PROMPT =
  "Create a natural clean identity portrait of the same child from the reference image. " +
  "Preserve the child's real identity: face shape, eye color, skin tone, hair color, hair texture, hair length, " +
  "hairstyle, hairline, cheeks, nose, mouth, and age. " +
  "Use a simple neutral studio background. " +
  "The child should face the camera with both eyes visible. " +
  "Do not beautify, age up, change hairstyle, change hair color, change skin tone, enlarge eyes, make doll-like, " +
  "make anime-like, make Disney-princess-like, or add heavy makeup. " +
  "If the input photo has makeup, beauty filter, or stylization, reduce those artifacts while preserving identity. " +
  "Return one realistic, age-appropriate child portrait.";

// Which fal model the user selected in Settings ("Model"). Drives BOTH the
// identity anchor and the actual scene/page generation so the selected model is
// what really renders the output. Defaults to the existing Nano Banana behavior.
// Set ANCHOR_PROVIDER=gpt_image_2 (or ANCHOR_MODEL to the fal endpoint
// "openai/gpt-image-2/edit") to use GPT-Image-2 via fal.
function useGptImageModel() {
  const provider = (process.env.ANCHOR_PROVIDER || "nano_banana").toLowerCase();
  const model = (process.env.ANCHOR_MODEL || "").toLowerCase();
  return provider === "gpt_image_2" || model === GPT_IMAGE_2_ENDPOINT;
}

// Appended to the identity-anchor prompt when the intake validator flagged the
// uploaded photo as stylized (beauty filter / heavy makeup). The anchor step
// neutralizes the styling so the identity reference looks like a natural child.
const STYLIZED_ANCHOR_DIRECTIVE =
  "Create a natural clean identity portrait. Preserve the child's real facial structure, skin tone, eye color, " +
  "hair color, and hairstyle, but remove beauty filter effects, heavy makeup look, exaggerated eyelashes, " +
  "excessive blush, glossy/plastic skin, and adult-like styling. The child should look age-appropriate and natural.";

// FACE-FOCUSED scene edit: the product decision is that the TEMPLATE keeps its
// hair/outfit/body/pose/background; we only personalize the child's facial
// likeness so the page clearly looks like the uploaded child. This is the
// preferred default for likeness over the whole-head swap of DEFAULT_PROMPT.
const FACE_PROMPT =
  "The first image is the finished storybook scene and is CORRECT — preserve it faithfully: same composition, " +
  "framing, background, props, lighting, colors and art style, AND keep the child's HAIR exactly as drawn " +
  "(hairstyle, hairline, hair length, parting and hair color, and the way it frames the face), plus the same " +
  "outfit, body, pose, hand positions, head angle, gaze direction and facial expression/emotion. " +
  "The other image(s) are reference photos of ONE specific real child. " +
  "Change ONLY the child's FACIAL LIKENESS and visible facial skin so the face clearly and unmistakably " +
  "resembles that reference child: match the face shape, eyes (shape, size, spacing, color), eyebrows, nose, " +
  "mouth and lips, cheeks, chin and skin tone. Adapt the new face to the scene's existing expression, head " +
  "angle and lighting so it blends seamlessly — the result should look like the SAME individual from the " +
  "uploaded photo, naturally showing the scene's emotion. " +
  "Do NOT change the hair, hairstyle, hairline, hair length, hair texture or hair color — keep the template's " +
  "hair exactly. Do NOT change the outfit, body, pose, background, props, accessories, crown/headband, or any " +
  "text. Do NOT beautify, idealize, age the child up or down, slim them, enlarge the eyes, or alter " +
  "proportions. Keep the head the same size, position and angle as in the scene. " +
  "IGNORE any headband, hairband, clip, hat or other accessory worn in the reference photos — only the facial " +
  "identity and skin tone come from the references.";

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `${nanoid(10)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Access control (Clerk)
// ---------------------------------------------------------------------------
// The module/role model and the can() decision live in the shared access module
// (imported above) so the server and the web client agree by construction.

// Auth is only enforced when a Clerk secret key is configured, so the tool still
// runs locally with zero setup. Add CLERK_SECRET_KEY to turn on real access.
const AUTH_ENABLED = Boolean(process.env.CLERK_SECRET_KEY);

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map(normalizeEmail)
  .filter(Boolean);

// Map an API path prefix to the module it belongs to. Anything not listed is
// open to any signed-in user (config, media uploads, "who am I", etc.).
// can() then decides access uniformly (admin-only vs granted-to-member).
const ROUTE_MODULE = [
  [/^\/api\/stories(\/|$)/, "stories"],
  [/^\/api\/pricing(\/|$)/, "pricing"],
  [/^\/api\/orders(\/|$)/, "orders"],
  [/^\/api\/customers(\/|$)/, "customers"],
  [/^\/api\/variables(\/|$)/, "variables"],
  [/^\/api\/settings(\/|$)/, "settings"],
  [/^\/api\/access(\/|$)/, "access"],
  [/^\/api\/history(\/|$)/, "history"],
];

// Endpoints any signed-in user may hit regardless of module grants.
const OPEN_ENDPOINTS = new Set(["/api/config", "/api/media", "/api/access/me"]);

if (AUTH_ENABLED) app.use(clerkMiddleware());

const emailByUserId = new Map();

async function emailForUser(userId) {
  if (emailByUserId.has(userId)) return emailByUserId.get(userId);
  const user = await clerkClient.users.getUser(userId);
  const email = normalizeEmail(
    user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress
  );
  // Only memoize a real address — never cache an empty string, or a transient
  // miss would wrongly stick to this session and strip the user's access.
  if (email) emailByUserId.set(userId, email);
  return email;
}

// Find the stored record for a signed-in person. Primary match is the
// normalized email key; the secondary match by stable Clerk userId covers a
// user whose email later changed in Clerk (their record keeps working).
function findRecord(users, email, userId) {
  if (email && users[email]) return users[email];
  if (userId) return Object.values(users).find((u) => u.userId === userId) || null;
  return null;
}

// Resolve the signed-in person into a viewer: { email, userId, role, isAdmin,
// modules }. The first person to sign in (or anyone in ADMIN_EMAILS) is
// bootstrapped as admin and persisted, so there's always someone who can manage
// access. Returns null when not signed in.
async function resolveUser(req) {
  const { isAuthenticated, userId } = getAuth(req);
  if (!isAuthenticated) return null;
  const email = await emailForUser(userId);

  const db = await readDb();
  if (!db.access) db.access = { users: {} };
  if (!db.access.users) db.access.users = {};
  const users = db.access.users;

  const forcedAdmin = Boolean(email && ADMIN_EMAILS.includes(email));
  const noUsersYet = Object.keys(users).length === 0;

  let record = findRecord(users, email, userId);
  let dirty = false;

  if (!record && email && (forcedAdmin || noUsersYet)) {
    // Bootstrap: guarantee at least one admin exists.
    record = {
      email,
      userId,
      role: "admin",
      modules: ASSIGNABLE_MODULES.slice(),
      invitedAt: Date.now(),
      bootstrapped: true,
    };
    users[email] = record;
    dirty = true;
  } else if (record) {
    // Promote configured admins, stamp the stable userId on first sign-in, and
    // migrate legacy "pages" records to the new "modules" field — once.
    if (forcedAdmin && record.role !== "admin") {
      record.role = "admin";
      dirty = true;
    }
    if (userId && record.userId !== userId) {
      record.userId = userId;
      dirty = true;
    }
    if (!Array.isArray(record.modules)) {
      record.modules = sanitizeModules(record.pages);
      delete record.pages;
      dirty = true;
    }
  }
  if (dirty) await writeDb(db);

  const role = record?.role === "admin" || forcedAdmin ? "admin" : "member";
  const user = {
    email,
    userId,
    role,
    modules: role === "admin" ? ASSIGNABLE_MODULES.slice() : sanitizeModules(record?.modules),
  };
  // Country grants: admins implicitly get every enabled country; members get the
  // effective list (their assigned countries, or all when none are set yet).
  const countriesRef = { ...user, isAdmin: role === "admin", countries: sanitizeCountries(record?.countries, db.countries) };
  const effectiveCountries = allowedCountries(countriesRef, db.countries);
  // visibleModules() expands admins to admin-only modules too, via can().
  return {
    ...user,
    isAdmin: role === "admin",
    modules: visibleModules(user),
    countries: effectiveCountries,
    exists: Boolean(record),
  };
}

// Gate /api routes by the module they belong to, using the shared can(). Skips
// itself when auth is off so the tool runs fully open with zero setup.
app.use(async (req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (!req.path.startsWith("/api/")) return next();
  // The live-update stream carries only low-sensitivity change pings (which
  // story/order changed, and by whom) and EventSource can't send a Bearer
  // token, so it bypasses the module gate. The actual data is still fetched
  // through auth-gated endpoints.
  if (req.path === "/api/events") return next();

  try {
    const me = await resolveUser(req);
    if (!me) return res.status(401).json({ error: "Sign in required." });
    req.me = me;

    if (OPEN_ENDPOINTS.has(req.path)) return next();

    const rule = ROUTE_MODULE.find(([re]) => re.test(req.path));
    if (rule && !can(me, rule[1])) {
      const moduleId = rule[1];
      return res.status(403).json({
        error: MODULES[moduleId].adminOnly ? "Admins only." : `No access to "${moduleId}".`,
      });
    }
    return next();
  } catch (err) {
    console.error("[auth gate]", err);
    return res.status(401).json({ error: "Authentication failed." });
  }
});

app.use("/uploads", express.static(UPLOAD_DIR));

// ---------------------------------------------------------------------------
// Live updates (Server-Sent Events)
// ---------------------------------------------------------------------------
// A tiny in-memory pub/sub so two people editing the same story see each
// other's changes. Clients open an EventSource on /api/events; every time a
// story/order mutating request succeeds we broadcast a small "changed" ping and
// each client re-fetches the affected item. This keeps the data flow simple
// (no shared-document CRDT) while giving near-instant live sync for a small team.
const sseClients = new Set();

function broadcastEvent(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      // A dead socket is cleaned up by its own 'close' handler.
    }
  }
}

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering (nginx / Railway edge) so events flush immediately.
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.write(`data: ${JSON.stringify({ type: "connected", at: Date.now() })}\n\n`);

  sseClients.add(res);

  // Heartbeat keeps idle proxies from dropping the long-lived connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Broadcast a change ping whenever a story/order mutating request succeeds.
// Hooks the response 'finish' event so it covers every existing handler (cells,
// kid photos, generate, title, order edits, …) without touching each one. The
// originating client id is echoed so a client can ignore its own writes.
app.use((req, res, next) => {
  const mutating = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
  const match = /^\/api\/(stories|orders)(?:\/([^/?]+))?/.exec(req.path);
  if (mutating && match) {
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      broadcastEvent({
        type: match[1] === "stories" ? "story-changed" : "order-changed",
        // `id` is the affected item for edits, or null for list-level changes
        // (create/delete) — clients refresh their list either way.
        id: match[2] ? decodeURIComponent(match[2]) : null,
        clientId: req.get("x-client-id") || null,
        by: req.me?.email || null,
        at: Date.now(),
      });
    });
  }
  next();
});

// ---------------------------------------------------------------------------
// History / audit log
// ---------------------------------------------------------------------------
// Every successful mutating request is recorded as a single history entry so
// admins can see who changed what, and drill into the full timeline of any one
// item. The rules that turn a request into a label live in ./audit.js; here we
// just capture context (actor, created id, before-name for deletes) and append.
const HISTORY_MAX = 3000;

// A short, friendly name for an entity so the log reads "Story · My Book"
// rather than just an opaque id.
function entityName(db, entity, id) {
  if (!id) return null;
  if (entity === "story") return db.stories?.[id]?.title || null;
  if (entity === "order") return db.orders?.[id]?.title || null;
  if (entity === "customer") return db.customers?.[id]?.name || null;
  if (entity === "country") return db.countries?.[id]?.name || id;
  if (entity === "variable") return db.variables?.[id]?.name || null;
  if (entity === "access") return id; // the email is the name
  return null;
}

async function recordHistory(req, res, desc) {
  // Prefer the response payload (covers create/edit, which return the entity),
  // then fall back to the name snapshotted before a delete.
  const body = res._auditBody && typeof res._auditBody === "object" ? res._auditBody : {};
  const entityId = desc.entityId || body.id || null;
  const target = entityId ? `${desc.entity}:${entityId}` : desc.entity;
  const name = body.title || body.name || req._auditBeforeName || null;

  const entry = {
    id: nanoid(10),
    at: Date.now(),
    actor: req.me?.email || "local",
    entity: desc.entity,
    entityId,
    target,
    name,
    action: buildActionLabel(desc, req),
    method: req.method,
    path: req.path,
  };

  const db = await readDb();
  if (!Array.isArray(db.history)) db.history = [];
  db.history.unshift(entry);
  if (db.history.length > HISTORY_MAX) db.history.length = HISTORY_MAX;
  await writeDb(db);
}

app.use(async (req, res, next) => {
  let desc = null;
  try {
    desc = describeChange(req);
  } catch {
    desc = null;
  }
  if (!desc) return next();

  // Capture whatever the handler sends back, so we can learn a created entity's
  // id/title for accurate grouping and labels.
  const origJson = res.json.bind(res);
  res.json = (payload) => {
    res._auditBody = payload;
    return origJson(payload);
  };

  // A delete removes the entity, so grab its name now while it still exists.
  if (req.method === "DELETE" && desc.entityId) {
    try {
      const db = await readDb();
      req._auditBeforeName = entityName(db, desc.entity, desc.entityId);
    } catch {
      /* best-effort */
    }
  }

  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    recordHistory(req, res, desc).catch((err) => console.error("[history]", err.message));
  });
  next();
});

const asyncHandler = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    // fal client errors carry a structured `body` (often a FastAPI-style
    // validation `detail`) that explains exactly what was rejected. Surface it
    // instead of the opaque "Unprocessable Entity".
    const body = err?.body;
    if (body) {
      console.error(`[${req.method} ${req.path}] fal error ${err.status || ""}:`, err.message);
      try {
        console.error(JSON.stringify(body, null, 2));
      } catch {
        console.error(body);
      }
    } else {
      console.error(`[${req.method} ${req.path}]`, err);
    }

    let message = err?.message || "Internal error";
    const detail = body?.detail;
    if (Array.isArray(detail) && detail.length) {
      const d = detail[0];
      const loc = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
      message = `AI service rejected the request${loc ? ` (field: ${loc})` : ""}: ${
        d?.msg || message
      }`;
    } else if (typeof detail === "string") {
      message = detail;
    }
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: message });
  });

// --- Config / status ----------------------------------------------------------
app.get(
  "/api/config",
  asyncHandler(async (_req, res) => {
    res.json({
      falConfigured: Boolean(process.env.FAL_KEY),
      checkerEnabled: isCheckerEnabled(),
      defaultPrompt: DEFAULT_PROMPT,
      anchorPrompt: ANCHOR_PROMPT,
    });
  })
);

// --- Settings (API keys) ------------------------------------------------------
const ENV_PATH = path.join(__dirnameEnv, ".env");
const ANCHOR_PROVIDERS = ["nano_banana", "gpt_image_2"];

// Show a key exists without leaking it: keep the first/last few characters only.
function maskKey(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

// Update (or append) KEY=VALUE pairs in server/.env, leaving other lines intact.
async function upsertEnv(updates) {
  let text = "";
  try {
    text = await fs.readFile(ENV_PATH, "utf8");
  } catch {
    text = "";
  }
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]] ?? ""}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value ?? ""}`);
  }
  const result = next.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  await fs.writeFile(ENV_PATH, result, "utf8");
}

function settingsPayload() {
  return {
    falKey: { set: Boolean(process.env.FAL_KEY), masked: maskKey(process.env.FAL_KEY) },
    geminiKey: {
      set: Boolean(process.env.GEMINI_API_KEY),
      masked: maskKey(process.env.GEMINI_API_KEY),
    },
    anchorProvider: (process.env.ANCHOR_PROVIDER || "nano_banana").toLowerCase(),
    checkerEnabled: isCheckerEnabled(),
  };
}

app.get(
  "/api/settings",
  asyncHandler(async (_req, res) => {
    res.json(settingsPayload());
  })
);

app.put(
  "/api/settings",
  asyncHandler(async (req, res) => {
    const { falKey, geminiKey, anchorProvider } = req.body || {};
    const updates = {};

    // Only overwrite a key when a non-empty string is sent, so leaving the field
    // blank in the UI keeps the existing secret instead of wiping it.
    if (typeof falKey === "string" && falKey.trim()) {
      updates.FAL_KEY = falKey.trim();
      setFalKey(falKey.trim());
    }
    if (typeof geminiKey === "string" && geminiKey.trim()) {
      updates.GEMINI_API_KEY = geminiKey.trim();
      process.env.GEMINI_API_KEY = geminiKey.trim();
    }
    if (typeof anchorProvider === "string") {
      const p = anchorProvider.toLowerCase();
      if (!ANCHOR_PROVIDERS.includes(p)) {
        return res.status(400).json({ error: `Unknown anchor provider: ${anchorProvider}` });
      }
      updates.ANCHOR_PROVIDER = p;
      process.env.ANCHOR_PROVIDER = p;
    }

    if (Object.keys(updates).length) {
      // Durable store: keep settings in the database so they survive restarts
      // and redeploys (the .env file lives on ephemeral container storage).
      const db = await readDb();
      db.settings = { ...(db.settings || {}), ...updates };
      await writeDb(db);
      // Best-effort local convenience copy; ephemeral in production.
      try {
        await upsertEnv(updates);
      } catch {
        // ignore — the database copy above is the source of truth
      }
    }
    res.json({ ok: true, ...settingsPayload() });
  })
);

// Verify the fal.ai key works. Tests a pasted key when provided, otherwise the
// currently configured one. Admin-only via the /api/settings route gate.
app.post(
  "/api/settings/test-fal",
  asyncHandler(async (req, res) => {
    const override =
      typeof req.body?.falKey === "string" && req.body.falKey.trim()
        ? req.body.falKey.trim()
        : undefined;
    try {
      await testFalKey(override);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err?.message || "The fal.ai key check failed." });
    }
  })
);

// --- Access / team ------------------------------------------------------------
// Static description of the access model, sent alongside every access response
// so the client can render labels/icons/role options without duplicating them.
const ACCESS_META = {
  authEnabled: AUTH_ENABLED,
  modules: MODULES,
  moduleIds: MODULE_IDS,
  assignableModules: ASSIGNABLE_MODULES,
  adminOnlyModules: ADMIN_ONLY_MODULES,
  roles: ROLES,
};

// Normalize a stored record for the wire: ensure a `modules` array (migrating
// the legacy `pages` field) and drop internal-only bookkeeping.
function publicUser(record) {
  const role = record.role === "admin" ? "admin" : "member";
  return {
    email: record.email,
    role,
    modules: role === "admin" ? ASSIGNABLE_MODULES.slice() : sanitizeModules(record.modules ?? record.pages),
    // Member country grants (admins are implicitly all, so we leave it empty).
    countries: role === "admin" ? [] : Array.isArray(record.countries) ? record.countries : [],
    invitedAt: record.invitedAt || 0,
  };
}

// Who the current request is. When auth is disabled this returns a synthetic
// admin so the app stays fully usable with no Clerk setup.
app.get(
  "/api/access/me",
  asyncHandler(async (req, res) => {
    if (!AUTH_ENABLED) {
      const db = await readDb();
      const codes = enabledCountries(db.countries).map((c) => c.code);
      const user = { email: "", role: "admin", modules: ASSIGNABLE_MODULES.slice() };
      return res.json({ ...ACCESS_META, ...user, isAdmin: true, modules: visibleModules(user), countries: codes });
    }
    const me = req.me;
    res.json({
      ...ACCESS_META,
      email: me.email,
      role: me.role,
      isAdmin: me.isAdmin,
      modules: me.modules,
      countries: me.countries,
    });
  })
);

app.get(
  "/api/access/users",
  asyncHandler(async (_req, res) => {
    const db = await readDb();
    const users = Object.values(db.access?.users || {})
      .sort((a, b) => (b.invitedAt || 0) - (a.invitedAt || 0))
      .map(publicUser);
    res.json({ ...ACCESS_META, users });
  })
);

app.post(
  "/api/access/users",
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email is required." });
    }
    const role = normalizeRole(req.body?.role);
    const modules =
      role === "admin" ? ASSIGNABLE_MODULES.slice() : sanitizeModules(req.body?.modules ?? req.body?.pages);

    const db = await readDb();
    if (!db.access) db.access = { users: {} };
    if (!db.access.users) db.access.users = {};
    if (db.access.users[email]) {
      return res.status(409).json({ error: "That person already has access." });
    }
    // Members can be scoped to specific countries; admins are implicitly all.
    const countries = role === "admin" ? [] : sanitizeCountries(req.body?.countries, db.countries);
    db.access.users[email] = { email, role, modules, countries, invitedAt: Date.now() };
    await writeDb(db);
    res.json({ ok: true, user: publicUser(db.access.users[email]) });
  })
);

app.put(
  "/api/access/users/:email",
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const db = await readDb();
    const record = db.access?.users?.[email];
    if (!record) return res.status(404).json({ error: "User not found." });

    // Don't let an admin lock themselves out by self-demoting.
    if (AUTH_ENABLED && req.me?.email === email && req.body?.role === "member") {
      return res.status(400).json({ error: "You can't remove your own admin access." });
    }

    if (req.body?.role !== undefined) record.role = normalizeRole(req.body.role);
    const incomingModules = req.body?.modules ?? req.body?.pages;
    if (record.role === "admin") record.modules = ASSIGNABLE_MODULES.slice();
    else if (Array.isArray(incomingModules)) record.modules = sanitizeModules(incomingModules);
    delete record.pages; // drop the legacy field once touched

    // Country grants follow the same rule: admins are all (cleared), members keep
    // their explicit list.
    if (record.role === "admin") record.countries = [];
    else if (Array.isArray(req.body?.countries))
      record.countries = sanitizeCountries(req.body.countries, db.countries);

    await writeDb(db);
    res.json({ ok: true, user: publicUser(record) });
  })
);

app.delete(
  "/api/access/users/:email",
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    if (AUTH_ENABLED && req.me?.email === email) {
      return res.status(400).json({ error: "You can't remove your own access." });
    }
    const db = await readDb();
    if (db.access?.users?.[email]) {
      delete db.access.users[email];
      await writeDb(db);
    }
    res.json({ ok: true });
  })
);

// --- History / audit log ------------------------------------------------------
// Admin-only (gated by the "history" module). Supports optional filtering by
// `target` (for an item's related timeline), `entity`, or `actor`.
app.get(
  "/api/history",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    let entries = Array.isArray(db.history) ? db.history : [];
    const { target, entity, actor } = req.query;
    if (target) entries = entries.filter((e) => e.target === target);
    if (entity) entries = entries.filter((e) => e.entity === entity);
    if (actor) entries = entries.filter((e) => e.actor === actor);
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), HISTORY_MAX);
    res.json({ authEnabled: AUTH_ENABLED, entries: entries.slice(0, limit) });
  })
);

// --- Stories ------------------------------------------------------------------
app.get(
  "/api/stories",
  asyncHandler(async (_req, res) => {
    const db = await readDb();
    res.json(Object.values(db.stories).sort((a, b) => b.createdAt - a.createdAt));
  })
);

app.get(
  "/api/stories/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    // Lazily migrate legacy stories to the cast model before returning.
    if (!Array.isArray(story.characters) || story.characters.length === 0) {
      ensureCharacters(story);
      await writeDb(db);
    }
    res.json(story);
  })
);

app.post(
  "/api/stories",
  asyncHandler(async (req, res) => {
    const { title, titleEn, titleAr, age, gender, language, aspect } = req.body || {};
    const en = (titleEn || "").trim();
    const ar = (titleAr || "").trim();
    const db = await readDb();
    const id = nanoid(8);
    db.stories[id] = {
      id,
      // Primary title for display/back-compat: explicit title, else English, else Arabic.
      title: ((title || en || ar) || "Untitled story").trim(),
      titleEn: en,
      titleAr: ar,
      age: age != null && age !== "" ? Number(age) : null,
      gender: gender || "female",
      language: language === "ar" ? "ar" : "en",
      aspect: /^\d+:\d+$/.test(aspect || "") ? aspect : "3:4",
      createdAt: Date.now(),
      // Lifecycle: "draft" until every AI page is approved for every test child,
      // then "published". Orders may only be created for published stories.
      status: "draft",
      // Story-wide AI generation knobs applied to every page (and replayed by
      // orders). Per-scene overrides live on each scene.
      styleSettings: { ...DEFAULT_STYLE_SETTINGS },
      scenes: [],
      kids: {},
      // Calibration children used to validate the story before publishing.
      testKidIds: [],
      results: {},
      // Cast: the children this story features. Single-character by default; a
      // multi-kid story adds more and pins them to face slots per scene.
      characters: [
        { id: nanoid(8), key: "child", label: "Child", gender: gender || "female" },
      ],
    };
    await writeDb(db);
    res.status(201).json(db.stories[id]);
  })
);

app.delete(
  "/api/stories/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    if (!db.stories[req.params.id])
      return res.status(404).json({ error: "Story not found" });
    delete db.stories[req.params.id];
    await writeDb(db);
    res.json({ ok: true });
  })
);

// --- Scene uploads ------------------------------------------------------------
app.post(
  "/api/stories/:id/scenes",
  upload.array("scenes", 50),
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });

    // Upload each scene to fal and "understand" it (vision → reusable story/style
    // prompt) so identity-mode generation can recreate the story with any child.
    const lang = req.body?.lang === "ar" ? "ar" : "en";
    const added = await Promise.all(
      (req.files || []).map(async (file) => {
        const localUrl = `/uploads/${file.filename}`;
        let falUrl = null;
        let storyPrompt = null;
        try {
          falUrl = await uploadToFal(path.join(UPLOAD_DIR, file.filename));
          storyPrompt = (await describeScene(falUrl)) || null;
        } catch (e) {
          console.warn("scene understanding failed:", e.message);
        }
        return {
          id: nanoid(8),
          lang,
          fileName: file.filename,
          localUrl,
          falUrl,
          storyPrompt,
        };
      })
    );
    for (const scene of added) story.scenes.push(scene);
    await writeDb(db);
    res.json(story);
  })
);

// --- Reorder scenes (book page order) -----------------------------------------
app.put(
  "/api/stories/:id/scenes/order",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });

    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    const byId = new Map(story.scenes.map((s) => [s.id, s]));
    const reordered = order.map((id) => byId.get(id)).filter(Boolean);
    // Append any scenes the client didn't mention so nothing is lost.
    for (const s of story.scenes) if (!order.includes(s.id)) reordered.push(s);
    story.scenes = reordered;

    markStoryDraft(story);
    await writeDb(db);
    res.json(story);
  })
);

// --- Delete a single scene ----------------------------------------------------
app.delete(
  "/api/stories/:id/scenes/:sceneId",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });

    const idx = story.scenes.findIndex((s) => s.id === req.params.sceneId);
    if (idx === -1) return res.status(404).json({ error: "Scene not found" });

    const [removed] = story.scenes.splice(idx, 1);

    // Drop any generated results tied to this scene.
    for (const kidId of Object.keys(story.results || {})) {
      delete story.results[kidId][req.params.sceneId];
    }
    markStoryDraft(story);

    // Best-effort delete of the uploaded file.
    if (removed?.fileName) {
      await fs
        .unlink(path.join(UPLOAD_DIR, removed.fileName))
        .catch(() => {});
    }

    await writeDb(db);
    res.json(story);
  })
);

// --- Cells (book pages: image or text, single/double width) -------------------
// Cells are stored in `story.scenes` (legacy name). A cell with no `type` is an
// image cell for backward compatibility.
app.post(
  "/api/stories/:id/cells",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const { type, size, text, lang } = req.body || {};
    const cell = {
      id: nanoid(8),
      // Which language book this page belongs to ("en" | "ar").
      lang: lang === "ar" ? "ar" : "en",
      type: type === "text" ? "text" : "image",
      size: size === "double" ? "double" : "single",
      text: type === "text" ? text || "" : "",
      fileName: null,
      localUrl: null,
      falUrl: null,
      storyPrompt: null,
      bgFileName: null,
      bgUrl: null,
      bgFalUrl: null,
    };
    story.scenes.push(cell);
    markStoryDraft(story);
    await writeDb(db);
    res.status(201).json(story);
  })
);

// Copy every page from one language book into the other, replacing whatever was
// there. Pages are deep-cloned with fresh ids (so generated results don't carry
// over) but keep the same layout, text, images and per-page settings.
app.post(
  "/api/stories/:id/cells/copy-language",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const from = req.body?.from === "ar" ? "ar" : "en";
    const to = req.body?.to === "ar" ? "ar" : "en";
    if (from === to) return res.status(400).json({ error: "Source and target language must differ" });

    const source = (story.scenes || []).filter((s) => (s.lang || "en") === from);
    if (source.length === 0)
      return res.status(400).json({ error: `The ${from === "ar" ? "Arabic" : "English"} book has no pages to copy.` });

    const others = (story.scenes || []).filter((s) => (s.lang || "en") !== to);
    const clones = source.map((s) => {
      const copy = JSON.parse(JSON.stringify(s));
      copy.id = nanoid(8);
      copy.lang = to;
      return copy;
    });
    story.scenes = [...others, ...clones];
    markStoryDraft(story);
    await writeDb(db);
    res.json(story);
  })
);

app.put(
  "/api/stories/:id/cells/:cellId",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const cell = story.scenes.find((s) => s.id === req.params.cellId);
    if (!cell) return res.status(404).json({ error: "Cell not found" });
    const { text, size, type, style, elements, bgUrl, bgFalUrl, bgColor, safeZones, kidSlots, sides, identityScoring, identityScoringManual, identityNote, genChoice, correction, aiPrompt } = req.body || {};
    if (["strict", "advisory", "none"].includes(identityScoring)) cell.identityScoring = identityScoring;
    if (typeof identityScoringManual === "boolean") cell.identityScoringManual = identityScoringManual;
    if (typeof identityNote === "string") cell.identityNote = identityNote;
    // Per-scene generation overrides (method/mode choice + correction note).
    const GEN_CHOICES = ["compose", "headswap", "identity", "faceswap"];
    if (genChoice === null || genChoice === "") cell.genChoice = null;
    else if (GEN_CHOICES.includes(genChoice)) cell.genChoice = genChoice;
    if (typeof correction === "string") cell.correction = correction;
    if (typeof aiPrompt === "string") cell.aiPrompt = aiPrompt;
    if (typeof text === "string") cell.text = text;
    if (size === "single" || size === "double") cell.size = size;
    if (type === "text" || type === "image") cell.type = type;
    if (style && typeof style === "object") cell.style = { ...(cell.style || {}), ...style };
    if (Array.isArray(elements)) cell.elements = elements;
    if (Array.isArray(safeZones)) cell.safeZones = safeZones;
    if (Array.isArray(kidSlots)) cell.kidSlots = kidSlots;
    // Per-side design ({ left, right }): each side is an independent page the
    // press prints together on one sheet.
    if (sides && typeof sides === "object") cell.sides = sides;
    if (bgUrl !== undefined) cell.bgUrl = bgUrl;
    if (bgFalUrl !== undefined) cell.bgFalUrl = bgFalUrl;
    if (typeof bgColor === "string") cell.bgColor = bgColor;
    // Editing a page's actual content (text/layout/image/bg) invalidates the
    // approved test renders → back to draft. Changing only the scoring level or
    // note doesn't alter any rendered image, so it leaves publish intact.
    const contentChanged =
      typeof text === "string" ||
      size === "single" ||
      size === "double" ||
      type === "text" ||
      type === "image" ||
      (style && typeof style === "object") ||
      Array.isArray(elements) ||
      Array.isArray(safeZones) ||
      Array.isArray(kidSlots) ||
      (sides && typeof sides === "object") ||
      bgUrl !== undefined ||
      bgFalUrl !== undefined ||
      typeof bgColor === "string" ||
      genChoice !== undefined ||
      typeof correction === "string" ||
      typeof aiPrompt === "string";
    if (contentChanged) markStoryDraft(story);
    await writeDb(db);
    res.json(story);
  })
);

// Analyze each page once (at story-design time) and classify how its identity
// should be scored per order: strict / advisory / none. Manual overrides are
// preserved. Lets every order know up front what to expect from each page.
app.post(
  "/api/stories/:id/analyze",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });

    for (const scene of story.scenes) {
      if (scene.identityScoringManual) continue; // never clobber a manual choice
      let baseUrl = null;
      try {
        baseUrl = await ensureBaseFalUrl(scene);
      } catch {
        baseUrl = null;
      }
      if (!baseUrl) {
        scene.identityScoring = "none";
        scene.identityNote = "No AI character on this page";
        continue;
      }
      const { level, note } = await classifyFaceVisibility(baseUrl);
      scene.identityScoring = level;
      scene.identityNote = note;
    }

    await writeDb(db);
    res.json(story);
  })
);

app.post(
  "/api/stories/:id/cells/:cellId/image",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const cell = story.scenes.find((s) => s.id === req.params.cellId);
    if (!cell) return res.status(404).json({ error: "Cell not found" });
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    cell.type = "image";
    cell.fileName = req.file.filename;
    cell.localUrl = `/uploads/${req.file.filename}`;
    cell.text = "";
    try {
      cell.falUrl = await uploadToFal(path.join(UPLOAD_DIR, req.file.filename));
      cell.storyPrompt = (await describeScene(cell.falUrl)) || null;
    } catch (e) {
      console.warn("scene understanding failed:", e.message);
    }
    markStoryDraft(story);
    await writeDb(db);
    res.json(story);
  })
);

// Background image behind a cell's content (decorative; no AI processing).
app.post(
  "/api/stories/:id/cells/:cellId/background",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const cell = story.scenes.find((s) => s.id === req.params.cellId);
    if (!cell) return res.status(404).json({ error: "Cell not found" });
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    cell.bgFileName = req.file.filename;
    cell.bgUrl = `/uploads/${req.file.filename}`;
    try {
      cell.bgFalUrl = await uploadToFal(path.join(UPLOAD_DIR, req.file.filename));
    } catch (e) {
      console.warn("background upload to fal failed:", e.message);
      cell.bgFalUrl = null;
    }
    await writeDb(db);
    res.json(story);
  })
);

app.delete(
  "/api/stories/:id/cells/:cellId/background",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const cell = story.scenes.find((s) => s.id === req.params.cellId);
    if (!cell) return res.status(404).json({ error: "Cell not found" });
    cell.bgFileName = null;
    cell.bgUrl = null;
    cell.bgFalUrl = null;
    await writeDb(db);
    res.json(story);
  })
);

// Generic media upload for editor elements (images dropped onto a page).
// Returns the local url immediately. The fal upload is a slow remote round-trip
// and is NOT needed just to place a decorative image on the canvas — it's only
// required when the image becomes an AI generation base, which is uploaded to
// fal lazily on demand (see aiBaseFalUrl). Pass ?fal=1 to force it inline.
app.post(
  "/api/media",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    const url = `/uploads/${req.file.filename}`;
    if (req.query.fal === "1") {
      let falUrl = null;
      try {
        falUrl = await uploadToFal(path.join(UPLOAD_DIR, req.file.filename));
      } catch (e) {
        console.warn("media upload to fal failed:", e.message);
      }
      return res.status(201).json({ url, falUrl });
    }
    res.status(201).json({ url, falUrl: null });
  })
);

async function safeDownload(url, name) {
  try {
    return await downloadToUploads(url, name);
  } catch {
    return url;
  }
}

// Persist a single kid's fields back into the db (re-read to avoid clobbering).
async function patchKid(storyId, kidId, patch) {
  const db = await readDb();
  const story = db.stories[storyId];
  if (!story?.kids[kidId]) return null;
  Object.assign(story.kids[kidId], patch);
  await writeDb(db);
  return story.kids[kidId];
}

// A fresh kid record (used by stories and orders).
function newKid(file) {
  return {
    id: nanoid(8),
    fileName: file.filename,
    localUrl: `/uploads/${file.filename}`,
    rawFalUrl: null,
    restoredFalUrl: null,
    restoredLocal: null,
    // Faithful identity anchor — the reference used for generation + scoring.
    identityAnchorFalUrl: null,
    identityAnchorLocal: null,
    identityAnchorCheck: null,
    identityAnchorWeak: false,
    // Prettier parent-facing portrait — shown in UI, never used as identity.
    presentationFalUrl: null,
    presentationLocal: null,
    // Legacy aliases (kept so older UI/scoring keeps working). anchorFalUrl
    // mirrors the identity anchor; anchorLocal prefers the presentation portrait.
    anchorFalUrl: null,
    anchorLocal: null,
    anchorCheck: null,
    features: null,
    featuresStruct: null,
    // Photo intake gate (see validateKidPhoto / derivePhotoStatus).
    // rawPhotoCheck   — validation of the originally uploaded photo
    // restoredPhotoCheck — validation re-run after auto-enhancement (if attempted)
    // photoStatus     — accepted | fixable | needs_new_photo | review
    // photoFixAttempted — true once auto-enhancement ran for a fixable photo
    // photoFailureReason — human explanation when status is needs_new_photo
    // restoreOutcome  — "skipped" (original used) | "used" | "discarded"
    rawPhotoCheck: null,
    restoredPhotoCheck: null,
    photoStatus: null,
    photoFixAttempted: false,
    photoFailureReason: null,
    restoreOutcome: null,
    // "test" for calibration children on a story; null for order children.
    role: null,
  };
}

// Shared 400 message when a photo failed the intake gate.
const PHOTO_GATE_MESSAGE = "Photo is not suitable. Please upload a clearer front-facing photo.";

// Informational note stored on stylized (filtered/made-up) but otherwise usable
// photos. Not a rejection — the anchor step neutralizes the styling.
const STYLIZED_PHOTO_NOTE = "photo is stylized; anchor should neutralize makeup/filter";

// Turn a validation result into a human explanation for a rejected photo.
function photoFailureReason(check) {
  const reasons = (check?.reasons || []).filter(Boolean);
  if (reasons.length) return reasons.join("; ");
  return "The photo can't be used as a clear identity reference.";
}

// The note shown for a given status: the failure reason when rejected, a
// stylization note when the photo is merely filtered/made-up, else nothing.
function photoStatusNote(check, status) {
  if (status === "needs_new_photo") return photoFailureReason(check);
  if (check?.stylized) return STYLIZED_PHOTO_NOTE;
  return null;
}

// Validate the RAW upload and set initial intake-gate fields on the kid.
async function applyRawPhotoCheck(kid) {
  const check = await validateKidPhoto(kid.rawFalUrl);
  kid.rawPhotoCheck = check;
  kid.restoredPhotoCheck = null;
  kid.photoFixAttempted = false;
  kid.photoStatus = derivePhotoStatus(check, "raw");
  kid.photoFailureReason = photoStatusNote(check, kid.photoStatus);
  return kid;
}

// Decide whether the photo needs restoration. We restore ONLY for genuine
// fixable quality problems (low res, blur, noise, lighting, compression, faded /
// mild color damage). We do NOT restore just because the photo is stylized
// (filter/makeup) — a clear stylized photo goes straight to the anchor, which
// neutralizes the styling.
function needsRestore(rawCheck) {
  return Boolean(rawCheck?.fixable);
}

// Did the restored image REGRESS vs the raw photo? If so we discard it and fall
// back to the original. (The raw photo already passed the intake gate — a
// needs_new_photo raw would have been blocked before reaching restore.)
function restoreRegressed(rawCheck, restoredCheck) {
  if (!restoredCheck) return false;
  const c = restoredCheck.checks || {};
  if (c.exactlyOneChild === false) return true; // multiple faces / a new person appeared
  if (c.faceClearlyVisible === false) return true; // face no longer clearly visible
  if (restoredCheck.identityCritical) return true; // restore introduced a critical problem
  if (
    typeof restoredCheck.score === "number" &&
    typeof rawCheck?.score === "number" &&
    restoredCheck.score < rawCheck.score
  )
    return true; // identity usability got worse
  return false;
}

// ---- Shared, storage-agnostic pipeline steps (operate on a kid object) --------

// Conditionally restore/enhance the photo, then extract the child's feature spec
// from whichever image we end up trusting. Returns a patch. The decision is
// recorded in `restoreOutcome`: "skipped" (original used) | "used" (restored
// improved the image) | "discarded" (restore made it worse → original used).
async function runRestore(kid) {
  const rawCheck = kid.rawPhotoCheck;
  const shouldRestore = needsRestore(rawCheck);

  let identitySource = kid.rawFalUrl; // image the anchor + features will use
  let restoreOutcome = "skipped";
  let restoredFalUrl = null;
  let restoredLocal = null;
  let restoredPhotoCheck = null;

  if (shouldRestore) {
    let enhancedUrl = null;
    try {
      enhancedUrl = await restorePhoto(kid.rawFalUrl);
    } catch (e) {
      console.warn("restore failed, using raw:", e.message);
    }
    if (enhancedUrl && enhancedUrl !== kid.rawFalUrl) {
      // Re-run the checker on the enhanced image to catch regressions.
      restoredPhotoCheck = await validateKidPhoto(enhancedUrl);
      if (restoreRegressed(rawCheck, restoredPhotoCheck)) {
        console.warn("restored image worse than raw — discarding, using original photo.");
        restoreOutcome = "discarded";
      } else {
        restoreOutcome = "used";
        identitySource = enhancedUrl;
        restoredFalUrl = enhancedUrl;
        restoredLocal = await safeDownload(enhancedUrl, `restored-${nanoid(6)}.png`);
      }
    }
    // enhancedUrl null / unchanged → restore unavailable or no-op → keep original.
  }

  const [features, featuresStruct] = await Promise.all([
    describeChildFeatures(identitySource),
    describeChildFeaturesStruct(identitySource),
  ]);
  if (features) console.log("extracted child features:", features);
  if (featuresStruct) console.log("extracted structured features:", featuresStruct);

  // The intake gate already validated the RAW photo; restore is only a quality
  // step and never downgrades a usable photo to needs_new_photo. Normalize the
  // transient "fixable" status to a terminal one.
  const photoStatus = kid.photoStatus === "fixable" ? "accepted" : kid.photoStatus || "accepted";

  return {
    restoredFalUrl,
    restoredLocal,
    restoredPhotoCheck,
    restoreOutcome,
    photoFixAttempted: shouldRestore,
    photoStatus,
    photoFailureReason: photoStatusNote(rawCheck, photoStatus),
    features: features || null,
    featuresStruct: featuresStruct || null,
  };
}

// Minimum identity-match score for the identity anchor to be trusted as the main
// generation reference. Below this, we treat the anchor as "weak" (it drifted
// from the real child) and rely on the restored/raw photo instead.
const ANCHOR_MIN_SCORE = 85;

// Build BOTH anchors and gate the identity anchor:
//   - identityAnchor: faithful, used for generation + scoring
//   - presentationPortrait: prettier, parent-facing only (best-effort)
// The identity anchor is scored against the restored/raw photo; if it drifts
// (score < ANCHOR_MIN_SCORE or judged a different child) it's flagged weak so
// generation falls back to the real photo. Returns a patch.
async function runAnchor(kid, anchorPrompt) {
  const sourceUrl = kid.restoredFalUrl || kid.rawFalUrl;

  // If intake flagged the photo as stylized (filter/makeup), tell the anchor to
  // neutralize it so the identity reference looks like a natural child.
  const stylized = Boolean(kid.restoredPhotoCheck?.stylized || kid.rawPhotoCheck?.stylized);
  const baseAnchorPrompt = (anchorPrompt || IDENTITY_ANCHOR_PROMPT).trim();

  // ONLY the identity anchor is provider-switchable; the presentation portrait
  // stays on Nano Banana. GPT-Image-2 uses its own concise prompt (which already
  // neutralizes makeup/filters); Nano Banana keeps the detailed faithful prompt
  // plus the stylized directive when the intake flagged styling.
  // Identity source: restored photo only when restore was accepted ("used");
  // skipped/discarded leave restoredFalUrl null, so this resolves to the raw
  // uploaded photo — exactly the required behavior.
  const useGptImage = useGptImageModel();
  const provider = useGptImage ? "gpt_image_2" : "nano_banana";
  const identityPrompt = useGptImage
    ? (anchorPrompt || GPT_IMAGE_ANCHOR_PROMPT).trim()
    : stylized
    ? `${baseAnchorPrompt} ${STYLIZED_ANCHOR_DIRECTIVE}`
    : baseAnchorPrompt;

  const generateIdentity = async () => {
    if (useGptImage) {
      console.log(
        `anchor provider: gpt_image_2 endpoint: ${GPT_IMAGE_2_ENDPOINT} kidId=${kid.id} — generating`
      );
      const { url, requestId } = await gptImage2Edit({
        imageUrl: sourceUrl,
        prompt: identityPrompt,
        imageSize: "square_hd",
        quality: "medium",
        outputFormat: "png",
      });
      console.log(
        `anchor provider: gpt_image_2 endpoint: ${GPT_IMAGE_2_ENDPOINT} kidId=${kid.id} falRequestId=${
          requestId || "n/a"
        } — ok`
      );
      return url;
    }
    const a = await nanoEdit({ imageUrls: [sourceUrl], prompt: identityPrompt, resolution: "2K" });
    return a.url;
  };

  // Faithful identity anchor (and the prettier portrait) in parallel.
  const [identity, presentation] = await Promise.all([
    generateIdentity()
      .then(async (rawUrl) => {
        const fal = await padToSquareFal(rawUrl, 1024).catch(() => rawUrl);
        return { falUrl: fal, local: await safeDownload(fal, `idanchor-${nanoid(6)}.png`) };
      })
      .catch((e) => {
        console.warn(
          `identity anchor failed (provider=${provider}), falling back to restored photo:`,
          e.message
        );
        return { falUrl: sourceUrl, local: kid.restoredLocal || kid.localUrl };
      }),
    nanoEdit({
      imageUrls: [sourceUrl],
      prompt: PRESENTATION_PORTRAIT_PROMPT.trim(),
      resolution: "2K",
    })
      .then(async (p) => {
        const fal = await padToSquareFal(p.url, 1024).catch(() => p.url);
        return { falUrl: fal, local: await safeDownload(fal, `portrait-${nanoid(6)}.png`) };
      })
      .catch((e) => {
        console.warn("presentation portrait failed:", e.message);
        return { falUrl: null, local: null };
      }),
  ]);

  // Acceptance gate: does the identity anchor still look like the real child?
  const identityAnchorCheck = await checkConsistency({
    referenceUrl: kid.restoredFalUrl || kid.rawFalUrl,
    candidateUrl: identity.falUrl,
  });
  const score = identityAnchorCheck?.score;
  const identityAnchorWeak =
    identity.falUrl !== sourceUrl &&
    ((typeof score === "number" && score < ANCHOR_MIN_SCORE) ||
      identityAnchorCheck?.same_child === false ||
      // Discard an anchor that drifted the child's hair (color/style) from the
      // source even if the face score is high.
      identityAnchorCheck?.hair_changed === true);
  if (identityAnchorWeak) {
    console.warn(
      `identity anchor weak (score ${score ?? "?"}${
        identityAnchorCheck?.hair_changed ? ", hair changed" : ""
      }) — generation will rely on the restored/raw photo instead.`
    );
  }

  return {
    identityAnchorFalUrl: identity.falUrl,
    identityAnchorLocal: identity.local,
    identityAnchorCheck,
    identityAnchorWeak,
    presentationFalUrl: presentation.falUrl,
    presentationLocal: presentation.local,
    // Legacy aliases: keep generation/scoring working via anchorFalUrl, and show
    // the prettier portrait in the UI when available.
    anchorFalUrl: identity.falUrl,
    anchorLocal: presentation.local || identity.local,
    anchorCheck: identityAnchorCheck,
  };
}

// Ordered identity references for generation. Strongest, most faithful sources
// first (restored, then raw photo); the identity anchor is appended ONLY when it
// passed the acceptance gate, so a drifted anchor never dominates likeness.
function identityRefs(kid) {
  const list = [kid.restoredFalUrl, kid.rawFalUrl || kid.falUrl];
  if (kid.identityAnchorFalUrl && !kid.identityAnchorWeak) list.push(kid.identityAnchorFalUrl);
  else if (!kid.identityAnchorFalUrl && kid.anchorFalUrl) list.push(kid.anchorFalUrl); // legacy kids
  return list.filter((u, i, a) => u && a.indexOf(u) === i);
}

// The single best faithful reference to SCORE a generated page against. Uses the
// gated identity anchor when trustworthy, otherwise the restored/raw photo.
function scoreReference(kid) {
  if (kid.identityAnchorFalUrl && !kid.identityAnchorWeak) return kid.identityAnchorFalUrl;
  return kid.restoredFalUrl || kid.rawFalUrl || kid.anchorFalUrl;
}

// Auto-Decision Engine (Step 1). Turns a checker result + the page's scoring
// level into an automatic verdict, without removing the manual approve flow.
const DECISION_THRESHOLDS = { minAutoApproveScore: 85, minReviewScore: 70 };

// Readable explanation when a page's hair drifted from the identity anchor.
function hairReason(check) {
  if (check?.hair_color_match === false && check?.hairstyle_match === false)
    return "hair color and hairstyle changed from anchor";
  if (check?.hair_color_match === false) return "hair color changed";
  if (check?.hairstyle_match === false) return "hairstyle changed";
  if (Array.isArray(check?.hair_changes) && check.hair_changes.length)
    return "hair changed from anchor: " + check.hair_changes.join("; ");
  return "hair changed from anchor";
}

function decidePage(check, scoring) {
  const scoreThresholds = { ...DECISION_THRESHOLDS };
  const verdict = (decision, decisionReason, autoApproved) => ({
    decision,
    decisionReason,
    autoApproved,
    scoreThresholds,
    decidedAt: Date.now(),
  });

  // Hair is a hard identity requirement: a hair-color or main-hairstyle change
  // must block automatic approval, even when the face match score is high.
  const hairChanged = check?.hair_changed === true;

  // Pages that never get identity-scored (decorative / text / no clear face).
  if (scoring === "none") {
    return verdict("no_score", "Page does not require identity scoring.", true);
  }

  // Missing result or the checker itself errored / is disabled.
  if (!check || check.enabled === false || check.message) {
    return verdict("needs_review", check?.message || "Could not verify identity.", false);
  }

  // Face too turned/hidden/small to judge identity automatically.
  if (check.face_visible === false) {
    return verdict("needs_review", "Face is not visible enough for automatic approval.", false);
  }

  // Advisory pages: review-only scoring, so a successful render auto-approves —
  // unless the hair drifted from the anchor, which forces manual review.
  if (scoring === "advisory") {
    if (hairChanged) return verdict("needs_review", hairReason(check), false);
    return verdict("auto_approved", "Advisory page generated successfully.", true);
  }

  // Strict pages: gate on the identity score.
  if (scoring === "strict") {
    const score = typeof check.score === "number" ? check.score : null;
    if (score == null) {
      return verdict("needs_review", "Could not verify identity.", false);
    }
    if (score >= scoreThresholds.minAutoApproveScore && check.same_child !== false) {
      // High face match is not enough — hair must also match the anchor.
      if (hairChanged) return verdict("needs_review", hairReason(check), false);
      return verdict("auto_approved", "Identity score passed automatic threshold.", true);
    }
    if (score >= scoreThresholds.minReviewScore) {
      return verdict("needs_review", "Identity score is borderline.", false);
    }
    return verdict("rejected", "Identity score is below review threshold.", false);
  }

  return verdict("needs_review", "Needs manual review.", false);
}

// Remove any age estimate from a free-text feature description so it can't
// override the authoritative story age. Drops standalone clauses/sentences that
// are purely about age ("approximately 16 years old", "is around 5") and tidies
// up the leftover wording.
function stripAgeMentions(text) {
  if (!text || typeof text !== "string") return "";
  let t = text;
  // "(is/looks) (approximately/about/around/roughly) N year(s)(-)old" possibly
  // joined to the next clause by "with/and".
  t = t.replace(
    /\b(?:is|looks?|appears?(?:\s+to\s+be)?)?\s*(?:approximately|about|around|roughly|maybe|likely)?\s*\d{1,2}[\s-]*(?:years?|yrs?|months?)[\s-]*old\b/gi,
    ""
  );
  // Clean up dangling connectors/punctuation left behind ("This child  with a..."
  // -> "This child has a...", stray double spaces, leading "with/and").
  t = t
    .replace(/\b(this child|the child|she|he|they)\s+with\b/gi, "$1 has")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/([,;])\s*(?=[,.;])/g, "")
    .replace(/(^|[.!?]\s+)(?:and|with)\s+/gi, "$1")
    .trim();
  return t;
}

// Generate one scene for one kid. `scene` must already have a falUrl. The
// optional `persistSceneStoryPrompt` callback stores a backfilled description.
// Returns a complete result record (not persisted here).
async function runGenerate({
  scene,
  kid,
  prompt,
  method,
  gender,
  age,
  workflowType,
  mode,
  extraPrompt,
  persistSceneStoryPrompt,
}) {
  const genMode = (mode || "compose").toLowerCase();
  const extra = (extraPrompt || "").trim();
  // The page's own prompt (set in the editor) is the PRIMARY description of what
  // this page should depict; it leads the generation prompt below.
  const pagePrompt = (scene.aiPrompt || "").trim();

  // A short natural-language descriptor of the child (age + gender) to anchor
  // proportions/identity in the generative prompts.
  const genderWord = gender === "male" ? "boy" : gender === "non-binary" ? "child" : "girl";

  // Age comes from the PHOTO (the child actually being placed in the scene), not
  // the story template. Use the age detected from the uploaded photo; if it's
  // unavailable, stay age-neutral rather than falling back to the story age.
  const photoAge = kid.featuresStruct?.approx_age;
  const effectiveAge = Number.isFinite(photoAge) && photoAge > 0 ? Math.round(photoAge) : null;
  const childDesc = [effectiveAge ? `${effectiveAge}-year-old` : "young", genderWord]
    .filter(Boolean)
    .join(" ");

  // The free-text feature description may also carry an age phrase (older
  // descriptions said e.g. "approximately 16 years old"); strip it so the photo
  // age in childDesc is the single age statement and nothing contradicts it.
  const featureText = stripAgeMentions(kid.features);

  // Faithful, ordered references (restored, raw, gated identity anchor).
  const refs = identityRefs(kid);

  const runEdit = async (useRefs = refs) => {
    const basePrompt =
      genMode === "headswap" ? DEFAULT_PROMPT : genMode === "face" ? FACE_PROMPT : COMPOSE_PROMPT;
    let p = (prompt || basePrompt).trim();
    // Lead with the page's own prompt so it drives what the scene shows. The
    // identity, hair and proportion constraints below still lock the child's
    // likeness regardless of this description.
    if (pagePrompt) {
      p =
        `THIS PAGE DEPICTS: ${pagePrompt} ` +
        `Treat this as the primary, authoritative description of the page's scene and content. ` +
        p;
    }
    p += ` The child is a ${childDesc}; keep age-appropriate, natural proportions with a normal-sized head.`;
    // Hair is a hard identity requirement on every page, regardless of mode or
    // any custom prompt override above.
    p += ` ${HAIR_PRESERVATION}`;
    if (featureText) {
      p +=
        " For absolute certainty, the reference child has these exact features: " +
        featureText +
        " Reproduce these features faithfully; do not invent or average them.";
    }
    if (extra) p += ` ${extra}`;
    // Honor the model selected in Settings: GPT-Image-2 edits the scene with the
    // same scene-base-first, references-after ordering; otherwise Nano Banana.
    if (useGptImageModel()) {
      const g = await gptImage2Edit({
        imageUrls: [scene.falUrl, ...useRefs],
        prompt: p,
        imageSize: "auto",
        quality: "medium",
        outputFormat: "png",
      });
      return {
        out: { url: g.url, description: GPT_IMAGE_2_ENDPOINT },
        method: `edit:${genMode}`,
        usedPrompt: p,
      };
    }
    const r = await nanoEdit({ imageUrls: [scene.falUrl, ...useRefs], prompt: p });
    return { out: r, method: `edit:${genMode}`, usedPrompt: p };
  };

  const runIdentity = async () => {
    if (!scene.storyPrompt) {
      const desc = await describeScene(scene.falUrl).catch(() => "");
      if (desc) {
        scene.storyPrompt = desc;
        if (persistSceneStoryPrompt) await persistSceneStoryPrompt(desc);
      }
    }
    const sceneStory = (scene.storyPrompt || "").trim();
    const p = [
      // Page prompt leads so it primarily shapes the generated scene.
      pagePrompt,
      prompt?.trim(),
      sceneStory,
      `The main character is a ${childDesc}.`,
      featureText
        ? `The child is unmistakably this specific individual: ${featureText}`
        : "",
      "Natural, anatomically-correct child with realistic age-appropriate proportions; " +
        "head proportionate to the body, not oversized. No text, words, letters or logos.",
      extra,
    ]
      .filter(Boolean)
      .join(" ");
    const ref = scoreReference(kid) || kid.restoredFalUrl || kid.rawFalUrl || kid.falUrl;
    const r = await fluxPulid({ referenceImageUrl: ref, prompt: p });
    return { out: { url: r.url, description: "fal-ai/flux-pulid" }, method: "identity", usedPrompt: p };
  };

  const wantSwap = (method || "edit").toLowerCase() === "swap";

  // How strictly this page is scored. "none" = never scored (no clear face), so
  // we skip the likeness retry loop and do a single pass.
  const scoring =
    scene.identityScoring || (aiBaseElement(scene) || scene.falUrl ? "advisory" : "none");
  const scoreOf = async (url) =>
    checkConsistency({ referenceUrl: scoreReference(kid), candidateUrl: url, candidateIsScene: true });

  let out, usedPrompt = null, usedMethod, swapError = null, check = null, refStrategy = null;

  if (genMode === "identity") {
    try {
      ({ out, method: usedMethod, usedPrompt } = await runIdentity());
    } catch (e) {
      console.warn("identity (flux-pulid) failed, falling back to edit:", e.message);
      swapError = e.message;
      ({ out, method: usedMethod, usedPrompt } = await runEdit());
    }
  } else if (wantSwap) {
    try {
      const faceSrc = kid.restoredFalUrl || kid.rawFalUrl || kid.falUrl;
      const [faceUrl, targetUrl] = await Promise.all([
        downscaleToFal(faceSrc, 1280).catch(() => faceSrc),
        downscaleToFal(scene.falUrl, 1280).catch(() => scene.falUrl),
      ]);
      const swap = await advancedFaceSwap({
        faceImageUrl: faceUrl,
        targetImageUrl: targetUrl,
        gender: gender || "female",
        // Keep the template's hair (product decision); swap only the face.
        workflowType: workflowType || "target_hair",
      });
      out = { url: swap.url, description: "easel-ai/advanced-face-swap" };
      usedMethod = "swap";
    } catch (e) {
      console.warn("face swap failed, falling back to edit:", e.message);
      swapError = e.message;
      ({ out, method: usedMethod, usedPrompt } = await runEdit());
    }
  } else {
    // Edit modes (face/compose/headswap): when the page is scored, try a few
    // reference strategies and KEEP THE BEST-SCORING render. Early-exits as soon
    // as a render is clearly the same child, so the common case is a single pass.
    const strategies = [
      { name: "restored+raw+anchor", refs },
      { name: "restored-only", refs: [kid.restoredFalUrl].filter(Boolean) },
      {
        name: "anchor-only",
        refs: [
          kid.identityAnchorFalUrl && !kid.identityAnchorWeak
            ? kid.identityAnchorFalUrl
            : null,
        ].filter(Boolean),
      },
    ];
    // De-dupe + drop empty/identical strategies (keeps the first occurrence).
    const seen = new Set();
    const tries = strategies.filter((s) => {
      const key = s.refs.join("|");
      if (!s.refs.length || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (scoring === "none" || !isCheckerEnabled() || tries.length <= 1) {
      ({ out, method: usedMethod, usedPrompt } = await runEdit(tries[0]?.refs || refs));
      refStrategy = tries[0]?.name || "restored+raw+anchor";
    } else {
      let best = null;
      for (const st of tries) {
        let attempt;
        try {
          attempt = await runEdit(st.refs);
        } catch (e) {
          console.warn(`likeness attempt (${st.name}) failed:`, e.message);
          continue;
        }
        const c = await scoreOf(attempt.out.url).catch(() => null);
        const sc = typeof c?.score === "number" ? c.score : -1;
        console.log(`likeness attempt ${st.name}: score ${c?.score ?? "?"}`);
        if (!best || sc > best.score) best = { ...attempt, check: c, score: sc, refStrategy: st.name };
        if (sc >= ANCHOR_MIN_SCORE) break; // good enough, stop spending
      }
      if (!best) {
        // All attempts errored — surface a normal single edit (will throw if truly broken).
        ({ out, method: usedMethod, usedPrompt } = await runEdit());
      } else {
        out = best.out;
        usedMethod = best.method;
        usedPrompt = best.usedPrompt;
        check = best.check || null;
        refStrategy = best.refStrategy;
      }
    }
  }

  const fileName = `result-${kid.id}-${scene.id}-${nanoid(6)}.png`;
  let localUrl;
  try {
    localUrl = await downloadToUploads(out.url, fileName);
  } catch {
    localUrl = out.url;
  }

  // Score the chosen render against the faithful identity reference (gated
  // identity anchor, else restored/raw photo) unless it was already scored in
  // the retry loop above. "none" pages are never scored.
  if (scoring === "none") {
    check = { enabled: true, level: "none", score: null, same_child: null, mismatches: [] };
  } else if (!check) {
    check = await scoreOf(out.url);
  }
  if (check) check.level = scoring;

  const decisionInfo = decidePage(check, scoring);

  return {
    url: localUrl,
    remoteUrl: out.url,
    description: out.description,
    method: usedMethod,
    refStrategy,
    swapError,
    prompt: usedPrompt,
    check,
    ...decisionInfo,
    createdAt: Date.now(),
  };
}

// Convert a kid-slot box (drawn in cell-canvas coordinates) into the AI base
// image's own coordinate space. The AI base element occupies a sub-rectangle of
// the cell; the generated image fills exactly that rectangle. Legacy full-bleed
// scenes (no AI element) map identically (the image is the whole cell).
function slotToAiSpace(slot, scene) {
  const ai = aiBaseElement(scene);
  if (!ai) return { xPct: slot.xPct, yPct: slot.yPct, wPct: slot.wPct, hPct: slot.hPct };
  const aw = ai.wPct || 100;
  const ah = ai.hPct || 100;
  return {
    xPct: ((slot.xPct - (ai.xPct || 0)) / aw) * 100,
    yPct: ((slot.yPct - (ai.yPct || 0)) / ah) * 100,
    wPct: (slot.wPct / aw) * 100,
    hPct: (slot.hPct / ah) * 100,
  };
}

// Build an RGBA buffer of `swapped` resized to w×h with feathered edges, so it
// composites onto the base without a hard rectangular seam. Falls back to a hard
// edge if any sharp channel op fails (composite must always succeed).
async function featherCrop(swappedBuf, w, h) {
  const rgb = await sharp(swappedBuf).resize(w, h, { fit: "fill" }).removeAlpha().png().toBuffer();
  try {
    const inset = Math.max(1, Math.round(Math.min(w, h) * 0.08));
    // Single-channel alpha mask: opaque interior, transparent border. Built as a
    // raw 1-channel buffer (sharp's create() only allows 3–4 channels), then
    // blurred to soften the edge before joining as the alpha channel.
    const maskRaw = Buffer.alloc(w * h, 0);
    for (let yy = inset; yy < h - inset; yy++) {
      const row = yy * w;
      for (let xx = inset; xx < w - inset; xx++) maskRaw[row + xx] = 255;
    }
    const mask = await sharp(maskRaw, { raw: { width: w, height: h, channels: 1 } })
      .blur(Math.max(0.5, inset / 2))
      .png()
      .toBuffer();
    return await sharp(rgb).joinChannel(mask).png().toBuffer();
  } catch (e) {
    console.warn("feather failed, using hard edge:", e.message);
    return sharp(rgb).ensureAlpha().png().toBuffer();
  }
}

// Composite-per-face generation. For each kid slot: crop the slot box from the
// base image, run the existing single-face swap on just that crop, then paste the
// swapped face back. Handles any number of children deterministically (each child
// lands exactly where its slot is). Returns the same result shape as runGenerate.
async function runSlotComposite({ scene, baseFalUrl, slots, kidsByCharacter, charactersById, scoring }) {
  const baseBuf = await fetchImageBuffer(baseFalUrl);
  const meta = await sharp(baseBuf).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) throw new Error("Could not read base image dimensions for composite.");

  const overlays = [];
  const perFace = [];

  for (const slot of slots) {
    const kid = kidsByCharacter[slot.characterId];
    const character = charactersById[slot.characterId] || {};
    if (!kid) {
      perFace.push({ characterId: slot.characterId, label: character.label, error: "no photo" });
      continue;
    }
    const box = slotToAiSpace(slot, scene);
    // Pixel rect with a small padding margin, clamped to the image bounds.
    const padX = (box.wPct / 100) * W * 0.12;
    const padY = (box.hPct / 100) * H * 0.12;
    const x = Math.max(0, Math.round((box.xPct / 100) * W - padX));
    const y = Math.max(0, Math.round((box.yPct / 100) * H - padY));
    const w = Math.min(W - x, Math.round((box.wPct / 100) * W + padX * 2));
    const h = Math.min(H - y, Math.round((box.hPct / 100) * H + padY * 2));
    if (w <= 2 || h <= 2) {
      perFace.push({ characterId: slot.characterId, label: character.label, error: "slot too small" });
      continue;
    }

    const cropBuf = await sharp(baseBuf).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
    const cropUrl = await uploadBufferToFal(cropBuf, `crop-${slot.id}-${nanoid(6)}.png`);
    const faceSrc = kid.restoredFalUrl || kid.rawFalUrl || kid.falUrl;
    let swappedUrl;
    try {
      const swap = await advancedFaceSwap({
        faceImageUrl: faceSrc,
        targetImageUrl: cropUrl,
        gender: character.gender || "female",
        // Keep the template's hair (product decision); swap only the face.
        workflowType: "target_hair",
      });
      swappedUrl = swap.url;
    } catch (e) {
      console.warn(`slot swap failed for ${character.label || slot.characterId}:`, e.message);
      perFace.push({ characterId: slot.characterId, label: character.label, error: e.message });
      continue; // leave the original crop in place
    }

    const swappedBuf = await fetchImageBuffer(swappedUrl);
    const feathered = await featherCrop(swappedBuf, w, h);
    overlays.push({ input: feathered, left: x, top: y });

    // Per-face identity score against this child's faithful reference.
    let faceCheck = null;
    if (scoring !== "none" && isCheckerEnabled()) {
      faceCheck = await checkConsistency({
        referenceUrl: scoreReference(kid),
        candidateUrl: swappedUrl,
        candidateIsScene: false,
      }).catch(() => null);
    }
    perFace.push({
      characterId: slot.characterId,
      label: character.label,
      score: typeof faceCheck?.score === "number" ? faceCheck.score : null,
      check: faceCheck,
    });
  }

  const finalBuf = await sharp(baseBuf).composite(overlays).png().toBuffer();
  const remoteUrl = await uploadBufferToFal(finalBuf, `composite-${scene.id}-${nanoid(6)}.png`);
  const fileName = `result-composite-${scene.id}-${nanoid(6)}.png`;
  let localUrl;
  try {
    localUrl = await downloadToUploads(remoteUrl, fileName);
  } catch {
    localUrl = remoteUrl;
  }

  // Aggregate score = the weakest face (a story page is only as good as its
  // least-matching child). Drives the same auto-decision as single-kid pages.
  const scored = perFace.filter((f) => typeof f.score === "number");
  const minScore = scored.length ? Math.min(...scored.map((f) => f.score)) : null;
  let check;
  if (scoring === "none") {
    check = { enabled: true, level: "none", score: null, same_child: null, mismatches: [] };
  } else {
    check = {
      enabled: true,
      level: scoring,
      score: minScore,
      same_child: minScore == null ? null : minScore >= DECISION_THRESHOLDS.minReviewScore,
      mismatches: [],
      perFace,
    };
  }
  const decisionInfo = decidePage(check, scoring);

  return {
    url: localUrl,
    remoteUrl,
    description: `composite/${slots.length}-face`,
    method: "composite",
    perFace,
    swapError: perFace.find((f) => f.error)?.error || null,
    prompt: null,
    check,
    ...decisionInfo,
    createdAt: Date.now(),
  };
}

// Ensure a scene has a cached fal URL (uploads it once if needed). Persists to
// the story it belongs to. Returns the falUrl.
async function ensureSceneFalUrl(storyId, sceneId) {
  const db = await readDb();
  const story = db.stories[storyId];
  const scene = story?.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;
  if (!scene.falUrl) {
    scene.falUrl = await uploadToFal(path.join(UPLOAD_DIR, scene.fileName));
    await writeDb(db);
  }
  return scene.falUrl;
}

// The AI-plane image element is the scene base that gets regenerated with the
// child. Text/SVG/static-image elements are overlays and are never sent to AI.
function aiBaseElement(scene) {
  const els = Array.isArray(scene.elements) ? scene.elements : [];
  return els.find((e) => e.type === "image" && e.plane === "ai") || null;
}

// A stable identity for a page's AI base image. Language twins are deep clones of
// the same page, so they share this key — letting an order generate each unique
// image once and reuse the render for every page that shares the same base.
function sceneBaseKey(scene) {
  const ai = aiBaseElement(scene);
  return (ai && (ai.falUrl || ai.url)) || scene.falUrl || scene.fileName || null;
}

// Default story-wide generation knobs.
const DEFAULT_STYLE_SETTINGS = {
  artStyle: "illustration", // "illustration" | "semi_real" | "photoreal" — the whole story world
  faceColorMatch: "normal", // "normal" | "strong"
  colorNote: "", // free-text palette/warmth guidance
  notes: "", // free-text global directives
  // How realistic the child's FACE should look, independent of the story world.
  // "match_story" (default) | "semi_realistic" | "realistic"
  childFaceStyle: "match_story",
};

const ART_STYLES = ["illustration", "semi_real", "photoreal"];
const CHILD_FACE_STYLES = ["match_story", "semi_realistic", "realistic"];

// Turn a story's style settings into prompt directives appended to every page.
// The art-style line is phrased as an explicit override so it wins over the
// base prompt's hardcoded "keep illustrated / not photographic" wording.
function styleDirectives(s) {
  const st = { ...DEFAULT_STYLE_SETTINGS, ...(s || {}) };
  const parts = [];
  if (st.artStyle === "photoreal")
    parts.push(
      "ART STYLE OVERRIDE: render the final image as a photorealistic, lifelike photograph of a real " +
        "child with real skin texture and natural lighting — this supersedes any earlier instruction to keep " +
        "the result illustrated or non-photographic."
    );
  else if (st.artStyle === "semi_real")
    parts.push(
      "ART STYLE OVERRIDE: render in a semi-realistic, painterly storybook style — more lifelike and " +
        "dimensional than a flat cartoon, but still a polished illustration."
    );
  else
    parts.push(
      "ART STYLE: keep the scene's illustrated storybook art style and medium; do not make the result photographic."
    );
  // Child-face realism is independent of the story world; "match_story" adds nothing.
  if (st.childFaceStyle === "semi_realistic")
    parts.push(
      "CHILD FACE STYLE: keep the story's visual style, but render the child's face with more natural human " +
        "proportions. Avoid oversized eyes, doll-like cheeks, plastic skin, chibi/anime/Pixar/Disney features, " +
        "and exaggerated smiles. Keep the face faithful to the identity reference while still blending into the " +
        "storybook art."
    );
  else if (st.childFaceStyle === "realistic")
    parts.push(
      "CHILD FACE STYLE: keep the story's environment and clothing in its selected story style, but render the " +
        "child's face and visible skin with realistic human facial proportions and softly realistic skin detail. " +
        "Eyes must be normal-sized; nose, mouth, cheeks, and jaw should match the real reference child. Do not " +
        "make the child look like a cartoon, doll, anime, Pixar/Disney character, or chibi. Blend the realistic " +
        "face into the scene lighting."
    );
  if (st.faceColorMatch === "strong")
    parts.push(
      "SKIN TONE: the child's facial skin tone, hue and brightness must EXACTLY match their own neck, hands " +
        "and body and the scene's lighting — absolutely no pale, washed-out, grey, ashy or pasted-in face; " +
        "blend tone, warmth, shadows and highlights seamlessly."
    );
  if (st.colorNote && st.colorNote.trim()) parts.push("COLOR/PALETTE: " + st.colorNote.trim());
  if (st.notes && st.notes.trim()) parts.push(st.notes.trim());
  return parts.join(" ");
}

// Compose the per-generation "extra" guidance: page safe-zones + story-wide
// style directives + this page's correction note. Used identically by the test
// flow and orders so a published story renders the same way for every child.
function composeExtra(story, scene) {
  return [
    safeZoneGuidance(scene),
    styleDirectives(story?.styleSettings),
    // The per-page prompt (scene.aiPrompt) is intentionally NOT included here:
    // runGenerate applies it as the PRIMARY scene description (it leads the
    // prompt) rather than as trailing extra guidance.
    (scene.correction || "").trim(),
  ]
    .filter(Boolean)
    .join(" ");
}

// Map a per-scene generation choice to the (mode, method) runGenerate expects.
// Returns null when the scene has no override (caller falls back to defaults).
function resolveGen(choice) {
  switch (choice) {
    case "face":
      return { mode: "face", method: "edit" };
    case "headswap":
      return { mode: "headswap", method: "edit" };
    case "identity":
      return { mode: "identity", method: "edit" };
    case "faceswap":
      return { mode: "compose", method: "swap" };
    case "compose":
      return { mode: "compose", method: "edit" };
    default:
      return null;
  }
}

// True when a page has an AI image the pipeline can regenerate with a child
// (mirrors the client's sceneHasAiBase). Overlay/text-only pages are skipped.
function sceneIsAi(scene) {
  if (aiBaseElement(scene)) return true;
  if (scene.type === "text") return false;
  return Boolean(scene.falUrl || scene.fileName);
}

// Any change that invalidates a previously-approved render (regenerating a page,
// editing a prompt/layout, adding/removing pages) drops the story back to draft
// so "published" always means "every AI page is currently approved".
function markStoryDraft(story) {
  if (story && story.status === "published") story.status = "draft";
}

// Lazily migrate a story to the multi-character (cast) model. Legacy stories get
// a single character seeded from the story's own gender, so existing single-child
// stories behave exactly as before. Also keeps story.gender mirrored to the first
// character so older single-child prompts/routes keep working. Mutates + returns.
function ensureCharacters(story) {
  if (!story) return story;
  if (!Array.isArray(story.characters) || story.characters.length === 0) {
    story.characters = [
      { id: nanoid(8), key: "child", label: "Child", gender: story.gender || "female" },
    ];
  }
  // story.gender is the back-compat mirror of the primary character.
  story.gender = story.characters[0].gender || story.gender || "female";
  return story;
}

// Find a cast character by id (after ensureCharacters has run).
function getCharacter(story, characterId) {
  return (story.characters || []).find((c) => c.id === characterId) || null;
}

// The id of the primary (first) character — the back-compat target for the old
// single-kid order fields and unparameterized kid routes.
function primaryCharacterId(story) {
  ensureCharacters(story);
  return story.characters[0].id;
}

// Resolve a fal URL for the scene's AI base. Prefers the AI-plane image element
// (element model); falls back to the legacy whole-scene image. Returns null when
// the page is overlay/text only (nothing to regenerate).
async function ensureBaseFalUrl(scene) {
  const ai = aiBaseElement(scene);
  if (ai) {
    if (ai.falUrl) return ai.falUrl;
    if (ai.url) return uploadToFal(path.join(UPLOAD_DIR, ai.url.split("/").pop()));
  }
  if (scene.falUrl) return scene.falUrl;
  if (scene.fileName) return uploadToFal(path.join(UPLOAD_DIR, scene.fileName));
  return null;
}

// Turn the page's safe zones into prompt guidance so the model keeps those
// regions clear (they're reserved for text/overlays added afterward).
function safeZoneGuidance(scene) {
  const zones = (Array.isArray(scene.safeZones) ? scene.safeZones : []).filter(Boolean);
  if (!zones.length) return "";
  const parts = zones.map((z) => {
    const x = Math.round(z.xPct || 0);
    const y = Math.round(z.yPct || 0);
    const w = Math.round(z.wPct || 0);
    const h = Math.round(z.hPct || 0);
    return `a region ${w}% wide and ${h}% tall starting ${x}% from the left and ${y}% from the top`;
  });
  return (
    " IMPORTANT COMPOSITION RULE: keep these regions visually calm, open and uncluttered because text will be placed there later — " +
    parts.join("; ") +
    ". Do not put the main subject's face or any important detail inside those regions, and do not render any text, words, letters or logos anywhere in the image."
  );
}

// --- Stage 1: upload the raw photo (returns immediately so the UI shows it) -----
app.post(
  "/api/stories/:id/kid",
  upload.single("kid"),
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    if (!req.file) return res.status(400).json({ error: "No kid photo uploaded" });

    const kid = newKid(req.file);
    kid.role = "test";
    kid.rawFalUrl = await uploadToFal(path.join(UPLOAD_DIR, req.file.filename));
    // Photo intake gate: validate the raw upload before restore/anchor. Identity-
    // critical problems → needs_new_photo now; fixable quality issues → fixable
    // (re-checked after auto-enhancement). The record is saved either way so the
    // UI can show the photo + reason.
    await applyRawPhotoCheck(kid);
    story.kids[kid.id] = kid;
    story.testKidIds ||= [];
    if (!story.testKidIds.includes(kid.id)) story.testKidIds.push(kid.id);
    if (!story.results[kid.id]) story.results[kid.id] = {};
    // A new (unapproved) test child means the story is no longer fully approved.
    markStoryDraft(story);
    await writeDb(db);

    res.json({ kidId: kid.id, kid });
  })
);

// --- Stage 2: restore / enhance the photo --------------------------------------
app.post(
  "/api/stories/:id/kid/:kidId/restore",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const kid = db.stories[req.params.id]?.kids[req.params.kidId];
    if (!kid) return res.status(404).json({ error: "Kid not found" });
    if (kid.photoStatus === "needs_new_photo") return res.status(400).json({ error: PHOTO_GATE_MESSAGE });

    const patch = await runRestore(kid);
    const updated = await patchKid(req.params.id, req.params.kidId, patch);
    res.json({ kidId: kid.id, kid: updated });
  })
);

// --- Stage 3: build the stylized anchor + auto-score it -------------------------
app.post(
  "/api/stories/:id/kid/:kidId/anchor",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const kid = db.stories[req.params.id]?.kids[req.params.kidId];
    if (!kid) return res.status(404).json({ error: "Kid not found" });
    if (kid.photoStatus === "needs_new_photo") return res.status(400).json({ error: PHOTO_GATE_MESSAGE });

    const patch = await runAnchor(kid, req.body?.anchorPrompt);
    const updated = await patchKid(req.params.id, req.params.kidId, patch);
    res.json({ kidId: kid.id, kid: updated });
  })
);

// --- Generate one scene for a given kid ---------------------------------------
app.post(
  "/api/stories/:id/generate",
  asyncHandler(async (req, res) => {
    const { sceneId, kidId, prompt, method, gender, workflowType, mode } = req.body || {};
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });

    const scene = story.scenes.find((s) => s.id === sceneId);
    const kid = story.kids[kidId];
    if (!scene) return res.status(404).json({ error: "Scene not found" });
    if (!kid) return res.status(404).json({ error: "Kid not found" });
    if (kid.photoStatus === "needs_new_photo") return res.status(400).json({ error: PHOTO_GATE_MESSAGE });

    const baseFalUrl = await ensureBaseFalUrl(scene);
    if (!baseFalUrl)
      return res
        .status(400)
        .json({ error: "This page has no AI image to regenerate (it is text/overlay only)." });

    // Resolve the effective recipe: a per-scene mode override wins over the
    // request defaults. In identity mode the base prompt must stay empty so the
    // scene's own storyPrompt drives it (the head-swap text doesn't apply there).
    const choiceGen = resolveGen(scene.genChoice);
    const genMode = choiceGen?.mode || mode || "face";
    const genMethod = choiceGen?.method || method || "edit";
    const genPrompt = genMode === "identity" ? "" : prompt || "";

    const result = await runGenerate({
      scene: { ...scene, falUrl: baseFalUrl },
      kid,
      prompt: genPrompt,
      method: genMethod,
      gender: gender || story.gender,
      age: story.age,
      workflowType,
      mode: genMode,
      extraPrompt: composeExtra(story, scene),
      persistSceneStoryPrompt: async (desc) => {
        const dbS = await readDb();
        const sc = dbS.stories[req.params.id]?.scenes.find((s) => s.id === sceneId);
        if (sc) {
          sc.storyPrompt = desc;
          await writeDb(dbS);
        }
      },
    });

    const db2 = await readDb();
    const story2 = db2.stories[req.params.id];
    if (!story2.results[kidId]) story2.results[kidId] = {};
    // Auto-Decision Engine: a freshly generated page is approved automatically
    // when the decision engine says so (high-scoring strict, advisory, or
    // no-score pages). A fresh render clears any prior manual override.
    result.approved = result.autoApproved === true;
    result.manualApprovalOverride = false;
    // Record the kid-agnostic generation recipe that produced this render so
    // that, once approved, orders can replay it (only the kid changes). The
    // per-kid features + story style directives are re-applied at order time.
    result.genPrompt = genPrompt;
    result.genMode = genMode;
    result.genMethod = genMethod;
    story2.results[kidId][sceneId] = result;
    markStoryDraft(story2);
    await writeDb(db2);

    res.json({ sceneId, kidId, result });
  })
);

// --- Test approval + publishing -----------------------------------------------

// Whether a generated result counts as approved for publishing. A manual
// approve/unapprove (manualApprovalOverride) always wins; otherwise the
// Auto-Decision Engine's auto-approval / no-score verdict is accepted.
function resultIsApproved(r) {
  if (!r) return false;
  // A manual approve/unapprove always wins.
  if (r.manualApprovalOverride === true) return r.approved === true;
  if (r.approved === true) return true;
  // Stored Auto-Decision Engine verdict (Step 1+).
  if (r.decision) return r.decision === "auto_approved" || r.decision === "no_score";
  if (r.autoApproved === true) return true;
  // Fallback for results generated before Step 1 (no decision fields): derive the
  // verdict from the saved checker result so good old renders are not stuck.
  const d = decidePage(r.check, r.check?.level || "advisory").decision;
  return d === "auto_approved" || d === "no_score";
}

// Compute, for a story, which (testKid × AI-scene) cells still need approval.
// Returns { aiScenes, testKidIds, missing[], total, approved }.
function publishReadiness(story) {
  const aiScenes = (story.scenes || []).filter(sceneIsAi);
  // story.kids only ever holds calibration (test) children — orders keep their
  // own kid — so it's the authoritative set even for stories created before
  // testKidIds existed.
  const testKidIds = Object.keys(story.kids || {});
  const missing = [];
  for (const kidId of testKidIds) {
    for (const scene of aiScenes) {
      const r = story.results?.[kidId]?.[scene.id];
      if (!resultIsApproved(r)) missing.push({ kidId, sceneId: scene.id });
    }
  }
  const total = testKidIds.length * aiScenes.length;
  return { aiScenes, testKidIds, missing, total, approved: total - missing.length };
}

// Approve (or un-approve) one test child's render of one scene.
app.post(
  "/api/stories/:id/results/:kidId/:sceneId/approve",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const result = story.results?.[req.params.kidId]?.[req.params.sceneId];
    if (!result) return res.status(404).json({ error: "No generated result to approve yet" });

    const approved = req.body?.approved === false ? false : true;
    result.approved = approved;
    // Manual approve/unapprove always overrides the Auto-Decision Engine.
    result.manualApprovalOverride = true;
    if (approved) {
      // Lock the approved recipe onto the scene so every order replays exactly
      // what was tested and approved here, swapping only the child.
      const scene = story.scenes.find((s) => s.id === req.params.sceneId);
      if (scene) {
        scene.approvedPrompt = result.genPrompt ?? null;
        scene.approvedMode = result.genMode || "compose";
        scene.approvedMethod = result.genMethod || "edit";
      }
    } else {
      // Un-approving can never leave a published story valid.
      markStoryDraft(story);
    }
    await writeDb(db);
    res.json(story);
  })
);

// Publish a story. Testing/approval is recommended but not required — an admin
// can publish at any time from the header button.
app.post(
  "/api/stories/:id/publish",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });

    story.status = "published";
    story.publishedAt = Date.now();
    await writeDb(db);
    res.json(story);
  })
);

// Update a story's per-language titles. The primary `title` (used for lists and
// back-compat) tracks the English title, falling back to Arabic. Renaming does
// not affect any rendered page, so it does NOT drop the story back to draft.
app.put(
  "/api/stories/:id/title",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const { titleEn, titleAr } = req.body || {};
    if (typeof titleEn === "string") story.titleEn = titleEn.trim();
    if (typeof titleAr === "string") story.titleAr = titleAr.trim();
    story.title = (story.titleEn || story.titleAr || "Untitled story").trim();
    await writeDb(db);
    res.json(story);
  })
);

// Update the story's cast (the children it features). Each character has a label
// and gender; ids are stable (kept when present so scene slot bindings survive).
// Changing the cast can change how pages generate, so it drops the story to draft.
app.put(
  "/api/stories/:id/characters",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });

    const incoming = Array.isArray(req.body?.characters) ? req.body.characters : null;
    if (!incoming || incoming.length === 0)
      return res.status(400).json({ error: "A story needs at least one character." });

    const usedKeys = new Set();
    const next = incoming.map((c, i) => {
      const label = String(c?.label || "").trim() || `Child ${i + 1}`;
      const gender = ["female", "male", "non-binary"].includes(c?.gender) ? c.gender : "female";
      // Keep a stable, unique key (used by name variables); derive from label.
      let key = String(c?.key || label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `child${i + 1}`;
      while (usedKeys.has(key)) key = `${key}_${i}`;
      usedKeys.add(key);
      return { id: c?.id && typeof c.id === "string" ? c.id : nanoid(8), key, label, gender };
    });

    story.characters = next;
    // Mirror primary onto story.gender for back-compat.
    story.gender = next[0].gender;
    markStoryDraft(story);
    await writeDb(db);
    res.json(story);
  })
);

// Update the story's child gender. This changes how pages generate, so it drops
// the story back to draft.
app.put(
  "/api/stories/:id/gender",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const { gender } = req.body || {};
    if (["female", "male", "non-binary"].includes(gender)) {
      story.gender = gender;
      // Mirror onto the primary character so the cast stays consistent.
      ensureCharacters(story);
      story.characters[0].gender = gender;
    }
    markStoryDraft(story);
    await writeDb(db);
    res.json(story);
  })
);

// Update a story's story-wide AI style settings. Changing them invalidates the
// approved test renders, so the story drops back to draft and must be re-tested.
app.put(
  "/api/stories/:id/style",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const s = req.body || {};
    const next = { ...DEFAULT_STYLE_SETTINGS, ...(story.styleSettings || {}) };
    if (ART_STYLES.includes(s.artStyle)) next.artStyle = s.artStyle;
    if (CHILD_FACE_STYLES.includes(s.childFaceStyle)) next.childFaceStyle = s.childFaceStyle;
    if (["normal", "strong"].includes(s.faceColorMatch)) next.faceColorMatch = s.faceColorMatch;
    if (typeof s.colorNote === "string") next.colorNote = s.colorNote;
    if (typeof s.notes === "string") next.notes = s.notes;
    story.styleSettings = next;
    markStoryDraft(story);
    await writeDb(db);
    res.json(story);
  })
);

// Read style values (art style, palette, mood) off an approved render or the
// page's template image so the style panel can be auto-filled. Does NOT save —
// the client previews and lets the user adjust before saving.
app.post(
  "/api/stories/:id/extract-style",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const scene = story.scenes.find((s) => s.id === req.body?.sceneId);
    if (!scene) return res.status(404).json({ error: "Scene not found" });

    // Prefer an approved generated render for this page (the look you signed off
    // on); fall back to any render, then the page's template image.
    let imageUrl = null;
    for (const kidId of Object.keys(story.results || {})) {
      const r = story.results[kidId]?.[scene.id];
      if (r?.approved && r.remoteUrl) {
        imageUrl = r.remoteUrl;
        break;
      }
      if (!imageUrl && r?.remoteUrl) imageUrl = r.remoteUrl;
    }
    if (!imageUrl) imageUrl = await ensureBaseFalUrl(scene).catch(() => null);
    if (!imageUrl) return res.status(400).json({ error: "This page has no image to read style from." });

    const style = await extractStyleFromImage(imageUrl);
    if (!style) return res.status(502).json({ error: "Could not read the style from that image." });
    res.json(style);
  })
);

// Manually return a published story to draft (to edit/re-test it).
app.post(
  "/api/stories/:id/unpublish",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    story.status = "draft";
    await writeDb(db);
    res.json(story);
  })
);

// Remove a test child (and its generated results) from a story.
app.delete(
  "/api/stories/:id/kid/:kidId",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const { kidId } = req.params;
    delete story.kids?.[kidId];
    delete story.results?.[kidId];
    story.testKidIds = (story.testKidIds || []).filter((k) => k !== kidId);
    // Fewer/changed test children may invalidate a publish.
    markStoryDraft(story);
    await writeDb(db);
    res.json(story);
  })
);

// ============================ VARIABLES ======================================
// Admin-managed placeholders that text cells can reference as {{Name}}. Their
// values are supplied per order and substituted into the rendered book.
const VAR_TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// Per-character name tokens, e.g. {{name:hero}} / {{nameAr:hero}} where the
// suffix is a cast character's `key`. Distinct from the global VAR_TOKEN above.
const NAME_TOKEN = /\{\{\s*(name|nameAr)\s*:\s*([A-Za-z0-9_]+)\s*\}\}/g;

// `names` (optional) maps a character key -> { name, nameAr } captured at order
// intake. `names.__primary__` is the first character, used so the legacy
// {{Child_Name}} variable falls back to the primary child's intake name.
function applyVars(text, vars, names) {
  if (!text) return text || "";
  let out = text;
  if (names) {
    out = out.replace(NAME_TOKEN, (m, kind, key) => {
      const rec = names[key];
      const v = rec && (kind === "nameAr" ? rec.nameAr : rec.name);
      return v != null && String(v) !== "" ? String(v) : m;
    });
  }
  out = out.replace(VAR_TOKEN, (m, key) => {
    let v = vars?.[key];
    if ((v == null || String(v) === "") && key === "Child_Name" && names?.__primary__) {
      v = names.__primary__.name;
    }
    return v != null && String(v) !== "" ? String(v) : m;
  });
  return out;
}

app.get(
  "/api/variables",
  asyncHandler(async (_req, res) => {
    const db = await readDb();
    const list = Object.values(db.variables || {}).sort((a, b) => a.createdAt - b.createdAt);
    res.json(list);
  })
);

app.post(
  "/api/variables",
  asyncHandler(async (req, res) => {
    const { name, label, defaultValue } = req.body || {};
    const clean = String(name || "").trim().replace(/[^A-Za-z0-9_]/g, "_");
    if (!clean) return res.status(400).json({ error: "Variable name required" });
    const db = await readDb();
    db.variables ||= {};
    if (Object.values(db.variables).some((v) => v.name.toLowerCase() === clean.toLowerCase()))
      return res.status(400).json({ error: "A variable with that name already exists" });
    const id = nanoid(8);
    db.variables[id] = {
      id,
      name: clean,
      label: (label || "").trim() || clean,
      defaultValue: (defaultValue || "").trim(),
      createdAt: Date.now(),
    };
    await writeDb(db);
    res.status(201).json(db.variables[id]);
  })
);

app.delete(
  "/api/variables/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    if (!db.variables?.[req.params.id])
      return res.status(404).json({ error: "Variable not found" });
    delete db.variables[req.params.id];
    await writeDb(db);
    res.json({ ok: true });
  })
);

// --- Customers --------------------------------------------------------------
// A simple directory of people. A customer is { id, name, phone (E.164),
// country (ISO), createdAt }. The phone is validated with libphonenumber-js so
// each number matches its country's real length/format, and it is unique across
// all customers (compared on the normalized E.164 value).

// Validate + normalize a phone number. `country` is an ISO code (e.g. "SA") used
// to interpret numbers typed without a leading "+". Returns either
// { e164, country } or { error }.
function normalizeCustomerPhone(raw, country) {
  const input = String(raw || "").trim();
  if (!input) return { error: "Phone number is required." };
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(input, country || undefined);
  } catch {
    parsed = null;
  }
  if (!parsed) return { error: "Enter a valid phone number with its country code." };
  if (!parsed.isValid()) {
    return { error: "That phone number isn't the right length for the selected country." };
  }
  return { e164: parsed.number, country: parsed.country || country || null };
}

app.get(
  "/api/customers",
  asyncHandler(async (_req, res) => {
    const db = await readDb();
    const list = Object.values(db.customers || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(list);
  })
);

app.post(
  "/api/customers",
  asyncHandler(async (req, res) => {
    const { name, phone, country } = req.body || {};
    const cleanName = String(name || "").trim();
    if (!cleanName) return res.status(400).json({ error: "Customer name is required." });

    const norm = normalizeCustomerPhone(phone, country);
    if (norm.error) return res.status(400).json({ error: norm.error });

    const db = await readDb();
    db.customers ||= {};
    if (Object.values(db.customers).some((c) => c.phone === norm.e164))
      return res.status(400).json({ error: "A customer with that phone number already exists." });

    const id = nanoid(8);
    db.customers[id] = {
      id,
      name: cleanName,
      phone: norm.e164,
      country: norm.country,
      createdAt: Date.now(),
    };
    await writeDb(db);
    res.status(201).json(db.customers[id]);
  })
);

app.put(
  "/api/customers/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const customer = db.customers?.[req.params.id];
    if (!customer) return res.status(404).json({ error: "Customer not found." });

    const { name, phone, country } = req.body || {};
    if (name !== undefined) {
      const cleanName = String(name || "").trim();
      if (!cleanName) return res.status(400).json({ error: "Customer name is required." });
      customer.name = cleanName;
    }
    if (phone !== undefined) {
      const norm = normalizeCustomerPhone(phone, country ?? customer.country);
      if (norm.error) return res.status(400).json({ error: norm.error });
      if (Object.values(db.customers).some((c) => c.id !== customer.id && c.phone === norm.e164))
        return res.status(400).json({ error: "A customer with that phone number already exists." });
      customer.phone = norm.e164;
      customer.country = norm.country;
    }
    await writeDb(db);
    res.json(customer);
  })
);

app.delete(
  "/api/customers/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    if (!db.customers?.[req.params.id])
      return res.status(404).json({ error: "Customer not found." });
    delete db.customers[req.params.id];
    await writeDb(db);
    res.json({ ok: true });
  })
);

// --- Countries (markets) ----------------------------------------------------
// The dynamic registry of operating countries. Reading the (enabled) list is
// open to any signed-in user so selectors/labels work; mutations are admin-only
// (management lives in Settings). When auth is disabled the local user is admin.

function isAdminReq(req) {
  return !AUTH_ENABLED || Boolean(req.me?.isAdmin);
}

app.get(
  "/api/countries",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const all = countryList(db.countries);
    // Admins (and the settings UI via ?all=1) get the full list incl. disabled.
    res.json(isAdminReq(req) || req.query.all === "1" ? all : all.filter((c) => c.enabled));
  })
);

app.post(
  "/api/countries",
  asyncHandler(async (req, res) => {
    if (!isAdminReq(req)) return res.status(403).json({ error: "Admins only." });
    const cc = String(req.body?.code || "").toUpperCase();
    if (!isIsoCountry(cc)) return res.status(400).json({ error: "Unknown country code." });

    const db = await readDb();
    db.countries ||= {};
    if (db.countries[cc]) return res.status(409).json({ error: "That country is already added." });

    const overrides = { order: Object.keys(db.countries).length };
    if (typeof req.body.enabled === "boolean") overrides.enabled = req.body.enabled;
    if (req.body.name && String(req.body.name).trim()) overrides.name = String(req.body.name).trim();
    if (req.body.currency && String(req.body.currency).trim())
      overrides.currency = String(req.body.currency).trim().toUpperCase();
    if (req.body.tax) overrides.tax = req.body.tax;

    db.countries[cc] = defaultCountryRecord(cc, overrides);
    await writeDb(db);
    res.status(201).json(db.countries[cc]);
  })
);

app.put(
  "/api/countries/:code",
  asyncHandler(async (req, res) => {
    if (!isAdminReq(req)) return res.status(403).json({ error: "Admins only." });
    const cc = String(req.params.code || "").toUpperCase();
    const db = await readDb();
    const c = db.countries?.[cc];
    if (!c) return res.status(404).json({ error: "Country not found." });

    const { name, currency, enabled, order, tax } = req.body || {};
    if (name !== undefined) c.name = String(name || "").trim() || c.name;
    if (currency !== undefined) c.currency = String(currency || "").trim().toUpperCase() || c.currency;
    if (enabled !== undefined) c.enabled = Boolean(enabled);
    if (order !== undefined && Number.isFinite(Number(order))) c.order = Number(order);
    if (tax !== undefined) c.tax = normalizeTax(tax);

    await writeDb(db);
    res.json(c);
  })
);

app.delete(
  "/api/countries/:code",
  asyncHandler(async (req, res) => {
    if (!isAdminReq(req)) return res.status(403).json({ error: "Admins only." });
    const cc = String(req.params.code || "").toUpperCase();
    const db = await readDb();
    if (!db.countries?.[cc]) return res.status(404).json({ error: "Country not found." });
    // Historical orders keep their own price/country snapshot, so removing a
    // country here only hides it from new pricing/selectors.
    delete db.countries[cc];
    await writeDb(db);
    res.json({ ok: true });
  })
);

// --- Custom symbols ---------------------------------------------------------
// A shared library of user-uploaded SVG symbols, persisted so they can be
// reused across pages and sessions. Mirrors the built-in SYMBOL_LIBRARY shape
// ({ id, name, svg }) so the editor can render them the same way.

// Strip raw SVG markup down to a single safe <svg> root: drop the XML prolog,
// doctype, comments, <script> tags and inline event handlers.
function sanitizeSvgMarkup(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, "");
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  const start = s.toLowerCase().indexOf("<svg");
  const end = s.toLowerCase().lastIndexOf("</svg>");
  if (start === -1 || end === -1) return "";
  s = s.slice(start, end + 6);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/\son\w+="[^"]*"/gi, "");
  return s.trim();
}

app.get(
  "/api/symbols",
  asyncHandler(async (_req, res) => {
    const db = await readDb();
    const list = Object.values(db.symbols || {}).sort((a, b) => a.createdAt - b.createdAt);
    res.json(list);
  })
);

app.post(
  "/api/symbols",
  asyncHandler(async (req, res) => {
    const svg = sanitizeSvgMarkup(req.body?.svg);
    if (!svg) return res.status(400).json({ error: "A valid <svg> is required" });
    // Guard against pathologically large uploads bloating the JSON store.
    if (svg.length > 100_000)
      return res.status(400).json({ error: "That SVG is too large (max 100KB)." });
    const name = String(req.body?.name || "").trim().slice(0, 80) || "Symbol";
    const db = await readDb();
    db.symbols ||= {};
    const id = nanoid(8);
    db.symbols[id] = { id, name, svg, category: "Custom", createdAt: Date.now() };
    await writeDb(db);
    res.status(201).json(db.symbols[id]);
  })
);

app.delete(
  "/api/symbols/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    if (!db.symbols?.[req.params.id])
      return res.status(404).json({ error: "Symbol not found" });
    delete db.symbols[req.params.id];
    await writeDb(db);
    res.json({ ok: true });
  })
);

// --- Test-image library -----------------------------------------------------
// A small shared panel of reference photos (up to 4 girls + 4 boys) kept in
// Settings. When testing a story we feed the gender-matched set through the
// normal test-child pipeline, so a single calibrated panel covers every story.
const TEST_IMAGE_GENDERS = ["girl", "boy"];
const MAX_TEST_IMAGES_PER_GENDER = 4;

function testImagesPayload(db) {
  const lib = db.testImages || {};
  const pick = (g) =>
    (Array.isArray(lib[g]) ? lib[g] : []).map((it) => ({
      id: it.id,
      gender: g,
      localUrl: it.localUrl,
      createdAt: it.createdAt,
    }));
  return { girl: pick("girl"), boy: pick("boy") };
}

app.get(
  "/api/test-images",
  asyncHandler(async (_req, res) => {
    const db = await readDb();
    res.json(testImagesPayload(db));
  })
);

app.post(
  "/api/test-images",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    const gender = String(req.body?.gender || "").toLowerCase();
    if (!TEST_IMAGE_GENDERS.includes(gender))
      return res.status(400).json({ error: "gender must be 'girl' or 'boy'" });
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const db = await readDb();
    db.testImages ||= { girl: [], boy: [] };
    db.testImages[gender] ||= [];
    if (db.testImages[gender].length >= MAX_TEST_IMAGES_PER_GENDER) {
      await fs.unlink(path.join(UPLOAD_DIR, req.file.filename)).catch(() => {});
      return res
        .status(400)
        .json({ error: `You can keep at most ${MAX_TEST_IMAGES_PER_GENDER} ${gender} photos.` });
    }

    db.testImages[gender].push({
      id: nanoid(8),
      fileName: req.file.filename,
      localUrl: `/uploads/${req.file.filename}`,
      createdAt: Date.now(),
    });
    await writeDb(db);
    res.status(201).json(testImagesPayload(db));
  })
);

app.delete(
  "/api/test-images/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    db.testImages ||= { girl: [], boy: [] };
    let removed = null;
    for (const g of TEST_IMAGE_GENDERS) {
      const arr = db.testImages[g] || [];
      const idx = arr.findIndex((it) => it.id === req.params.id);
      if (idx !== -1) {
        removed = arr.splice(idx, 1)[0];
        break;
      }
    }
    if (!removed) return res.status(404).json({ error: "Test image not found" });
    if (removed.fileName)
      await fs.unlink(path.join(UPLOAD_DIR, removed.fileName)).catch(() => {});
    await writeDb(db);
    res.json(testImagesPayload(db));
  })
);

// ============================ ORDERS =========================================
// An order = one child (kid) processed against one story's scenes. Orders are
// first-class and have their own pages, separate from story (scene) management.

// Resolve which character a kid photo belongs to, defaulting to the story's
// primary character (the back-compat target for legacy single-kid orders).
function orderCharacterId(db, order, characterId) {
  const story = db.stories[order.storyId];
  if (!story) return characterId || null;
  ensureCharacters(story);
  if (characterId && getCharacter(story, characterId)) return characterId;
  return story.characters[0].id;
}

// Read an order's kid for a character, falling back to the legacy order.kid for
// the primary character (orders created before the cast model).
function getOrderKid(db, order, characterId) {
  const cid = orderCharacterId(db, order, characterId);
  const story = db.stories[order.storyId];
  const primId = story ? primaryCharacterId(story) : null;
  const kid = order.kids?.[cid] || (cid === primId ? order.kid : null) || null;
  return { cid, primId, kid };
}

// Patch a character's kid (re-read to avoid clobbering concurrent writes). The
// primary character stays mirrored onto the legacy order.kid field.
async function patchOrderKid(orderId, characterId, patch) {
  const db = await readDb();
  const order = db.orders?.[orderId];
  if (!order) return null;
  const { cid, primId, kid } = getOrderKid(db, order, characterId);
  if (!kid) return null;
  if (!order.kids || typeof order.kids !== "object") order.kids = {};
  const updated = { ...kid, ...patch };
  order.kids[cid] = updated;
  if (cid === primId) order.kid = updated;
  await writeDb(db);
  return updated;
}

// Hydrate an order with its story's cells/title for the client. Text cells get
// a `resolvedText` with the order's variable values substituted in.
// ── Pricing module ─────────────────────────────────────────────────────────
// Pricing is its own module (own access grant), kept entirely separate from the
// creative story workflow. Prices are per-country and stored on the story as
// `prices[CODE] = { price, discountPrice }`. A country with no usable price is
// "waiting for price" (not live for orders).

// List every story with just what the Pricing screen needs: id, title, the
// story's own publish state, and the full per-country price map. The client
// scopes the editable view to the country picked in the header.
app.get(
  "/api/pricing",
  asyncHandler(async (_req, res) => {
    const db = await readDb();
    const rows = Object.values(db.stories)
      // Only published stories are priceable — drafts are still in creative work.
      .filter((s) => s.status === "published")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({
        id: s.id,
        title: s.title || "Untitled story",
        gender: s.gender || "female",
        status: s.status || "draft",
        prices: s.prices && typeof s.prices === "object" ? s.prices : {},
      }));
    res.json(rows);
  })
);

// Set (or clear) a story's price in ONE country. Members may only price the
// countries they're assigned to — "if I'm in Kuwait I price Kuwait". A blank or
// non-positive price clears the entry, returning that market to "waiting".
app.put(
  "/api/pricing/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });

    const cc = String(req.body?.country || "").toUpperCase();
    const countryRec = getCountry(db.countries, cc);
    if (!countryRec || !countryRec.enabled)
      return res.status(400).json({ error: "Pick a valid country to price." });
    if (AUTH_ENABLED && !req.me?.isAdmin && !canCountry(req.me, cc, db.countries))
      return res.status(403).json({ error: `You don't have access to ${countryRec.name}.` });

    const price = Number(req.body?.price);
    const rawDiscount = req.body?.discountPrice;
    const discount = rawDiscount === "" || rawDiscount == null ? null : Number(rawDiscount);

    if (!(story.prices && typeof story.prices === "object")) story.prices = {};

    // Blank / non-positive price → clear this market (back to "waiting").
    if (!Number.isFinite(price) || price <= 0) {
      delete story.prices[cc];
      await writeDb(db);
      return res.json({ id: story.id, country: cc, prices: story.prices });
    }

    if (discount != null && (!Number.isFinite(discount) || discount < 0))
      return res.status(400).json({ error: "Discounted price must be a positive number." });
    if (discount != null && discount >= price)
      return res.status(400).json({ error: "Discounted price must be below the regular price." });

    story.prices[cc] = { price, discountPrice: discount != null && discount > 0 ? discount : null };
    await writeDb(db);
    res.json({ id: story.id, country: cc, prices: story.prices });
  })
);

// The country an order belongs to, falling back to the first enabled country for
// legacy orders created before the multi-country model.
function defaultCountryCode(db) {
  return enabledCountries(db.countries)[0]?.code || "SA";
}

function hydrateOrder(db, order) {
  const story = db.stories[order.storyId];
  const vars = order.variables || {};
  // The order's language scopes which book(s) it produces. Legacy orders with no
  // language fall back to "both" so nothing they already show disappears.
  const language = ["en", "ar", "both"].includes(order.language) ? order.language : "both";

  // Cast + per-character photos. The story drives the cast; the order carries one
  // kid per character in `order.kids`. Legacy orders only have `order.kid`, which
  // maps to the primary character; keep `kid` aliased so old readers keep working.
  const characters = story ? ensureCharacters(story).characters : [];
  const primaryId = characters[0]?.id || null;
  let kids = order.kids && typeof order.kids === "object" ? { ...order.kids } : {};
  if (order.kid && primaryId && !kids[primaryId]) kids[primaryId] = order.kid;
  const kid = (primaryId && kids[primaryId]) || order.kid || null;

  // Per-character names captured at intake, keyed by character.key for the
  // {{name:<key>}} / {{nameAr:<key>}} tokens (primary doubles as {{Child_Name}}).
  const names = {};
  for (const c of characters) {
    const k = kids[c.id];
    names[c.key] = { name: k?.name || "", nameAr: k?.nameAr || "" };
  }
  names.__primary__ = characters[0] ? names[characters[0].key] : null;

  const scenes = (story?.scenes || [])
    .filter((c) => language === "both" || (c.lang || "en") === language)
    .map((c) => (c.type === "text" ? { ...c, resolvedText: applyVars(c.text, vars, names) } : c));

  // Country + price snapshot. New orders carry their own pricing; legacy ones get
  // a best-effort price from the story's current price for display only.
  const country = order.country || defaultCountryCode(db);
  let pricing = order.pricing || null;
  if (!pricing) {
    const eff = effectivePrice(story?.prices?.[country]);
    const rec = getCountry(db.countries, country);
    if (eff && rec) {
      pricing = {
        ...computeOrderPricing(eff.effective, rec),
        listPrice: eff.price,
        discountPrice: eff.discountPrice,
      };
    }
  }

  // Customer snapshot for display. Legacy orders predate customers (null).
  const customer = order.customerId ? db.customers?.[order.customerId] || null : null;

  return {
    ...order,
    language,
    storyTitle: story?.title || "(deleted story)",
    storyMissing: !story,
    customer: customer
      ? { id: customer.id, name: customer.name, phone: customer.phone, country: customer.country }
      : null,
    scenes,
    variables: vars,
    country,
    pricing,
    characters,
    kids,
    kid,
    // Age/gender/aspect live on the story; surface them for the order UI.
    age: story?.age ?? null,
    gender: story?.gender || "female",
    aspect: story?.aspect || "3:4",
  };
}

app.get(
  "/api/orders",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    // Admins (and local/no-auth) see every country; members are scoped to theirs.
    const isAdmin = !AUTH_ENABLED || req.me?.isAdmin;
    const allowed = isAdmin ? null : allowedCountries(req.me, db.countries);
    const wanted = String(req.query.country || "all");

    const orders = Object.values(db.orders || {})
      .map((o) => hydrateOrder(db, o))
      .filter((o) => {
        if (allowed && !allowed.includes(o.country)) return false;
        if (wanted !== "all" && o.country !== wanted) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json(orders);
  })
);

app.post(
  "/api/orders",
  asyncHandler(async (req, res) => {
    const { title, storyId, variables, language, country, customerId } = req.body || {};
    const db = await readDb();
    const story = db.stories[storyId];
    if (!story) return res.status(400).json({ error: "Pick a valid story" });
    if (story.status !== "published")
      return res
        .status(400)
        .json({ error: "This story isn't published yet. Test and publish it before taking orders." });

    // Every order belongs to a customer.
    const customer = db.customers?.[customerId];
    if (!customer) return res.status(400).json({ error: "Pick a customer for this order." });

    const cc = String(country || "").toUpperCase();
    const countryRec = getCountry(db.countries, cc);
    if (!countryRec || !countryRec.enabled)
      return res.status(400).json({ error: "Pick a valid country for this order." });
    if (AUTH_ENABLED && !req.me?.isAdmin && !canCountry(req.me, cc, db.countries))
      return res.status(403).json({ error: `You don't have access to ${countryRec.name}.` });

    const eff = effectivePrice(story.prices?.[cc]);
    if (!eff)
      return res.status(400).json({ error: `This story is waiting for a price in ${countryRec.name}.` });

    db.orders ||= {};
    const id = nanoid(8);
    db.orders[id] = {
      id,
      title: (title || "Untitled order").trim(),
      storyId,
      customerId: customer.id,
      country: cc,
      // Snapshot the price + tax so later edits never rewrite this order. The
      // effective price (discount when present) drives the tax math; the list +
      // discount prices ride along for display.
      pricing: {
        ...computeOrderPricing(eff.effective, countryRec),
        listPrice: eff.price,
        discountPrice: eff.discountPrice,
      },
      // Which book(s) this order generates: "en", "ar", or "both".
      language: ["en", "ar", "both"].includes(language) ? language : "both",
      variables: variables && typeof variables === "object" ? variables : {},
      createdAt: Date.now(),
      kid: null,
      // One uploaded child per cast character (keyed by character id).
      kids: {},
      results: {},
    };
    await writeDb(db);
    res.status(201).json(hydrateOrder(db, db.orders[id]));
  })
);

app.get(
  "/api/orders/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const order = db.orders?.[req.params.id];
    if (!order) return res.status(404).json({ error: "Order not found" });
    const country = order.country || defaultCountryCode(db);
    if (AUTH_ENABLED && !req.me?.isAdmin && !canCountry(req.me, country, db.countries))
      return res.status(403).json({ error: "No access to this country's orders." });
    res.json(hydrateOrder(db, order));
  })
);

app.delete(
  "/api/orders/:id",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    if (!db.orders?.[req.params.id])
      return res.status(404).json({ error: "Order not found" });
    delete db.orders[req.params.id];
    await writeDb(db);
    res.json({ ok: true });
  })
);

// Stage 1: upload a kid photo. `characterId` selects which cast member it's for;
// omitted (legacy /kid) targets the story's primary character.
async function handleKidUpload(req, res, characterId) {
  const db = await readDb();
  const order = db.orders?.[req.params.id];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!req.file) return res.status(400).json({ error: "No kid photo uploaded" });

  const cid = orderCharacterId(db, order, characterId);
  const primId = primaryCharacterId(db.stories[order.storyId]);
  const kid = newKid(req.file);
  kid.rawFalUrl = await uploadToFal(path.join(UPLOAD_DIR, req.file.filename));
  // Photo intake gate (see validateKidPhoto / derivePhotoStatus). Saved even on
  // failure so the UI can show the original photo and the failure reasons.
  await applyRawPhotoCheck(kid);
  if (!order.kids || typeof order.kids !== "object") order.kids = {};
  order.kids[cid] = kid;
  if (cid === primId) order.kid = kid;
  // A new photo invalidates every render that used the old cast.
  order.results = {};
  await writeDb(db);
  res.json(hydrateOrder(db, order));
}

// Stage 2: restore + feature extraction for a character's kid.
async function handleKidRestore(req, res, characterId) {
  const db = await readDb();
  const order = db.orders?.[req.params.id];
  if (!order) return res.status(404).json({ error: "Order not found" });
  const { kid } = getOrderKid(db, order, characterId);
  if (!kid) return res.status(404).json({ error: "This child has no photo yet" });
  if (kid.photoStatus === "needs_new_photo") return res.status(400).json({ error: PHOTO_GATE_MESSAGE });

  const patch = await runRestore(kid);
  await patchOrderKid(req.params.id, characterId, patch);
  const db2 = await readDb();
  res.json(hydrateOrder(db2, db2.orders[req.params.id]));
}

// Stage 3: anchor + score for a character's kid.
async function handleKidAnchor(req, res, characterId) {
  const db = await readDb();
  const order = db.orders?.[req.params.id];
  if (!order) return res.status(404).json({ error: "Order not found" });
  const { kid } = getOrderKid(db, order, characterId);
  if (!kid) return res.status(404).json({ error: "This child has no photo yet" });
  if (kid.photoStatus === "needs_new_photo") return res.status(400).json({ error: PHOTO_GATE_MESSAGE });

  const patch = await runAnchor(kid, req.body?.anchorPrompt);
  await patchOrderKid(req.params.id, characterId, patch);
  const db2 = await readDb();
  res.json(hydrateOrder(db2, db2.orders[req.params.id]));
}

// Set a character's display name (used by {{name:<key>}} / {{nameAr:<key>}}).
async function handleKidName(req, res, characterId) {
  const order = (await readDb()).orders?.[req.params.id];
  if (!order) return res.status(404).json({ error: "Order not found" });
  const patch = {};
  if (typeof req.body?.name === "string") patch.name = req.body.name.trim();
  if (typeof req.body?.nameAr === "string") patch.nameAr = req.body.nameAr.trim();
  const updated = await patchOrderKid(req.params.id, characterId, patch);
  if (!updated) return res.status(404).json({ error: "This child has no photo yet" });
  const db2 = await readDb();
  res.json(hydrateOrder(db2, db2.orders[req.params.id]));
}

// Legacy single-kid routes (target the primary character).
app.post("/api/orders/:id/kid", upload.single("kid"), asyncHandler((req, res) => handleKidUpload(req, res, null)));
app.put("/api/orders/:id/kid/name", asyncHandler((req, res) => handleKidName(req, res, null)));
app.put(
  "/api/orders/:id/characters/:characterId/kid/name",
  asyncHandler((req, res) => handleKidName(req, res, req.params.characterId))
);
app.post("/api/orders/:id/kid/restore", asyncHandler((req, res) => handleKidRestore(req, res, null)));
app.post("/api/orders/:id/kid/anchor", asyncHandler((req, res) => handleKidAnchor(req, res, null)));

// Per-character routes (multi-kid orders). Scoped under /characters/:characterId
// to avoid colliding with the /kid/restore and /kid/anchor sub-paths above.
app.post(
  "/api/orders/:id/characters/:characterId/kid",
  upload.single("kid"),
  asyncHandler((req, res) => handleKidUpload(req, res, req.params.characterId))
);
app.post(
  "/api/orders/:id/characters/:characterId/kid/restore",
  asyncHandler((req, res) => handleKidRestore(req, res, req.params.characterId))
);
app.post(
  "/api/orders/:id/characters/:characterId/kid/anchor",
  asyncHandler((req, res) => handleKidAnchor(req, res, req.params.characterId))
);

// Generate one scene for this order's kid.
app.post(
  "/api/orders/:id/generate",
  asyncHandler(async (req, res) => {
    const { sceneId, prompt, method, gender, workflowType, mode } = req.body || {};
    const db = await readDb();
    const order = db.orders?.[req.params.id];
    if (!order) return res.status(404).json({ error: "Order not found" });

    const story = db.stories[order.storyId];
    if (!story) return res.status(400).json({ error: "Order's story was deleted" });
    if (story.status !== "published")
      return res.status(400).json({ error: "This story is no longer published. Re-publish it to fulfill orders." });
    ensureCharacters(story);
    const scene = story.scenes.find((s) => s.id === sceneId);
    if (!scene) return res.status(404).json({ error: "Scene not found" });

    const baseFalUrl = await ensureBaseFalUrl(scene);
    if (!baseFalUrl)
      return res
        .status(400)
        .json({ error: "This page has no AI image to regenerate (it is text/overlay only)." });

    // Per-character kid map (legacy order.kid mirrors the primary character).
    const charactersById = Object.fromEntries(story.characters.map((c) => [c.id, c]));
    const primId = story.characters[0].id;
    const kidsByCharacter = order.kids && typeof order.kids === "object" ? { ...order.kids } : {};
    if (order.kid && !kidsByCharacter[primId]) kidsByCharacter[primId] = order.kid;

    // Scoring level is shared by both generation paths.
    const scoring = scene.identityScoring || (aiBaseElement(scene) || scene.falUrl ? "advisory" : "none");

    // Multi-kid pages with face slots use composite-per-face; everything else
    // falls back to the original single-kid generation (full back-compat).
    const slots = Array.isArray(scene.kidSlots) ? scene.kidSlots.filter((s) => s.characterId) : [];

    let result;
    if (slots.length) {
      const needed = [...new Set(slots.map((s) => s.characterId))];
      const missing = needed.filter((cid) => {
        const k = kidsByCharacter[cid];
        return !k || k.photoStatus === "needs_new_photo";
      });
      if (missing.length)
        return res.status(400).json({
          error: `Upload an accepted photo for: ${missing
            .map((cid) => charactersById[cid]?.label || "a child")
            .join(", ")}`,
        });
      result = await runSlotComposite({
        scene: { ...scene, falUrl: baseFalUrl },
        baseFalUrl,
        slots,
        kidsByCharacter,
        charactersById,
        scoring,
      });
    } else {
      if (!order.kid) return res.status(400).json({ error: "Upload a kid photo first" });
      if (order.kid.photoStatus === "needs_new_photo") return res.status(400).json({ error: PHOTO_GATE_MESSAGE });

      // Replay the recipe that was tested and approved on the story for this page;
      // only the child differs. Fall back to the request values for any page that
      // somehow lacks an approved recipe.
      const genMode = scene.approvedMode || mode || "face";
      const genMethod = scene.approvedMethod || method || "edit";
      const genPrompt =
        scene.approvedPrompt != null ? scene.approvedPrompt : genMode === "identity" ? "" : prompt;

      result = await runGenerate({
        scene: { ...scene, falUrl: baseFalUrl },
        kid: order.kid,
        prompt: genPrompt,
        method: genMethod,
        gender: gender || story.gender,
        age: story.age,
        workflowType,
        mode: genMode,
        extraPrompt: composeExtra(story, scene),
        persistSceneStoryPrompt: async (desc) => {
          const dbS = await readDb();
          const sc = dbS.stories[order.storyId]?.scenes.find((s) => s.id === sceneId);
          if (sc) {
            sc.storyPrompt = desc;
            await writeDb(dbS);
          }
        },
      });
    }

    const db2 = await readDb();
    const order2 = db2.orders[req.params.id];
    order2.results ||= {};
    order2.results[sceneId] = result;

    // Reuse this render for any language twin that shares the same base image, so
    // a "both" order produces each unique image once. Twins are visually identical
    // (only their overlay text differs), so the same generated image is correct.
    const filledIds = [sceneId];
    const lang = ["en", "ar", "both"].includes(order2.language) ? order2.language : "both";
    const baseKey = sceneBaseKey(scene);
    if (baseKey) {
      for (const sib of story.scenes) {
        if (sib.id === sceneId) continue;
        if (lang !== "both" && (sib.lang || "en") !== lang) continue;
        if (sceneBaseKey(sib) === baseKey) {
          order2.results[sib.id] = result;
          filledIds.push(sib.id);
        }
      }
    }
    await writeDb(db2);

    res.json({ sceneId, result, filledIds });
  })
);

// --- Consistency check (stubbed in fal-only build) ----------------------------
app.post(
  "/api/check",
  asyncHandler(async (req, res) => {
    const { referenceUrl, candidateUrl, candidateIsScene } = req.body || {};
    const result = await checkConsistency({ referenceUrl, candidateUrl, candidateIsScene });
    res.json(result);
  })
);

// --- Serve the built web SPA (single-service production deploy) ---------------
// In production the Express server also serves the Vite build, so the API and
// UI share one origin (no proxy needed). In local dev Vite serves the UI.
const WEB_DIST = path.join(__dirname, "..", "web", "dist");
app.use(express.static(WEB_DIST));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/uploads")) return next();
  res.sendFile(path.join(WEB_DIST, "index.html"), (err) => {
    if (err) next();
  });
});

// Hydrate runtime config from the database so user-saved settings (fal key,
// gemini key, anchor provider) persist across restarts and redeploys. These
// take precedence over the injected environment defaults once a user saves them.
async function applyStoredSettings() {
  try {
    const db = await readDb();
    const s = db.settings || {};
    if (s.FAL_KEY) setFalKey(s.FAL_KEY);
    if (s.GEMINI_API_KEY) process.env.GEMINI_API_KEY = s.GEMINI_API_KEY;
    if (s.ANCHOR_PROVIDER) process.env.ANCHOR_PROVIDER = s.ANCHOR_PROVIDER;
    if (Object.keys(s).length) {
      console.log(`  Loaded saved settings: ${Object.keys(s).join(", ")}`);
    }
  } catch (err) {
    console.error("[settings] failed to load stored settings:", err.message);
  }
}

// Seed the country registry (GCC) on first boot so the app is usable immediately.
// Admins can edit/add/remove afterward; we never overwrite an existing registry.
async function seedCountriesIfEmpty() {
  try {
    const db = await readDb();
    if (db.countries && Object.keys(db.countries).length) return;
    db.countries = {};
    SEED_COUNTRY_CODES.forEach((code, i) => {
      db.countries[code] = defaultCountryRecord(code, { order: i });
    });
    await writeDb(db);
    console.log(`  Seeded countries: ${SEED_COUNTRY_CODES.join(", ")}`);
  } catch (err) {
    console.error("[countries] failed to seed registry:", err.message);
  }
}

await applyStoredSettings();
await seedCountriesIfEmpty();

app.listen(PORT, () => {
  console.log(`\n  Hazawy admin server  ->  http://localhost:${PORT}`);
  if (!process.env.FAL_KEY) {
    console.log("  ⚠  FAL_KEY missing. Copy server/.env.example to server/.env and add it.");
  }
  console.log(`  Checker: ${isCheckerEnabled() ? "enabled" : "stubbed (no GEMINI_API_KEY)"}\n`);
});
