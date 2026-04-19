#!/usr/bin/env node

/**
 * scanGoogle.mjs — Combined portal + Google Search scanner
 *
 * Phase 1: Scans tracked_companies via Greenhouse/Ashby/Lever APIs (like scan.mjs)
 * Phase 2: Runs search_queries via Serper.dev Google Search
 *
 * Both phases apply title_filter from portals.yml and share the same dedup set.
 * Results are appended to pipeline.md + scan-history.tsv.
 *
 * Requires SERPER_API_KEY environment variable (set in .claude/settings.local.json).
 * Get a key at: https://serper.dev
 *
 * Usage:
 *   node scanGoogle.mjs                        # run full scan (portals + google)
 *   node scanGoogle.mjs --dry-run              # preview without writing files
 *   node scanGoogle.mjs --company Cohere       # portal scan for one company
 *   node scanGoogle.mjs --query "trabajando"   # google queries matching name
 *   node scanGoogle.mjs --skip-portals         # google only
 *   node scanGoogle.mjs --skip-google          # portals only (same as scan.mjs)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const PROFILE_PATH = 'config/profile.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

mkdirSync('data', { recursive: true });

// Read SERPER_API_KEY from env or fall back to .claude/settings.local.json
function resolveApiKey() {
  if (process.env.SERPER_API_KEY) return process.env.SERPER_API_KEY;
  const settingsPaths = [
    '.claude/settings.local.json',
    `${process.env.HOME}/.claude/settings.local.json`,
  ];
  for (const p of settingsPaths) {
    try {
      const s = JSON.parse(readFileSync(p, 'utf-8'));
      if (s?.env?.SERPER_API_KEY) return s.env.SERPER_API_KEY;
    } catch { /* not found */ }
  }
  return null;
}

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;
const SERPER_DELAY_MS = 300;

const COUNTRY_TO_GL = {
  chile: 'cl', spain: 'es', argentina: 'ar', colombia: 'co',
  mexico: 'mx', peru: 'pe', brazil: 'br', germany: 'de',
  france: 'fr', japan: 'jp', 'united states': 'us', usa: 'us',
  'united kingdom': 'gb', uk: 'gb', canada: 'ca', australia: 'au',
};
const COUNTRY_TO_HL = {
  chile: 'es', spain: 'es', argentina: 'es', colombia: 'es',
  mexico: 'es', peru: 'es', brazil: 'pt', germany: 'de',
  france: 'fr', japan: 'ja', 'united states': 'en', usa: 'en',
  'united kingdom': 'en', uk: 'en', canada: 'en', australia: 'en',
};

// ── API detection (Greenhouse / Ashby / Lever) ──────────────────────

function detectApi(company) {
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }
  const url = company.careers_url || '';

  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return { type: 'lever', url: `https://api.lever.co/v0/postings/${leverMatch[1]}` };
  }

  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

function parseGreenhouse(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '', url: j.absolute_url || '',
    company: companyName, location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '', url: j.jobUrl || '',
    company: companyName, location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '', url: j.hostedUrl || '',
    company: companyName, location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch helpers ───────────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) seen.add(match[1]);
  }
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(match[0]);
  }
  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') seen.add(`${company}::${role}`);
    }
  }
  return seen;
}

// ── Pipeline / history writers ──────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;
  let text = existsSync(PIPELINE_PATH)
    ? readFileSync(PIPELINE_PATH, 'utf-8')
    : '# Pipeline\n\n## Pendientes\n\n## Procesadas\n';

  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch ──────────────────────────────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < tasks.length) { const task = tasks[i++]; results.push(await task()); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
  return results;
}

// ── Geo config ──────────────────────────────────────────────────────

function loadGeoConfig() {
  if (!existsSync(PROFILE_PATH)) return { gl: 'us', hl: 'en' };
  try {
    const profile = parseYaml(readFileSync(PROFILE_PATH, 'utf-8'));
    const country = (profile?.location?.country || '').toLowerCase();
    return { gl: COUNTRY_TO_GL[country] || 'us', hl: COUNTRY_TO_HL[country] || 'en' };
  } catch { return { gl: 'us', hl: 'en' }; }
}

// ── Google Search via Serper ────────────────────────────────────────

function extractCompany(title) {
  const patterns = [
    / at ([^|–\-]+)/i,
    / en ([^|–\-]+)/i,
    /^([^|–\-]+)\s*[-–|]\s/,
    /\s*[-–|]\s*([^|–\-]+)$/,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return match[1].trim();
  }
  return 'Unknown';
}

async function searchGoogle(query, geo, apiKey) {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, gl: geo.gl, hl: geo.hl, autocorrect: false }),
  });
  if (!response.ok) throw new Error(`Serper API error: ${response.status}`);
  const data = await response.json();
  return (data.organic || []).map(item => ({
    title: item.title,
    url: item.link,
    company: extractCompany(item.title),
    source: 'google-search',
  }));
}

// ── Phase 1: Portal scan ────────────────────────────────────────────

async function runPortalScan({ companies, titleFilter, seenUrls, seenCompanyRoles, filterCompany, date }) {
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;
  console.log(`\n── Phase 1: Portal Scan ──────────────────────────────`);
  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);

  let totalFound = 0, totalFiltered = 0, totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;
      for (const job of jobs) {
        if (!titleFilter(job.title)) { totalFiltered++; continue; }
        if (seenUrls.has(job.url)) { totalDupes++; continue; }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);
  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.company}: ${e.error}`);
  }

  return newOffers;
}

// ── Phase 2: Google Search ──────────────────────────────────────────

async function runGoogleScan({ queries, titleFilter, seenUrls, geo, apiKey, filterQuery }) {
  if (!apiKey) {
    console.log('\n── Phase 2: Google Search ────────────────────────────');
    console.log('  ⚠ Skipped — SERPER_API_KEY not set. Get one at https://serper.dev');
    return [];
  }

  let activeQueries = queries.filter(q => q.enabled !== false);
  if (filterQuery) activeQueries = activeQueries.filter(q => q.name.toLowerCase().includes(filterQuery));

  console.log(`\n── Phase 2: Google Search ────────────────────────────`);
  console.log(`Geo: ${geo.gl.toUpperCase()} / ${geo.hl} | Queries: ${activeQueries.length}`);

  const newOffers = [];
  const errors = [];

  for (const [i, q] of activeQueries.entries()) {
    try {
      process.stdout.write(`  [${i + 1}/${activeQueries.length}] ${q.name}... `);
      const results = await searchGoogle(q.query, geo, apiKey);
      const before = newOffers.length;
      for (const res of results) {
        if (!titleFilter(res.title)) continue;
        if (!seenUrls.has(res.url)) {
          newOffers.push(res);
          seenUrls.add(res.url);
        }
      }
      console.log(`${results.length} results, ${newOffers.length - before} new`);
    } catch (err) {
      console.log('ERROR');
      errors.push({ name: q.name, error: err.message });
    }
    if (i < activeQueries.length - 1) await sleep(SERPER_DELAY_MS);
  }

  console.log(`New offers added:      ${newOffers.length}`);
  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.name}: ${e.error}`);
  }

  return newOffers;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipPortals = args.includes('--skip-portals');
  const skipGoogle = args.includes('--skip-google');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const queryFlag = args.indexOf('--query');
  const filterQuery = queryFlag !== -1 ? args[queryFlag + 1]?.toLowerCase() : null;

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const queries = config.search_queries || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const geo = loadGeoConfig();
  const apiKey = resolveApiKey();
  const date = new Date().toISOString().slice(0, 10);

  console.log(`Combined Scan (Portals + Google) — ${date}`);
  if (dryRun) console.log('(dry run — no files will be written)');

  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const portalOffers = skipPortals ? [] : await runPortalScan({
    companies, titleFilter, seenUrls, seenCompanyRoles, filterCompany, date,
  });

  const googleOffers = skipGoogle ? [] : await runGoogleScan({
    queries, titleFilter, seenUrls, geo, apiKey, filterQuery,
  });

  const allNewOffers = [...portalOffers, ...googleOffers];

  if (!dryRun && allNewOffers.length > 0) {
    appendToPipeline(allNewOffers);
    appendToScanHistory(allNewOffers, date);
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Combined Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Portal offers:         ${portalOffers.length}`);
  console.log(`Google offers:         ${googleOffers.length}`);
  console.log(`Total new offers:      ${allNewOffers.length}`);

  if (allNewOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of allNewOffers) {
      console.log(`  + [${o.source}] ${o.company} | ${o.title}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
