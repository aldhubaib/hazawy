import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_ROOT lets a host (e.g. Railway volume) point persistent storage at a
// mounted path. Falls back to the server folder for local development.
const DATA_ROOT = process.env.DATA_ROOT || __dirname;
const DATA_DIR = path.join(DATA_ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "stories.json");

const EMPTY = { stories: {}, orders: {}, variables: {}, symbols: {}, access: { users: {} } };

// When DATABASE_URL is present (production / Railway Postgres) the whole app
// state is stored as a single JSONB document. Otherwise we fall back to a local
// JSON file so `npm run dev` works with no database installed.
const USE_PG = Boolean(process.env.DATABASE_URL);

// --- Postgres-backed store (production) --------------------------------------
let pool = null;
let schemaReady = null;

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      // Railway's private network connection is plaintext; public proxy URLs
      // (sslmode=require / *.rlwy.net) need TLS with relaxed cert checking.
      ssl: /sslmode=require|rlwy\.net/.test(process.env.DATABASE_URL || "")
        ? { rejectUnauthorized: false }
        : false,
    });
  }
  return pool;
}

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = getPool();
    await db.query(
      `CREATE TABLE IF NOT EXISTS app_state (
         id INT PRIMARY KEY,
         data JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const { rows } = await db.query("SELECT 1 FROM app_state WHERE id = 1");
    if (rows.length === 0) {
      // First boot: seed the single state row, importing any pre-existing JSON
      // file (e.g. data carried over on a Railway volume) when present.
      let seed = EMPTY;
      try {
        const parsed = JSON.parse(await fs.readFile(DB_FILE, "utf8"));
        if (parsed && typeof parsed === "object") {
          seed = { ...EMPTY, ...parsed };
          console.log("[db] imported existing stories.json into Postgres");
        }
      } catch {
        // nothing to import — start empty
      }
      await db.query(
        "INSERT INTO app_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
        [seed]
      );
    }
  })();
  return schemaReady;
}

async function pgRead() {
  await ensureSchema();
  const { rows } = await getPool().query("SELECT data FROM app_state WHERE id = 1");
  if (!rows.length) return structuredClone(EMPTY);
  return { ...structuredClone(EMPTY), ...rows[0].data };
}

async function pgWrite(data) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [data]
  );
}

// --- JSON-file store (local dev fallback) -----------------------------------
async function ensureFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify(EMPTY, null, 2));
  }
}

async function fileRead() {
  await ensureFile();
  const raw = await fs.readFile(DB_FILE, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return structuredClone(EMPTY);
  }
}

async function fileWrite(data) {
  await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

// --- Public API (unchanged signatures) --------------------------------------
export async function readDb() {
  return USE_PG ? pgRead() : fileRead();
}

let writeChain = Promise.resolve();
export function writeDb(data) {
  // Serialize writes so concurrent generate calls don't clobber each other.
  writeChain = writeChain.then(() => (USE_PG ? pgWrite(data) : fileWrite(data)));
  return writeChain;
}
