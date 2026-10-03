#!/usr/bin/env node
/**
 * verify-truth.mjs: check the site's truth data, and scan for text that must not be published.
 *
 * Every feature claim on the site is backed by a row in src/data/truth/*.json. This script keeps
 * those rows honest and keeps internal wording out of public files. A run is green only when no
 * check reports an error. Checks run in this order.
 *
 *   schema         every src/data/truth/*.json row validates against src/lib/truth/schema.ts
 *                  (a shipped or beta row needs `since` plus a release ref whose version matches,
 *                  no stored `lane`, `limits[]` present, and so on). features, glossary, roadmap
 *                  and engines are required. tiers.json is optional until pricing data lands.
 *   refs           cross-references inside the set: unique ids, every roadmap card names a real
 *                  feature, and a glossary avoid[] term is never also a canonical term.
 *   tiers          tiers[].includes and coming resolve to real features with the right status
 *                  (includes = released only; coming = not yet released).
 *   lanes          a lane is derived from status and never stored: no `lane` key anywhere in the
 *                  truth files, deriveLane() is total over the statuses, and a "notify me" card
 *                  does not sit on a feature that has already shipped.
 *   tags           NETWORK. Every shipped or beta row's release ref exists: the git tag in the
 *                  owning ikenga-hq repository (GitHub API) or the version on npm (npm registry).
 *   public-safety  no file under src/data/truth, src/lib/truth, src/content or src/pages matches a
 *                  forbidden pattern. The patterns are NOT in this repository: they come from the
 *                  TRUTH_SAFETY_PATTERNS environment variable (see below).
 *   glossary       none of the glossary avoid[] terms in src/content, src/pages or the truth rows
 *                  themselves (glossary.json is the source of the list, so it is not scanned).
 *                  Hits in src/content and src/pages are errors, or only warnings with
 *                  --content-lint=warn. Hits in the truth rows are always errors.
 *
 * Usage
 *   node scripts/verify-truth.mjs                    run every check (the tags check needs network)
 *   node scripts/verify-truth.mjs --offline          skip the tags check, loudly (local use only)
 *   node scripts/verify-truth.mjs --content-lint=warn
 *                                                    report glossary hits in src/content and
 *                                                    src/pages as warnings that do not fail the
 *                                                    run. The default is error. CI uses warn until
 *                                                    the site rebuild lands, then switches back.
 *   node scripts/verify-truth.mjs --require-safety-patterns
 *                                                    fail instead of skipping when
 *                                                    TRUTH_SAFETY_PATTERNS is empty or missing
 *   node scripts/verify-truth.mjs --self-test        prove each check goes red on a seeded violation
 *                                                    and green on the real truth data. Needs no
 *                                                    network and ignores TRUTH_SAFETY_PATTERNS.
 *   node scripts/verify-truth.mjs --root <dir>       read truth and content from another tree
 *                                                    (same layout as this repository)
 *
 * An unknown argument is an error (exit 2), including as the first argument.
 *
 * Exit status: 0 green, 1 errors (or a tag that could not be verified), 2 usage or load error.
 *
 * Environment
 *   TRUTH_SAFETY_PATTERNS   Forbidden patterns for the public-safety scan, one regular expression
 *                           per line. A plain line is a JavaScript regex source compiled with the
 *                           u flag. A line of the form /source/flags uses those flags (any of i, m,
 *                           s, u). Blank lines and lines starting with # are ignored. In CI the
 *                           value comes from a repository secret of the same name. When it is empty
 *                           or missing (forks, local runs) the public-safety check prints a warning
 *                           and is skipped. The patterns are deliberately not kept in this
 *                           repository, and this script never prints them: a finding names only the
 *                           file, the line and the pattern number.
 *   GITHUB_TOKEN or GH_TOKEN
 *                           Sent to api.github.com when set (raises the rate limit; CI passes the
 *                           workflow token). Never printed.
 *
 * There is no way to exempt a line from the public-safety scan or the glossary check: change the
 * text instead.
 *
 * Needs Node 22.18 or later (built-in type stripping), because the schema is imported as
 * TypeScript. Zod comes from `astro/zod`, so there is no extra dependency.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const REQUIRED_FILES = ['features.json', 'glossary.json', 'roadmap.json', 'engines.json'];
const OPTIONAL_FILES = ['tiers.json'];
/** Every file under these directories is scanned for forbidden patterns. */
const SAFETY_SCAN_DIRS = ['src/data/truth', 'src/lib/truth', 'src/content', 'src/pages'];
/** Glossary avoid[] terms are checked in these directories. */
const GLOSSARY_SCAN_DIRS = ['src/content', 'src/pages'];
const CHECKS = ['schema', 'refs', 'tiers', 'lanes', 'tags', 'public-safety', 'glossary'];
const SAFETY_ENV = 'TRUTH_SAFETY_PATTERNS';

class UsageError extends Error {}

// ───────────────────────────── arguments ─────────────────────────────

/** Parse the command line. Throws UsageError on anything it does not know, whatever the position. */
function parseArgs(argv) {
  const opts = { help: false, offline: false, selfTest: false, requireSafety: false, contentLint: 'error', root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--require-safety-patterns') opts.requireSafety = true;
    else if (a === '--root') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new UsageError('--root needs a directory');
      opts.root = path.resolve(v);
    } else if (a.startsWith('--root=')) {
      const v = a.slice('--root='.length);
      if (!v) throw new UsageError('--root needs a directory');
      opts.root = path.resolve(v);
    } else if (a.startsWith('--content-lint=')) {
      const v = a.slice('--content-lint='.length);
      if (v !== 'warn' && v !== 'error') throw new UsageError('--content-lint takes "warn" or "error"');
      opts.contentLint = v;
    } else {
      throw new UsageError(`unknown argument "${a}"`);
    }
  }
  return opts;
}

const USAGE = 'Usage: node scripts/verify-truth.mjs [--offline] [--content-lint=warn|error] [--require-safety-patterns] [--self-test] [--root <dir>]\nSee the header of this file for what each check does.';

// ───────────────────────────── load ─────────────────────────────

async function loadSchema() {
  const url = new URL('../src/lib/truth/schema.ts', import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    console.error('verify-truth: cannot load src/lib/truth/schema.ts');
    if (err && err.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      console.error(`This needs Node 22.18 or later (built-in TypeScript type stripping). Running ${process.version}.`);
    } else {
      console.error(err && err.message ? err.message : err);
    }
    process.exit(2);
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
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
      data[name] = JSON.parse(stripBom(readFileSync(file, 'utf8')));
    } catch (err) {
      errors.push({ check: 'schema', where: `src/data/truth/${name}`, message: `not valid JSON: ${err.message}` });
    }
  }
  return { data, errors };
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every text file under the given dirs, as `{ file, text }` with root-relative "/" paths. Binary files are skipped. */
function loadFiles(root, dirs) {
  const files = [];
  for (const d of dirs) {
    for (const full of walk(path.join(root, d))) {
      const buf = readFileSync(full);
      if (isBinary(buf)) continue;
      files.push({ file: path.relative(root, full).split(path.sep).join('/'), text: stripBom(buf.toString('utf8')) });
    }
  }
  return files;
}

// ───────────────────────────── helpers ─────────────────────────────

const fmtPath = (p) => p.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('').replace(/^\./, '');

/** Walk parsed JSON, calling visit(text, path, isKey) for every string value and object key. */
function walkStrings(value, visit, p = []) {
  if (typeof value === 'string') {
    visit(value, p, false);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, visit, p.concat(i)));
  } else if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      visit(k, p.concat(k), true);
      walkStrings(value[k], visit, p.concat(k));
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
 * case-insensitively ("chat panel"); all-caps codes match case-sensitively. A term never matches
 * inside a longer word.
 */
function avoidRegex(term) {
  const body = term.trim().split(/\s+/).map(escapeRe).join('\\s+');
  const flags = /[a-z]/.test(term) ? 'iu' : 'u';
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, flags);
}

/** Of several hits on one line, drop a term that sits inside a longer hit. */
function dropContained(hits) {
  return hits.filter((h) => !h.term || !hits.some((o) => o !== h && o.term && o.term.length > h.term.length && o.term.toLowerCase().includes(h.term.toLowerCase())));
}

/**
 * Parse the forbidden-pattern list. One regular expression per line; /source/flags sets flags.
 * Throws UsageError naming the line number (never the pattern) when a line is not a valid regex.
 */
function parseSafetyPatterns(text) {
  const out = [];
  (text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    let source = line;
    let flags = 'u';
    const m = /^\/(.+)\/([a-z]*)$/.exec(line);
    if (m) {
      source = m[1];
      if (!/^[imsu]*$/.test(m[2])) throw new UsageError(`${SAFETY_ENV} line ${i + 1}: only the flags i, m, s and u are allowed`);
      flags = m[2].includes('u') ? m[2] : m[2] + 'u';
    }
    try {
      out.push({ n: out.length + 1, re: new RegExp(source, flags) });
    } catch {
      throw new UsageError(`${SAFETY_ENV} line ${i + 1}: not a valid regular expression`);
    }
  });
  return out;
}

/** Scan files line by line against `rules` ([{ label, re, term? }]). Returns findings with the given check name and level. */
function scanFiles(files, rules, check, level, describe) {
  const findings = [];
  for (const { file, text } of files) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const r of dropContained(rules.filter((x) => x.re.test(line)))) {
        findings.push({ check, level, where: `${file}:${i + 1}`, message: describe(r, line) });
      }
    });
  }
  return findings;
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
      findings.push({ check: 'lanes', where: `${name}:${fmtPath(p)}`, message: 'a lane is derived from the feature status and must never be stored' });
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
  return { findings, laneCounts };
}

/** Every distinct release ref on a shipped or beta row, with the feature ids that rest on it. */
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

/**
 * Forbidden-pattern scan over every file in `files`. The message never repeats the line or the
 * pattern, so a CI log does not republish what the scan is there to keep out.
 */
function checkPublicSafety(files, patterns) {
  const rules = patterns.map((p) => ({ n: p.n, re: p.re }));
  return scanFiles(files, rules, 'public-safety', 'error', (r) => `matches forbidden pattern #${r.n}; edit or remove the text`);
}

function checkGlossary(truth, parsed, files, contentLint) {
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
  const level = contentLint === 'warn' ? 'warn' : 'error';
  const findings = scanFiles(files, rules, 'glossary', level, (r, line) => `${r.label}: ${line.trim().slice(0, 140)}`);
  // The truth rows are public copy too, and they are our own data: a hit there is always an error.
  // glossary.json is the source of the list, so it is skipped.
  for (const name of Object.keys(truth)) {
    if (name === 'glossary.json') continue;
    walkStrings(truth[name], (text, p, isKey) => {
      if (isKey) return;
      for (const r of dropContained(rules.filter((x) => x.re.test(text)))) {
        findings.push({ check: 'glossary', level: 'error', where: `${name}:${fmtPath(p)}`, message: `${r.label}: ${text.slice(0, 100)}` });
      }
    });
  }
  return { findings, terms: rules.length };
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
      if (res.status === 404 || res.status === 200) return { status: res.status };
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
 * { ok: false, reason: 'missing' | 'error', detail }; pass `null` to skip the network step.
 * `safetyPatterns` is the parsed forbidden-pattern list; an empty list skips the public-safety scan.
 */
async function verify(schema, { truth, loadErrors = [], safetyFiles, glossaryFiles, tagExists, safetyPatterns, contentLint = 'error' }) {
  const findings = loadErrors.map((f) => ({ level: 'error', ...f }));
  const { findings: schemaFindings, parsed } = checkSchema(schema, truth);
  findings.push(...schemaFindings.map((f) => ({ level: 'error', ...f })));

  // refs and tiers need every file to validate. A check that did not run must never read as PASS.
  const notRun = {};
  const haveCore = REQUIRED_FILES.every((n) => parsed[n]) && (!('tiers.json' in truth) || parsed['tiers.json']);
  if (haveCore) findings.push(...checkSet(schema, parsed).map((f) => ({ level: 'error', ...f })));
  else notRun.refs = notRun.tiers = 'a truth file failed validation (see schema)';

  // lanes and tags run on every feature row that validates on its own, so one bad row cannot blank them.
  const rawFeatures = Array.isArray(truth['features.json']) ? truth['features.json'] : [];
  const rawRoadmap = Array.isArray(truth['roadmap.json']) ? truth['roadmap.json'] : [];
  const validFeatures = rawFeatures.filter((row) => schema.FeatureSchema.safeParse(row).success);
  const lanes = checkLanes(schema, truth, validFeatures, rawRoadmap);
  findings.push(...lanes.findings.map((f) => ({ level: 'error', ...f })));

  let tags = { distinct: 0, skipped: false, rowsNotChecked: rawFeatures.length - validFeatures.length };
  if (!tagExists) {
    tags.skipped = true;
  } else {
    const t = await checkTags(schema, validFeatures, tagExists);
    findings.push(...t.findings.map((f) => ({ level: 'error', ...f })));
    tags = { ...tags, distinct: t.distinct };
  }

  const safetySkipped = safetyPatterns.length === 0;
  if (!safetySkipped) findings.push(...checkPublicSafety(safetyFiles, safetyPatterns));
  const glossary = checkGlossary(truth, parsed, glossaryFiles, contentLint);
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
  return {
    findings,
    errors: findings.filter((f) => f.level !== 'warn'),
    warnings: findings.filter((f) => f.level === 'warn'),
    notRun,
    counts,
    laneCounts: lanes.laneCounts,
    tags,
    safety: { skipped: safetySkipped, patterns: safetyPatterns.length, files: safetyFiles.length },
    glossaryScan: { terms: glossary.terms, files: glossaryFiles.length },
    haveTiersFile: 'tiers.json' in truth,
  };
}

function report(result, { offline }) {
  const { findings, errors, warnings, notRun, counts, laneCounts, tags, safety, glossaryScan } = result;
  const lines = [];
  lines.push(`Truth: ${counts.features} features (${counts.released} shipped or beta), ${counts.glossary} glossary terms, ${counts.roadmap} roadmap cards, ${counts.engines} engines, ${counts.tiers} tiers${result.haveTiersFile ? '' : ' (no tiers file yet, so there are no tier refs to resolve)'}`);
  const lc = Object.keys(laneCounts).length ? Object.entries(laneCounts).map(([k, v]) => `${k} ${v}`).join(', ') : 'none';
  lines.push(`Roadmap lanes (derived from status): ${lc}`);
  lines.push(`Scanned ${safety.files} file(s) under ${SAFETY_SCAN_DIRS.join(', ')}; checked ${glossaryScan.files} file(s) under ${GLOSSARY_SCAN_DIRS.join(', ')} for ${glossaryScan.terms} glossary avoid[] term(s)`);
  lines.push('');
  for (const check of CHECKS) {
    const errs = findings.filter((f) => f.check === check && f.level !== 'warn');
    const warns = findings.filter((f) => f.check === check && f.level === 'warn');
    let state = errs.length === 0 ? (warns.length === 0 ? 'PASS' : `WARN (${warns.length}, not blocking)`) : `FAIL (${errs.length}${warns.length ? `, plus ${warns.length} warning(s)` : ''})`;
    if (notRun[check] && errs.length === 0) state = `NOT RUN (${notRun[check]})`;
    if (check === 'tags') {
      const unchecked = tags.rowsNotChecked > 0 ? `; ${tags.rowsNotChecked} row(s) not checked because they failed validation` : '';
      state = tags.skipped ? 'SKIPPED (--offline: release refs NOT verified)' : errs.length === 0 ? (tags.rowsNotChecked > 0 ? `INCOMPLETE (${tags.distinct} distinct release refs exist${unchecked})` : `PASS (${tags.distinct} distinct release refs exist)`) : `FAIL (${errs.length} of ${tags.distinct} release refs${unchecked})`;
    }
    if (check === 'public-safety') {
      if (safety.skipped) state = `SKIPPED (${SAFETY_ENV} is empty or not set: nothing was scanned)`;
      else if (errs.length === 0) state = `PASS (${safety.patterns} pattern(s))`;
    }
    lines.push(`  ${check.padEnd(14)} ${state}`);
  }
  if (safety.skipped) {
    lines.push('');
    lines.push(`WARNING: ${SAFETY_ENV} is empty or not set, so the public-safety scan did NOT run. In CI it is supplied from the repository secret of the same name.`);
  }
  for (const [label, group] of [['errors', errors], ['warnings', warnings]]) {
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`${label.toUpperCase()}${label === 'warnings' ? ' (do not fail the run)' : ''}`);
    for (const check of CHECKS) {
      const mine = group.filter((f) => f.check === check);
      if (mine.length === 0) continue;
      lines.push(`[${check}]`);
      for (const f of mine) lines.push(`  ${f.where}  ${f.message}`);
    }
  }
  lines.push('');
  const tail = [];
  if (offline) tail.push('tags not verified');
  if (safety.skipped) tail.push('public-safety scan skipped');
  if (warnings.length > 0) tail.push(`${warnings.length} warning(s)`);
  const extra = tail.length ? ` (${tail.join('; ')})` : '';
  lines.push(errors.length === 0 ? `verify-truth: OK${extra}` : `verify-truth: FAILED, ${errors.length} error(s)${extra}`);
  return lines.join('\n');
}

// ───────────────────────────── self-test ─────────────────────────────

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Test pattern set: a plain pattern and a /source/flags pattern. Synthetic, so it names nothing real. */
const TEST_PATTERN_TEXT = ['\\bSEEDED-INTERNAL-\\d+\\b', '/\\bseeded-flagged-term\\b/i'].join('\n');

/**
 * Seeded violations, run in memory with no network, then a few end-to-end runs of this script as
 * a child process (so the TRUTH_SAFETY_PATTERNS handoff and the exit codes are exercised too).
 * The baseline is the REAL truth data plus synthetic clean content, so the self-test proves each
 * check independent of what src/content and src/pages say today. Each case must fire exactly the
 * checks (and levels) it expects. The real TRUTH_SAFETY_PATTERNS is never used here.
 */
async function selfTest(schema, root) {
  const { data: truth0, errors } = loadTruth(root);
  if (errors.length) {
    console.error('self-test: the real truth files do not load:\n' + errors.map((e) => `  ${e.where}  ${e.message}`).join('\n'));
    return 1;
  }
  const testPatterns = parseSafetyPatterns(TEST_PATTERN_TEXT);
  const clean = [{ file: 'src/content/docs/clean.mdx', text: 'Plain prose that names no forbidden or avoided term.\n' }];
  const okTags = async () => ({ ok: true });
  const stubTags = async (ref) => (ref.version === '9.9.9' ? { ok: false, reason: 'missing' } : { ok: true });
  const firstReleased = truth0['features.json'].find((f) => f.status === 'shipped');
  // Any row that has not released (in-progress, next or exploring). Do not assume one is in-progress: once the last
  // in-progress row ships, none may be left.
  const firstUnreleased = truth0['features.json'].find((f) => f.status !== 'shipped' && f.status !== 'beta');
  const roadmapShipped = truth0['roadmap.json'].find((r) => {
    const f = truth0['features.json'].find((x) => x.id === r.feature_id);
    return f && f.status === 'shipped';
  });
  const avoidTerm = truth0['glossary.json'].flatMap((g) => g.avoid)[0];
  const aTier = (over) => ({ id: 'team', price: 20, price_monthly: 25, billing_period: 'annual', unit: 'member', addons: [], includes: [], coming: [], prerequisites: [], availability: 'early-access', cta: { kind: 'contact', label: 'Talk to us', href: '/contact/' }, ...over });
  const seed = (file, text) => (f) => f.concat({ file, text });
  // The personal tier in a mutable copy of the truth data. Its cases need the real tiers.json to carry one.
  const personalOf = (t) => t['tiers.json'].find((x) => x.id === 'personal');
  const hasPersonal = !!(truth0['tiers.json'] || []).find((x) => x.id === 'personal');

  // Each case: expect = checks that must fire (as errors unless `warnOnly`); mutate edits a copy of the truth data;
  // safety / glossary edit the scanned file lists; patterns overrides the pattern set; contentLint sets the mode.
  const cases = [
    { name: 'control: real truth data, clean content, every tag exists', expect: [] },
    { name: 'shipped row with no `since`', expect: ['schema'], mutate: (t) => { delete t['features.json'].find((f) => f.id === firstReleased.id).since; } },
    { name: 'shipped row whose release tag does not exist (9.9.9)', expect: ['tags'], stub: true, mutate: (t) => { const f = t['features.json'].find((x) => x.id === firstReleased.id); f.since = '9.9.9'; f.ref_public = 'https://github.com/ikenga-hq/ikenga/releases/tag/v9.9.9'; } },
    { name: 'one invalid row does not blank the tags check: a bad row plus a missing tag elsewhere fires both', expect: ['schema', 'tags'], stub: true, mutate: (t) => { const rows = t['features.json'].filter((x) => x.status === 'shipped'); delete rows[0].since; const g = rows.find((x) => x.ref_public.includes('github.com/ikenga-hq/ikenga/releases') && x.id !== rows[0].id); g.since = '9.9.9'; g.ref_public = 'https://github.com/ikenga-hq/ikenga/releases/tag/v9.9.9'; } },
    { name: 'shipped row linking a PR instead of a release', expect: ['schema'], mutate: (t) => { t['features.json'].find((f) => f.id === firstReleased.id).ref_public = 'https://github.com/ikenga-hq/ikenga/pull/1'; } },
    { name: 'stored `lane` on a roadmap card', expect: ['lanes'], mutate: (t) => { t['roadmap.json'][0].lane = 'shipped'; } },
    { name: '"notify me" on a card for a shipped feature', expect: ['lanes'], skip: !roadmapShipped, mutate: (t) => { t['roadmap.json'].find((r) => r.feature_id === roadmapShipped.feature_id).notify = true; } },
    { name: 'roadmap card for an unknown feature id', expect: ['refs'], mutate: (t) => { t['roadmap.json'].push({ feature_id: 'nope.missing', public_label: 'Nope', notify: false }); } },
    { name: 'tier includes an unknown feature id', expect: ['tiers'], mutate: (t) => { t['tiers.json'] = [aTier({ includes: ['nope.missing'] })]; } },
    { name: 'tier includes a feature that has not released', expect: ['tiers'], mutate: (t) => { t['tiers.json'] = [aTier({ includes: [firstUnreleased.id] })]; } },
    { name: 'tier lists a released feature under coming', expect: ['tiers'], mutate: (t) => { t['tiers.json'] = [aTier({ coming: [firstReleased.id] })]; } },
    { name: 'valid tier refs pass', expect: [], mutate: (t) => { t['tiers.json'] = [aTier({ includes: [firstReleased.id], coming: [firstUnreleased.id] })]; } },
    { name: 'tiers: the older shape (no personal tier, add-ons without size, spec, members or regions) still passes', expect: [], mutate: (t) => { t['tiers.json'] = [aTier({ id: 'enterprise', price: 40, price_monthly: undefined, min_members: 5, addons: [{ id: 'managed-instance', price: 150, unit: 'org', prerequisites: ['managed-ops'] }] })]; } },
    { name: 'tiers: a paid tier that lacks a feature the free tier includes', expect: ['tiers'], mutate: (t) => { t['tiers.json'] = [aTier({ id: 'free', price: 0, price_monthly: undefined, billing_period: undefined, unit: undefined, includes: [firstReleased.id] }), aTier({ includes: [] })]; } },
    { name: 'tiers: the personal tier with no personal plan', expect: ['schema'], skip: !hasPersonal, mutate: (t) => { delete personalOf(t).personal; } },
    { name: 'tiers: a personal plan on a tier that is not personal', expect: ['schema'], skip: !hasPersonal, mutate: (t) => { t['tiers.json'].find((x) => x.id === 'team').personal = clone(personalOf(t).personal); } },
    { name: 'tiers: a personal price that is not the lowest size price', expect: ['schema'], skip: !hasPersonal, mutate: (t) => { personalOf(t).price += 1; } },
    { name: 'tiers: a personal size priced in a region that is quote-only', expect: ['schema'], skip: !hasPersonal, mutate: (t) => { const p = personalOf(t).personal; const q = p.regions.find((r) => r.pricing === 'quote'); p.sizes[0].prices.push({ region: q.id, price: 99 }); } },
    { name: 'tiers: a personal size priced in an unknown region', expect: ['schema'], skip: !hasPersonal, mutate: (t) => { personalOf(t).personal.sizes[0].prices[0].region = 'nowhere'; } },
    { name: 'tiers: a personal price range whose top is not above its bottom', expect: ['schema'], skip: !hasPersonal, mutate: (t) => { const x = personalOf(t).personal.sizes[0].prices[0]; x.price_max = x.price; } },
    { name: 'tiers: an add-on region at list price with no published price', expect: ['schema'], mutate: (t) => { t['tiers.json'] = [aTier({ id: 'enterprise', price_monthly: undefined, addons: [{ id: 'managed-instance-small', price: null, unit: 'org', regions: [{ id: 'eu', label: 'EU', pricing: 'list' }] }] })]; } },
    { name: 'tiers: an add-on with the same region twice', expect: ['schema'], mutate: (t) => { t['tiers.json'] = [aTier({ id: 'enterprise', price_monthly: undefined, addons: [{ id: 'managed-instance-small', price: 150, unit: 'org', regions: [{ id: 'eu', label: 'EU', pricing: 'list' }, { id: 'eu', label: 'EU again', pricing: 'list' }] }] })]; } },
    { name: 'tiers: an add-on spec with a fractional vCPU count', expect: ['schema'], mutate: (t) => { t['tiers.json'] = [aTier({ id: 'enterprise', price_monthly: undefined, addons: [{ id: 'managed-instance-small', price: 150, unit: 'org', spec: { ram_gb: 8, vcpu: 2.5, disk_gb: 80 } }] })]; } },
    { name: 'public safety: seeded internal id in a truth row', expect: ['public-safety'], files: seed('src/data/truth/features.json', '  "limits": ["Waits on SEEDED-INTERNAL-42."]\n') },
    { name: 'public safety: seeded id in an extra file of src/data/truth (every file is scanned, not only the named ones)', expect: ['public-safety'], files: seed('src/data/truth/notes.txt', 'SEEDED-INTERNAL-7\n') },
    { name: 'public safety: seeded id in src/lib/truth', expect: ['public-safety'], files: seed('src/lib/truth/helper.ts', '// see SEEDED-INTERNAL-9\n') },
    { name: 'public safety: seeded id in src/content', expect: ['public-safety'], files: seed('src/content/docs/seed.mdx', 'Tracked as SEEDED-INTERNAL-12.\n') },
    { name: 'public safety: seeded id in src/pages, in a code comment', expect: ['public-safety'], files: seed('src/pages/seed.astro', '<!-- SEEDED-INTERNAL-3 -->\n') },
    { name: 'public safety: a /source/flags pattern matches case-insensitively', expect: ['public-safety'], files: seed('src/content/docs/seed.mdx', 'This mentions Seeded-Flagged-Term in prose.\n') },
    { name: 'public safety: a near miss ("SEEDED-INTERNAL-" with no number) is not a hit', expect: [], files: seed('src/content/docs/seed.mdx', 'SEEDED-INTERNAL- is not a full id.\n') },
    { name: 'public safety: no patterns means skipped (a warning, no findings), even with a seeded id present', expect: [], patterns: [], skippedSafety: true, files: seed('src/content/docs/seed.mdx', 'Tracked as SEEDED-INTERNAL-12.\n') },
    { name: 'glossary: avoid[] term in src/pages is an error by default', expect: ['glossary'], files: seed('src/pages/seed.astro', `<p>Open the ${avoidTerm} now.</p>\n`) },
    { name: 'glossary: the same hit is only a warning with --content-lint=warn', expect: ['glossary'], warnOnly: true, contentLint: 'warn', files: seed('src/content/docs/seed.mdx', `Use the ${avoidTerm}.\n`) },
    { name: 'glossary: avoid[] term in a truth row is an error even with --content-lint=warn', expect: ['glossary'], contentLint: 'warn', mutate: (t) => { t['features.json'][0].plain_name = `The ${avoidTerm}`; } },
    { name: 'glossary: a word that merely contains an avoid term is not a hit', expect: [], files: seed('src/content/docs/seed.mdx', `Words like ${avoidTerm}ling and x${avoidTerm} are fine.\n`) },
  ].filter((c) => !c.skip);

  let bad = 0;
  const say = (pass, name, verdict) => console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name} -> ${verdict}`);
  for (const c of cases) {
    const truth = clone(truth0);
    if (c.mutate) c.mutate(truth);
    const scanned = c.files ? c.files(clean.slice()) : clean;
    const r = await verify(schema, {
      truth,
      safetyFiles: scanned,
      glossaryFiles: scanned.filter((f) => f.file.startsWith('src/content/') || f.file.startsWith('src/pages/')),
      tagExists: c.stub ? stubTags : okTags,
      safetyPatterns: c.patterns ?? testPatterns,
      contentLint: c.contentLint ?? 'error',
    });
    const group = c.warnOnly ? r.warnings : r.errors;
    const fired = [...new Set(group.map((f) => f.check))];
    const missing = c.expect.filter((e) => !fired.includes(e));
    const extra = fired.filter((e) => !c.expect.includes(e));
    const wrongLevel = c.warnOnly ? r.errors.length > 0 : c.expect.length === 0 ? r.warnings.length > 0 : false;
    const skipOk = c.skippedSafety === undefined || r.safety.skipped === c.skippedSafety;
    const pass = missing.length === 0 && extra.length === 0 && !wrongLevel && skipOk;
    if (!pass) bad++;
    const verdict = r.errors.length === 0 ? (r.warnings.length ? `green with ${r.warnings.length} warning(s)` : 'green') : `red (${[...new Set(r.errors.map((f) => f.check))].join(', ')})`;
    say(pass, c.name, verdict);
    if (!pass) for (const f of group.slice(0, 5)) console.log(`         ${f.check} ${f.where}  ${f.message}`);
  }

  // Pattern parsing: invalid input names the line, never the pattern.
  const parseCases = [
    { name: 'pattern list: comments, blanks and CRLF line ends are handled', run: () => parseSafetyPatterns('# note\r\n\r\n\\bA-\\d+\r\n/b-\\d/i\r\n').length === 2 },
    { name: 'pattern list: an invalid regex fails with the line number and without echoing the pattern', run: () => { try { parseSafetyPatterns('ok-\\d\n(unclosed-group'); return false; } catch (e) { return e instanceof UsageError && e.message.includes('line 2') && !e.message.includes('unclosed-group'); } } },
    { name: 'pattern list: an unsupported flag fails with the line number', run: () => { try { parseSafetyPatterns('/abc/g'); return false; } catch (e) { return e instanceof UsageError && e.message.includes('line 1'); } } },
    { name: 'arguments: an unknown FIRST flag is an error', run: () => { try { parseArgs(['--bogus']); return false; } catch (e) { return e instanceof UsageError; } } },
    { name: 'arguments: an unknown flag after valid ones is an error', run: () => { try { parseArgs(['--offline', '--bogus']); return false; } catch (e) { return e instanceof UsageError; } } },
    { name: 'arguments: a bad --content-lint value is an error', run: () => { try { parseArgs(['--content-lint=maybe']); return false; } catch (e) { return e instanceof UsageError; } } },
    { name: 'arguments: valid flags parse', run: () => { const o = parseArgs(['--offline', '--content-lint=warn', '--root', '.']); return o.offline && o.contentLint === 'warn'; } },
  ];
  for (const c of parseCases) {
    let pass = false;
    try { pass = c.run(); } catch { pass = false; }
    if (!pass) bad++;
    say(pass, c.name, pass ? 'as expected' : 'unexpected');
  }

  // End to end: run this script as a child process with a temporary tree and the test patterns in the env var.
  const tmp = mkdtempSync(path.join(tmpdir(), 'verify-truth-'));
  try {
    mkdirSync(path.join(tmp, 'src/data/truth'), { recursive: true });
    mkdirSync(path.join(tmp, 'src/content/docs'), { recursive: true });
    mkdirSync(path.join(tmp, 'src/pages'), { recursive: true });
    for (const n of [...REQUIRED_FILES, ...OPTIONAL_FILES]) {
      const from = path.join(root, 'src/data/truth', n);
      if (existsSync(from)) copyFileSync(from, path.join(tmp, 'src/data/truth', n));
    }
    const seededFile = path.join(tmp, 'src/content/docs/seed.mdx');
    const run = (args, envValue) => {
      const env = { ...process.env, [SAFETY_ENV]: envValue };
      const r = spawnSync(process.execPath, [SCRIPT_FILE, '--offline', '--root', tmp, ...args], { env, encoding: 'utf8', timeout: 120000 });
      return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
    };
    const e2e = [
      { name: 'end to end: clean tree, test patterns in the env var -> exit 0', setup: () => writeFileSync(seededFile, 'Nothing special here.\n'), args: [], env: TEST_PATTERN_TEXT, check: (r) => r.code === 0 && /public-safety\s+PASS/.test(r.out) },
      { name: 'end to end: seeded internal id, patterns in the env var -> exit 1, finding names the file and line but not the pattern or the text', setup: () => writeFileSync(seededFile, 'Line one.\nTracked as SEEDED-INTERNAL-42.\n'), args: [], env: TEST_PATTERN_TEXT, check: (r) => r.code === 1 && /seed\.mdx:2/.test(r.out) && /public-safety\s+FAIL/.test(r.out) && !r.out.includes('SEEDED-INTERNAL') && !r.out.includes('\\bSEEDED') },
      { name: 'end to end: same seeded tree, env var empty -> exit 0 with a skip warning', setup: () => {}, args: [], env: '', check: (r) => r.code === 0 && /SKIPPED/.test(r.out) && /WARNING/.test(r.out) },
      { name: 'end to end: same seeded tree, env var empty, --require-safety-patterns -> exit 1', setup: () => {}, args: ['--require-safety-patterns'], env: '', check: (r) => r.code === 1 },
      { name: 'end to end: an invalid pattern in the env var -> exit 2 naming the line', setup: () => {}, args: [], env: 'fine\n(broken', check: (r) => r.code === 2 && /line 2/.test(r.out) && !r.out.includes('(broken') },
      { name: 'end to end: an unknown first flag -> exit 2', setup: () => {}, args: ['--nope'], env: '', check: (r) => r.code === 2 },
      { name: `end to end: an avoided term in a page -> exit 1 by default`, setup: () => writeFileSync(seededFile, `Use the ${avoidTerm}.\n`), args: [], env: '', check: (r) => r.code === 1 && /glossary\s+FAIL/.test(r.out) },
      { name: `end to end: the same page with --content-lint=warn -> exit 0 and a warning`, setup: () => {}, args: ['--content-lint=warn'], env: '', check: (r) => r.code === 0 && /glossary\s+WARN/.test(r.out) },
    ];
    for (const c of e2e) {
      c.setup();
      const r = run(c.args, c.env);
      const pass = c.check(r);
      if (!pass) bad++;
      say(pass, c.name, `exit ${r.code}`);
      if (!pass) console.log(r.out.split('\n').slice(0, 14).map((l) => `         ${l}`).join('\n'));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const total = cases.length + parseCases.length + 8;
  console.log(bad === 0 ? `\nverify-truth self-test: ${total} cases ok` : `\nverify-truth self-test: ${bad} of ${total} cases FAILED`);
  return bad === 0 ? 0 : 1;
}

// ───────────────────────────── main ─────────────────────────────

function annotate(result, safetySkipped) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  if (safetySkipped) console.log(`::warning title=Public-safety scan skipped::${SAFETY_ENV} is empty or not set, so nothing was scanned.`);
  if (result.warnings.length > 0) console.log(`::warning title=Glossary terms::${result.warnings.length} avoided term(s) found in src/content or src/pages. They do not fail CI yet.`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`verify-truth: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const schema = await loadSchema();
  if (opts.selfTest) return selfTest(schema, opts.root);

  let safetyPatterns;
  try {
    safetyPatterns = parseSafetyPatterns(process.env[SAFETY_ENV] || '');
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`verify-truth: ${err.message}`);
    return 2;
  }
  if (safetyPatterns.length === 0 && opts.requireSafety) {
    console.error(`verify-truth: ${SAFETY_ENV} is empty or not set, and --require-safety-patterns was given`);
    return 1;
  }

  const { data, errors } = loadTruth(opts.root);
  const safetyFiles = loadFiles(opts.root, SAFETY_SCAN_DIRS);
  const result = await verify(schema, {
    truth: data,
    loadErrors: errors,
    safetyFiles,
    glossaryFiles: safetyFiles.filter((f) => GLOSSARY_SCAN_DIRS.some((d) => f.file.startsWith(`${d}/`))),
    tagExists: opts.offline ? null : makeNetworkTagChecker(),
    safetyPatterns,
    contentLint: opts.contentLint,
  });
  console.log(report(result, { offline: opts.offline }));
  annotate(result, result.safety.skipped);
  return result.errors.length === 0 ? 0 : 1;
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
