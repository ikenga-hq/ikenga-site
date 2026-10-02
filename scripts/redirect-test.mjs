#!/usr/bin/env node
/**
 * redirect-test.mjs: make sure every public URL keeps working, in both slash forms.
 *
 * scripts/routes.txt lists the public routes. For each one this script asks for the plain form
 * (`/packages`) and the slash form (`/packages/`) and follows any redirect. A route passes when
 * each form ends on a 200 and every redirect on the way is permanent (301 or 308). It fails on a
 * 404, a temporary redirect (302 or 307), a redirect loop, or more than five redirects in a row.
 *
 * The permanent redirect is 308 as well as 301 because Cloudflare Pages answers a page folder
 * asked for without its trailing slash (`/docs`) with a 308 to the slash form. A route marked
 * `file` in routes.txt (for example `/install.sh`) has no slash form and is asked for once.
 *
 * It also checks every static rule in the `_redirects` file: the destination must end on a 200,
 * so a rule can never send visitors to a page that no longer exists.
 *
 * Usage
 *   node scripts/redirect-test.mjs                  test the built site in dist/ (run `pnpm build`
 *                                                   first). Needs no server and no network.
 *   node scripts/redirect-test.mjs --base <url>     test a deployed site with real requests, for
 *                                                   example https://ikenga.dev or a Pages preview.
 *                                                   This is the authoritative answer; the dist
 *                                                   mode is a model of it (see lib/pages-routes.mjs).
 *   node scripts/redirect-test.mjs --dist <dir>     use another build folder
 *   node scripts/redirect-test.mjs --routes <file>  use another route list
 *   node scripts/redirect-test.mjs --self-test      prove the test goes red on seeded failures and
 *                                                   green on good routes. Needs no build and no
 *                                                   network.
 *
 * Exit status: 0 every route passes, 1 at least one fails, 2 usage or load error.
 *
 * When a page moves, keep its line in routes.txt and add a `_redirects` rule for the old URL, in
 * both slash forms (a rule matches its source literally). The test then proves the old URL still
 * lands on the new page.
 */

import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalResolver, createRemoteResolver, follow, describeHops, walkFiles } from './lib/pages-routes.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const USAGE =
  'Usage: node scripts/redirect-test.mjs [--dist <dir>] [--routes <file>] [--base <url>] [--self-test]\n' +
  'See the header of this file for what the test checks.';

function parseArgs(argv) {
  const opts = { dist: path.join(ROOT, 'dist'), routes: path.join(SCRIPT_DIR, 'routes.txt'), base: null, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--dist') opts.dist = path.resolve(value());
    else if (arg === '--routes') opts.routes = path.resolve(value());
    else if (arg === '--base') opts.base = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

/** Parse routes.txt: one route per line, `/path` or `/path file`, with # comments. */
function parseRoutes(text) {
  const routes = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [route, flag, ...rest] = line.split(/\s+/);
    if (!route.startsWith('/') || rest.length > 0 || (flag !== undefined && flag !== 'file')) {
      throw new Error(`routes: cannot read the line "${raw.trim()}" (expected "/path" or "/path file")`);
    }
    const clean = route.length > 1 ? route.replace(/\/+$/, '') : route;
    routes.push({ path: clean, file: flag === 'file' });
  }
  return routes;
}

/** The URLs to ask for: both slash forms of a page route, the exact path of a file route. */
function formsOf(route) {
  if (route.path === '/' || route.file) return [route.path];
  return [route.path, `${route.path}/`];
}

/** Run every form of every route. Returns one `{ route, form, result }` per request. */
async function runRoutes(routes, resolve) {
  const rows = [];
  for (const route of routes) {
    for (const form of formsOf(route)) {
      let result;
      try {
        result = await follow(resolve, form);
      } catch (err) {
        result = { ok: false, hops: [], reason: `request failed: ${err.message}` };
      }
      rows.push({ route, form, result });
    }
  }
  return rows;
}

/** Check that every static `_redirects` destination ends on a 200. Local mode only. */
async function runRules(rules, resolve) {
  const rows = [];
  for (const rule of rules) {
    if (/[*:]/.test(rule.to) || /^https?:\/\//i.test(rule.to) || rule.status === 200) continue;
    const result = await follow(resolve, rule.to);
    rows.push({ rule, result });
  }
  return rows;
}

function printRoutes(rows) {
  let bad = 0;
  for (const { form, result } of rows) {
    const trace = describeHops(result.hops);
    if (result.ok) {
      console.log(`  ok    ${form}  ${trace}`);
    } else {
      bad += 1;
      console.log(`  FAIL  ${form}  ${trace}\n          ${result.reason}`);
    }
  }
  return bad;
}

function printRules(rows) {
  let bad = 0;
  for (const { rule, result } of rows) {
    if (result.ok) {
      console.log(`  ok    ${rule.from} -> ${rule.to}  (${rule.status})`);
    } else {
      bad += 1;
      console.log(`  FAIL  ${rule.from} -> ${rule.to}  (line ${rule.line}): the destination is ${result.reason}`);
    }
  }
  return bad;
}

async function main(opts) {
  if (!existsSync(opts.routes)) {
    console.error(`redirect-test: no route list at ${opts.routes}`);
    return 2;
  }
  const routes = parseRoutes(readFileSync(opts.routes, 'utf8'));

  let resolve;
  let rules = [];
  if (opts.base) {
    resolve = createRemoteResolver(opts.base);
    console.log(`redirect-test: ${routes.length} routes against ${opts.base} (real requests)`);
  } else {
    if (!existsSync(opts.dist)) {
      console.error(`redirect-test: no build output at ${opts.dist}. Run "pnpm build" first.`);
      return 2;
    }
    const local = createLocalResolver({ distDir: opts.dist, functionsDir: path.join(ROOT, 'functions') });
    resolve = local.resolve;
    rules = local.rules;
    console.log(`redirect-test: ${routes.length} routes against the build in ${path.relative(process.cwd(), opts.dist) || '.'}`);
  }

  console.log('\nroutes (both slash forms)');
  const routeRows = await runRoutes(routes, resolve);
  let failed = printRoutes(routeRows);

  let ruleCount = 0;
  if (!opts.base) {
    console.log('\n_redirects destinations');
    const ruleRows = await runRules(rules, resolve);
    ruleCount = ruleRows.length;
    failed += printRules(ruleRows);
  }

  console.log(`\nredirect-test: ${routeRows.length} requests, ${ruleCount} redirect rules, ${failed} failed`);
  if (failed > 0) {
    console.error('redirect-test: FAILED. Every public URL must end on a 200 through permanent redirects only.');
    return 1;
  }
  console.log('redirect-test: all routes resolve.');
  return 0;
}

// ───────────────────────────── self-test ─────────────────────────────

async function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'redirect-test-'));
  const put = (rel, content = '<!doctype html>') => {
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
    put('index.html');
    put('packages/index.html');
    put('docs/index.html');
    put('404.html');
    put('demos/a.html');
    put('install.sh', '#!/bin/sh');
    put(
      '_redirects',
      [
        '# comment',
        '/old / 301',
        '/old/ / 301',
        '/half /packages/ 301',
        '/temp /packages/ 302',
        '/temp/ /packages/ 302',
        '/dead /nowhere/ 301',
        '/dead/ /nowhere/ 301',
        '/loop-a /loop-b 301',
        '/loop-b /loop-a 301',
        '/moved/* /docs/:splat 301',
      ].join('\n'),
    );
    const { resolve, rules } = createLocalResolver({ distDir: dir });
    const check = async (route, formsExpected, shouldPass) => {
      const rows = await runRoutes([route], resolve);
      const ok = rows.every((row) => row.result.ok);
      const note = rows.map((row) => `${row.form}: ${row.result.ok ? 'ok' : row.result.reason}`).join('; ');
      expect(`${shouldPass ? 'green' : 'red  '} ${route.path}${route.file ? ' (file)' : ''} [${rows.length} request(s)]`, ok === shouldPass && rows.length === formsExpected, note);
    };

    console.log('routes: good cases');
    await check({ path: '/', file: false }, 1, true);
    await check({ path: '/packages', file: false }, 2, true);
    await check({ path: '/docs', file: false }, 2, true);
    await check({ path: '/404', file: false }, 2, true);
    await check({ path: '/install.sh', file: true }, 1, true);
    await check({ path: '/demos/a.html', file: true }, 1, true);
    await check({ path: '/old', file: false }, 2, true);

    console.log('routes: seeded failures');
    await check({ path: '/gone', file: false }, 2, false); // 404 in both forms
    await check({ path: '/temp', file: false }, 2, false); // 302
    await check({ path: '/loop-a', file: false }, 2, false); // redirect loop
    await check({ path: '/half', file: false }, 2, false); // only the plain form has a rule
    await check({ path: '/dead', file: false }, 2, false); // 301 to a page that does not exist
    await check({ path: '/moved/zzz', file: false }, 2, false); // a splat rule that lands on a missing page
    await check({ path: '/install.sh/', file: true }, 1, false); // a file has no slash form

    console.log('_redirects destinations');
    const ruleRows = await runRules(rules, resolve);
    const verdict = (from) => ruleRows.find((row) => row.rule.from === from)?.result.ok;
    expect('green /old -> /', verdict('/old') === true);
    expect('red   /dead -> /nowhere/', verdict('/dead') === false);
    expect('skipped rules with a splat', !ruleRows.some((row) => row.rule.from === '/moved/*'));

    console.log('routes.txt parser');
    expect('reads paths, flags and comments', JSON.stringify(parseRoutes('# c\n/a\n/b/ file # x\n/')) === JSON.stringify([{ path: '/a', file: false }, { path: '/b', file: true }, { path: '/', file: false }]));
    let threw = false;
    try {
      parseRoutes('/a oops');
    } catch {
      threw = true;
    }
    expect('rejects an unknown flag', threw);
    expect('the real route list loads', parseRoutes(readFileSync(path.join(SCRIPT_DIR, 'routes.txt'), 'utf8')).length > 0);

    console.log('real requests (--base)');
    const server = createServer((req, res) => {
      const table = {
        '/ok/': [200],
        '/ok': [308, '/ok/'],
        '/perm': [301, '/ok/'],
        '/temp': [302, '/ok/'],
        '/away': [301, 'https://example.invalid/'],
      };
      const [status, location] = table[req.url] ?? [404];
      res.writeHead(status, location ? { location } : {});
      res.end('x');
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const remote = createRemoteResolver(`http://127.0.0.1:${server.address().port}`);
      const hit = async (p) => (await follow(remote, p)).ok;
      expect('green 200', (await hit('/ok/')) === true);
      expect('green 308 then 200', (await hit('/ok')) === true);
      expect('green 301 then 200', (await hit('/perm')) === true);
      expect('green permanent redirect to another site', (await hit('/away')) === true);
      expect('red   302', (await hit('/temp')) === false);
      expect('red   404', (await hit('/missing')) === false);
    } finally {
      server.close();
    }

    const walked = walkFiles(dir).size;
    expect('the model reads the seeded build', walked === 7, `saw ${walked} files`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(bad === 0 ? `\nredirect-test self-test: ${total} cases ok` : `\nredirect-test self-test: ${bad} of ${total} cases FAILED`);
  return bad === 0 ? 0 : 1;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`redirect-test: ${err.message}\n${USAGE}`);
  process.exit(2);
}
try {
  // Set the exit code and let the process end by itself. Calling process.exit() while sockets are
  // still closing can crash Node on Windows.
  process.exitCode = opts.selfTest ? await selfTest() : await main(opts);
} catch (err) {
  console.error(`redirect-test: ${err.message}`);
  process.exitCode = 2;
}
