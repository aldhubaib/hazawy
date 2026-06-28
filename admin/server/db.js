import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_ROOT lets a host (e.g. Railway volume) point persistent storage at a
// mounted path. Falls back to the server folder for local development.
const DATA_ROOT = process.env.DATA_ROOT || __dirname;
const DATA_DIR = path.join(DATA_ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "stories.json");

const EMPTY = { stories: {}, orders: {}, variables: {}, symbols: {}, access: { users: {} } };

async function ensureFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify(EMPTY, null, 2));
  }
}

export async function readDb() {
  await ensureFile();
  const raw = await fs.readFile(DB_FILE, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return structuredClone(EMPTY);
  }
}

let writeChain = Promise.resolve();
export function writeDb(data) {
  // Serialize writes so concurrent generate calls don't clobber each other.
  writeChain = writeChain.then(() =>
    fs.writeFile(DB_FILE, JSON.stringify(data, null, 2))
  );
  return writeChain;
}
