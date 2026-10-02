#!/usr/bin/env node
/**
 * check-links.mjs: find broken links and broken #anchors in the built site.
 *
 * It reads every HTML page in dist/ and checks each link and file reference: `a`, `area`, `link`,
 * `script`, `img`, `source`, `iframe`, `video`, `audio`, `form` and the social preview image. A link
 * to this site is checked against the build the way Cloudflare Pages would answer it (see
 * lib/pages-routes.mjs), so a link to a page that is gone, a missing file, or a `#section` that is
 * not on the target page is an error. Text inside inline scripts, styles and HTML comments is not
 * scanned.
 *
 *   error     a link that does not end on a 200, or a #anchor with no matching id on the page
 *   warning   an internal link that works only through a redirect (for example `/packages` where
 *             the page lives at `/packages/`). Use --strict-redirects to make these errors.
 *
 * Links to other sites are not checked by default, so a PR never fails because someone else's
 * server is slow. Add --external to check them too: a 404, a 410 or a host that does not exist is
 * an error; a timeout, a 403, a 429 or a 5xx is only a warning, and a permanent redirect is a
 * warning that names the new address.
 *
 * Known broken links. scripts/known-broken-links.txt lists links that are broken today and are
 * waiting for a fix. They are reported but do not fail the run, so the check can be switched on
 * without hiding anything new. The list can only shrink: a listed link that now works is an error
 * ("stale entry"), which forces the line to be deleted. Fix a link; do not add it to the list.
 *
 * Usage
 *   node scripts/check-links.mjs                      check the build in dist/ (run `pnpm build`)
 *   node scripts/check-links.mjs --external           also check links to other sites (network)
 *   node scripts/check-links.mjs --strict-redirects   treat links that rely on a redirect as errors
 *   node scripts/check-links.mjs --no-known           ignore known-broken-links.txt: report every
 *                                                     broken link as an error
 *   node scripts/check-links.mjs --dist <dir>         check another build folder
 *   node scripts/check-links.mjs --self-test          prove the checker goes red on seeded broken
 *                                                     links and green on good ones. Needs no build
 *                                                     and no network.
 *
 * Exit status: 0 no errors, 1 at least one error, 2 usage or load error.
 *
 * The site address comes from `site` in astro.config.mjs, so a link written as
 * https://ikenga.dev/... is checked as an internal link.
 */

import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalResolver, follow, walkFiles } from './lib/pages-routes.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const USAGE =
  'Usage: node scripts/check-links.mjs [--dist <dir>] [--external] [--strict-redirects] [--no-known] [--self-test]\n' +
  'See the header of this file for what the checker does.';

function parseArgs(argv) {
  const opts = { dist: path.join(ROOT, 'dist'), external: false, strictRedirects: false, useKnown: true, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--external') opts.external = true;
    else if (arg === '--strict-redirects') opts.strictRedirects = true;
    else if (arg === '--no-known') opts.useKnown = false;
    else if (arg === '--dist') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error('--dist needs a value');
      opts.dist = path.resolve(next);
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

// ───────────────────────────── reading HTML ─────────────────────────────

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&lt;': '<', '&gt;': '>' };
const decode = (text) => text.replace(/&(?:amp|quot|lt|gt|#39|#x27);/g, (m) => ENTITIES[m]);

/** The HTML with comments and the bodies of inline scripts and styles removed. */
function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2');
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Every URL reference in a page, as `{ tag, attr, url }`. */
function collectReferences(html) {
  const refs = [];
  const re = /<(a|area|link|script|img|source|iframe|video|audio|form|meta)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  const clean = stripNoise(html);
  let m;
  while ((m = re.exec(clean))) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    const add = (attr) => {
      if (attrs[attr] !== undefined && attrs[attr].trim() !== '') refs.push({ tag, attr, url: attrs[attr].trim() });
    };
    if (tag === 'a' || tag === 'area') add('href');
    else if (tag === 'link') {
      if (!/\b(?:preconnect|dns-prefetch)\b/i.test(attrs.rel ?? '')) add('href');
    } else if (tag === 'script' || tag === 'iframe' || tag === 'audio') add('src');
    else if (tag === 'form') add('action');
    else if (tag === 'video') {
      add('src');
      add('poster');
    } else if (tag === 'img' || tag === 'source') {
      add('src');
      for (const candidate of (attrs.srcset ?? '').split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) refs.push({ tag, attr: 'srcset', url });
      }
    } else if (tag === 'meta') {
      const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
      if (key === 'og:image' || key === 'twitter:image') add('content');
    }
  }
  return refs;
}

/** Every id (and old-style `<a name>`) on a page. */
function collectIds(html) {
  const ids = new Set();
  const re = /<[a-z][^>]*?\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m;
  const clean = stripNoise(html);
  while ((m = re.exec(clean))) ids.add(decode(m[1] ?? m[2] ?? m[3] ?? ''));
  return ids;
}

// ───────────────────────────── checking ─────────────────────────────

/** The URL path a page file is served at (`docs/x/index.html` is `/docs/x/`). */
function pagePathOf(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel.slice(0, -'.html'.length)}`;
}

/** The hosts that count as this site, from `site` in astro.config.mjs. */
function siteHostsFrom(root) {
  const hosts = new Set(['ikenga.dev']);
  const config = path.join(root, 'astro.config.mjs');
  if (existsSync(config)) {
    const m = /\bsite\s*:\s*['"]https?:\/\/([^/'"]+)/.exec(readFileSync(config, 'utf8'));
    if (m) hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

const SKIP_SCHEME = /^(?:mailto|tel|sms|javascript|data|blob|about):/i;

/**
 * Check every page in `distDir`. Returns `{ errors, warnings, stats, external }`.
 * `external` maps each outside URL to the pages that link to it.
 */
async function checkSite({ distDir, functionsDir, siteHosts = new Set(['ikenga.dev']), strictRedirects = false }) {
  const { resolve, files } = createLocalResolver({ distDir, functionsDir });
  const errors = [];
  const warnings = [];
  const external = new Map();
  const stats = { pages: 0, internal: 0, redirected: 0, anchors: 0 };

  const idCache = new Map();
  const idsOf = (file) => {
    if (!idCache.has(file)) idCache.set(file, collectIds(readFileSync(file, 'utf8')));
    return idCache.get(file);
  };
  const followCache = new Map();
  const landOn = async (pathname) => {
    if (!followCache.has(pathname)) followCache.set(pathname, await follow(async (p) => resolve(p), pathname));
    return followCache.get(pathname);
  };

  const pages = [...files].filter((f) => f.endsWith('.html')).sort();
  stats.pages = pages.length;

  const work = async () => {
    for (const rel of pages) {
      const pagePath = pagePathOf(rel);
      const html = readFileSync(path.join(distDir, rel), 'utf8');
      for (const ref of collectReferences(html)) {
        const where = `<${ref.tag} ${ref.attr}="${ref.url.length > 90 ? `${ref.url.slice(0, 87)}...` : ref.url}">`;
        const problem = (list, message) => list.push({ page: pagePath, where, url: ref.url, message });

        if (SKIP_SCHEME.test(ref.url)) continue;
        let target;
        try {
          target = new URL(ref.url, `http://site.invalid${pagePath}`);
        } catch {
          problem(errors, 'not a valid URL');
          continue;
        }
        const own = target.origin === 'http://site.invalid' || siteHosts.has(target.host.toLowerCase());
        if (!own) {
          if (/^https?:$/.test(target.protocol)) {
            const key = target.href.replace(/#.*$/, '');
            if (!external.has(key)) external.set(key, new Set());
            external.get(key).add(pagePath);
          }
          continue;
        }

        stats.internal += 1;
        let pathname;
        try {
          pathname = decodeURI(target.pathname);
        } catch {
          problem(errors, 'the path is not valid percent-encoding');
          continue;
        }
        const landed = await landOn(pathname);
        if (!landed.ok) {
          problem(errors, `${pathname} is ${landed.reason}`);
          continue;
        }
        if (landed.hops.length > 1) {
          stats.redirected += 1;
          const last = landed.hops[landed.hops.length - 1].path;
          problem(strictRedirects ? errors : warnings, `${pathname} works only through a redirect; link to ${last} instead`);
        }

        const fragment = target.hash.replace(/^#/, '');
        if (fragment && fragment !== 'top' && !fragment.startsWith(':~:')) {
          const file = landed.hops[landed.hops.length - 1].file;
          if (file && file.endsWith('.html')) {
            stats.anchors += 1;
            let wanted = fragment;
            try {
              wanted = decodeURIComponent(fragment);
            } catch {
              // keep the raw text
            }
            if (!idsOf(file).has(wanted)) {
              problem(errors, `no element with id "${wanted}" on ${landed.hops[landed.hops.length - 1].path}`);
            }
          }
        }
      }
    }
  };
  await work();
  return { errors, warnings, stats, external };
}

// ───────────────────────────── known broken links ─────────────────────────────

/** Parse known-broken-links.txt: one `<page> <link as written>` per line, full-line # comments. */
function parseKnown(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(\S+)$/.exec(line);
    if (!m) throw new Error(`known-broken-links.txt: cannot read the line "${line}" (expected "<page> <link>")`);
    entries.push({ page: m[1], url: m[2] });
  }
  return entries;
}

/**
 * Split errors into new ones and known ones, and find listed entries that no longer fail.
 * Returns `{ fresh, known, stale }`.
 */
function applyKnown(errors, entries) {
  const listed = new Set(entries.map((e) => `${e.page} ${e.url}`));
  const seen = new Set();
  const fresh = [];
  const known = [];
  for (const error of errors) {
    const key = `${error.page} ${error.url}`;
    if (listed.has(key)) {
      known.push(error);
      seen.add(key);
    } else fresh.push(error);
  }
  const stale = entries.filter((e) => !seen.has(`${e.page} ${e.url}`));
  return { fresh, known, stale };
}

// ───────────────────────────── other sites (--external) ─────────────────────────────

/** Check one outside URL. Returns `{ level: 'ok' | 'warn' | 'error', message? }`. */
async function checkOneExternal(url, timeoutMs) {
  let current = url;
  let moved;
  for (let hop = 0; hop < 5; hop += 1) {
    let res;
    for (const method of ['HEAD', 'GET']) {
      try {
        res = await fetch(current, {
          method,
          redirect: 'manual',
          headers: { 'user-agent': 'ikenga-site-link-check', accept: '*/*' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.arrayBuffer();
      } catch (err) {
        const code = err?.cause?.code;
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { level: 'error', message: `the host does not exist (${code})` };
        if (method === 'GET') return { level: 'warn', message: `could not be reached (${code ?? err.name})` };
        continue;
      }
      if (method === 'HEAD' && [403, 405, 501].includes(res.status)) continue;
      break;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (res.status === 301 || res.status === 308) moved ??= new URL(res.headers.get('location'), current).href;
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    if (res.status === 404 || res.status === 410) return { level: 'error', message: `${res.status}` };
    if (res.status >= 200 && res.status < 300) {
      return moved && moved.replace(/\/$/, '') !== url.replace(/\/$/, '')
        ? { level: 'warn', message: `moved permanently to ${moved}` }
        : { level: 'ok' };
    }
    return { level: 'warn', message: `answered ${res.status}` };
  }
  return { level: 'warn', message: 'more than 5 redirects' };
}

async function checkExternalLinks(external, { concurrency = 6, timeoutMs = 12000 } = {}) {
  const queue = [...external.keys()];
  const results = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      results.push({ url, pages: [...external.get(url)], ...(await checkOneExternal(url, timeoutMs)) });
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.url.localeCompare(b.url));
}

// ───────────────────────────── running ─────────────────────────────

function printProblems(label, list) {
  let page;
  for (const item of list) {
    if (item.page !== page) {
      page = item.page;
      console.log(`  ${page}`);
    }
    console.log(`    ${label}  ${item.where}\n           ${item.message}`);
  }
}

async function main(opts) {
  if (!existsSync(opts.dist)) {
    console.error(`check-links: no build output at ${opts.dist}. Run "pnpm build" first.`);
    return 2;
  }
  const result = await checkSite({
    distDir: opts.dist,
    functionsDir: path.join(ROOT, 'functions'),
    siteHosts: siteHostsFrom(ROOT),
    strictRedirects: opts.strictRedirects,
  });
  const { warnings, stats, external } = result;
  const knownFile = path.join(SCRIPT_DIR, 'known-broken-links.txt');
  const entries = opts.useKnown && existsSync(knownFile) ? parseKnown(readFileSync(knownFile, 'utf8')) : [];
  const { fresh: errors, known, stale } = applyKnown(result.errors, entries);
  let externalErrors = 0;
  let externalWarnings = 0;

  console.log(`check-links: ${stats.pages} pages, ${stats.internal} internal links and file references, ${stats.anchors} #anchors`);
  if (warnings.length) {
    console.log(`\nwarnings (${warnings.length})`);
    printProblems('warn ', warnings);
  }
  if (known.length) {
    console.log(`\nknown broken links (${known.length}, listed in scripts/known-broken-links.txt; fix them and delete the lines)`);
    printProblems('known', known);
  }
  if (errors.length) {
    console.log(`\nerrors (${errors.length})`);
    printProblems('ERROR', errors);
  }
  if (stale.length) {
    console.log(`\nstale entries in scripts/known-broken-links.txt (${stale.length}): these links work now, so delete the lines`);
    for (const e of stale) console.log(`  ERROR  ${e.page} ${e.url}`);
  }

  if (opts.external) {
    console.log(`\nchecking ${external.size} links to other sites`);
    const checked = await checkExternalLinks(external);
    for (const item of checked) {
      if (item.level === 'ok') continue;
      if (item.level === 'error') externalErrors += 1;
      else externalWarnings += 1;
      console.log(`  ${item.level === 'error' ? 'ERROR' : 'warn '}  ${item.url}  ${item.message}\n           linked from ${item.pages.slice(0, 3).join(', ')}${item.pages.length > 3 ? `, and ${item.pages.length - 3} more` : ''}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::${item.level === 'error' ? 'error' : 'warning'} title=External link::${item.url} ${item.message}`);
      }
    }
  } else {
    console.log(`\n${external.size} links to other sites were not checked (use --external)`);
  }

  const totalErrors = errors.length + stale.length + externalErrors;
  console.log(
    `\ncheck-links: ${stats.redirected} internal links rely on a redirect, ${warnings.length + externalWarnings} warnings, ${known.length} known, ${totalErrors} errors`,
  );
  if (totalErrors > 0) {
    console.error('check-links: FAILED. Fix the links above, or the pages they point to.');
    return 1;
  }
  console.log('check-links: no broken links.');
  return 0;
}

// ───────────────────────────── self-test ─────────────────────────────

async function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-links-'));
  const put = (rel, content) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  let total = 0;
  let bad = 0;
  const expect = (name, passed, detail = '') => {
    total += 1;
    if (!passed) bad += 1;
    console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${name}${passed || !detail ? '' : `: ${detail}`}`);
  };

  try {
    const dist = path.join(dir, 'dist');
    put(
      'dist/index.html',
      `<!doctype html><html><head>
        <link rel="stylesheet" href="/_astro/a.css">
        <link rel="preconnect" href="https://fonts.example.net">
        <link rel="canonical" href="https://ikenga.dev/">
        <meta property="og:image" content="https://ikenga.dev/assets/og.png">
        <script src="/_astro/a.js"></script>
        <script>const t = '<a href="/in-script/">x</a>';</script>
        <!-- <a href="/in-comment/">x</a> -->
      </head><body id="top">
        <a href="/packages/">good page</a>
        <a href="/packages/#section-one">good anchor</a>
        <a href="/packages/#section-two">bad anchor</a>
        <a href="/packages">relies on a redirect</a>
        <a href="/missing/">missing page</a>
        <a href="https://ikenga.dev/gone/">missing page by full address</a>
        <a href="https://ikenga.dev/packages/">good by full address</a>
        <a href="docs/">good relative link</a>
        <a href="#nope">bad same-page anchor</a>
        <a href="#top">good same-page anchor</a>
        <a href="/install.sh">good file</a>
        <a href="/api/subscribe">good function route</a>
        <a href="mailto:hello@example.com">mail</a>
        <a href="https://example.com/page">another site</a>
        <img src="/img/ok.png" srcset="/img/ok.png 1x, /img/missing@2x.png 2x" alt="">
        <img src="/img/missing.png" alt="">
        <a href="/a%20b/">encoded space</a>
        <a href='/packages/' data-x="a>b">attribute with a greater-than sign</a>
      </body></html>`,
    );
    put('dist/packages/index.html', '<!doctype html><h2 id="section-one">One</h2><a href="../docs/">up and over</a><a href="../nowhere/">broken</a>');
    put('dist/docs/index.html', '<!doctype html><title>docs</title>');
    put('dist/a b/index.html', '<!doctype html>');
    put('dist/_astro/a.css', 'body{}');
    put('dist/_astro/a.js', '//');
    put('dist/img/ok.png', 'x');
    put('dist/install.sh', '#!/bin/sh');
    put('functions/api/subscribe.ts', 'export const onRequestPost = () => {};');

    const result = await checkSite({ distDir: dist, functionsDir: path.join(dir, 'functions') });
    const errorFor = (url) => result.errors.filter((e) => e.where.includes(`="${url}"`));
    const onPage = (page) => result.errors.filter((e) => e.page === page);

    console.log('green: these links are fine');
    expect('a page, a file, a function route and a full-address link pass', ['/packages/', '/install.sh', '/api/subscribe', 'https://ikenga.dev/packages/'].every((u) => errorFor(u).length === 0));
    expect('a good anchor and #top pass', errorFor('/packages/#section-one').length === 0 && errorFor('#top').length === 0);
    expect('a relative link and a percent-encoded path pass', errorFor('docs/').length === 0 && errorFor('/a%20b/').length === 0);
    expect('mailto is skipped and another site is collected, not errored', errorFor('mailto:hello@example.com').length === 0 && result.external.has('https://example.com/page'));
    expect('preconnect hints, inline scripts and comments are not read', result.external.size === 1 && errorFor('/in-script/').length === 0 && errorFor('/in-comment/').length === 0);
    expect('a > inside an attribute does not hide the link', collectReferences('<a href="/p/" data-x="a>b">x</a>').length === 1);

    console.log('red: seeded broken links');
    expect('a missing page is an error', errorFor('/missing/').length === 1);
    expect('a missing page by full address is an error', errorFor('https://ikenga.dev/gone/').length === 1);
    expect('a missing anchor on another page is an error', errorFor('/packages/#section-two').length === 1);
    expect('a missing anchor on the same page is an error', errorFor('#nope').length === 1);
    expect('a missing image is an error', errorFor('/img/missing.png').length === 1);
    expect('a missing srcset candidate is an error', errorFor('/img/missing@2x.png').length === 1);
    expect('a missing social preview image is an error', errorFor('https://ikenga.dev/assets/og.png').length === 1);
    expect('a broken relative link on another page is an error', onPage('/packages/').length === 1);
    expect('the total is exactly the seeded errors', result.errors.length === 8, `got ${result.errors.length}: ${result.errors.map((e) => e.where).join(' | ')}`);

    console.log('warnings and strict mode');
    expect('a link that needs a redirect is a warning, not an error', result.warnings.length === 1 && result.warnings[0].message.includes('/packages/'));
    const strict = await checkSite({ distDir: dist, functionsDir: path.join(dir, 'functions'), strictRedirects: true });
    expect('--strict-redirects makes it an error', strict.errors.length === 9 && strict.warnings.length === 0);

    console.log('known broken links');
    const listed = parseKnown('# a comment\n/ /missing/\n/ #nope\n/gone/ /x/\n');
    const split = applyKnown(result.errors, listed);
    expect('a listed broken link is known, not new', split.known.length === 2 && split.fresh.length === result.errors.length - 2);
    expect('a listed link that works is a stale entry', split.stale.length === 1 && split.stale[0].page === '/gone/');
    expect('an unlisted broken link stays an error', split.fresh.some((e) => e.url === '/img/missing.png'));
    expect('the same link on another page is not covered by the entry', applyKnown([{ page: '/b/', url: '#nope' }], listed).fresh.length === 1);
    let badLine = false;
    try {
      parseKnown('/only-one-token');
    } catch {
      badLine = true;
    }
    expect('a malformed line is rejected', badLine);
    expect('the real list loads', parseKnown(readFileSync(path.join(SCRIPT_DIR, 'known-broken-links.txt'), 'utf8')).length >= 0);

    console.log('reading HTML');
    expect('collectReferences reads quoted, single-quoted and bare attributes', JSON.stringify(collectReferences('<a href=/x>1</a><a href=\'/y\'>2</a><a href="/z">3</a>').map((r) => r.url)) === JSON.stringify(['/x', '/y', '/z']));
    expect('collectIds reads id and name', [...collectIds('<h2 id="a">x</h2><a name="b"></a><p data-id="no">')].sort().join() === 'a,b');
    expect('the site address comes from the config', siteHostsFrom(ROOT).has('ikenga.dev'));
    expect('walkFiles sees the seeded build', walkFiles(dist).size === 8, `saw ${walkFiles(dist).size}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(bad === 0 ? `\ncheck-links self-test: ${total} cases ok` : `\ncheck-links self-test: ${bad} of ${total} cases FAILED`);
  return bad === 0 ? 0 : 1;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`check-links: ${err.message}\n${USAGE}`);
  process.exit(2);
}
try {
  // Set the exit code and let the process end by itself. Calling process.exit() while sockets are
  // still closing can crash Node on Windows.
  process.exitCode = opts.selfTest ? await selfTest() : await main(opts);
} catch (err) {
  console.error(`check-links: ${err.message}`);
  process.exitCode = 2;
}
