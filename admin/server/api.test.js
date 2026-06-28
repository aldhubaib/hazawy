import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Grab a free TCP port so parallel/local runs don't collide on a fixed one.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let serverProc;
let baseUrl;
let dataRoot;
let envPath;
let envBackup; // null = file didn't exist before the test

const api = (path, init) => fetch(`${baseUrl}${path}`, init);

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  // Isolated datastore so the test never reads or clobbers real dev data.
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hazawy-test-"));

  // Saving settings writes a best-effort copy to server/.env. Snapshot it so we
  // can restore it afterward and never disturb the developer's real config.
  envPath = path.join(__dirname, ".env");
  try {
    envBackup = await fs.readFile(envPath, "utf8");
  } catch {
    envBackup = null;
  }

  serverProc = spawn("node", ["index.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_ROOT: dataRoot,
      // Force open mode + JSON-file store regardless of any local .env, so the
      // test is hermetic (no Clerk, no Postgres). Setting the keys to "" stops
      // dotenv from re-populating them from server/.env.
      CLERK_SECRET_KEY: "",
      DATABASE_URL: "",
      FAL_KEY: "",
      GEMINI_API_KEY: "",
      // Deterministic default so the model setting starts at "nano_banana".
      ANCHOR_PROVIDER: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  serverProc.stdout.on("data", (d) => (logs += d));
  serverProc.stderr.on("data", (d) => (logs += d));

  // Poll until the server answers, or fail with the captured output.
  const deadline = Date.now() + 15000;
  for (;;) {
    if (serverProc.exitCode !== null) {
      throw new Error(`server exited early (code ${serverProc.exitCode}):\n${logs}`);
    }
    try {
      const res = await api("/api/config");
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server never became ready:\n${logs}`);
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  if (serverProc && serverProc.exitCode === null) serverProc.kill("SIGKILL");
  if (dataRoot) await fs.rm(dataRoot, { recursive: true, force: true });
  // Restore (or remove) server/.env so the test leaves no trace.
  if (envPath) {
    if (envBackup === null) await fs.rm(envPath, { force: true });
    else await fs.writeFile(envPath, envBackup, "utf8");
  }
});

test("GET /api/config returns runtime status", async () => {
  const res = await api("/api/config");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.falConfigured, "boolean");
  assert.equal(typeof body.checkerEnabled, "boolean");
  assert.equal(typeof body.defaultPrompt, "string");
});

test("GET /api/access/me grants full page access in open mode", async () => {
  const res = await api("/api/access/me");
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.isAdmin, true);
  // The bug we chased: "stories" must be among the pages an admin can open.
  assert.ok(me.allPages.includes("stories"), "allPages should include stories");
  assert.deepEqual(
    [...me.allPages].sort(),
    ["access", "orders", "settings", "stories", "variables"]
  );
});

test("GET /api/stories returns a list", async () => {
  const res = await api("/api/stories");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test("GET /api/settings reports model + key status", async () => {
  const res = await api("/api/settings");
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.anchorProvider, "nano_banana"); // deterministic default
  assert.equal(s.falKey.set, false); // FAL_KEY forced empty for the test
  assert.equal(typeof s.checkerEnabled, "boolean");
});

test("PUT /api/settings changes the model and it round-trips", async () => {
  const put = await api("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anchorProvider: "gpt_image_2" }),
  });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.equal(saved.ok, true);
  assert.equal(saved.anchorProvider, "gpt_image_2");

  // A fresh read reflects the saved model.
  const res = await api("/api/settings");
  const s = await res.json();
  assert.equal(s.anchorProvider, "gpt_image_2");
});

test("PUT /api/settings rejects an unknown model", async () => {
  const res = await api("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anchorProvider: "not_a_real_model" }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/settings/test-fal reports clearly when no key is set", async () => {
  // FAL_KEY is forced empty for the test, so the check should fail cleanly
  // (400 + ok:false) rather than throw or hit the network.
  const res = await api("/api/settings/test-fal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /key/i);
});

test("access user lifecycle: create, list, reject bad email", async () => {
  const email = "teammate@example.com";

  const created = await api("/api/access/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, role: "member", pages: ["stories", "orders"] }),
  });
  assert.equal(created.status, 200);
  const { user } = await created.json();
  assert.equal(user.email, email);
  assert.deepEqual(user.pages.sort(), ["orders", "stories"]);

  const list = await api("/api/access/users");
  assert.equal(list.status, 200);
  const { users } = await list.json();
  assert.ok(users.some((u) => u.email === email), "created user should be listed");

  const bad = await api("/api/access/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", role: "member" }),
  });
  assert.equal(bad.status, 400);
});
