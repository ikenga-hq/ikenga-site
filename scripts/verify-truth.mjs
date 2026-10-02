#!/usr/bin/env node
/**
 * verify-truth.mjs: enforce the honest-inventory rule and the public-safety split
 * (plan 2026-10-02-site-docs-enterprise-overhaul, WP-11; G-01, G-05).
 *
 * Checks, in order. A run is green only when every check has zero findings.
 *
 *   schema         every src/data/truth/*.json row validates against src/data/truth/schema.ts
 *                  (shipped/beta rows need `since` plus a release ref whose version matches; no
 *                  stored `lane`; `limits[]` present; ...). features, glossary, roadmap and engines
 *                  are required; tiers.json is optional until WP-31 writes it.
 *   refs           cross-references inside the set: unique ids, every roadmap item names a real
 *                  feature, a glossary avoid[] term is never also a canonical term.
 *   tiers          tiers[].includes/coming resolve to real features, with the right status
 *                  (includes = released only; coming = not yet released).
 *   lanes          a lane is derived from status and never stored: no `lane` key anywhere in the
 *                  truth files, deriveLane() is total over the statuses, and a "notify me" card
 *                  does not sit on a feature that has already shipped.
 *   tags           NETWORK. Every shipped/beta row's release ref exists: the git tag in the
 *                  owning ikenga-hq repo (GitHub API) or the version on npm (npm registry).
 *   public-safety  none of T2, T3, DEC-, WP-, G-ACCESS, "hosted account" (or an internal G-xx
 *                  gate id) in src/data/truth (parsed values and keys; glossary avoid[] is exempt,
 *                  it exists to list banned terms) or in src/content (every text file, by line).
 *   glossary       none of the glossary avoid[] terms in src/content, src/pages, or the truth rows
 *                  themselves (glossary.json is the source of the list, so it is not scanned).
 *
 * Usage
 *   node scripts/verify-truth.mjs                run every check (needs network for `tags`)
 *   node scripts/verify-truth.mjs --offline      skip `tags`, loudly (local use only, never CI)
 *   node scripts/verify-truth.mjs --self-test    prove each check goes red on a seeded violation
 *                                                and green on the real truth data (no network;
 *                                                independent of what src/content says today)
 *   node scripts/verify-truth.mjs --root <dir>   read truth and content from another tree
 *                                                (same layout as this repo)
 *
 * Exit status: 0 green, 1 findings (or a tag that could not be verified), 2 usage or load error.
 *
 * Environment: GITHUB_TOKEN or GH_TOKEN is sent to api.github.com when set (raises the rate
 * limit; CI passes the workflow token). It is never printed.
 *
 * Deliberate exceptions: a line carrying `truth-lint-ignore`, or the line right after one,
 * is skipped by the public-safety and glossary scans (HTML, MDX or JS comment, whichever the
 * file allows). Use it for the glossary page and for "formerly called" notes. Ignored lines
 * are counted in the summary, so an exception is never silent.
 *
 * Needs Node >= 22.18 (built-in type stripping): the contract in schema.ts is imported as
 * TypeScript. Zod comes from `astro/zod`, so there is no extra dependency.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const REQUIRED_FILES = ['features.json', 'glossary.json', 'roadmap.json', 'engines.json'];
const OPTIONAL_FILES = ['tiers.json'];
const CONTENT_DIRS = ['src/content'];
const GLOSSARY_SCAN_DIRS = ['src/content', 'src/pages'];
const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.astro', '.html', '.txt', '.json', '.yaml', '.yml', '.ts', '.tsx', '.js', '.jsx', '.mjs']);
const IGNORE_MARKER = 'truth-lint-ignore';
const CHECKS = ['schema', 'refs', 'tiers', 'lanes', 'tags', 'public-safety', 'glossary'];

// ───────────────────────────── load ─────────────────────────────

async function loadSchema() {
  const url = new URL('../src/data/truth/schema.ts', import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    console.error('verify-truth: cannot load src/data/truth/schema.ts');
    if (err && err.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      console.error(`This needs Node >= 22.18 (built-in TypeScript type stripping). Running ${process.version}.`);
    } else {
      console.error(err && err.message ? err.message : err);
    }
    process.exit(2);
  }
}

function readText(file) {
  return readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/** Load the truth files. `errors` collects missing or unparsable files as findings. */
function loadTruth(root) {
  const dir = path.join(root, 'src/data/truth');
  const data = {};
  const errors = [];
  for (const name of [...REQUIRED_FILES, ...OPTIONAL_FILES]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      if (REQUIRED_FILES.includes(name)) errors.push({ check: 'schema', where: `src/data/truth/${name}`, message: 'required truth file is missing' });
      continue;
    }
    try {
      data[name] = JSON.parse(readText(file));
    } catch (err) {
      errors.push({ check: 'schema', where: `src/data/truth/${name}`, message: `not valid JSON: ${err.message}` });
    }
  }
  return { data, errors };
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_EXTENSIONS.has(path.extname(entry).toLowerCase())) out.push(full);
  }
  return out;
}

/** Collect `{ file, text }` for every text file under the given dirs, paths relative to root with "/". */
function loadFiles(root, dirs) {
  const files = [];
  for (const d of dirs) {
    for (const full of walk(path.join(root, d))) {
      files.push({ file: path.relative(root, full).split(path.sep).join('/'), text: readText(full) });
    }
  }
  return files;
}

// ───────────────────────────── helpers ─────────────────────────────

const fmtPath = (p) => p.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('').replace(/^\./, '');

/** Walk parsed JSON, calling visit(text, path, isKey) for every string value and object key. */
function walkStrings(value, visit, exemptKeys, p = []) {
  if (typeof value === 'string') {
    visit(value, p, false);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, visit, exemptKeys, p.concat(i)));
  } else if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (exemptKeys.includes(k)) continue;
      visit(k, p.concat(k), true);
      walkStrings(value[k], visit, exemptKeys, p.concat(k));
    }
  }
}

/** Does `value` have a key named `lane` or `lanes` anywhere? Returns the paths. */
function findLaneKeys(value, p = [], out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => findLaneKeys(v, p.concat(i), out));
  else if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (k === 'lane' || k === 'lanes') out.push(p.concat(k));
      findLaneKeys(value[k], p.concat(k), out);
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-term matcher for a glossary avoid[] entry. Terms with a lower-case letter match
 * case-insensitively ("chat panel"); codes such as T1 match case-sensitively. A term never
 * matches inside a longer word.
 */
function avoidRegex(term) {
  const body = term.trim().split(/\s+/).map(escapeRe).join('\\s+');
  const flags = /[a-z]/.test(term) ? 'iu' : 'u';
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, flags);
}

/** Of several hits on one line, drop a term that sits inside a longer hit ("T1" inside "T1 server"). */
function dropContained(hits) {
  return hits.filter((h) => !h.term || !hits.some((o) => o !== h && o.term && o.term.length > h.term.length && o.term.toLowerCase().includes(h.term.toLowerCase())));
}

/** Scan files line by line. `rules` = [{ label, re }]. Returns { findings, ignored }. */
function scanFiles(files, rules, check) {
  const findings = [];
  let ignored = 0;
  for (const { file, text } of files) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const hits = dropContained(rules.filter((r) => r.re.test(line)));
      if (hits.length === 0) return;
      if (line.includes(IGNORE_MARKER) || (i > 0 && (lines[i - 1] ?? '').includes(IGNORE_MARKER))) {
        ignored += hits.length;
        return;
      }
      for (const h of hits) {
        findings.push({ check, where: `${file}:${i + 1}`, message: `${h.label}: ${line.trim().slice(0, 140)}` });
      }
    });
  }
  return { findings, ignored };
}

// ───────────────────────────── the checks ─────────────────────────────

function checkSchema(schema, truth) {
  const findings = [];
  const parsed = {};
  for (const name of [...REQUIRED_FILES, ...OPTIONAL_FILES]) {
    if (!(name in truth)) continue;
    const r = schema.TRUTH_FILE_SCHEMAS[name].safeParse(truth[name]);
    if (r.success) {
      parsed[name] = r.data;
      continue;
    }
    for (const issue of r.error.issues) {
      // A stored `lane` is reported by the lanes check, with a clearer message.
      if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys) && issue.keys.length > 0 && issue.keys.every((k) => k === 'lane' || k === 'lanes')) continue;
      // The row schemas also scan for public-safety tokens; the public-safety check reports those once.
      if (typeof issue.message === 'string' && issue.message.startsWith('public-safety:')) continue;
      findings.push({ check: 'schema', where: `${name}:${fmtPath(issue.path)}`, message: issue.message });
    }
  }
  return { findings, parsed };
}

function checkSet(schema, parsed) {
  const set = {
    features: parsed['features.json'],
    glossary: parsed['glossary.json'],
    roadmap: parsed['roadmap.json'],
    engines: parsed['engines.json'],
    tiers: parsed['tiers.json'] ?? [],
  };
  const r = schema.TruthSetSchema.safeParse(set);
  if (r.success) return [];
  return r.error.issues.map((issue) => ({
    check: issue.path[0] === 'tiers' ? 'tiers' : 'refs',
    where: fmtPath(issue.path),
    message: issue.message,
  }));
}

function checkLanes(schema, truth, features, roadmap) {
  const findings = [];
  for (const name of Object.keys(truth)) {
    for (const p of findLaneKeys(truth[name])) {
      findings.push({ check: 'lanes', where: `${name}:${fmtPath(p)}`, message: 'a lane is derived from features[].status and must never be stored (01 rule 1, G-01)' });
    }
  }
  for (const status of schema.FEATURE_STATUSES) {
    let lane;
    try {
      lane = schema.deriveLane(status);
    } catch (err) {
      findings.push({ check: 'lanes', where: 'schema.ts:deriveLane', message: `deriveLane("${status}") threw: ${err.message}` });
      continue;
    }
    if (!schema.LANES.includes(lane)) findings.push({ check: 'lanes', where: 'schema.ts:deriveLane', message: `deriveLane("${status}") returned unknown lane "${lane}"` });
  }
  const laneCounts = {};
  {
    const byId = new Map(features.map((f) => [f.id, f]));
    roadmap.forEach((item, i) => {
      const f = item && byId.get(item.feature_id);
      if (!f) return; // reported by `refs`
      const lane = schema.deriveLane(f.status);
      laneCounts[lane] = (laneCounts[lane] || 0) + 1;
      if (item.notify && lane === 'shipped') {
        findings.push({ check: 'lanes', where: `roadmap.json:[${i}]`, message: `"${item.feature_id}" is shipped, so a "notify me" card has nothing to wait for; set notify to false` });
      }
    });
  }
  return { findings, laneCounts };
}

/** Every distinct release ref on a shipped/beta row → the feature ids that rest on it. */
function releasedRefs(schema, features) {
  const refs = new Map();
  for (const f of features) {
    if (!schema.isReleased(f.status) || typeof f.ref_public !== 'string') continue;
    const ref = schema.parseReleaseRef(f.ref_public);
    if (!ref) continue; // reported by `schema`
    const key = f.ref_public;
    if (!refs.has(key)) refs.set(key, { ref, ids: [] });
    refs.get(key).ids.push(f.id);
  }
  return refs;
}

async function checkTags(schema, features, tagExists) {
  const findings = [];
  const refs = releasedRefs(schema, features);
  const entries = [...refs.entries()];
  const results = await mapPool(entries, 6, ([, { ref }]) => tagExists(ref));
  const unverified = new Map(); // error detail -> [refs]: one finding per cause, not one per ref
  entries.forEach(([url, { ref, ids }], i) => {
    const r = results[i];
    if (r.ok) return;
    const what = ref.kind === 'github-release' ? `tag ${ref.tag} in ikenga-hq/${ref.repo}` : `${ref.pkg}@${ref.version} on npm`;
    if (r.reason !== 'missing') {
      if (!unverified.has(r.detail)) unverified.set(r.detail, []);
      unverified.get(r.detail).push(what);
      return;
    }
    const used = `used by ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ` and ${ids.length - 4} more` : ''}`;
    findings.push({ check: 'tags', where: url, message: `${what} does not exist, so these rows cannot be "shipped" (${used})` });
  });
  for (const [detail, whats] of unverified) {
    findings.push({ check: 'tags', where: '(network)', message: `could not verify ${whats.length} release ref(s): ${detail}. First: ${whats.slice(0, 3).join('; ')}` });
  }
  return { findings, distinct: entries.length };
}

function checkPublicSafety(schema, truth, contentFiles) {
  const findings = [];
  const exempt = schema.PUBLIC_SAFETY_EXEMPT_KEYS;
  for (const name of Object.keys(truth)) {
    walkStrings(
      truth[name],
      (text, p, isKey) => {
        for (const pat of schema.PUBLIC_SAFETY_PATTERNS) {
          if (pat.re.test(text)) {
            findings.push({ check: 'public-safety', where: `${name}:${fmtPath(p)}`, message: `"${pat.token}" must not appear in public truth${isKey ? ' (object key)' : ''}: ${text.slice(0, 100)}` });
          }
        }
      },
      exempt,
    );
  }
  const rules = schema.PUBLIC_SAFETY_PATTERNS.map((p) => ({ label: `"${p.token}" must not appear in public content`, re: p.re }));
  const scanned = scanFiles(contentFiles, rules, 'public-safety');
  findings.push(...scanned.findings);
  return { findings, ignored: scanned.ignored };
}

function checkGlossary(truth, parsed, scanFilesList) {
  const findings = [];
  const glossary = parsed['glossary.json'] ?? (Array.isArray(truth['glossary.json']) ? truth['glossary.json'] : []);
  const seen = new Set();
  const rules = [];
  for (const g of glossary) {
    if (!g || !Array.isArray(g.avoid)) continue;
    for (const raw of g.avoid) {
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ label: `avoid "${raw}" (use "${g.term}")`, term: raw, re: avoidRegex(raw) });
    }
  }
  const scanned = scanFiles(scanFilesList, rules, 'glossary');
  findings.push(...scanned.findings);
  // The truth rows are public copy too. glossary.json is the source of the list: skip it.
  for (const name of Object.keys(truth)) {
    if (name === 'glossary.json') continue;
    walkStrings(
      truth[name],
      (text, p, isKey) => {
        if (isKey) return;
        for (const r of dropContained(rules.filter((x) => x.re.test(text)))) findings.push({ check: 'glossary', where: `${name}:${fmtPath(p)}`, message: `${r.label}: ${text.slice(0, 100)}` });
      },
      [],
    );
  }
  return { findings, ignored: scanned.ignored, terms: rules.length };
}

// ───────────────────────────── network ─────────────────────────────

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStatus(url, headers) {
  let last = 'no response';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 404 || res.status === 200) return { status: res.status, res };
      if (res.status === 403 || res.status === 429) {
        const left = res.headers.get('x-ratelimit-remaining');
        return { status: res.status, error: left === '0' ? 'GitHub API rate limit reached (set GITHUB_TOKEN)' : `HTTP ${res.status}` };
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err && err.message ? err.message : String(err);
    }
    if (attempt < 3) await sleep(400 * attempt);
  }
  return { status: 0, error: last };
}

/** Real tag check: GitHub API for git tags, the npm registry for npm versions. */
function makeNetworkTagChecker() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const ghHeaders = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ikenga-site-verify-truth' };
  if (token) ghHeaders.Authorization = `Bearer ${token}`;
  const npmHeaders = { Accept: 'application/json', 'User-Agent': 'ikenga-site-verify-truth' };
  return async (ref) => {
    if (ref.kind === 'github-release') {
      const tagPath = ref.tag.split('/').map(encodeURIComponent).join('/');
      const url = `https://api.github.com/repos/ikenga-hq/${ref.repo}/git/ref/tags/${tagPath}`;
      const r = await fetchStatus(url, ghHeaders);
      if (r.status === 200) return { ok: true };
      if (r.status === 404) return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'error', detail: r.error };
    }
    const url = `https://registry.npmjs.org/${ref.pkg.replace('/', '%2f')}/${encodeURIComponent(ref.version)}`;
    const r = await fetchStatus(url, npmHeaders);
    if (r.status === 200) return { ok: true };
    if (r.status === 404) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'error', detail: r.error };
  };
}

// ───────────────────────────── run ─────────────────────────────

/**
 * Run every check on already-loaded input. `tagExists(ref)` resolves { ok } or
 * { ok: false, reason: 'missing' | 'error', detail }. Pass `null` to skip the network step.
 */
async function verify(schema, { truth, loadErrors = [], contentFiles, glossaryFiles, tagExists }) {
  const findings = [...loadErrors];
  const { findings: schemaFindings, parsed } = checkSchema(schema, truth);
  findings.push(...schemaFindings);

  // refs and tiers need every file to validate. A check that did not run must never read as PASS.
  const notRun = {};
  const haveCore = REQUIRED_FILES.every((n) => parsed[n]) && (!('tiers.json' in truth) || parsed['tiers.json']);
  if (haveCore) findings.push(...checkSet(schema, parsed));
  else notRun.refs = notRun.tiers = 'a truth file failed validation (see schema)';

  // lanes and tags run on every feature row that validates on its own, so one bad row cannot blank them.
  const rawFeatures = Array.isArray(truth['features.json']) ? truth['features.json'] : [];
  const rawRoadmap = Array.isArray(truth['roadmap.json']) ? truth['roadmap.json'] : [];
  const validFeatures = rawFeatures.filter((row) => schema.FeatureSchema.safeParse(row).success);
  const lanes = checkLanes(schema, truth, validFeatures, rawRoadmap);
  findings.push(...lanes.findings);

  let tags = { distinct: 0, skipped: false, rowsNotChecked: rawFeatures.length - validFeatures.length };
  if (!tagExists) {
    tags.skipped = true;
  } else {
    const t = await checkTags(schema, validFeatures, tagExists);
    findings.push(...t.findings);
    tags = { ...tags, distinct: t.distinct };
  }

  const safety = checkPublicSafety(schema, truth, contentFiles);
  findings.push(...safety.findings);
  const glossary = checkGlossary(truth, parsed, glossaryFiles);
  findings.push(...glossary.findings);

  const len = (n) => (Array.isArray(truth[n]) ? truth[n].length : 0);
  const counts = {
    features: rawFeatures.length,
    released: validFeatures.filter((f) => schema.isReleased(f.status)).length,
    glossary: len('glossary.json'),
    roadmap: len('roadmap.json'),
    engines: len('engines.json'),
    tiers: len('tiers.json'),
  };
  return { findings, notRun, counts, laneCounts: lanes.laneCounts, tags, ignored: safety.ignored + glossary.ignored, avoidTerms: glossary.terms, contentFileCount: contentFiles.length, glossaryFileCount: glossaryFiles.length, haveTiersFile: 'tiers.json' in truth };
}

function report(result, { offline }) {
  const { findings, notRun, counts, laneCounts, tags, ignored } = result;
  const lines = [];
  lines.push(`Truth: ${counts.features} features (${counts.released} shipped or beta), ${counts.glossary} glossary terms, ${counts.roadmap} roadmap cards, ${counts.engines} engines, ${counts.tiers} tiers${result.haveTiersFile ? '' : ' (tiers.json not present yet: WP-31 writes it, so there are no tier refs to resolve)'}`);
  const lc = Object.keys(laneCounts).length ? Object.entries(laneCounts).map(([k, v]) => `${k} ${v}`).join(', ') : 'none';
  lines.push(`Roadmap lanes (derived from status): ${lc}`);
  lines.push(`Scanned ${result.contentFileCount} file(s) under ${CONTENT_DIRS.join(', ')} for public safety; ${result.glossaryFileCount} under ${GLOSSARY_SCAN_DIRS.join(', ')} for ${result.avoidTerms} glossary avoid[] term(s)`);
  lines.push('');
  for (const check of CHECKS) {
    const mine = findings.filter((f) => f.check === check);
    let state = mine.length === 0 ? 'PASS' : `FAIL (${mine.length})`;
    if (notRun[check] && mine.length === 0) state = `NOT RUN (${notRun[check]})`;
    if (check === 'tags') {
      const unchecked = tags.rowsNotChecked > 0 ? `; ${tags.rowsNotChecked} row(s) not checked because they failed validation` : '';
      state = tags.skipped ? 'SKIPPED (--offline: release refs NOT verified)' : mine.length === 0 ? (tags.rowsNotChecked > 0 ? `INCOMPLETE (${tags.distinct} distinct release refs exist${unchecked})` : `PASS (${tags.distinct} distinct release refs exist)`) : `FAIL (${mine.length} of ${tags.distinct} release refs${unchecked})`;
    }
    lines.push(`  ${check.padEnd(14)} ${state}`);
  }
  if (ignored > 0) lines.push(`  ${ignored} hit(s) skipped by ${IGNORE_MARKER} markers`);
  if (findings.length > 0) {
    lines.push('');
    for (const check of CHECKS) {
      const mine = findings.filter((f) => f.check === check);
      if (mine.length === 0) continue;
      lines.push(`[${check}]`);
      for (const f of mine) lines.push(`  ${f.where}  ${f.message}`);
    }
  }
  lines.push('');
  lines.push(findings.length === 0 ? (offline ? 'verify-truth: OK (offline: tags not verified)' : 'verify-truth: OK') : `verify-truth: FAILED, ${findings.length} finding(s)`);
  return lines.join('\n');
}

// ───────────────────────────── self-test ─────────────────────────────

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Seeded violations, run in memory with no network. The baseline is the REAL truth data plus
 * synthetic clean content, so the self-test proves each check independent of today's content.
 * Each case must fire exactly the checks in `expect` (the control and the exceptions: none).
 */
async function selfTest(schema, root) {
  const { data: truth0, errors } = loadTruth(root);
  if (errors.length) {
    console.error('self-test: the real truth files do not load:\n' + errors.map((e) => `  ${e.where}  ${e.message}`).join('\n'));
    return 1;
  }
  const clean = [{ file: 'src/content/docs/clean.mdx', text: 'Plain prose that names no banned term.\n' }];
  const content0 = clean;
  const glossary0 = clean;
  const okTags = async () => ({ ok: true });
  const stubTags = async (ref) => (ref.version === '9.9.9' ? { ok: false, reason: 'missing' } : { ok: true });
  const firstReleased = truth0['features.json'].find((f) => f.status === 'shipped');
  const roadmapShipped = truth0['roadmap.json'].find((r) => {
    const f = truth0['features.json'].find((x) => x.id === r.feature_id);
    return f && f.status === 'shipped';
  });
  const aTier = (over) => ({ id: 'team', price: 20, price_monthly: 25, billing_period: 'annual', unit: 'member', addons: [], includes: [], coming: [], prerequisites: [], availability: 'early-access', cta: { kind: 'contact', label: 'Talk to us', href: '/contact/' }, ...over });

  const cases = [
    { name: 'control: real truth data, clean content, every tag exists', mutate: () => {}, expect: [] },
    { name: 'shipped row with no `since`', expect: ['schema'], mutate: (t) => { delete t['features.json'].find((f) => f.id === firstReleased.id).since; } },
    { name: 'shipped row whose release tag does not exist (v9.9.9)', expect: ['tags'], mutate: (t) => { const f = t['features.json'].find((x) => x.id === firstReleased.id); f.since = '9.9.9'; f.ref_public = 'https://github.com/ikenga-hq/ikenga/releases/tag/v9.9.9'; } },
    { name: 'one invalid row must not blank the tags check: a bad row plus a missing tag elsewhere fires both', expect: ['schema', 'tags'], mutate: (t) => { const rows = t['features.json'].filter((x) => x.status === 'shipped'); delete rows[0].since; const g = rows.find((x) => x.ref_public.includes('github.com/ikenga-hq/ikenga/releases') && x.id !== rows[0].id); g.since = '9.9.9'; g.ref_public = 'https://github.com/ikenga-hq/ikenga/releases/tag/v9.9.9'; } },
    { name: 'shipped row linking a PR instead of a release', expect: ['schema'], mutate: (t) => { t['features.json'].find((f) => f.id === firstReleased.id).ref_public = 'https://github.com/ikenga-hq/ikenga/pull/1'; } },
    { name: 'stored `lane` on a roadmap card', expect: ['lanes'], mutate: (t) => { t['roadmap.json'][0].lane = 'shipped'; } },
    { name: '"notify me" on a card for a shipped feature', expect: ['lanes'], skip: !roadmapShipped, mutate: (t) => { t['roadmap.json'].find((r) => r.feature_id === roadmapShipped.feature_id).notify = true; } },
    { name: 'roadmap card for an unknown feature id', expect: ['refs'], mutate: (t) => { t['roadmap.json'].push({ feature_id: 'nope.missing', public_label: 'Nope', notify: false }); } },
    { name: 'tier includes an unknown feature id', expect: ['tiers'], mutate: (t) => { t['tiers.json'] = [aTier({ includes: ['nope.missing'] })]; } },
    { name: 'tier includes a feature that has not released', expect: ['tiers'], mutate: (t) => { const f = t['features.json'].find((x) => x.status === 'in-progress'); t['tiers.json'] = [aTier({ includes: [f.id] })]; } },
    { name: 'tier lists a released feature under coming', expect: ['tiers'], mutate: (t) => { t['tiers.json'] = [aTier({ coming: [firstReleased.id] })]; } },
    { name: 'public safety: "WP-12" in a feature limit', expect: ['public-safety'], mutate: (t) => { t['features.json'][0].limits.push('Waits on WP-12.'); } },
    { name: 'public safety: "T2" in a roadmap note (also a glossary avoid[] term, so both fire)', expect: ['public-safety', 'glossary'], mutate: (t) => { t['roadmap.json'][0].public_note = 'Ships with the T2 isolation work.'; } },
    { name: 'public safety: "hosted account" in src/content', expect: ['public-safety'], content: (f) => f.concat({ file: 'src/content/docs/seed.mdx', text: 'Sign up for a hosted account to start.\n' }) },
    { name: 'public safety: "G-ACCESS" in src/content', expect: ['public-safety'], content: (f) => f.concat({ file: 'src/content/docs/seed.mdx', text: 'Tracked by G-ACCESS-BUILT.\n' }) },
    { name: 'glossary: avoid[] term in src/pages', expect: ['glossary'], glossary: (f) => f.concat({ file: 'src/pages/seed.astro', text: '<p>Open the chat panel.</p>\n' }) },
    { name: 'glossary: T1 in src/content', expect: ['glossary'], glossary: (f) => f.concat({ file: 'src/content/docs/seed.mdx', text: 'Run a T1 server.\n' }) },
    { name: 'glossary: avoid[] term in a truth row', expect: ['glossary'], mutate: (t) => { t['features.json'][0].plain_name = 'The chat panel'; } },
    { name: 'exception: a truth-lint-ignore marker (line before, or same line) skips the hit and is counted', expect: [], ignoredAtLeast: 2, content: (f) => f.concat({ file: 'src/content/docs/seed.mdx', text: '<!-- truth-lint-ignore: glossary page lists banned terms -->\nAvoid: chat panel, WP-12.\nAvoid: T1. <!-- truth-lint-ignore -->\n' }), glossary: (f) => f.concat({ file: 'src/content/docs/seed.mdx', text: '<!-- truth-lint-ignore: glossary page lists banned terms -->\nAvoid: chat panel, WP-12.\nAvoid: T1. <!-- truth-lint-ignore -->\n' }) },
    { name: 'a word that merely contains a banned term is not a hit ("T10", "chat panelling")', expect: [], content: (f) => f.concat({ file: 'src/content/docs/seed.mdx', text: 'Models T10 and chat panelling are fine.\n' }), glossary: (f) => f.concat({ file: 'src/content/docs/seed.mdx', text: 'Models T10 and chat panelling are fine.\n' }) },
  ].filter((c) => !c.skip);

  let bad = 0;
  for (const c of cases) {
    const truth = clone(truth0);
    if (c.mutate) c.mutate(truth);
    const contentFiles = c.content ? c.content(content0.slice()) : content0;
    const glossaryFiles = c.glossary ? c.glossary(glossary0.slice()) : glossary0;
    const tagExists = /9.9.9|tags check/.test(c.name) ? stubTags : okTags;
    const r = await verify(schema, { truth, contentFiles, glossaryFiles, tagExists });
    const fired = [...new Set(r.findings.map((f) => f.check))];
    const missing = c.expect.filter((e) => !fired.includes(e));
    const extra = fired.filter((e) => !c.expect.includes(e));
    const ignoredOk = c.ignoredAtLeast === undefined || r.ignored >= c.ignoredAtLeast;
    const pass = missing.length === 0 && extra.length === 0 && ignoredOk;
    if (!pass) bad++;
    const verdict = r.findings.length === 0 ? 'green' : `red (${fired.join(', ')})`;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${c.name} -> ${verdict}`);
    if (!pass && r.findings.length > 0) for (const f of r.findings.slice(0, 5)) console.log(`         ${f.check} ${f.where}  ${f.message}`);
  }
  console.log(bad === 0 ? `\nverify-truth self-test: ${cases.length} cases ok` : `\nverify-truth self-test: ${bad} of ${cases.length} cases FAILED`);
  return bad === 0 ? 0 : 1;
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  if (flag('--help') || flag('-h')) {
    console.log('Usage: node scripts/verify-truth.mjs [--offline] [--self-test] [--root <dir>]\nSee the header of this file for what each check does.');
    return 0;
  }
  let root = DEFAULT_ROOT;
  const ri = args.indexOf('--root');
  if (ri !== -1) {
    if (!args[ri + 1]) {
      console.error('verify-truth: --root needs a directory');
      return 2;
    }
    root = path.resolve(args[ri + 1]);
  }
  const known = new Set(['--help', '-h', '--offline', '--self-test', '--root', root, args[ri + 1]]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length) {
    console.error(`verify-truth: unknown argument ${unknown.join(' ')}`);
    return 2;
  }

  const schema = await loadSchema();
  if (flag('--self-test')) return selfTest(schema, root);

  const offline = flag('--offline');
  const { data, errors } = loadTruth(root);
  const result = await verify(schema, {
    truth: data,
    loadErrors: errors,
    contentFiles: loadFiles(root, CONTENT_DIRS),
    glossaryFiles: loadFiles(root, GLOSSARY_SCAN_DIRS),
    tagExists: offline ? null : makeNetworkTagChecker(),
  });
  console.log(report(result, { offline }));
  return result.findings.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('verify-truth: unexpected error');
    console.error(err);
    process.exitCode = 2;
  },
);
