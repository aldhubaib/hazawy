import { fal } from "@fal-ai/client";
import { readFileSync } from "node:fs";

const env = readFileSync("./server/.env", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
fal.config({ credentials: process.env.FAL_KEY });

const face = "https://v3b.fal.media/files/b/0a9ed70b/DaN14HcIyBQXH0fP1znFv_9a0d809f199b451d90be51863846e033.png";
const target = "https://v3b.fal.media/files/b/0a9ed565/DWTkey5-gUVFG5kE_FvJt_RSiMBTDvoD.png";

const t0 = Date.now();
try {
  const result = await fal.subscribe("easel-ai/advanced-face-swap", {
    input: {
      face_image_0: face,
      gender_0: "female",
      target_image: target,
      workflow_type: "target_hair",
      upscale: false,
      detailer: true,
    },
    logs: true,
    onQueueUpdate: (u) => {
      if (u.status === "IN_PROGRESS") (u.logs||[]).forEach(l => console.log("[log]", l.message));
      else console.log("[status]", u.status);
    },
  });
  console.log("DONE in", ((Date.now()-t0)/1000).toFixed(1), "s");
  console.log("data:", JSON.stringify(result.data));
} catch (e) {
  console.log("ERROR after", ((Date.now()-t0)/1000).toFixed(1), "s");
  console.log("message:", e.message);
  if (e.body) console.log("body:", JSON.stringify(e.body));
  if (e.status) console.log("status:", e.status);
}
