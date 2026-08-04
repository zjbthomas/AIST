import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve("public");
const DATA_FILE = path.join(ROOT, "data", "operators.json");
const ASSET_ROOT = path.join(ROOT, "assets", "prts");
const AVATAR_DIR = path.join(ASSET_ROOT, "operators");
const SKILL_DIR = path.join(ASSET_ROOT, "skills");
const MANIFEST_FILE = path.join(ASSET_ROOT, "manifest.json");
const FORCE = process.argv.includes("--force");
const CONCURRENCY = 6;

const hash = (value, length = 16) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, length);
const isRemote = (value) => /^https?:\/\//i.test(String(value ?? ""));
const publicPath = (absolutePath) => path.relative(ROOT, absolutePath).split(path.sep).join("/");

async function readJson(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, "utf8")); }
  catch { return fallback; }
}

async function download(url, destination) {
  const temporary = `${destination}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rm(temporary, { force: true });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await execFileAsync("curl", [
        "--fail", "--silent", "--show-error", "--location",
        "--retry", "2", "--retry-delay", "2", "--retry-all-errors",
        "--connect-timeout", "20", "--max-time", "90",
        "--user-agent", "Arknights-IS-Tracker/0.4 (weekly static asset cache)",
        "--output", temporary,
        url,
      ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });

      const stat = await fs.stat(temporary);
      if (stat.size < 100) throw new Error(`downloaded file is unexpectedly small (${stat.size} bytes)`);
      await fs.rename(temporary, destination);
      return stat.size;
    } catch (error) {
      lastError = error;
      await fs.rm(temporary, { force: true });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

const operators = await readJson(DATA_FILE, null);
if (!Array.isArray(operators)) throw new Error(`Missing or invalid ${DATA_FILE}. Run npm run sync:prts first.`);

await fs.mkdir(AVATAR_DIR, { recursive: true });
await fs.mkdir(SKILL_DIR, { recursive: true });
const oldManifest = await readJson(MANIFEST_FILE, { files: {} });
const nextManifest = { updatedAt: new Date().toISOString(), files: { ...(oldManifest.files ?? {}) } };

const jobs = [];
for (const operator of operators) {
  const operatorKey = operator.id ?? operator.name;
  if (isRemote(operator.avatar)) {
    const sourceUrl = operator.avatar;
    const filename = `operator-${hash(operatorKey)}.png`;
    const destination = path.join(AVATAR_DIR, filename);
    jobs.push({
      key: `avatar:${operatorKey}`,
      sourceUrl,
      destination,
      apply: () => {
        operator.avatarSource = sourceUrl;
        operator.avatar = publicPath(destination);
      },
    });
  }

  for (const [index, skill] of (operator.skills ?? []).entries()) {
    if (!isRemote(skill.icon)) continue;
    const sourceUrl = skill.icon;
    const skillKey = skill.name || String(index + 1);
    const filename = `skill-${hash(operatorKey)}-${index + 1}-${hash(skillKey, 8)}.png`;
    const destination = path.join(SKILL_DIR, filename);
    jobs.push({
      key: `skill:${operatorKey}:${index + 1}:${skillKey}`,
      sourceUrl,
      destination,
      apply: () => {
        skill.iconSource = sourceUrl;
        skill.icon = publicPath(destination);
      },
    });
  }
}

let downloaded = 0;
let reused = 0;
let failed = 0;
let bytes = 0;

await mapLimit(jobs, CONCURRENCY, async (job) => {
  const previous = nextManifest.files[job.key];
  let exists = false;
  try { exists = (await fs.stat(job.destination)).size >= 100; } catch { /* missing */ }

  if (!FORCE && exists && previous?.sourceUrl === job.sourceUrl) {
    reused += 1;
    job.apply();
    return;
  }

  try {
    const size = await download(job.sourceUrl, job.destination);
    nextManifest.files[job.key] = {
      sourceUrl: job.sourceUrl,
      path: publicPath(job.destination),
      size,
      updatedAt: new Date().toISOString(),
    };
    bytes += size;
    downloaded += 1;
    job.apply();
  } catch (error) {
    failed += 1;
    console.warn(`Asset download failed: ${job.key}: ${error?.message ?? error}`);
    // Keep the remote URL so the front end can still try it and fall back normally.
  }
});

await fs.writeFile(DATA_FILE, `${JSON.stringify(operators, null, 2)}\n`, "utf8");
await fs.writeFile(MANIFEST_FILE, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
console.log(`PRTS assets: ${downloaded} downloaded (${(bytes / 1024 / 1024).toFixed(1)} MiB), ${reused} reused, ${failed} failed.`);
if (failed > Math.max(20, Math.floor(jobs.length * 0.1))) {
  throw new Error(`Too many PRTS asset downloads failed (${failed}/${jobs.length}). Existing cached assets were kept.`);
}
