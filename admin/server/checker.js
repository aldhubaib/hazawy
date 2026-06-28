import { visionJudge } from "./fal.js";

/**
 * AI consistency checker — runs through fal's OpenRouter vision gateway
 * (google/gemini-2.5-flash) using the same FAL_KEY. No separate key needed.
 */
export function isCheckerEnabled() {
  return Boolean(process.env.FAL_KEY);
}

/* ===================== PHOTO INTAKE GATE ===================== */

const VALIDATE_SYSTEM =
  "You are a strict intake validator for a children's book personalization tool. You inspect ONE uploaded photo " +
  "to decide whether it is usable as the identity reference for a child, and whether any problems are fixable " +
  "by automatic photo enhancement or are identity-unsafe. Respond with ONLY minified JSON. No markdown, no " +
  "code fences, no prose.";

const VALIDATE_PROMPT =
  "Inspect the photo and mark each field true (good) or false (a problem). Be STRICT: this photo will be used as " +
  "the only identity reference for a child, so the real, front-on face must be plainly visible. NEVER assume or " +
  "imagine a face the camera does not actually show — a side/profile photo is NOT usable because the missing half " +
  "of the face would have to be invented. " +
  "IDENTITY-CRITICAL fields (cannot be fixed by enhancement): " +
  "faceDetected: a real child's face is actually present in the frame (false if there is no face, or only the " +
  "back of the head is shown). " +
  "exactlyOneChild: exactly one child is the subject (false if there are no children, multiple children/people, " +
  "or the subject is an adult). NOTE: this alone is NOT enough — the face must also be usable for identity. " +
  "faceLargeEnough: the face is big enough in the frame to capture identity (false if tiny or far away). " +
  "faceUncovered: nothing covers the face (false if sunglasses, a mask, a hand or an object hides the eyes/face). " +
  "notExtremelyBlurry: the face is recognizable (false ONLY if the image is EXTREMELY blurry / unrecognizable). " +
  "faceClearlyVisible: TRUE only when BOTH eyes, the nose, the mouth, and most of BOTH cheeks are clearly visible. " +
  "It MUST be false for a profile or strong side-view photo, false if hair covers one eye or a large part of the " +
  "face, and false if the head is turned far enough that one side of the face is hidden. A MILD three-quarter " +
  "angle is acceptable (true) ONLY when both eyes and most facial features are still clearly visible. " +
  "faceAngle: classify the head orientation as one of exactly: \"front\" (looking at the camera), " +
  "\"mild_three_quarter\" (slightly turned but both eyes/most features visible), \"profile\" (side view / strongly " +
  "turned so one side is hidden), or \"unclear\" (cannot tell, or face too obscured to judge). " +
  "STYLIZATION (reported but NOT a rejection by itself — the anchor step neutralizes it): " +
  "noHeavyStylization: true for a plain real photograph; false if a beauty/AR filter, heavy makeup, exaggerated " +
  "eyelashes/blush, glossy/plastic skin smoothing, or a cartoon/anime effect is applied. A real child's face that " +
  "is merely filtered/made-up is still usable as long as the identity-critical fields above are fine. " +
  "FIXABLE quality fields (automatic enhancement can likely repair these): " +
  "goodResolution: resolution is sufficient (false if low-resolution). " +
  "goodColor: natural color (false if faded, old, washed-out or color-cast). " +
  "sharpEnough: reasonably sharp (false if only MILD blur/softness). " +
  "brightEnough: adequately lit (false if only MILD darkness/underexposure). " +
  "lowNoise: clean (false if grainy/noisy). " +
  "noScanArtifacts: a direct photo (false if it is a scan or a photo-of-a-photo with glare/moire). " +
  'Return JSON exactly like: {"faceDetected":true,"exactlyOneChild":true,"faceLargeEnough":true,' +
  '"faceUncovered":true,"noHeavyStylization":true,"notExtremelyBlurry":true,"faceClearlyVisible":true,' +
  '"faceAngle":"front","goodResolution":true,"goodColor":true,"sharpEnough":true,"brightEnough":true,' +
  '"lowNoise":true,"noScanArtifacts":true,"score":0,"reasons":["short phrase"]}. ' +
  "score is overall usability (0-100) as a front-facing identity reference; a profile/side view or a face that is " +
  "significantly hair-covered must score low. reasons lists ONLY the problems found as short human-readable " +
  "phrases (empty array if none).";

// Hard failures — never usable, enhancement can't help. faceClearlyVisible folds
// in profile/side, hidden-eye and hair-over-face cases (it is identity-critical:
// restoration cannot recover a face the photo never showed). noHeavyStylization
// is intentionally NOT here: a filtered/made-up real face is still a valid
// identity reference and the anchor step neutralizes the styling.
const IDENTITY_CRITICAL_KEYS = [
  "faceDetected",
  "exactlyOneChild",
  "faceLargeEnough",
  "faceUncovered",
  "notExtremelyBlurry",
  "faceClearlyVisible",
];
const FIXABLE_KEYS = [
  "goodResolution",
  "goodColor",
  "sharpEnough",
  "brightEnough",
  "lowNoise",
  "noScanArtifacts",
];
// Stylization is reported but is neither identity-critical nor fixable-by-restore;
// it only flags that the anchor should neutralize makeup/filter effects.
const STYLIZATION_KEY = "noHeavyStylization";
const ALL_CHECK_KEYS = [...IDENTITY_CRITICAL_KEYS, STYLIZATION_KEY, ...FIXABLE_KEYS];

const FACE_ANGLES = new Set(["front", "mild_three_quarter", "profile", "unclear"]);

const NULL_CHECKS = Object.fromEntries(ALL_CHECK_KEYS.map((k) => [k, null]));

/**
 * Map a validation result to a photo status, given the phase it was run in.
 *  - raw phase:        accepted (good) | fixable (try enhancement) | needs_new_photo (identity-critical)
 *  - restored phase:   accepted | review (continue) | needs_new_photo (enhancement didn't make it usable)
 *
 * Identity-critical failures always mean needs_new_photo. faceAngle is enforced
 * directly so a side/profile photo never auto-continues to restore/anchor:
 *  - "profile"           → needs_new_photo (face would have to be invented)
 *  - "unclear"           → needs_new_photo if score is low, else review (never accepted)
 *  - "front" / "mild_three_quarter" → fall through to the normal score logic
 * A disabled/uncertain check never hard-blocks (falls back to review/continue).
 *
 * @param {object} check  validateKidPhoto() result
 * @param {"raw"|"restored"} phase
 */
export function derivePhotoStatus(check, phase) {
  if (!check) return "review";
  if (check.enabled === false) return "review"; // checker off → don't block
  if (check.identityCritical) return "needs_new_photo";
  const score = check.score;
  // A profile/side view can never be made front-facing without inventing a face.
  if (check.faceAngle === "profile") return "needs_new_photo";
  if (check.faceAngle === "unclear") {
    return score != null && score >= 60 ? "review" : "needs_new_photo";
  }
  // Stylized (filter/makeup) but identity-critical fields + angle are fine: never
  // reject for styling alone. Route through enhancement so the anchor can run and
  // neutralize it. raw → fixable (re-check after restore); restored → accepted.
  if (check.stylized) return phase === "restored" ? "accepted" : "fixable";
  if (phase === "restored") {
    if (score == null) return "review";
    if (score >= 80) return "accepted";
    if (score >= 60) return "review";
    return "needs_new_photo"; // enhancement couldn't make it usable
  }
  // raw phase (front / mild three-quarter)
  if (score == null) return "review"; // uncertain but not identity-critical → continue
  if (score >= 80) return "accepted";
  return "fixable"; // non-critical but below 80 → enhance, then re-check
}

/**
 * Photo intake gate. Validates a child photo and classifies its problems as
 * identity-critical vs fixable, so the pipeline can try enhancement before
 * rejecting. Never throws — an inconclusive/unavailable check is non-blocking.
 *
 * @param {string} imageUrl public URL of the photo to inspect
 * @returns {{score:number|null, reasons:string[], checks:object, faceAngle:string|null,
 *   identityCritical:boolean, stylized:boolean, fixable:boolean, enabled:boolean, checkedAt:number}}
 */
export async function validateKidPhoto(imageUrl) {
  const base = {
    checks: { ...NULL_CHECKS },
    faceAngle: null,
    identityCritical: false,
    stylized: false,
    fixable: false,
    checkedAt: Date.now(),
  };
  if (!isCheckerEnabled()) {
    return { ...base, enabled: false, score: null, reasons: ["Automatic photo check unavailable (vision not configured)."] };
  }
  if (!imageUrl) {
    return { ...base, enabled: true, identityCritical: true, score: 0, reasons: ["No photo to check."] };
  }
  try {
    const raw = await visionJudge({
      imageUrls: [imageUrl],
      systemPrompt: VALIDATE_SYSTEM,
      prompt: VALIDATE_PROMPT,
    });
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in validator output");
    const obj = JSON.parse(m[0]);
    const b = (v) => (typeof v === "boolean" ? v : null);
    const checks = Object.fromEntries(ALL_CHECK_KEYS.map((k) => [k, b(obj[k])]));
    const faceAngle = FACE_ANGLES.has(obj.faceAngle) ? obj.faceAngle : "unclear";
    // A failure counts only when the model explicitly says false (null = unknown).
    const identityCritical = IDENTITY_CRITICAL_KEYS.some((k) => checks[k] === false);
    const stylized = checks[STYLIZATION_KEY] === false;
    const fixable = FIXABLE_KEYS.some((k) => checks[k] === false);
    const score = typeof obj.score === "number" ? Math.round(obj.score) : null;
    const reasons = Array.isArray(obj.reasons) ? obj.reasons.slice(0, 8).map(String) : [];
    return {
      checks,
      faceAngle,
      identityCritical,
      stylized,
      fixable,
      enabled: true,
      score,
      reasons,
      checkedAt: Date.now(),
    };
  } catch (e) {
    // Never hard-block on a checker error — treat as inconclusive.
    return { ...base, enabled: true, score: null, reasons: ["Automatic photo check was inconclusive."] };
  }
}

const SYSTEM_PROMPT =
  "You are a strict identity-matching judge for a children's book personalization tool. " +
  "You compare a reference photo of a child against an illustrated picture that is supposed " +
  "to depict the SAME child. Respond with ONLY minified JSON. No markdown, no code fences, no prose.";

function buildPrompt(candidateIsScene) {
  const where = candidateIsScene
    ? "Image 2 is a full storybook scene — focus only on the main child in it."
    : "Image 2 is an illustrated portrait of the child.";
  return (
    `Image 1 is the reference of the real child (the identity anchor). ${where} ` +
    "Ignore differences in art style, medium, coloring, lighting, clothing and background. " +
    "Judge whether it is the same child, based on: face shape, eyes, eyebrows, nose, mouth, " +
    "hairstyle, hair color, skin tone, and approximate age. " +
    "FIRST decide whether the child's face in image 2 is actually visible enough to judge identity: " +
    "set face_visible to false if the face is turned away, in profile, looking down, very small, blurred, " +
    "or mostly hidden by hair/objects, so key features cannot be compared. " +
    "SEPARATELY, compare the HAIR between image 1 and image 2 (hair is a hard identity requirement). " +
    "hair_color_match: false if the hair COLOR differs (e.g. the anchor is brown/dark but the scene child is " +
    "blonde/red/another color). hairstyle_match: false if the main HAIRSTYLE or silhouette differs — length, " +
    "texture (straight/wavy/curly/coily), or style such as loose vs buns vs braids vs ponytail vs a redesigned " +
    "princess hairstyle. A crown, tiara, hat or accessory resting on top of the SAME hairstyle is NOT a " +
    "hairstyle change. List the specific hair differences in hair_changes. " +
    'Return JSON exactly like: {"face_visible": true, "same_child": true, "score": 0-100, ' +
    '"hair_color_match": true, "hairstyle_match": true, "hair_changes": ["short phrase"], ' +
    '"mismatches": ["short phrase"]}. ' +
    "score is your confidence (0-100) that it is the same child (only meaningful when face_visible is true). " +
    "mismatches lists what differs (empty if none)."
  );
}

function parseJudge(text) {
  // Models sometimes wrap JSON in ```json fences or add stray text.
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON in judge output");
  const obj = JSON.parse(match[0]);
  const boolOrNull = (v) => (typeof v === "boolean" ? v : null);
  const hairColorMatch = boolOrNull(obj.hair_color_match);
  const hairstyleMatch = boolOrNull(obj.hairstyle_match);
  const hairChanged = hairColorMatch === false || hairstyleMatch === false;
  const hairChanges = Array.isArray(obj.hair_changes) ? obj.hair_changes.slice(0, 4).map(String) : [];
  // Surface hair problems in the mismatch list so they're visible in the UI.
  const hairPhrases = [];
  if (hairColorMatch === false) hairPhrases.push("hair color changed");
  if (hairstyleMatch === false) hairPhrases.push("hairstyle changed");
  const rawMismatches = Array.isArray(obj.mismatches) ? obj.mismatches.slice(0, 6).map(String) : [];
  const mismatches = [...new Set([...hairPhrases, ...hairChanges, ...rawMismatches])].slice(0, 6);
  return {
    // Default to visible (true) when the field is absent so older behavior holds.
    face_visible: obj.face_visible === false ? false : true,
    same_child: Boolean(obj.same_child),
    score: typeof obj.score === "number" ? Math.round(obj.score) : null,
    hair_color_match: hairColorMatch,
    hairstyle_match: hairstyleMatch,
    hair_changed: hairChanged,
    hair_changes: hairChanges,
    mismatches,
  };
}

const CLASSIFY_SYSTEM =
  "You analyze a children's storybook page illustration to decide how reliably an automated face-identity " +
  "check could verify the main child on that page. Respond with ONLY minified JSON. No markdown, no prose.";

/**
 * Classify, at story-design time, how the child's face appears on a page so we
 * know up front how its identity should be scored per order:
 *   - "strict"   → face clear & front-facing (a low score later is a real fail)
 *   - "advisory" → child present but turned/profile/small/partly hidden (review only)
 *   - "none"     → no child / no visible face (decorative or text page; never scored)
 * Returns { level, note, enabled }.
 */
export async function classifyFaceVisibility(imageUrl) {
  if (!isCheckerEnabled()) return { level: "advisory", note: "", enabled: false };
  if (!imageUrl) return { level: "none", note: "No image on this page", enabled: true };
  try {
    const raw = await visionJudge({
      imageUrls: [imageUrl],
      systemPrompt: CLASSIFY_SYSTEM,
      prompt:
        "Look at this storybook page illustration. Decide how visible the MAIN CHILD's face is for automated " +
        "identity verification. " +
        'Return JSON exactly like: {"visibility":"clear","note":"short phrase"}. ' +
        "visibility must be one of: " +
        "'clear' (a child's face is reasonably large and front-facing / three-quarter, good for identity scoring); " +
        "'partial' (a child is present but the face is turned away, in profile, looking down, very small, blurred " +
        "or mostly hidden by hair/objects); " +
        "'none' (there is no child or no visible human face at all — decorative, scenery or text-only page). " +
        "note is a short phrase explaining why.",
    });
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    const obj = m ? JSON.parse(m[0]) : {};
    const v = String(obj.visibility || "").toLowerCase();
    const level = v === "clear" ? "strict" : v === "none" ? "none" : "advisory";
    return {
      level,
      note: typeof obj.note === "string" ? obj.note.slice(0, 120) : "",
      enabled: true,
    };
  } catch (e) {
    return { level: "advisory", note: "Could not classify automatically", enabled: true };
  }
}

/**
 * Compare a reference image to a candidate image.
 * @param {string} referenceUrl  public URL of the real child's photo
 * @param {string} candidateUrl  public URL of the illustration to score
 * @param {boolean} candidateIsScene  true if candidate is a full scene
 */
export async function checkConsistency({ referenceUrl, candidateUrl, candidateIsScene = false }) {
  if (!isCheckerEnabled()) {
    return { enabled: false, score: null, same_child: null, mismatches: [], message: "FAL_KEY missing." };
  }
  if (!referenceUrl || !candidateUrl) {
    return { enabled: true, score: null, same_child: null, mismatches: [], message: "Missing image to compare." };
  }

  try {
    const raw = await visionJudge({
      imageUrls: [referenceUrl, candidateUrl],
      systemPrompt: SYSTEM_PROMPT,
      prompt: buildPrompt(candidateIsScene),
    });
    const parsed = parseJudge(raw);
    return { enabled: true, ...parsed, checkedAt: Date.now() };
  } catch (e) {
    return {
      enabled: true,
      score: null,
      same_child: null,
      mismatches: [],
      message: "Checker error: " + e.message,
    };
  }
}
