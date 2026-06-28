import { fal } from "@fal-ai/client";
import { readFileSync } from "node:fs";
const env = readFileSync("./server/.env", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
fal.config({ credentials: process.env.FAL_KEY });
const t0 = Date.now();
let lastLogCount = 0;
try {
  const result = await fal.subscribe("easel-ai/advanced-face-swap", {
    input: {
      face_image_0: "https://images.easelai.com/mirror_fal/faces/female.png",
      gender_0: "female",
      target_image: "https://images.easelai.com/mirror_fal/men_single_player/saturday.png",
      workflow_type: "target_hair",
      upscale: false,
      detailer: false,
    },
    logs: true,
    onQueueUpdate: (u) => {
      if (u.status === "IN_PROGRESS") {
        const logs = u.logs || [];
        for (let i = lastLogCount; i < logs.length; i++) console.log("[log]", logs[i].message);
        lastLogCount = logs.length;
      } else console.log("[status]", u.status, ((Date.now()-t0)/1000).toFixed(1)+"s");
    },
  });
  console.log("DONE in", ((Date.now()-t0)/1000).toFixed(1), "s");
  console.log("data:", JSON.stringify(result.data));
} catch (e) {
  console.log("ERROR after", ((Date.now()-t0)/1000).toFixed(1), "s:", e.message);
  if (e.body) console.log("body:", JSON.stringify(e.body));
}
