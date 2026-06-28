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

const api = (path, init) => fetch(`${baseUrl}${path}`, init);

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  // Isolated datastore so the test never reads or clobbers real dev data.
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hazawy-test-"));

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
