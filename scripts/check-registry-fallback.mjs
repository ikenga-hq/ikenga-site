#!/usr/bin/env node
/**
 * check-registry-fallback.mjs: fail the build when the package catalog silently went stale.
 *
 * The /packages page is generated at build time from the live package registry. If the registry
 * cannot be fetched, the build is allowed to fall back to the committed snapshot in
 * src/data/registry-snapshot.json, so a registry outage never blocks a deploy. That fallback is
 * only acceptable when the registry really is down. If the registry answers and the build still used
 * the snapshot, the catalog on the site is stale for no reason (a wrong URL, a bad timeout, a
 * forced fallback left switched on), and nobody would see it.
 *
 * This script looks for two signs that a build used the snapshot:
 *   - the build log has a `[registry]` line that mentions the snapshot or a fallback, and
 *   - a built page shows the visible label "from committed snapshot".
 * If it finds either, it asks the registry for its index (the URL the loader uses, the
 * IKENGA_REGISTRY_URL override if set, and the public address https://registry.ikenga.dev/index.json).
 *
 *   no sign of the snapshot               pass: the catalog was built from live data
 *   snapshot used, registry answers       FAIL: the build should have used live data
 *   snapshot used, registry unreachable   pass with a warning: the fallback did its job
 *
 * Usage
 *   node scripts/check-registry-fallback.mjs --log <file>
 *                                          check a saved build log (and the pages in dist/).
 *                                          In CI: pnpm build 2>&1 | tee build.log
 *   node scripts/check-registry-fallback.mjs [--dist <dir>]
 *                                          check the built pages only (no log)
 *   node scripts/check-registry-fallback.mjs --registry-url <url> [--registry-url <url> ...]
 *                                          probe only these URLs instead of the defaults
 *   node scripts/check-registry-fallback.mjs --self-test
 *                                          prove the check goes red on a seeded fallback and green
 *                                          on live data. Needs no build and no network.
 *
 * Exit status: 0 pass, 1 the snapshot was used while the registry was reachable, 2 usage or load error.
 */

import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './lib/pages-routes.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const PUBLIC_REGISTRY = 'https://registry.ikenga.dev/index.json';
const SNAPSHOT_LABEL = 'from committed snapshot';
const USAGE =
  'Usage: node scripts/check-registry-fallback.mjs [--log <file>] [--dist <dir>] [--registry-url <url> ...] [--self-test]\n' +
  'See the header of this file for what the check does.';

function parseArgs(argv) {
  const opts = { log: null, dist: path.join(ROOT, 'dist'), urls: [], selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--log') opts.log = path.resolve(value());
    else if (arg === '--dist') opts.dist = path.resolve(value());
    else if (arg === '--registry-url') opts.urls.push(value());
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

/** The build log without colour codes. */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Log lines that say the build used the snapshot. */
function fallbackLines(logText) {
  return stripAnsi(logText)
    .split(/\r?\n/)
    .filter((line) => /\[registry\]/i.test(line) && /\b(?:snapshot|fallback)\b/i.test(line))
    .map((line) => line.trim());
}

/** Built pages that show the snapshot label. */
function labelledPages(distDir) {
  const found = [];
  for (const rel of walkFiles(distDir)) {
    if (rel.endsWith('.html') && readFileSync(path.join(distDir, rel), 'utf8').includes(SNAPSHOT_LABEL)) found.push(rel);
  }
  return found.sort();
}

/** The registry URL the loader is written to use, read from src/lib/registry.ts. */
function loaderUrl(root) {
  const file = path.join(root, 'src/lib/registry.ts');
  if (!existsSync(file)) return null;
  const m = /\bREGISTRY_URL\s*=\s*['"](https?:\/\/[^'"]+)['"]/.exec(readFileSync(file, 'utf8'));
  return m ? m[1] : null;
}

/** Ask for a registry index. Reachable means a 200 with a non-empty `pkgs` list, within two tries. */
async function probe(url, timeoutMs = 10000) {
  let detail = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'ikenga-site-registry-check' } });
      if (!res.ok) {
        detail = `answered ${res.status}`;
        continue;
      }
      const body = await res.json();
      if (Array.isArray(body?.pkgs) && body.pkgs.length > 0) return { url, reachable: true, detail: `${body.pkgs.length} pkgs` };
      detail = 'answered 200 but the index is empty or malformed';
    } catch (err) {
      detail = `${err?.cause?.code ?? err?.cause?.errors?.[0]?.code ?? err?.name ?? 'error'}`;
    }
  }
  return { url, reachable: false, detail };
}

/**
 * The verdict. `lines` and `pages` are the signs of a fallback; `probes` are the registry answers.
 * Returns `{ code, level, message }`.
 */
function decide({ lines, pages, probes }) {
  if (lines.length === 0 && pages.length === 0) {
    return { code: 0, level: 'ok', message: 'no sign of the snapshot: the catalog was built from live registry data.' };
  }
  const up = probes.filter((p) => p.reachable);
  if (up.length > 0) {
    return {
      code: 1,
      level: 'error',
      message:
        `the build used the committed snapshot, but the registry answers (${up.map((p) => p.url).join(', ')}).\n` +
        '  The catalog on the site would be stale for no reason. Check the registry URL in src/lib/registry.ts,\n' +
        '  the fetch timeout, and that IKENGA_REGISTRY_FALLBACK is not set. If the registry changed address,\n' +
        '  refresh src/data/registry-snapshot.json too.',
    };
  }
  return {
    code: 0,
    level: 'warn',
    message: 'the build used the committed snapshot and the registry did not answer from here, so the fallback did its job. The catalog may be stale; rebuild when the registry is back.',
  };
}

async function main(opts) {
  let lines = [];
  if (opts.log) {
    if (!existsSync(opts.log)) {
      console.error(`check-registry-fallback: no build log at ${opts.log}`);
      return 2;
    }
    lines = fallbackLines(readFileSync(opts.log, 'utf8'));
  }
  if (!existsSync(opts.dist)) {
    console.error(`check-registry-fallback: no build output at ${opts.dist}. Run "pnpm build" first.`);
    return 2;
  }
  const pages = labelledPages(opts.dist);

  console.log(`check-registry-fallback: ${opts.log ? 'build log and ' : ''}built pages`);
  for (const line of lines) console.log(`  build log: ${line}`);
  for (const page of pages) console.log(`  page shows "${SNAPSHOT_LABEL}": ${page}`);

  let probes = [];
  if (lines.length > 0 || pages.length > 0) {
    const urls = opts.urls.length > 0 ? opts.urls : [...new Set([process.env.IKENGA_REGISTRY_URL, loaderUrl(ROOT), PUBLIC_REGISTRY].filter(Boolean))];
    probes = await Promise.all(urls.map((url) => probe(url)));
    for (const p of probes) console.log(`  registry ${p.reachable ? 'answers' : 'does not answer'}: ${p.url} (${p.detail})`);
  }

  const verdict = decide({ lines, pages, probes });
  if (verdict.level === 'error') {
    console.error(`\ncheck-registry-fallback: FAILED. ${verdict.message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Registry snapshot used while the registry is up::${verdict.message.split('\n')[0]}`);
  } else if (verdict.level === 'warn') {
    console.log(`\ncheck-registry-fallback: warning. ${verdict.message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Registry snapshot used::${verdict.message}`);
  } else {
    console.log(`\ncheck-registry-fallback: ${verdict.message}`);
  }
  return verdict.code;
}

// ───────────────────────────── self-test ─────────────────────────────

async function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'registry-check-'));
  let total = 0;
  let bad = 0;
  const expect = (name, passed, detail = '') => {
    total += 1;
    if (!passed) bad += 1;
    console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${name}${passed || !detail ? '' : `: ${detail}`}`);
  };
  const up = { url: 'https://registry.example/index.json', reachable: true, detail: '9 pkgs' };
  const down = { url: 'https://registry.example/index.json', reachable: false, detail: 'ENOTFOUND' };

  try {
    console.log('reading signs of a fallback');
    const liveLog = '\u001b[34m[registry]\u001b[39m live: 9 pkgs (updatedAt 2026-10-01T00:00:00Z) from https://registry.example/index.json\nbuild complete';
    const warnLog = '[registry] WARNING: live registry unavailable (fetch failed) - building from the COMMITTED SNAPSHOT asOf 2026-07-04T22:35:17Z, 90 days old (9 pkgs).';
    const coloured = '\u001b[33m[registry] WARNING: using the fallback copy\u001b[39m';
    expect('a live log has no fallback lines', fallbackLines(liveLog).length === 0);
    expect('a warning line is found', fallbackLines(warnLog).length === 1);
    expect('colour codes do not hide it', fallbackLines(coloured).length === 1);
    expect('other lines that say "snapshot" are ignored', fallbackLines('captured a snapshot of the page\nmcp-browser snapshot tool').length === 0);

    mkdirSync(path.join(dir, 'live/packages'), { recursive: true });
    mkdirSync(path.join(dir, 'stale/packages'), { recursive: true });
    writeFileSync(path.join(dir, 'live/packages/index.html'), '<p>Last published July 4, 2026 · install commands</p>');
    writeFileSync(path.join(dir, 'stale/packages/index.html'), `<p>Last published July 4, 2026 · ${SNAPSHOT_LABEL} · install commands</p>`);
    expect('a live page has no label', labelledPages(path.join(dir, 'live')).length === 0);
    expect('a page with the label is found', labelledPages(path.join(dir, 'stale')).join() === 'packages/index.html');

    console.log('the verdict');
    expect('green: live data', decide({ lines: [], pages: [], probes: [up] }).code === 0);
    expect('red:   snapshot in the log, registry answers', decide({ lines: ['x'], pages: [], probes: [up] }).code === 1);
    expect('red:   snapshot label on a page, registry answers', decide({ lines: [], pages: ['packages/index.html'], probes: [up] }).code === 1);
    expect('red:   one of several probes answers', decide({ lines: ['x'], pages: [], probes: [down, up] }).code === 1);
    expect('green with a warning: snapshot used, registry down', (() => { const v = decide({ lines: ['x'], pages: [], probes: [down] }); return v.code === 0 && v.level === 'warn'; })());

    console.log('probing a registry');
    const server = createServer((req, res) => {
      if (req.url === '/index.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ pkgs: [{ name: 'a' }] }));
      } else if (req.url === '/empty.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ pkgs: [] }));
      } else {
        res.writeHead(404);
        res.end('x');
      }
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    let closedPort;
    try {
      closedPort = server.address().port;
      const base = `http://127.0.0.1:${closedPort}`;
      expect('a good index is reachable', (await probe(`${base}/index.json`, 3000)).reachable === true);
      expect('a 404 is not', (await probe(`${base}/gone.json`, 3000)).reachable === false);
      expect('an empty index is not', (await probe(`${base}/empty.json`, 3000)).reachable === false);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    // The port the server just used is now closed, so nothing answers on it.
    expect('a closed port is not', (await probe(`http://127.0.0.1:${closedPort}/index.json`, 3000)).reachable === false);

    console.log('the real loader');
    const url = loaderUrl(ROOT);
    expect('the loader URL can be read from src/lib/registry.ts', typeof url === 'string' && /^https:\/\//.test(url), String(url));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(bad === 0 ? `\ncheck-registry-fallback self-test: ${total} cases ok` : `\ncheck-registry-fallback self-test: ${bad} of ${total} cases FAILED`);
  return bad === 0 ? 0 : 1;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`check-registry-fallback: ${err.message}\n${USAGE}`);
  process.exit(2);
}
try {
  // Set the exit code and let the process end by itself. Calling process.exit() while sockets are
  // still closing can crash Node on Windows.
  process.exitCode = opts.selfTest ? await selfTest() : await main(opts);
} catch (err) {
  console.error(`check-registry-fallback: ${err.message}`);
  process.exitCode = 2;
}
