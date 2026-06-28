import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fal } from "@fal-ai/client";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "uploads");

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!process.env.FAL_KEY) {
    throw new Error(
      "FAL_KEY is not set. Copy server/.env.example to server/.env and add your fal.ai key."
    );
  }
  fal.config({ credentials: process.env.FAL_KEY });
  configured = true;
}

/**
 * Apply a new fal.ai key at runtime (e.g. saved from the Settings page) so the
 * client picks it up without a server restart.
 */
export function setFalKey(key) {
  const trimmed = (key || "").trim();
  if (!trimmed) {
    process.env.FAL_KEY = "";
    configured = false;
    return;
  }
  process.env.FAL_KEY = trimmed;
  fal.config({ credentials: trimmed });
  configured = true;
}

/** Upload a local file to fal storage and return a public URL. */
export async function uploadToFal(absPath) {
  ensureConfigured();
  const buf = await fs.readFile(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const type = MIME_BY_EXT[ext] || "application/octet-stream";
  const file = new File([buf], path.basename(absPath), { type });
  return fal.storage.upload(file);
}

/**
 * GPT-Image-2 EDIT via fal (openai/gpt-image-2/edit). Image-in, image-out: the
 * uploaded/restored child photo is the actual input, not just a text prompt.
 * Uses the existing FAL_KEY / @fal-ai/client setup (no OpenAI SDK). Returns the
 * generated image URL plus the fal request id (no image bytes are returned).
 */
export const GPT_IMAGE_2_ENDPOINT = "openai/gpt-image-2/edit";

export async function gptImage2Edit({
  imageUrl,
  prompt,
  imageSize = "square_hd",
  quality = "medium",
  outputFormat = "png",
}) {
  ensureConfigured();
  const result = await fal.subscribe(GPT_IMAGE_2_ENDPOINT, {
    input: {
      prompt,
      image_urls: [imageUrl],
      image_size: imageSize,
      quality,
      num_images: 1,
      output_format: outputFormat,
    },
    logs: true,
  });
  const image = result?.data?.images?.[0];
  if (!image?.url) {
    throw new Error("gpt-image-2 edit returned no image. Raw: " + JSON.stringify(result?.data));
  }
  return { url: image.url, requestId: result?.requestId || null };
}

/** Reject a promise if it doesn't settle within `ms` (the upstream job keeps running). */
export function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Download an image, downscale its longest edge to `maxEdge` px (keeping aspect),
 * and re-upload to fal. Large inputs (e.g. 4096px) make downstream models slow
 * and expensive; ~1024px is plenty for face identity. Returns a fal URL.
 */
export async function downscaleToFal(imageUrl, maxEdge = 1024) {
  ensureConfigured();
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image to downscale (${res.status})`);
  const input = Buffer.from(await res.arrayBuffer());
  const out = await sharp(input)
    .rotate() // honor EXIF orientation
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const file = new File([out], "downscaled.png", { type: "image/png" });
  return fal.storage.upload(file);
}

/**
 * Place an image onto a fixed square canvas so every anchor shares the same
 * aspect ratio and output size — a consistent reference frame for all kids,
 * regardless of how each original photo was cropped/zoomed. Returns a fal URL.
 *
 * NOTE: this standardizes the CANVAS (aspect + size). True eye-level/scale
 * alignment (FFHQ-style) additionally needs a face-landmark detector to warp
 * each face onto fixed eye coordinates — a heavier follow-up we can add later.
 */
export async function padToSquareFal(imageUrl, size = 1024, background = { r: 236, g: 236, b: 238 }) {
  ensureConfigured();
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image to normalize (${res.status})`);
  const input = Buffer.from(await res.arrayBuffer());
  const out = await sharp(input)
    .rotate() // honor EXIF orientation
    .resize(size, size, { fit: "contain", background })
    .flatten({ background })
    .png()
    .toBuffer();
  const file = new File([out], "anchor-normalized.png", { type: "image/png" });
  return fal.storage.upload(file);
}

/**
 * Restore / enhance an old or degraded photo (fixes fading, color cast,
 * scratches, low resolution). Returns a public URL to the cleaned image.
 */
export async function restorePhoto(imageUrl) {
  ensureConfigured();
  const result = await fal.subscribe("fal-ai/image-apps-v2/photo-restoration", {
    input: {
      image_url: imageUrl,
      enhance_resolution: true,
      fix_colors: true,
      remove_scratches: true,
    },
  });
  const out = result?.data?.images?.[0];
  if (!out?.url) {
    throw new Error("photo-restoration returned no image: " + JSON.stringify(result?.data));
  }
  return out.url;
}

/**
 * Generic Nano Banana 2 edit. First URL is the base image, the rest are
 * reference images. Returns the generated image URL + model description.
 */
// nano-banana is non-deterministic and intermittently refuses to produce any
// image for a given prompt+images (fal returns 422 `no_media_generated`).
// The same inputs usually succeed on a retry, so we retry a few times before
// surfacing the failure with a clear, actionable message.
function isNoMediaError(err) {
  if (err?.status !== 422) return false;
  const detail = err?.body?.detail;
  if (!Array.isArray(detail)) return false;
  return detail.some((d) => d?.type === "no_media_generated");
}

export async function nanoEdit({ imageUrls, prompt, resolution = "1K", retries = 3 }) {
  ensureConfigured();
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fal.subscribe("fal-ai/nano-banana-2/edit", {
        input: {
          prompt,
          image_urls: imageUrls,
          resolution,
          num_images: 1,
        },
      });
      const image = result?.data?.images?.[0];
      if (!image?.url) {
        throw new Error("fal returned no image. Raw: " + JSON.stringify(result?.data));
      }
      return { url: image.url, description: result.data.description || "" };
    } catch (err) {
      lastErr = err;
      if (!isNoMediaError(err)) throw err;
      console.warn(
        `nanoEdit: model refused (no_media_generated), attempt ${attempt}/${retries}` +
          (attempt < retries ? " — retrying…" : "")
      );
    }
  }
  const e = new Error(
    "The image model refused to generate this page after several attempts. " +
      "This usually means the prompt or reference photo tripped a content/safety filter — " +
      "try a different reference photo, a clearer face crop, or regenerate."
  );
  e.cause = lastErr;
  e.status = 422;
  throw e;
}

/**
 * Landmark-based face swap (easel-ai/advanced-face-swap). Unlike nanoEdit, this
 * keeps the TARGET scene's facial geometry (eye position, head pose, smile) and
 * transplants the child's identity onto it — far more consistent across scenes.
 *
 * @param {string} faceImageUrl     public URL of the child's face (real/restored photo)
 * @param {string} targetImageUrl   public URL of the finished scene to swap into
 * @param {"male"|"female"|"non-binary"} gender  gender of the child
 * @param {"target_hair"|"user_hair"} workflowType  target_hair keeps the scene's hair
 * @param {boolean} upscale  2x upscale (changes output size); off to keep scene resolution
 * @param {boolean} detailer  refine face detail (slightly slower)
 */
export async function advancedFaceSwap({
  faceImageUrl,
  targetImageUrl,
  gender = "female",
  workflowType = "target_hair",
  upscale = false,
  detailer = true,
  timeoutMs = 90000,
}) {
  ensureConfigured();
  const result = await withTimeout(
    fal.subscribe("easel-ai/advanced-face-swap", {
      input: {
        face_image_0: faceImageUrl,
        gender_0: gender,
        target_image: targetImageUrl,
        workflow_type: workflowType,
        upscale,
        detailer,
      },
    }),
    timeoutMs,
    "face swap"
  );
  const image = result?.data?.image;
  if (!image?.url) {
    throw new Error("face swap returned no image. Raw: " + JSON.stringify(result?.data));
  }
  return { url: image.url };
}

/**
 * Run a vision LLM (via fal's OpenRouter gateway) over one or more images.
 * Uses the same FAL_KEY — no separate Gemini key required.
 * Returns the model's raw text output.
 */
export async function visionJudge({
  imageUrls,
  prompt,
  systemPrompt,
  model = "google/gemini-2.5-flash",
}) {
  ensureConfigured();
  const result = await fal.subscribe("openrouter/router/vision", {
    input: {
      prompt,
      system_prompt: systemPrompt,
      image_urls: imageUrls,
      model,
      temperature: 0,
    },
  });
  const output = result?.data?.output;
  if (typeof output !== "string") {
    throw new Error("vision judge returned no output: " + JSON.stringify(result?.data));
  }
  return output;
}

/**
 * Use a vision model to describe ONE child's permanent identifying features, so
 * the description can be injected into the generation prompt alongside the photo.
 * Returns a short plain-text spec (or "" on failure).
 */
export async function describeChildFeatures(imageUrl) {
  try {
    const text = await visionJudge({
      imageUrls: [imageUrl],
      systemPrompt:
        "You are an expert character artist writing a precise reference sheet so another " +
        "artist can reproduce ONE specific child's face exactly. Output plain text only, no preamble.",
      prompt:
        "Describe ONLY this child's permanent identifying features, specifically and concisely, in 2-4 " +
        "sentences. Cover: face shape; skin tone; eyes (shape, size, spacing, color); eyebrows; nose; " +
        "mouth and lips; cheeks and chin; hair (style, length, parting/bangs, color, texture); " +
        "and any distinctive marks. Do NOT mention, estimate or imply the child's age or how old they " +
        "look. Do not guess a name. Do not describe or mention any headband, " +
        "hairband, clip, hat or other head accessory. Do not describe clothing, background, mood, " +
        "lighting, or image quality. Present tense.",
    });
    return (text || "").trim();
  } catch (e) {
    console.warn("describeChildFeatures failed:", e.message);
    return "";
  }
}

/**
 * Extract a child's permanent features as STRUCTURED, enum-friendly fields so the
 * app can reason about them programmatically (panel coverage, order-time guard,
 * scoring). Complements describeChildFeatures (which returns free prose for the
 * generation prompt). Returns an object, or null on failure.
 */
export async function describeChildFeaturesStruct(imageUrl) {
  try {
    const raw = await visionJudge({
      imageUrls: [imageUrl],
      systemPrompt:
        "You analyze a photo of ONE child and output a compact structured description of their " +
        "permanent identifying features. Respond with ONLY minified JSON. No markdown, no prose.",
      prompt:
        "Look at this child and return JSON exactly like: " +
        '{"skin_tone":"medium","hair_length":"short","hair_color":"black","hair_texture":"straight",' +
        '"eye_color":"brown","glasses":false,"approx_age":5}. ' +
        "skin_tone must be one of: 'fair','light','medium','olive','brown','dark'. " +
        "hair_length must be one of: 'bald','very_short','short','chin','shoulder','long'. " +
        "hair_texture must be one of: 'straight','wavy','curly','coily'. " +
        "hair_color and eye_color are short lowercase words. glasses is a boolean. " +
        "approx_age is an integer estimate in years. Use your best judgement for every field.",
    });
    const cleaned = (raw || "").replace(/```json/gi, "").replace(/```/g, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const oneOf = (v, allowed) =>
      typeof v === "string" && allowed.includes(v.toLowerCase()) ? v.toLowerCase() : null;
    return {
      skin_tone: oneOf(o.skin_tone, ["fair", "light", "medium", "olive", "brown", "dark"]),
      hair_length: oneOf(o.hair_length, ["bald", "very_short", "short", "chin", "shoulder", "long"]),
      hair_color: typeof o.hair_color === "string" ? o.hair_color.toLowerCase().slice(0, 24) : null,
      hair_texture: oneOf(o.hair_texture, ["straight", "wavy", "curly", "coily"]),
      eye_color: typeof o.eye_color === "string" ? o.eye_color.toLowerCase().slice(0, 24) : null,
      glasses: typeof o.glasses === "boolean" ? o.glasses : null,
      approx_age: typeof o.approx_age === "number" ? Math.round(o.approx_age) : null,
    };
  } catch (e) {
    console.warn("describeChildFeaturesStruct failed:", e.message);
    return null;
  }
}

/**
 * Read the visual STYLE off a finished/approved illustration so the story's
 * style settings can be auto-filled instead of typed. Returns structured fields
 * { artStyle, colorNote, notes } or null on failure.
 */
export async function extractStyleFromImage(imageUrl) {
  try {
    const raw = await visionJudge({
      imageUrls: [imageUrl],
      systemPrompt:
        "You analyze the visual STYLE of a children's storybook image and describe it as compact JSON. " +
        "Respond with ONLY minified JSON. No markdown, no prose.",
      prompt:
        "Judge ONLY the visual style (not the characters, faces or story). " +
        'Return JSON exactly like: {"artStyle":"illustration","colorNote":"warm golden tones with soft pink ' +
        'and gold pastels","notes":"soft cinematic lighting with magical sparkles"}. ' +
        "artStyle must be one of: 'illustration' (hand-drawn/painted storybook art), " +
        "'semi_real' (painterly and dimensional but still illustrated), " +
        "'photoreal' (looks like a real photograph). " +
        "colorNote: a short phrase describing the palette, warmth and tones. " +
        "notes: a short phrase of other style cues (lighting, mood, texture).",
    });
    const cleaned = (raw || "").replace(/```json/gi, "").replace(/```/g, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const artStyle = ["illustration", "semi_real", "photoreal"].includes(
      String(o.artStyle || "").toLowerCase()
    )
      ? String(o.artStyle).toLowerCase()
      : "illustration";
    return {
      artStyle,
      colorNote: typeof o.colorNote === "string" ? o.colorNote.trim().slice(0, 160) : "",
      notes: typeof o.notes === "string" ? o.notes.trim().slice(0, 200) : "",
    };
  } catch (e) {
    console.warn("extractStyleFromImage failed:", e.message);
    return null;
  }
}

/**
 * "Understand" a scene template: convert a finished storybook illustration into a
 * reusable text prompt that recreates the same STORY and STYLE with a different
 * child. Deliberately avoids describing the template child's identity (face/hair/
 * skin) and any title text, so the prompt is identity-neutral. Returns "" on fail.
 */
export async function describeScene(imageUrl) {
  try {
    const text = await visionJudge({
      imageUrls: [imageUrl],
      systemPrompt:
        "You are an art director converting a finished children's storybook illustration into a single " +
        "text-to-image prompt that recreates the same scene and story with a DIFFERENT child. Output only " +
        "the prompt, no preamble.",
      prompt:
        "Write one vivid image-generation prompt (2-4 sentences) that recreates this scene's STORY and STYLE " +
        "with a different child as the main character. Include: what the child is doing (the action/activity), " +
        "the setting and key props, the art style/medium, the composition and camera framing, and the " +
        "lighting, mood and color palette. Refer to the main character ONLY as 'the child' — do NOT describe " +
        "their face, hair, skin tone, ethnicity, age or identity, and do NOT include any title text, words, " +
        "letters or logos. Present tense, no preamble.",
    });
    return (text || "").trim();
  } catch (e) {
    console.warn("describeScene failed:", e.message);
    return "";
  }
}

/**
 * PuLID for Flux: identity-preserving text-to-image. Generates a NEW image from
 * `prompt` while locking the face to `referenceImageUrl` (the child's anchor).
 * Unlike nanoEdit, it does not copy a template image — the scene must be described
 * in the prompt. Strong, tuning-free face consistency. Returns { url }.
 */
export async function fluxPulid({
  referenceImageUrl,
  prompt,
  negativePrompt,
  imageSize,
  timeoutMs = 120000,
}) {
  ensureConfigured();
  const result = await withTimeout(
    fal.subscribe("fal-ai/flux-pulid", {
      input: {
        reference_image_url: referenceImageUrl,
        prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        ...(imageSize ? { image_size: imageSize } : {}),
      },
    }),
    timeoutMs,
    "flux-pulid"
  );
  const image = result?.data?.images?.[0];
  if (!image?.url) {
    throw new Error("flux-pulid returned no image. Raw: " + JSON.stringify(result?.data));
  }
  return { url: image.url };
}

/** Download a remote image into uploads/ so results survive (fal URLs can expire). */
export async function downloadToUploads(remoteUrl, fileName) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`Failed to download result (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const abs = path.join(UPLOAD_DIR, fileName);
  await fs.writeFile(abs, buf);
  return `/uploads/${fileName}`;
}
