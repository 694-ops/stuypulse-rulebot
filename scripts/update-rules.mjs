// Rebuilds rules.json from frcmanual.com, using the newest season the site has.
//
//   node scripts/update-rules.mjs [path/to/rules.json]
//
// It reads the site's sitemap to find each season's rule sections (the pages
// whose names end in a letter code, like "game-rules-(g)"), collects every
// numbered rule heading on them, and rewrites rules.json when anything changed.
// It refuses to go back to an older season or to drop most of the rules, so a
// change to frcmanual.com's page layout fails the run instead of emptying the bot.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SITE = "https://www.frcmanual.com";
const RULES_FILE = process.argv[2] ?? fileURLToPath(new URL("../rules.json", import.meta.url));

// A season's manual has around 200 numbered rules. Far fewer means the page
// layout changed or the season is only partly posted.
const MIN_RULES = 100;
// Team Updates remove a handful of rules at most. Losing more than this share
// of the current season's rules in one run is treated as a broken scrape.
const MAX_DROP = 0.2;
// Sections in the order the bot has always listed them; any new ones go last.
const SECTION_ORDER = ["g", "r", "i", "t", "c", "e"];

async function get(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "stuypulse-rulebot (+https://github.com/694-ops/stuypulse-rulebot)" },
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return String.fromCodePoint(n);
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

// Rule sections for each season, as { year: { letter: slug } }.
async function findSeasons() {
  const sitemap = await get(`${SITE}/sitemap.xml`);
  const seasons = {};
  for (const [, year, rawSlug] of sitemap.matchAll(/<loc>https:\/\/www\.frcmanual\.com\/(\d{4})\/([^<]+)<\/loc>/g)) {
    const slug = decodeEntities(rawSlug);
    const letter = slug.match(/-\(([a-z])\)$/)?.[1];
    if (!letter) continue;
    seasons[year] ??= {};
    // The site lists some sections twice ("inspection-&-eligibility-(i)" and
    // "inspection-and-eligibility-(i)"); keep the one without "&".
    if (!seasons[year][letter] || seasons[year][letter].includes("&")) seasons[year][letter] = slug;
  }
  return seasons;
}

function sectionRank(letter) {
  const i = SECTION_ORDER.indexOf(letter);
  return i === -1 ? SECTION_ORDER.length : i;
}

async function scrapeSeason(year, sections) {
  const rules = {};
  const letters = Object.keys(sections).sort((a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b));
  for (const letter of letters) {
    const slug = sections[letter];
    const html = await get(`${SITE}/${year}/${slug}`);
    for (const [, id, inner] of html.matchAll(/<h3[^>]*\sid="([a-z]\d+-[^"]*)"[^>]*>([\s\S]*?)<\/h3>/g)) {
      const key = id.match(/^[a-z]\d+/)[0].toUpperCase();
      if (rules[key]) continue;
      const text = decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      const name = text.replace(/^[A-Za-z]\d+\s*\*?\s*/, "");
      rules[key] = { name, link: `${SITE}/${year}/${slug}#${id}` };
    }
  }
  return rules;
}

function seasonOf(rules) {
  const link = Object.values(rules)[0]?.link ?? "";
  return Number(link.match(/frcmanual\.com\/(\d{4})\//)?.[1] ?? 0);
}

function describeChanges(oldRules, newRules) {
  const added = Object.keys(newRules).filter((k) => !oldRules[k]);
  const removed = Object.keys(oldRules).filter((k) => !newRules[k]);
  const renamed = Object.keys(newRules).filter((k) => oldRules[k] && oldRules[k].name !== newRules[k].name);
  const moved = Object.keys(newRules).filter(
    (k) => oldRules[k] && oldRules[k].name === newRules[k].name && oldRules[k].link !== newRules[k].link,
  );
  return { added, removed, renamed, moved };
}

function report(lines, commitMessage) {
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  if (process.env.GITHUB_OUTPUT && commitMessage) appendFileSync(process.env.GITHUB_OUTPUT, `message=${commitMessage}\n`);
}

const oldText = readFileSync(RULES_FILE, "utf8");
const oldRules = JSON.parse(oldText);
const currentSeason = seasonOf(oldRules);

const seasons = await findSeasons();
const candidates = Object.keys(seasons).map(Number).filter((y) => y >= currentSeason).sort((a, b) => b - a);
if (candidates.length === 0) throw new Error(`frcmanual.com's sitemap lists no rule sections for ${currentSeason} or later.`);

let season, newRules;
for (const year of candidates) {
  const rules = await scrapeSeason(year, seasons[year]);
  const count = Object.keys(rules).length;
  console.log(`${year}: ${count} rules in sections ${Object.keys(seasons[year]).join(", ").toUpperCase()}`);
  if (count >= MIN_RULES) {
    season = year;
    newRules = rules;
    break;
  }
}
if (!season) {
  throw new Error(`No season from ${currentSeason} on had at least ${MIN_RULES} rules. frcmanual.com's layout may have changed; check the h3 rule headings.`);
}

const oldCount = Object.keys(oldRules).length;
const newCount = Object.keys(newRules).length;
if (season === currentSeason && newCount < oldCount * (1 - MAX_DROP)) {
  throw new Error(`The ${season} manual dropped from ${oldCount} to ${newCount} rules. That looks like a broken scrape, so rules.json was left alone.`);
}

const newText = JSON.stringify(newRules, null, 4) + "\n";
if (newText === oldText) {
  report([`rules.json is already up to date with the ${season} manual (${newCount} rules).`]);
} else {
  writeFileSync(RULES_FILE, newText);
  const { added, removed, renamed, moved } = describeChanges(oldRules, newRules);
  const lines = [
    season === currentSeason
      ? `Updated rules.json from the ${season} manual: ${newCount} rules.`
      : `Switched rules.json from the ${currentSeason} manual to the ${season} manual: ${newCount} rules.`,
  ];
  if (season === currentSeason) {
    if (added.length) lines.push(`Added: ${added.join(", ")}`);
    if (removed.length) lines.push(`Removed: ${removed.join(", ")}`);
    if (renamed.length) lines.push(`Renamed: ${renamed.join(", ")}`);
    if (moved.length) lines.push(`New link: ${moved.join(", ")}`);
  }
  const commitMessage =
    season === currentSeason
      ? `Update rules from the ${season} manual (${added.length} added, ${removed.length} removed, ${renamed.length} renamed, ${moved.length} relinked)`
      : `Switch rules to the ${season} manual`;
  report(lines, commitMessage);
}
