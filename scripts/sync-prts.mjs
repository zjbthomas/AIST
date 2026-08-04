import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as cheerio from "cheerio";

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

function decodeHtmlEntities(value) {
  const input = String(value ?? "");
  if (!input.includes("&")) return input;

  // Let Cheerio's HTML parser decode named and numeric entities consistently.
  const $ = cheerio.load(`<textarea>${input}</textarea>`, null, false);
  return $("textarea").text();
}

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

const PROFESSION_ALIASES = new Map([
  ["PIONEER", "VANGUARD"], ["VANGUARD", "VANGUARD"], ["先锋", "VANGUARD"],
  ["WARRIOR", "GUARD"], ["GUARD", "GUARD"], ["近卫", "GUARD"],
  ["TANK", "DEFENDER"], ["DEFENDER", "DEFENDER"], ["重装", "DEFENDER"],
  ["SNIPER", "SNIPER"], ["狙击", "SNIPER"],
  ["CASTER", "CASTER"], ["术师", "CASTER"],
  ["MEDIC", "MEDIC"], ["医疗", "MEDIC"],
  ["SUPPORT", "SUPPORTER"], ["SUPPORTER", "SUPPORTER"], ["辅助", "SUPPORTER"],
  ["SPECIAL", "SPECIALIST"], ["SPECIALIST", "SPECIALIST"], ["特种", "SPECIALIST"],
]);

function normalizeProfession(value) {
  const raw = String(value ?? "").trim();
  return PROFESSION_ALIASES.get(raw) || PROFESSION_ALIASES.get(raw.toUpperCase()) || raw.toUpperCase();
}

async function operatorList() {
  const data = await request({ action: "parse", page: "干员一览", prop: "text|revid" });
  const html = typeof data.parse?.text === "string" ? data.parse.text : data.parse?.text?.["*"];
  if (!html) {
    throw new Error("PRTS 干员一览 API 未返回 HTML，无法解析干员列表");
  }

  // Parse the actual DOM instead of matching a nested div with a non-greedy
  // regular expression. The old expression could stop at the first child
  // closing tag and return an empty operator list after unrelated page edits.
  const $ = cheerio.load(html);
  const container = $("#filter-data");
  const nodes = container.length
    ? container.children("div[data-zh]")
    : $("div[data-zh]");

  const seen = new Set();
  const operators = [];
  nodes.each((_, element) => {
    const entry = element.attribs ?? {};
    const name = String(entry["data-zh"] ?? "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);

    // PRTS data-rarity is zero-based: 0 means 1-star and 5 means 6-star.
    // data-star/data-rank, when present, are treated as direct 1-6 values.
    const rarityField = entry["data-rarity"] !== undefined
      ? "data-rarity"
      : entry["data-star"] !== undefined
        ? "data-star"
        : "data-rank";
    const rarityRaw = entry[rarityField] ?? "3";
    const parsedRarity = Number(String(rarityRaw).replace(/\D/g, ""));
    const rarity = rarityField === "data-rarity"
      ? Math.max(1, Math.min(6, (Number.isFinite(parsedRarity) ? parsedRarity : 2) + 1))
      : Math.max(1, Math.min(6, Number.isFinite(parsedRarity) && parsedRarity > 0 ? parsedRarity : 3));
    const profession = normalizeProfession(
      entry["data-profession"] || entry["data-class"] || entry["data-job"] || "",
    );
    operators.push({ name, rarity, profession });
  });

  if (operators.length < 100) {
    await fs.mkdir(path.join(OUT, "debug"), { recursive: true });
    await fs.writeFile(path.join(OUT, "debug", "operator-list.html"), html, "utf8");
    throw new Error(
      `只从干员一览解析到 ${operators.length} 个干员，拒绝继续同步。调试页面已保存到 public/data/debug/operator-list.html`,
    );
  }

  return { operators, revid: data.parse?.revid };
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

async function operatorDetails({ name, rarity, profession }) {
  const data = await request({ action: "parse", page: name, prop: "text|revid" });
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
    id: name, name, rarity, profession,
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
    const failures = [];
    for (let j = 0; j < settled.length; j += 1) {
      const item = settled[j];
      if (item.status === "fulfilled") result.push(item.value);
      else failures.push({ name: chunk[j]?.name ?? "unknown", reason: item.reason });
    }
    if (failures.length) {
      const first = failures[0];
      console.warn(`Operator detail failures in this batch: ${failures.length}. First: ${first.name}: ${first.reason?.message ?? first.reason}`);
    }
    console.log(`Operators: ${Math.min(i + chunk.length, list.length)}/${list.length} (${result.length} resolved)`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const operatorsWithSkills = result.filter((operator) => operator.skills.length > 0).length;
  const resolvedSkillIcons = result.reduce(
    (count, operator) => count + operator.skills.filter((skill) => Boolean(skill.icon)).length,
    0,
  );
  console.log(`Skills: ${operatorsWithSkills}/${result.length} operators, ${resolvedSkillIcons} resolved icons`);
  if (result.length === 0) {
    throw new Error("427 个干员详情请求全部失败。请查看上方 First failure；同步器不会再把请求失败误报为技能解析失败");
  }
  if (operatorsWithSkills === 0) {
    throw new Error("干员详情已获取，但没有从任何干员页面解析到技能。请检查 public/data/debug 中的页面结构");
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
  ["Ⅰ", 1], ["I", 1], ["一", 1],
  ["Ⅱ", 2], ["II", 2], ["二", 2],
  ["Ⅲ", 3], ["III", 3], ["三", 3],
  ["Ⅳ", 4], ["IV", 4], ["四", 4],
  ["Ⅴ", 5], ["V", 5], ["五", 5],
  ["Ⅵ", 6], ["VI", 6], ["六", 6],
  ["Ⅶ", 7], ["VII", 7], ["七", 7],
]);

function compactText(value) {
  return decodeHtmlEntities(String(value ?? ""))
    // Content-expansion notes are bracketed, e.g. [Ⅱ]. Bare Ⅰ/Ⅱ/Ⅲ are
    // floor labels and must never be removed here.
    .replace(/\[[ⅠⅡⅢⅣⅤⅥIVX]+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function exactFloor(value) {
  const text = compactText(value)
    .replace(/^第\s*/, "")
    .replace(/\s*层$/, "")
    .replace(/[()（）【】\[\]：:]/g, "")
    .trim();
  return FLOOR_MAP.get(text);
}

function normalizeStageHref(href) {
  if (!href) return "";
  if (/^https?:\/\//.test(href)) return href;
  return new URL(href, "https://prts.wiki").href;
}

function cleanStageName(value) {
  return compactText(value)
    .replace(/\^\{?\[?[ⅠⅡⅢIVX]+\]?\}?$/gi, "")
    .replace(/[¹²³]+$/g, "")
    .trim();
}

const NON_STAGE_NAMES = new Set([
  "查看活动详情", "遭遇记录", "关卡一览", "集成战略", "作战", "编辑",
  "一般作战", "普通作战", "紧急作战", "一般作战 & 紧急作战",
  "一般作战&紧急作战", "单", "双", "文件", "图片",
]);

function directTableRows($, table) {
  const rows = $(table).children("tbody,thead,tfoot").children("tr").toArray();
  return rows.length ? rows : $(table).children("tr").toArray();
}

function sectionNameFromTable($, table, sectionCode) {
  const rows = directTableRows($, table);
  let codeRowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (compactText($(rows[i]).text()).includes(sectionCode)) {
      codeRowIndex = i;
      const cells = $(rows[i]).find("th,td").toArray().map((cell) => compactText($(cell).text()));
      const inline = cells
        .map((text) => text.replace(sectionCode, "").trim())
        .find((text) => text && exactFloor(text) === undefined && text.length <= 50);
      if (inline) return inline;
      break;
    }
  }
  for (let i = Math.max(0, codeRowIndex + 1); i < Math.min(rows.length, codeRowIndex + 4); i++) {
    const text = compactText($(rows[i]).text());
    if (!text || exactFloor(text) !== undefined) continue;
    if ($(rows[i]).find("a").length > 3) continue;
    return text.replace(sectionCode, "").trim();
  }
  return sectionCode;
}


function textWithBreaks($, node) {
  const clone = $(node).clone();
  clone.find("br").replaceWith(" ");
  clone.find("sup").remove();
  return compactText(clone.text());
}

function sectionHeaderFromRow($, tr) {
  const cells = $(tr).children("th,td").toArray();
  if (!cells.length) return null;
  if ($(tr).children("th,td").find("table").length) return null;
  const text = compactText(cells.map((cell) => textWithBreaks($, cell)).join(" "));
  if (!/^ISW-[A-Z0-9-]+(?:\s*&\s*ISW-[A-Z0-9-]+)*\s+/i.test(text)) return null;
  if ($(tr).children("th,td").find('a[href*="/w/ISW-"]').length) return null;
  const codeMatch = text.match(/^(ISW-[A-Z0-9-]+(?:\s*&\s*ISW-[A-Z0-9-]+)*)\s+(.+)$/i);
  if (!codeMatch) return null;
  return {
    code: codeMatch[1].toUpperCase().replace(/\s+/g, " "),
    name: codeMatch[2].trim(),
  };
}

function imageFloorKey($, cell) {
  const parts = [];
  $(cell).find("img,source").each((_, node) => {
    for (const attr of ["alt", "title", "src", "data-src", "srcset"]) {
      const value = $(node).attr(attr);
      if (value) parts.push(String(value));
    }
  });
  $(cell).find("a").each((_, node) => {
    for (const attr of ["title", "href"]) {
      const value = $(node).attr(attr);
      if (value) parts.push(String(value));
    }
  });
  return compactText(parts.map((value) => {
    try { return decodeURIComponent(value); } catch { return value; }
  }).join(" | "));
}

function floorFromImageMetadata($, cell) {
  const key = imageFloorKey($, cell);
  if (!key) return undefined;

  // Prefer explicit phrases such as “第3层”, “第三层”, “区域Ⅲ” or file
  // names containing a standalone floor marker. Do not treat arbitrary digits
  // in hashes, dimensions or cache parameters as floor numbers.
  const patterns = [
    /第\s*([1-7一二三四五六七ⅠⅡⅢⅣⅤⅥⅦ]+)\s*层/i,
    /(?:楼层|层级|区域|区域层)\s*[_ -]*([1-7一二三四五六七ⅠⅡⅢⅣⅤⅥⅦ]+)/i,
    /(?:^|[_\s-])([ⅠⅡⅢⅣⅤⅥⅦ])(?:[_\s.-]|$)/,
  ];
  for (const pattern of patterns) {
    const match = key.match(pattern);
    if (!match) continue;
    const floor = exactFloor(match[1]);
    if (floor !== undefined) return floor;
  }
  return undefined;
}

function learnImageFloorMap($, rows) {
  const learned = new Map();
  let sectionName = "";
  let normalEmergencySequence = 0;

  for (const tr of rows) {
    const header = sectionHeaderFromRow($, tr);
    if (header) {
      sectionName = header.name;
      normalEmergencySequence = 0;
      continue;
    }

    const cells = $(tr).children("th,td").toArray();
    if (!cells.length) continue;
    const firstCell = $(cells[0]);
    const key = imageFloorKey($, firstCell);
    if (!key || !firstCell.find("img,source").length) continue;

    const metadataFloor = floorFromImageMetadata($, firstCell);
    if (metadataFloor !== undefined) {
      learned.set(key, metadataFloor);
      continue;
    }

    // The general/emergency table is the only safe baseline for ordered image
    // labels: it enumerates the main route from floor 1 onward. Learn each
    // image's absolute floor here, then reuse that exact image in sections such
    // as 险路恶敌 that may start at floor 3 or 5. Never restart numbering in
    // each section.
    const isNormalEmergency = /(?:一般|普通)作战/.test(sectionName) && /紧急作战/.test(sectionName);
    const rowHasStageLink = $(tr).find('a[href*="/w/ISW-"],a[href*="title=ISW-"]').length > 0;
    if (isNormalEmergency && rowHasStageLink) {
      normalEmergencySequence += 1;
      learned.set(key, normalEmergencySequence);
    }
  }
  return learned;
}

function stageRowsFromOrderedRows(theme, $, rows, sharedImageFloorMap = new Map()) {
  const output = [];
  const seen = new Set();
  const imageFloorMap = sharedImageFloorMap;
  let sectionCode = "";
  let sectionName = "";
  let currentFloor = 0;

  for (const tr of rows) {
    const header = sectionHeaderFromRow($, tr);
    if (header) {
      sectionCode = header.code;
      sectionName = header.name;
      currentFloor = 0;
      continue;
    }
    if (!sectionCode) continue;

    const cells = $(tr).children("th,td").toArray();
    let explicitFloor;
    for (const cell of cells) {
      const floor = exactFloor($(cell).clone().find("sup").remove().end().text());
      if (floor !== undefined) {
        explicitFloor = floor;
        currentFloor = floor;
        break;
      }
    }

    // Some themes (notably 岁的界园志异) render floor labels as images.
    // Resolve the image to an absolute floor using its own metadata or the map
    // learned from the complete general/emergency section. Never assume that
    // the first image in every section means floor 1: boss sections may begin
    // at floor 3 or 5.
    if (explicitFloor === undefined && cells.length > 0) {
      const firstCell = $(cells[0]);
      const key = imageFloorKey($, firstCell);
      const imageFloor = floorFromImageMetadata($, firstCell) ?? imageFloorMap.get(key);
      if (imageFloor !== undefined) currentFloor = imageFloor;
      else if (firstCell.find("img,source").length > 0) currentFloor = 0;
    }

    const isNormalEmergency = /(?:一般|普通)作战/.test(sectionName) && /紧急作战/.test(sectionName);
    $(tr).children("th,td").find("a[href]").each((__, anchor) => {
      const href = String($(anchor).attr("href") ?? "");
      const name = cleanStageName($(anchor).clone().find("sup").remove().end().text());
      if (!name || name.length > 50 || NON_STAGE_NAMES.has(name)) return;
      if (ROGUELIKE_THEMES.includes(name) || /^ISW-/i.test(name)) return;
      if (/^(?:文件|File|分类|模板|用户|帮助)[:：]/i.test(name)) return;
      if (href.startsWith("#") || /^(?:mailto|javascript):/i.test(href)) return;
      if (!href.startsWith("/w/") && !href.startsWith("./") && !href.includes("title=") && !/^https?:\/\/(?:[^/]+\.)?prts\.wiki/i.test(href)) return;
      if (!/(?:\/w\/|title=)ISW-/i.test(href)) return;
      if (/^(?:单|双|普通|紧急)$/.test(name)) return;

      const variants = isNormalEmergency
        ? [
            { id: "normal", name: "一般作战" },
            { id: "emergency", name: "紧急作战" },
          ]
        : [{ id: "default", name: sectionName }];

      for (const variant of variants) {
        const categoryId = `${sectionCode}:${variant.id}`;
        const key = `${theme}|${sectionCode}|${currentFloor}|${variant.id}|${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({
          id: key,
          theme,
          name,
          floor: currentFloor,
          sectionCode,
          sectionName,
          categoryId,
          categoryName: variant.name,
          variant: variant.id,
          prtsUrl: normalizeStageHref(href),
        });
      }
    });
  }
  return output;
}

function directRowsOfTable($, table) {
  // MediaWiki always inserts tbody in parsed HTML. Use only direct rows so
  // wrapper tables cannot duplicate rows from nested stage tables.
  const bodyRows = $(table).children("tbody,thead,tfoot").children("tr").toArray();
  return bodyRows.length ? bodyRows : $(table).children("tr").toArray();
}

function isStageTable($, table) {
  const rows = directRowsOfTable($, table);
  if (!rows.length) return false;
  return rows.some((tr) => {
    const text = compactText($(tr).children("th,td").toArray().map((cell) => textWithBreaks($, cell)).join(" "));
    return /^ISW-[A-Z0-9-]+(?:\s*&\s*ISW-[A-Z0-9-]+)*(?:\s+|$)/i.test(text);
  });
}

function stageSectionRoot($) {
  const headline = $("#关卡一览").first();
  if (!headline.length) return $.root();
  const heading = headline.closest("h2,h3");
  if (!heading.length) return $.root();

  const nodes = [];
  let node = heading.next();
  while (node.length) {
    if (node.is("h2")) break;
    nodes.push(node.get(0));
    node = node.next();
  }
  return nodes.length ? $(nodes) : $.root();
}

function innermostStageTables($, root) {
  // `root` may itself be a collection containing the stage table as a direct
  // sibling of the “关卡一览” heading. Cheerio's `.find()` only searches
  // descendants, so include root-level tables explicitly.
  const allTables = [
    ...root.filter("table").toArray(),
    ...root.find("table").toArray(),
  ];
  const uniqueTables = [...new Set(allTables)];
  const candidates = uniqueTables.filter((table) => isStageTable($, table));

  // Keep tables that do not contain another valid stage table. This removes
  // outer MediaWiki/collapsible wrapper tables while preserving the actual
  // ISW tables. A single table may contain multiple ISW sections.
  return candidates.filter((table) => {
    return !$(table).find("table").toArray().some((child) => child !== table && isStageTable($, child));
  });
}

const THEME_STAGE_ADAPTERS = {
  // Optional per-theme overrides can be registered here if PRTS introduces a
  // genuinely different representation. Current themes use the same ISW table
  // semantics despite different numbers and names of sections.
};

function parseStageTables(theme, html) {
  const $ = cheerio.load(html);
  const adapter = THEME_STAGE_ADAPTERS[theme];
  if (adapter) return adapter(theme, $, html);

  const root = stageSectionRoot($);
  const tables = innermostStageTables($, root);
  if (!tables.length && process.env.PRTS_DEBUG === "1") {
    const rootLevelTables = root.filter("table").length;
    const descendantTables = root.find("table").length;
    console.warn(`Stage parser debug (${theme}): root tables=${rootLevelTables}, descendant tables=${descendantTables}`);
  }
  const output = [];
  const seen = new Set();
  const tableRows = tables.map((table) => directRowsOfTable($, table));
  const imageFloorMap = new Map();
  for (const rows of tableRows) {
    for (const [key, floor] of learnImageFloorMap($, rows)) imageFloorMap.set(key, floor);
  }

  for (const rows of tableRows) {
    const parsed = stageRowsFromOrderedRows(theme, $, rows, imageFloorMap);
    for (const stage of parsed) {
      if (seen.has(stage.id)) continue;
      seen.add(stage.id);
      output.push(stage);
    }
  }
  return output;
}

function categorySummary(stages) {
  const categories = new Map();
  for (const stage of stages) {
    if (!categories.has(stage.categoryId)) {
      categories.set(stage.categoryId, {
        id: stage.categoryId,
        sectionCode: stage.sectionCode,
        sectionName: stage.sectionName,
        name: stage.categoryName,
        count: 0,
      });
    }
    categories.get(stage.categoryId).count += 1;
  }
  return [...categories.values()];
}

function validateThemeStages(theme, stages) {
  if (stages.length < 10) throw new Error(`${theme}: 只解析到 ${stages.length} 个关卡`);
  const categories = categorySummary(stages);
  if (categories.length < 2) throw new Error(`${theme}: 只识别到 ${categories.length} 个关卡区块类别`);
  const combinedSections = [...new Set(stages.filter((stage) => /一般作战/.test(stage.sectionName) && /紧急作战/.test(stage.sectionName)).map((stage) => stage.sectionCode))];
  for (const sectionCode of combinedSections) {
    const normal = new Set(stages.filter((stage) => stage.sectionCode === sectionCode && stage.variant === "normal").map((stage) => `${stage.floor}|${stage.name}`));
    const emergency = new Set(stages.filter((stage) => stage.sectionCode === sectionCode && stage.variant === "emergency").map((stage) => `${stage.floor}|${stage.name}`));
    if (!normal.size || normal.size !== emergency.size || [...normal].some((key) => !emergency.has(key))) {
      throw new Error(`${theme}: ${sectionCode} 的一般/紧急作战展开结果不一致`);
    }
  }
  return stages;
}

async function stageSection(theme) {
  const attempts = [];
  const sectionList = await request({ action: "parse", page: theme, prop: "sections|revid" });
  const sections = sectionList.parse?.sections ?? [];
  const section = sections.find((item) => /关卡一览/.test(item.line || item.anchor || ""));

  if (section) {
    const parsed = await request({ action: "parse", page: theme, section: section.index, prop: "text|revid" });
    const html = typeof parsed.parse.text === "string" ? parsed.parse.text : parsed.parse.text["*"];
    const stages = parseStageTables(theme, html);
    attempts.push(`主题页“关卡一览”章节=${stages.length}`);
    if (stages.length >= 10) {
      return { stages: validateThemeStages(theme, stages), revid: parsed.parse.revid ?? sectionList.parse.revid, source: `${theme}#关卡一览` };
    }
  } else {
    attempts.push("主题页没有“关卡一览”章节");
  }

  const fullPage = await request({ action: "parse", page: theme, prop: "text|revid" });
  const fullHtml = typeof fullPage.parse.text === "string" ? fullPage.parse.text : fullPage.parse.text["*"];
  const fullStages = parseStageTables(theme, fullHtml);
  attempts.push(`完整主题页=${fullStages.length}`);
  if (fullStages.length >= 10) {
    return { stages: validateThemeStages(theme, fullStages), revid: fullPage.parse.revid, source: theme };
  }

  const debugDir = path.join(OUT, "debug");
  await fs.mkdir(debugDir, { recursive: true });
  await fs.writeFile(path.join(debugDir, `${safeName(theme)}.html`), fullHtml);
  throw new Error(`${theme}: 未能从真实 ISW 表格解析关卡（${attempts.join("，")}）。调试页面已保存到 public/data/debug/${safeName(theme)}.html`);
}

function extractSquadsFromHtml(theme, html) {
  const result = [];
  const seen = new Set();
  const add = (name) => {
    const $fragment = cheerio.load(String(name ?? ""), null, false);
    name = compactText($fragment.root().text()).replace(/^NEW\s*/i, "").trim();
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


const BASIC_OTHER_NODE_TYPES = [
  { code: "ENCOUNTER", name: "不期而遇" },
  { code: "WISH", name: "得偿所愿" },
  { code: "SAFE HOUSE", name: "安全屋" },
  { code: "DOWNTIME RECREATION", name: "幕间余兴" },
  { code: "ROGUE TRADER", name: "诡意行商" },
];

function normalizeNodeTypeName(name) {
  const text = compactText(name).replace(/^商店$/, "诡意行商");
  return text;
}

function nodeTypeSectionRoot($) {
  const headline = $("#事件节点").first();
  if (!headline.length) return $.root();
  const heading = headline.closest("h2,h3");
  if (!heading.length) return $.root();
  const nodes = [];
  let node = heading.next();
  while (node.length) {
    if (node.is("h2")) break;
    nodes.push(node.get(0));
    node = node.next();
  }
  return nodes.length ? $(nodes) : $.root();
}

function extractNodeTypesFromHtml(theme, html) {
  const $ = cheerio.load(html);
  const root = nodeTypeSectionRoot($);
  const result = [];
  const seen = new Set();
  const add = (code, rawName) => {
    const name = normalizeNodeTypeName(rawName);
    if (!name || seen.has(name)) return;
    seen.add(name);
    const combat = /^(作战|紧急作战|险路恶敌)$/.test(name);
    result.push({ id: `${theme}|${safeName(code || name)}`, theme, code: compactText(code), name, kind: combat ? "combat" : "other" });
  };

  root.find("li").each((_, li) => {
    const element = $(li);
    const headingText = compactText(element.children("b,strong").first().text());
    let label = headingText;
    if (!label) {
      const clone = element.clone();
      clone.children("p,ul,ol,dl,table,div").remove();
      label = compactText(textWithBreaks($, clone.get(0)));
    }
    const match = label.match(/^([A-Z][A-Z .&'/-]{1,45})[　\s]+(.{1,20})$/);
    if (match) add(match[1], match[2]);
  });

  // PRTS occasionally changes wrappers; scan short bold labels as a fallback.
  if (result.length < 5) {
    root.find("b,strong").each((_, node) => {
      const label = compactText($(node).text());
      const match = label.match(/^([A-Z][A-Z .&'/-]{1,45})[　\s]+(.{1,20})$/);
      if (match) add(match[1], match[2]);
    });
  }
  return result;
}

async function syncNodeTypes() {
  const all = [];
  const byTheme = {};
  for (const theme of ROGUELIKE_THEMES) {
    const parsed = await request({ action: "parse", page: theme, prop: "text|revid" });
    const html = typeof parsed.parse.text === "string" ? parsed.parse.text : parsed.parse.text["*"];
    let types = extractNodeTypesFromHtml(theme, html);
    if (types.filter((item) => item.kind === "other").length < 3) {
      const existingNames = new Set(types.map((item) => item.name));
      for (const item of BASIC_OTHER_NODE_TYPES) {
        if (!existingNames.has(item.name)) types.push({ id: `${theme}|${safeName(item.code)}`, theme, ...item, kind: "other" });
      }
      console.warn(`Node types: ${theme} 的 PRTS 节点类型解析不完整，已补充基础节点。`);
    }
    all.push(...types);
    byTheme[theme] = types.length;
    console.log(`Node types: ${theme} -> ${types.filter((item) => item.kind === "other").map((item) => item.name).join("、")}`);
  }
  await fs.writeFile(path.join(OUT, "node-types.json"), JSON.stringify(all, null, 2));
  return { count: all.length, byTheme };
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
  const categoriesByTheme = {};
  for (const theme of ROGUELIKE_THEMES) {
    const data = await stageSection(theme);
    all.push(...data.stages);
    revisions[theme] = data.revid;
    categoriesByTheme[theme] = categorySummary(data.stages);
    console.log(`Stages: ${theme} -> ${data.stages.length}`);
    console.log(`  Categories: ${categoriesByTheme[theme].map((item) => `${item.name}(${item.count})`).join("、")}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await fs.writeFile(path.join(OUT, "stages.json"), JSON.stringify(all, null, 2));
  await fs.writeFile(path.join(OUT, "stage-categories.json"), JSON.stringify(categoriesByTheme, null, 2));
  return { count: all.length, byTheme: Object.fromEntries(ROGUELIKE_THEMES.map((theme) => [theme, all.filter((s) => s.theme === theme).length])), categoriesByTheme, revisions };
}

try {
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch { /* no manifest */ }
  const operatorMeta = STAGES_ONLY ? previous.operatorMeta : await syncOperators();
  const stageMeta = OPERATORS_ONLY ? previous.stageMeta : await syncStages();
  const nodeTypeMeta = OPERATORS_ONLY ? previous.nodeTypeMeta : await syncNodeTypes();
  const squadMeta = OPERATORS_ONLY ? previous.squadMeta : await syncSquads();
  await fs.writeFile(manifestPath, JSON.stringify({ updatedAt: new Date().toISOString(), source: activeApi, operatorMeta, stageMeta, nodeTypeMeta, squadMeta }, null, 2));
  console.log(`PRTS sync complete: ${operatorMeta?.count ?? "cached"} operators, ${stageMeta?.count ?? "cached"} stages, ${nodeTypeMeta?.count ?? "cached"} node types, ${squadMeta?.count ?? "cached"} squads.`);
} catch (error) {
  console.error(`PRTS sync failed:
${error.stack ?? error.message}`);
  console.error("Diagnostic commands:");
  console.error("  curl -I https://prts.wiki/api.php");
  console.error("  curl \"https://prts.wiki/api.php?action=query&meta=siteinfo&format=json\"");
  process.exitCode = 1;
}
