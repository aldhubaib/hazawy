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
import { nanoid } from "nanoid";

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
  [/^\/api\/orders(\/|$)/, "orders"],
  [/^\/api\/variables(\/|$)/, "variables"],
  [/^\/api\/settings(\/|$)/, "settings"],
  [/^\/api\/access(\/|$)/, "access"],
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
  // visibleModules() expands admins to admin-only modules too, via can().
  return { ...user, isAdmin: role === "admin", modules: visibleModules(user), exists: Boolean(record) };
}

// Gate /api routes by the module they belong to, using the shared can(). Skips
// itself when auth is off so the tool runs fully open with zero setup.
app.use(async (req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (!req.path.startsWith("/api/")) return next();

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
    invitedAt: record.invitedAt || 0,
  };
}

// Who the current request is. When auth is disabled this returns a synthetic
// admin so the app stays fully usable with no Clerk setup.
app.get(
  "/api/access/me",
  asyncHandler(async (req, res) => {
    if (!AUTH_ENABLED) {
      const user = { email: "", role: "admin", modules: ASSIGNABLE_MODULES.slice() };
      return res.json({ ...ACCESS_META, ...user, isAdmin: true, modules: visibleModules(user) });
    }
    const me = req.me;
    res.json({ ...ACCESS_META, email: me.email, role: me.role, isAdmin: me.isAdmin, modules: me.modules });
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
    db.access.users[email] = { email, role, modules, invitedAt: Date.now() };
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
    const { text, size, type, style, elements, bgUrl, bgFalUrl, bgColor, safeZones, identityScoring, identityScoringManual, identityNote, genChoice, correction, aiPrompt } = req.body || {};
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
// Returns the local url plus a fal url; does not mutate any cell.
app.post(
  "/api/media",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    const url = `/uploads/${req.file.filename}`;
    let falUrl = null;
    try {
      falUrl = await uploadToFal(path.join(UPLOAD_DIR, req.file.filename));
    } catch (e) {
      console.warn("media upload to fal failed:", e.message);
    }
    res.status(201).json({ url, falUrl });
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
    // Per-page generation prompt set in the editor (AI image only).
    (scene.aiPrompt || "").trim(),
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

// Update the story's child gender. This changes how pages generate, so it drops
// the story back to draft.
app.put(
  "/api/stories/:id/gender",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const story = db.stories[req.params.id];
    if (!story) return res.status(404).json({ error: "Story not found" });
    const { gender } = req.body || {};
    if (["female", "male", "non-binary"].includes(gender)) story.gender = gender;
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

function applyVars(text, vars) {
  if (!text) return text || "";
  return text.replace(VAR_TOKEN, (m, key) => {
    const v = vars?.[key];
    return v != null && String(v) !== "" ? String(v) : m;
  });
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

// Patch the order's kid (re-read to avoid clobbering concurrent writes).
async function patchOrderKid(orderId, patch) {
  const db = await readDb();
  const order = db.orders?.[orderId];
  if (!order?.kid) return null;
  Object.assign(order.kid, patch);
  await writeDb(db);
  return order.kid;
}

// Hydrate an order with its story's cells/title for the client. Text cells get
// a `resolvedText` with the order's variable values substituted in.
function hydrateOrder(db, order) {
  const story = db.stories[order.storyId];
  const vars = order.variables || {};
  const scenes = (story?.scenes || []).map((c) =>
    c.type === "text" ? { ...c, resolvedText: applyVars(c.text, vars) } : c
  );
  return {
    ...order,
    storyTitle: story?.title || "(deleted story)",
    storyMissing: !story,
    scenes,
    variables: vars,
    // Age/gender/aspect live on the story; surface them for the order UI.
    age: story?.age ?? null,
    gender: story?.gender || "female",
    aspect: story?.aspect || "3:4",
  };
}

app.get(
  "/api/orders",
  asyncHandler(async (_req, res) => {
    const db = await readDb();
    const orders = Object.values(db.orders || {})
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((o) => hydrateOrder(db, o));
    res.json(orders);
  })
);

app.post(
  "/api/orders",
  asyncHandler(async (req, res) => {
    const { title, storyId, variables } = req.body || {};
    const db = await readDb();
    if (!db.stories[storyId]) return res.status(400).json({ error: "Pick a valid story" });
    if (db.stories[storyId].status !== "published")
      return res
        .status(400)
        .json({ error: "This story isn't published yet. Test and publish it before taking orders." });
    db.orders ||= {};
    const id = nanoid(8);
    db.orders[id] = {
      id,
      title: (title || "Untitled order").trim(),
      storyId,
      variables: variables && typeof variables === "object" ? variables : {},
      createdAt: Date.now(),
      kid: null,
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

// Stage 1: upload the kid photo for an order.
app.post(
  "/api/orders/:id/kid",
  upload.single("kid"),
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const order = db.orders?.[req.params.id];
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!req.file) return res.status(400).json({ error: "No kid photo uploaded" });

    const kid = newKid(req.file);
    kid.rawFalUrl = await uploadToFal(path.join(UPLOAD_DIR, req.file.filename));
    // Photo intake gate (see validateKidPhoto / derivePhotoStatus). Saved even on
    // failure so the UI can show the original photo and the failure reasons.
    await applyRawPhotoCheck(kid);
    order.kid = kid;
    order.results = {};
    await writeDb(db);
    res.json(hydrateOrder(db, order));
  })
);

// Stage 2: restore + feature extraction.
app.post(
  "/api/orders/:id/kid/restore",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const order = db.orders?.[req.params.id];
    if (!order?.kid) return res.status(404).json({ error: "Order has no kid yet" });
    if (order.kid.photoStatus === "needs_new_photo") return res.status(400).json({ error: PHOTO_GATE_MESSAGE });

    const patch = await runRestore(order.kid);
    await patchOrderKid(req.params.id, patch);
    const db2 = await readDb();
    res.json(hydrateOrder(db2, db2.orders[req.params.id]));
  })
);

// Stage 3: anchor + score.
app.post(
  "/api/orders/:id/kid/anchor",
  asyncHandler(async (req, res) => {
    const db = await readDb();
    const order = db.orders?.[req.params.id];
    if (!order?.kid) return res.status(404).json({ error: "Order has no kid yet" });
    if (order.kid.photoStatus === "needs_new_photo") return res.status(400).json({ error: PHOTO_GATE_MESSAGE });

    const patch = await runAnchor(order.kid, req.body?.anchorPrompt);
    await patchOrderKid(req.params.id, patch);
    const db2 = await readDb();
    res.json(hydrateOrder(db2, db2.orders[req.params.id]));
  })
);

// Generate one scene for this order's kid.
app.post(
  "/api/orders/:id/generate",
  asyncHandler(async (req, res) => {
    const { sceneId, prompt, method, gender, workflowType, mode } = req.body || {};
    const db = await readDb();
    const order = db.orders?.[req.params.id];
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.kid) return res.status(400).json({ error: "Upload a kid photo first" });
    if (order.kid.photoStatus === "needs_new_photo") return res.status(400).json({ error: PHOTO_GATE_MESSAGE });

    const story = db.stories[order.storyId];
    if (!story) return res.status(400).json({ error: "Order's story was deleted" });
    if (story.status !== "published")
      return res.status(400).json({ error: "This story is no longer published. Re-publish it to fulfill orders." });
    const scene = story.scenes.find((s) => s.id === sceneId);
    if (!scene) return res.status(404).json({ error: "Scene not found" });

    const baseFalUrl = await ensureBaseFalUrl(scene);
    if (!baseFalUrl)
      return res
        .status(400)
        .json({ error: "This page has no AI image to regenerate (it is text/overlay only)." });

    // Replay the recipe that was tested and approved on the story for this page;
    // only the child differs. Fall back to the request values for any page that
    // somehow lacks an approved recipe.
    const genMode = scene.approvedMode || mode || "face";
    const genMethod = scene.approvedMethod || method || "edit";
    const genPrompt =
      scene.approvedPrompt != null ? scene.approvedPrompt : genMode === "identity" ? "" : prompt;

    const result = await runGenerate({
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

    const db2 = await readDb();
    const order2 = db2.orders[req.params.id];
    order2.results ||= {};
    order2.results[sceneId] = result;
    await writeDb(db2);

    res.json({ sceneId, result });
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

await applyStoredSettings();

app.listen(PORT, () => {
  console.log(`\n  Hazawy admin server  ->  http://localhost:${PORT}`);
  if (!process.env.FAL_KEY) {
    console.log("  ⚠  FAL_KEY missing. Copy server/.env.example to server/.env and add it.");
  }
  console.log(`  Checker: ${isCheckerEnabled() ? "enabled" : "stubbed (no GEMINI_API_KEY)"}\n`);
});
