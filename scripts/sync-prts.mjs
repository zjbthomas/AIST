import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const API_ENDPOINTS = [
  "https://prts.wiki/api.php",
  "https://ak.mooncell.wiki/api.php",
];
let activeApi = API_ENDPOINTS[0];
const OUT = path.resolve("public/data");
const FORCE = process.argv.includes("--force");
const STAGES_ONLY = process.argv.includes("--stages-only");
const OPERATORS_ONLY = process.argv.includes("--operators-only");
const MAX_AGE = 24 * 60 * 60 * 1000;

await fs.mkdir(OUT, { recursive: true });
const manifestPath = path.join(OUT, "manifest.json");
try {
  const existing = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const stageCounts = Object.values(existing.stageMeta?.byTheme ?? {});
  const complete = existing.operatorMeta?.count > 100 && stageCounts.length === 6 && stageCounts.every((count) => Number(count) >= 10);
  if (!FORCE && complete && Date.now() - new Date(existing.updatedAt).getTime() < MAX_AGE) {
    console.log("PRTS data is fresh; skipping sync.");
    process.exit(0);
  }
} catch { /* first run */ }

function formatNetworkError(error) {
  const cause = error?.cause;
  return [
    error?.message,
    cause?.code,
    cause?.message,
    cause?.hostname ? `host=${cause.hostname}` : "",
  ].filter(Boolean).join(" | ");
}

function requestWithHttps(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      family: 4,
      timeout: 20_000,
      headers: {
        "User-Agent": "Arknights-IS-Tracker/0.3 (personal non-commercial tool)",
        Accept: "application/json",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error(`Invalid JSON response: ${error.message}`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("HTTPS request timed out after 20 seconds")));
    req.on("error", reject);
  });
}

async function requestWithCurl(url) {
  const args = [
    "--fail", "--silent", "--show-error", "--location",
    "--connect-timeout", "15", "--max-time", "30",
    "--user-agent", "Arknights-IS-Tracker/0.3 (personal non-commercial tool)",
    url.toString(),
  ];
  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

const request = async (params) => {
  const failures = [];
  for (const endpoint of API_ENDPOINTS) {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries({ ...params, format: "json", formatversion: "2" })) {
      url.searchParams.set(key, String(value));
    }

    try {
      const data = await requestWithHttps(url);
      activeApi = endpoint;
      return data;
    } catch (error) {
      failures.push(`${endpoint} via Node HTTPS: ${formatNetworkError(error)}`);
    }

    try {
      const data = await requestWithCurl(url);
      activeApi = endpoint;
      return data;
    } catch (error) {
      failures.push(`${endpoint} via curl: ${formatNetworkError(error)}`);
    }
  }

  throw new Error(`Unable to reach PRTS API.\n${failures.map((x) => `  - ${x}`).join("\n")}`);
};
const decode = (value) => decodeURIComponent(value.replaceAll("+", "%20"));
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replaceAll("&quot;", '"').replaceAll("&amp;", "&")]));
const safeName = (name) => name.replace(/[\\/:*?"<>|]/g, "_");
async function resolveFileUrls(filenames) {
  if (!filenames.length) return new Map();
  const data = await request({
    action: "query",
    prop: "imageinfo",
    iiprop: "url",
    titles: filenames.map((name) => `File:${name}`).join("|"),
  });
  const pages = Array.isArray(data.query?.pages) ? data.query.pages : Object.values(data.query?.pages ?? {});
  const result = new Map();
  for (const page of pages) {
    const filename = String(page.title ?? "").replace(/^File:/i, "");
    const url = page.imageinfo?.[0]?.thumburl || page.imageinfo?.[0]?.url;
    if (filename && url) result.set(filename, url);
  }
  return result;
}

async function operatorList() {
  const data = await request({ action: "parse", page: "干员一览", prop: "text|revid" });
  const html = typeof data.parse.text === "string" ? data.parse.text : data.parse.text["*"];
  const block = html.match(/<div[^>]+id="filter-data"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? html;
  const entries = [...block.matchAll(/<div\s+([^>]*data-zh="[^"]+"[^>]*)>/g)].map((m) => attrs(m[1]));
  const seen = new Set();
  const operators = [];
  for (const entry of entries) {
    const name = entry["data-zh"]; if (!name || seen.has(name)) continue; seen.add(name);
    const rarityRaw = entry["data-rarity"] || entry["data-star"] || entry["data-rank"] || "3";
    const rarity = Math.max(1, Math.min(6, Number(String(rarityRaw).replace(/\D/g, "")) || 3));
    operators.push({ name, rarity });
  }
  return { operators, revid: data.parse.revid };
}

function imageSource(page) {
  return page?.thumbnail?.source || page?.original?.source || page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url || "";
}

async function resolvePageImage(pageTitle) {
  try {
    const data = await request({
      action: "query",
      prop: "pageimages",
      piprop: "thumbnail|original|name",
      pithumbsize: "256",
      titles: pageTitle,
    });
    const pages = Array.isArray(data.query?.pages) ? data.query.pages : Object.values(data.query?.pages ?? {});
    return pages.map(imageSource).find(Boolean) || "";
  } catch {
    // Some MediaWiki installations do not expose PageImages. Continue with
    // the actual file list from the operator page instead of guessing a name.
    return "";
  }
}

function extractPageFiles(html) {
  const result = new Set();
  const patterns = [
    /(?:\/w\/|title=")文件:([^"'<>?#]+?\.(?:png|jpe?g|webp))/gi,
    /(?:\/wiki\/|title=")File:([^"'<>?#]+?\.(?:png|jpe?g|webp))/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      try { result.add(decodeHtmlEntities(decode(match[1]))); }
      catch { result.add(decodeHtmlEntities(match[1])); }
    }
  }
  return [...result];
}

function avatarScore(filename, operatorName) {
  const value = filename.toLowerCase();
  let score = 0;
  if (filename.includes(operatorName)) score += 100;
  if (/头像|head|avatar|icon/.test(value)) score += 90;
  if (/干员/.test(filename)) score += 25;
  if (/技能|skill|模组|module|基建|building|精英|elite|立绘|skin|时装|logo|职业|分支/.test(value)) score -= 180;
  if (/\.(png|webp)$/i.test(filename)) score += 5;
  return score;
}

async function resolveAvatarFromFiles(operatorName, html) {
  let candidates = extractPageFiles(html)
    .filter((filename) => avatarScore(filename, operatorName) > 0)
    .sort((a, b) => avatarScore(b, operatorName) - avatarScore(a, operatorName));

  // The parsed HTML can omit lazily rendered files. Ask MediaWiki for the
  // page's real image list and apply the same scoring rules as a fallback.
  if (!candidates.length) {
    try {
      const data = await request({
        action: "query",
        prop: "images",
        imlimit: "max",
        titles: operatorName,
      });
      const pages = Array.isArray(data.query?.pages) ? data.query.pages : Object.values(data.query?.pages ?? {});
      candidates = pages.flatMap((page) => page.images ?? [])
        .map((image) => String(image.title ?? "").replace(/^(?:File|文件):/i, ""))
        .filter((filename) => avatarScore(filename, operatorName) > 0)
        .sort((a, b) => avatarScore(b, operatorName) - avatarScore(a, operatorName));
    } catch { /* pageimages or parsed HTML may still have succeeded */ }
  }

  const best = [...new Set(candidates)].slice(0, 8);
  const urls = await resolveFileUrls(best);
  return best.map((filename) => urls.get(filename)).find(Boolean) || "";
}


function normalizePrtsAssetUrl(value) {
  if (!value) return "";
  const decoded = decodeHtmlEntities(String(value).replaceAll("&amp;", "&"));
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("/")) return new URL(decoded, activeApi).href;
  return decoded;
}

function extractRenderedImageUrl(html) {
  const candidates = [];
  for (const match of html.matchAll(/<(?:img|source)\b[^>]*(?:src|data-src|data-original|srcset)=\"([^\"]+)\"[^>]*>/gi)) {
    const first = match[1].split(/\s*,\s*/)[0].trim().split(/\s+/)[0];
    if (first) candidates.push(normalizePrtsAssetUrl(first));
  }
  for (const match of html.matchAll(/(?:background-image\s*:\s*url\(|url\()\s*[\"']?([^\"')]+)[\"']?\s*\)/gi)) {
    candidates.push(normalizePrtsAssetUrl(match[1]));
  }
  return candidates.find((url) => /(?:media\.prts\.wiki|mooncell|\.(?:png|webp|jpe?g)(?:\?|$))/i.test(url)) || "";
}

async function resolveAvatarFromTemplate(operatorName) {
  const data = await request({
    action: "parse",
    text: `{{干员头像|${operatorName}|128px}}`,
    contentmodel: "wikitext",
    prop: "text",
    disablelimitreport: "1",
  });
  const html = typeof data.parse?.text === "string" ? data.parse.text : data.parse?.text?.["*"] || "";
  const direct = extractRenderedImageUrl(html);
  if (direct) return direct;

  // Some template revisions return a file-page link instead of an <img>.
  // Resolve that exact file title through imageinfo rather than guessing it.
  const files = extractPageFiles(html);
  if (files.length) {
    const urls = await resolveFileUrls(files.slice(0, 5));
    return files.map((filename) => urls.get(filename)).find(Boolean) || "";
  }
  return "";
}

function extractSkillFilesFromHtml(html) {
  const files = [];
  const add = (encoded) => {
    let filename;
    try { filename = decodeHtmlEntities(decodeURIComponent(encoded)); }
    catch { filename = decodeHtmlEntities(encoded); }
    filename = filename.split(/[?#]/)[0];
    if (!/^技能_.+\.png$/i.test(filename) || files.includes(filename)) return;
    files.push(filename);
  };

  // PRTS encodes the Chinese namespace and filename in operator-page links.
  // This is the structure used by the working Python collector supplied with
  // this project: /w/%E6%96%87%E4%BB%B6:%E6%8A%80%E8%83%BD_....png
  for (const m of html.matchAll(/\/w\/%E6%96%87%E4%BB%B6:([^"'\s<>]+?\.png)/gi)) add(m[1]);
  for (const m of html.matchAll(/(?:\/w\/|title=["'])文件:([^"'\s<>]+?\.png)/gi)) add(m[1]);
  return files.slice(0, 3);
}

function rawWikitext(parseData) {
  const value = parseData?.parse?.wikitext;
  if (typeof value === "string") return value;
  if (value && typeof value["*"] === "string") return value["*"];
  return "";
}

function cleanWikiValue(value) {
  return decodeHtmlEntities(String(value ?? ""))
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .trim();
}

function extractSkillNames(wikitext) {
  const result = [];
  const add = (value) => {
    const name = cleanWikiValue(value).replace(/^技能[_：:]?/, "").trim();
    if (!name || name.length > 50 || /^(无|未知|-)$/.test(name)) return;
    if (!result.includes(name)) result.push(name);
  };

  // Current PRTS operator sources expose skill names through named parameters.
  for (const m of wikitext.matchAll(/\|\s*技能(?:名|名称)?\s*=\s*([^\n|}]+)/g)) add(m[1]);
  for (const m of wikitext.matchAll(/\|\s*技能[123]\s*=\s*([^\n|}]+)/g)) add(m[1]);
  // Older pages and transcluded data may contain rendered skill-icon templates.
  for (const m of wikitext.matchAll(/\{\{\s*技能图标\s*\|\s*([^|}\n]+)/g)) add(m[1]);
  // Last fallback: explicit skill image file titles in source.
  for (const m of wikitext.matchAll(/(?:文件|File):技能_([^|}\]\n]+?)\.png/gi)) add(m[1]);
  return result.slice(0, 3);
}

function prtsFileUrl(filename) {
  const digest = crypto.createHash("md5").update(filename, "utf8").digest("hex");
  return `https://media.prts.wiki/${digest[0]}/${digest.slice(0, 2)}/${encodeURIComponent(filename).replace(/%2F/gi, "/")}`;
}

async function operatorDetails({ name, rarity }) {
  const data = await request({ action: "parse", page: name, prop: "text|wikitext|revid" });
  const html = typeof data.parse.text === "string" ? data.parse.text : data.parse.text["*"];
  let source = rawWikitext(data);

  // Some MediaWiki versions do not return wikitext through action=parse.
  if (!source) {
    try {
      const revision = await request({
        action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: name,
      });
      const pages = Array.isArray(revision.query?.pages) ? revision.query.pages : Object.values(revision.query?.pages ?? {});
      source = pages[0]?.revisions?.[0]?.slots?.main?.content
        ?? pages[0]?.revisions?.[0]?.slots?.main?.["*"]
        ?? pages[0]?.revisions?.[0]?.content
        ?? pages[0]?.revisions?.[0]?.["*"]
        ?? "";
    } catch { /* the HTML fallback below may still find explicit files */ }
  }

  const explicitSkillFiles = extractSkillFilesFromHtml(html);
  let skillNames = explicitSkillFiles
    .map((filename) => filename.replace(/^技能_/, "").replace(/\.png$/i, ""));
  if (!skillNames.length) skillNames = extractSkillNames(source);
  if (!skillNames.length) {
    skillNames = extractPageFiles(html)
      .filter((filename) => /^技能_/i.test(filename))
      .map((filename) => filename.replace(/^技能_/, "").replace(/\.png$/i, ""))
      .slice(0, 3);
  }

  const avatar = await resolveAvatarFromTemplate(name)
    || await resolvePageImage(name)
    || await resolveAvatarFromFiles(name, html);

  return {
    id: name, name, rarity,
    avatar,
    skills: skillNames.map((skillName, index) => ({
      index: index + 1,
      name: skillName,
      icon: prtsFileUrl(`技能_${skillName}.png`),
    })),
    prtsUrl: `https://prts.wiki/w/${encodeURIComponent(name)}`,
    revid: data.parse.revid,
  };
}

async function syncOperators() {
  const { operators: list, revid } = await operatorList();
  const result = [];
  for (let i = 0; i < list.length; i += 6) {
    const chunk = list.slice(i, i + 6);
    const settled = await Promise.allSettled(chunk.map(operatorDetails));
    for (const item of settled) if (item.status === "fulfilled") result.push(item.value);
    console.log(`Operators: ${Math.min(i + chunk.length, list.length)}/${list.length}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const operatorsWithSkills = result.filter((operator) => operator.skills.length > 0).length;
  const resolvedSkillIcons = result.reduce(
    (count, operator) => count + operator.skills.filter((skill) => Boolean(skill.icon)).length,
    0,
  );
  console.log(`Skills: ${operatorsWithSkills}/${result.length} operators, ${resolvedSkillIcons} resolved icons`);
  if (operatorsWithSkills === 0) {
    throw new Error("没有从任何干员页面解析到技能。PRTS 页面结构可能已变化，拒绝覆盖现有数据");
  }

  const missingAvatars = result.filter((operator) => !operator.avatar).map((operator) => operator.name);
  const avatarCount = result.length - missingAvatars.length;
  if (missingAvatars.length) {
    console.warn(`Missing operator avatars (${missingAvatars.length}): ${missingAvatars.slice(0, 20).join("、")}${missingAvatars.length > 20 ? "……" : ""}`);
  }
  if (avatarCount < Math.floor(result.length * 0.9)) {
    await fs.mkdir(path.join(OUT, "debug"), { recursive: true });
    try {
      const sampleName = missingAvatars[0] || "棘刺";
      const sample = await request({
        action: "parse",
        text: `{{干员头像|${sampleName}|128px}}`,
        contentmodel: "wikitext",
        prop: "text",
      });
      const sampleHtml = typeof sample.parse?.text === "string" ? sample.parse.text : sample.parse?.text?.["*"] || "";
      await fs.writeFile(path.join(OUT, "debug", `avatar-template-${safeName(sampleName)}.html`), sampleHtml);
    } catch { /* best-effort diagnostic */ }
    throw new Error(`只解析到 ${avatarCount}/${result.length} 个干员头像，拒绝覆盖现有数据。缺失示例：${missingAvatars.slice(0, 20).join("、")}`);
  }
  await fs.writeFile(path.join(OUT, "operators.json"), JSON.stringify(result, null, 2));
  return { count: result.length, avatarCount, revid };
}

const ROGUELIKE_THEMES = [
  "傀影与猩红孤钻",
  "水月与深蓝之树",
  "探索者的银凇止境",
  "萨卡兹的无终奇语",
  "岁的界园志异",
  "沉沦者的黑流树海",
];

const FLOOR_MAP = new Map([
  ["0", 0], ["Ⅰ", 1], ["I", 1], ["一", 1],
  ["Ⅱ", 2], ["II", 2], ["二", 2],
  ["Ⅲ", 3], ["III", 3], ["三", 3],
  ["Ⅳ", 4], ["IV", 4], ["四", 4],
  ["Ⅴ", 5], ["V", 5], ["五", 5],
  ["Ⅵ", 6], ["VI", 6], ["六", 6],
  ["Ⅶ", 7], ["VII", 7], ["七", 7],
]);

const htmlText = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, " ")
  .trim();

function floorFromText(text) {
  const normalized = htmlText(text)
    .replace(/[：:、，,|｜]/g, " ")
    .replace(/第\s*/g, "")
    .replace(/\s*层/g, "")
    .trim();

  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const cleaned = token.replace(/[()（）【】\[\]]/g, "");
    if (FLOOR_MAP.has(cleaned)) return FLOOR_MAP.get(cleaned);
  }
  return undefined;
}

const STAGE_CATEGORIES = new Set([
  "一般作战", "紧急作战", "险路恶敌", "区域最终战斗", "特殊挑战",
]);
const STOP_CATEGORIES = new Set([
  "不期而遇", "鸭爵与雇员", "剧情", "事件一览", "诡意行商", "安全屋",
  "得偿所愿", "古堡馈赠", "深入探索", "追忆映射",
]);
const SKIP_STAGE_LINKS = new Set([
  "查看活动详情", "展开", "部分随机", "敌人一览", "关卡一览", "集成战略",
  ...STAGE_CATEGORIES, ...STOP_CATEGORIES,
  "编辑", "讨论", "历史", "首页", "文件", "分类", "模板",
]);

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToStageLines(html) {
  // Keep every link as an explicit token and force common block elements onto
  // separate lines. PRTS navboxes often place a whole theme in nested divs;
  // scanning raw text nodes merges headings, floors and stages together.
  const withLinks = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, rawAttrs, body) => {
    const attr = attrs(rawAttrs);
    const name = htmlText(body).replace(/[ⅠⅡⅢ]$/, "").trim();
    const href = attr.href || "";
    return `\n@@LINK@@${encodeURIComponent(href)}@@${encodeURIComponent(name)}\n`;
  });
  return decodeHtmlEntities(withLinks
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|li|ul|ol|tr|td|th|table|p|h[1-6]|dl|dt|dd)>/gi, "\n")
    .replace(/<(?:div|li|ul|ol|tr|td|th|table|p|h[1-6]|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function stageLinksFromHtml(theme, html) {
  const result = [];
  const seen = new Set();
  let currentTheme;
  let currentFloor;
  let inCombat = false;
  let inStageCategory = false;

  const setTextState = (text) => {
    const clean = text.replace(/[\[\]【】]/g, "").trim();
    const exactTheme = ROGUELIKE_THEMES.find((candidate) => clean === candidate || clean === `集成战略「${candidate}」`);
    if (exactTheme) {
      currentTheme = exactTheme;
      currentFloor = undefined;
      inCombat = false;
      inStageCategory = false;
      return;
    }
    if (currentTheme !== theme) return;
    if (clean === "作战") { inCombat = true; return; }
    if (STOP_CATEGORIES.has(clean) || /^(不期而遇|鸭爵与雇员|剧情|档案|诡意行商|狭路相逢|命运所指|海中来客|误入奇境|指点迷津|明烛试炼)/.test(clean)) {
      inStageCategory = false;
      currentFloor = undefined;
      return;
    }
    if (STAGE_CATEGORIES.has(clean) || clean === "一般作战 & 紧急作战" || clean === "一般作战&紧急作战") {
      inCombat = true;
      inStageCategory = true;
      currentFloor = undefined;
      return;
    }
    const floor = floorFromText(clean);
    if (inCombat && inStageCategory && floor !== undefined) currentFloor = floor;
  };

  for (const line of htmlToStageLines(html)) {
    if (!line.startsWith("@@LINK@@")) {
      setTextState(line);
      continue;
    }
    const marker = line.match(/^@@LINK@@([^@]*)@@(.*)$/);
    if (!marker) continue;
    const href = decodeURIComponent(marker[1] || "");
    const name = decodeURIComponent(marker[2] || "").replace(/[ⅠⅡⅢ]$/, "").trim();
    if (!name) continue;

    if (ROGUELIKE_THEMES.includes(name)) { setTextState(name); continue; }
    if (STAGE_CATEGORIES.has(name) || STOP_CATEGORIES.has(name)) { setTextState(name); continue; }
    const linkFloor = floorFromText(name);
    if (name.length <= 8 && linkFloor !== undefined) { setTextState(name); continue; }

    if (currentTheme !== theme || !inStageCategory || currentFloor === undefined || currentFloor === 0) continue;
    if (name.length > 40 || SKIP_STAGE_LINKS.has(name)) continue;
    if (/^(文件|分类|模板|帮助|特殊|用户|集成战略)[:：]/.test(name)) continue;
    if (!href.startsWith("/w/") && !href.includes("title=")) continue;

    const key = `${theme}|${currentFloor}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: key,
      theme,
      name,
      floor: currentFloor,
      prtsUrl: href.startsWith("http") ? href : `https://prts.wiki${href}`,
    });
  }
  return result;
}

let navboxCache;
async function navboxStages(theme) {
  if (!navboxCache) {
    navboxCache = await request({
      action: "parse",
      page: "模板:Navbox 集成战略",
      prop: "text|revid",
    });
  }
  const html = typeof navboxCache.parse.text === "string"
    ? navboxCache.parse.text
    : navboxCache.parse.text["*"];
  return {
    stages: stageLinksFromHtml(theme, html, { navbox: true }),
    revid: navboxCache.parse.revid,
    source: "模板:Navbox 集成战略",
  };
}

async function stageSection(theme) {
  const attempts = [];
  const sectionList = await request({ action: "parse", page: theme, prop: "sections|revid" });
  const sections = sectionList.parse?.sections ?? [];
  const section = sections.find((item) => /关卡一览/.test(item.line || item.anchor || ""));

  if (section) {
    const parsed = await request({ action: "parse", page: theme, section: section.index, prop: "text|revid" });
    const html = typeof parsed.parse.text === "string" ? parsed.parse.text : parsed.parse.text["*"];
    const stages = stageLinksFromHtml(theme, html);
    attempts.push(`主题页“关卡一览”章节=${stages.length}`);
    if (stages.length >= 10) {
      return { stages, revid: parsed.parse.revid ?? sectionList.parse.revid, source: `${theme}#关卡一览` };
    }
  } else {
    attempts.push("主题页没有“关卡一览”章节");
  }

  // 有些主题的楼层标题由章节外层模板提供，单独解析 section 会丢失楼层上下文。
  const fullPage = await request({ action: "parse", page: theme, prop: "text|revid" });
  const fullHtml = typeof fullPage.parse.text === "string" ? fullPage.parse.text : fullPage.parse.text["*"];
  const fullStages = stageLinksFromHtml(theme, fullHtml);
  attempts.push(`完整主题页=${fullStages.length}`);
  if (fullStages.length >= 10) {
    return { stages: fullStages, revid: fullPage.parse.revid, source: theme };
  }

  // 最稳定的回退：统一导航模板按主题→作战类型→楼层组织所有关卡。
  const navbox = await navboxStages(theme);
  attempts.push(`统一导航模板=${navbox.stages.length}`);
  if (navbox.stages.length >= 10) return navbox;

  // 保存页面 HTML，便于 PRTS 模板再次变化时定位，不覆盖已有 stages.json。
  const debugDir = path.join(OUT, "debug");
  await fs.mkdir(debugDir, { recursive: true });
  await fs.writeFile(path.join(debugDir, `${safeName(theme)}.html`), fullHtml);
  throw new Error(`${theme}: 未能可靠解析关卡（${attempts.join("，")}）。调试页面已保存到 public/data/debug/${safeName(theme)}.html`);
}

function extractSquadsFromHtml(theme, html) {
  const result = [];
  const seen = new Set();
  const add = (name) => {
    name = htmlText(name).replace(/^NEW\s*/i, "").trim();
    const match = name.match(/[A-Za-z0-9\u3400-\u9fff·²-]{2,20}分队/);
    if (!match) return;
    name = match[0];
    if (/^(战术|选择战术|月度小队)分队$/.test(name) || seen.has(name)) return;
    seen.add(name);
    result.push({ id: `${theme}|${name}`, theme, name });
  };

  // The squad list is presented as a table. Restrict extraction to the first
  // cell of each row so effect descriptions containing “分队” are ignored.
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    if (cells.length) add(cells[0][1]);
  }
  return result;
}

async function syncSquads() {
  const all = [];
  const byTheme = {};
  for (const theme of ROGUELIKE_THEMES) {
    const parsed = await request({ action: "parse", page: theme, prop: "text|revid" });
    const html = typeof parsed.parse.text === "string" ? parsed.parse.text : parsed.parse.text["*"];
    const squads = extractSquadsFromHtml(theme, html);
    if (squads.length < 4) {
      const debugDir = path.join(OUT, "debug");
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, `${safeName(theme)}-squads.html`), html);
      throw new Error(`${theme}: 只解析到 ${squads.length} 个分队，拒绝覆盖 squads.json`);
    }
    all.push(...squads);
    byTheme[theme] = squads.length;
    console.log(`Squads: ${theme} -> ${squads.length}`);
  }
  await fs.writeFile(path.join(OUT, "squads.json"), JSON.stringify(all, null, 2));
  return { count: all.length, byTheme };
}

async function syncStages() {
  const all = [];
  const revisions = {};
  for (const theme of ROGUELIKE_THEMES) {
    const data = await stageSection(theme);
    all.push(...data.stages);
    revisions[theme] = data.revid;
    console.log(`Stages: ${theme} -> ${data.stages.length}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await fs.writeFile(path.join(OUT, "stages.json"), JSON.stringify(all, null, 2));
  return { count: all.length, byTheme: Object.fromEntries(ROGUELIKE_THEMES.map((theme) => [theme, all.filter((s) => s.theme === theme).length])), revisions };
}

try {
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch { /* no manifest */ }
  const operatorMeta = STAGES_ONLY ? previous.operatorMeta : await syncOperators();
  const stageMeta = OPERATORS_ONLY ? previous.stageMeta : await syncStages();
  const squadMeta = OPERATORS_ONLY ? previous.squadMeta : await syncSquads();
  await fs.writeFile(manifestPath, JSON.stringify({ updatedAt: new Date().toISOString(), source: activeApi, operatorMeta, stageMeta, squadMeta }, null, 2));
  console.log(`PRTS sync complete: ${operatorMeta?.count ?? "cached"} operators, ${stageMeta?.count ?? "cached"} stages, ${squadMeta?.count ?? "cached"} squads.`);
} catch (error) {
  console.error(`PRTS sync failed:
${error.stack ?? error.message}`);
  console.error("Diagnostic commands:");
  console.error("  curl -I https://prts.wiki/api.php");
  console.error("  curl \"https://prts.wiki/api.php?action=query&meta=siteinfo&format=json\"");
  process.exitCode = 1;
}
