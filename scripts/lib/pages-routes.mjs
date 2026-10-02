/**
 * pages-routes.mjs: a small model of how Cloudflare Pages answers a request for this site.
 *
 * The route test and the link checker need to know what a visitor gets for a path: a page (200),
 * a permanent redirect (301 or 308), a temporary redirect, or a 404. This module answers that
 * from the built `dist/` folder, the `_redirects` file and the `functions/` folder, so the checks
 * run in CI without a server and without network access. It has no dependencies.
 *
 * What it models, checked against the live site:
 *   - `_redirects` rules are tried first, in order. A source path is matched literally, so
 *     `/old` and `/old/` are two different rules. `*` and `:splat` and `:name` placeholders work.
 *   - A page folder answers on the slash form: `/docs/` is 200, and `/docs` is a 308 to `/docs/`.
 *     `/docs/index` and `/docs/index.html` are 308s to `/docs/` too.
 *   - A single page file answers on the plain form: `/404` is 200, `/404/` is a 308 to `/404`,
 *     and `/demos/x.html` is a 308 to `/demos/x`.
 *   - Any other file (`/install.sh`, an image, a script) answers 200 on its exact path only.
 *   - A path that matches a function route in `functions/` is 200.
 *   - Anything else is 404.
 *
 * It is a model, not the platform. The route test can also run against a deployed URL
 * (`redirect-test.mjs --base <url>`), which is the authoritative answer; run it after a deploy.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Redirect statuses that tell search engines and bookmarks the move is permanent. */
export const PERMANENT = new Set([301, 308]);

/** Every file under `dir`, as a Set of posix-style paths relative to `dir`. */
export function walkFiles(dir) {
  const out = new Set();
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (statSync(childAbs).isDirectory()) visit(childAbs, childRel);
      else out.add(childRel);
    }
  };
  if (existsSync(dir)) visit(dir, '');
  return out;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse the text of a `_redirects` file into rules. A line is `source destination [status]`.
 * Blank lines and lines starting with # are ignored. The default status is 302, as on Pages.
 */
export function parseRedirects(text) {
  const rules = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [from, to, code] = line.split(/\s+/);
    if (!from || !to || !from.startsWith('/')) return;
    const status = code ? Number(code) : 302;
    const names = [];
    const source = from
      .split(/(\*|:[A-Za-z_][A-Za-z0-9_]*)/)
      .map((piece) => {
        if (piece === '*') {
          names.push('splat');
          return '(.*)';
        }
        if (piece.startsWith(':')) {
          names.push(piece.slice(1));
          return '([^/]+)';
        }
        return escapeRegExp(piece);
      })
      .join('');
    rules.push({ from, to, status, line: i + 1, names, pattern: new RegExp(`^${source}$`) });
  });
  return rules;
}

/** The first redirect rule that matches `pathname`, as `{ status, location, rule }`, or null. */
export function applyRedirects(rules, pathname) {
  for (const rule of rules) {
    const match = rule.pattern.exec(pathname);
    if (!match) continue;
    let location = rule.to;
    rule.names.forEach((name, i) => {
      location = location.split(`:${name}`).join(match[i + 1] ?? '');
    });
    if (rule.status === 200) return { status: 200, via: 'rewrite', rule };
    return { status: rule.status, location, via: 'redirects', rule };
  }
  return null;
}

/** Route patterns for the Pages Functions found under `functionsDir`. */
export function functionRoutes(functionsDir) {
  const routes = [];
  for (const file of walkFiles(functionsDir)) {
    if (!/\.(?:[cm]?[jt]s)$/.test(file)) continue;
    const parts = file.replace(/\.[cm]?[jt]s$/, '').split('/');
    // A folder or file whose name starts with an underscore holds shared code, not a route.
    if (parts.some((part) => part.startsWith('_'))) continue;
    if (parts[parts.length - 1] === 'index') parts.pop();
    const source = parts
      .map((part) => {
        if (/^\[\[.+\]\]$/.test(part)) return '(?:/.*)?';
        if (/^\[.+\]$/.test(part)) return '/[^/]+';
        return `/${escapeRegExp(part)}`;
      })
      .join('');
    routes.push(new RegExp(`^${source || ''}/?$`));
  }
  return routes;
}

/**
 * A resolver for the built site: `resolve(pathname)` returns `{ status, location?, via, file? }`.
 *   distDir        the build output folder
 *   redirectsText  the text of `_redirects` (defaults to the copy in `distDir`)
 *   functionsDir   the Pages Functions folder (optional)
 */
export function createLocalResolver({ distDir, redirectsText, functionsDir }) {
  const files = walkFiles(distDir);
  const text = redirectsText ?? (files.has('_redirects') ? readFileSync(path.join(distDir, '_redirects'), 'utf8') : '');
  const rules = parseRedirects(text);
  const functions = functionsDir ? functionRoutes(functionsDir) : [];

  const hit = (rel) => ({ status: 200, via: 'static', file: path.join(distDir, rel) });
  const moved = (location) => ({ status: 308, location, via: 'static' });

  const resolve = (rawPath) => {
    const pathname = rawPath.split(/[?#]/)[0] || '/';

    const redirected = applyRedirects(rules, pathname);
    if (redirected) return redirected;

    const rel = pathname.replace(/^\//, '');
    if (pathname.endsWith('/')) {
      if (files.has(`${rel}index.html`)) return hit(`${rel}index.html`);
      const bare = rel.slice(0, -1);
      if ((bare === 'index' || bare.endsWith('/index')) && files.has(`${bare}.html`)) return moved(`/${bare.slice(0, -'index'.length)}`);
      if (bare && files.has(`${bare}.html`)) return moved(`/${bare}`);
    } else {
      if (rel === 'index.html' || rel.endsWith('/index.html')) return moved(`/${rel.slice(0, -'index.html'.length)}`);
      if ((rel === 'index' || rel.endsWith('/index')) && files.has(`${rel}.html`)) return moved(`/${rel.slice(0, -'index'.length)}`);
      if (rel.endsWith('.html') && files.has(rel)) return moved(`/${rel.slice(0, -'.html'.length)}`);
      if (files.has(rel)) return hit(rel);
      if (files.has(`${rel}.html`)) return hit(`${rel}.html`);
      if (files.has(`${rel}/index.html`)) return moved(`/${rel}/`);
    }

    if (functions.some((route) => route.test(pathname))) return { status: 200, via: 'function' };
    return { status: 404, via: 'static' };
  };

  return { resolve, rules, files };
}

/**
 * A resolver for a deployed site: `resolve(pathname)` makes a real request and does not follow
 * redirects. A Location that points at the same origin is reduced to its path.
 */
export function createRemoteResolver(base, { timeoutMs = 20000 } = {}) {
  const origin = new URL(base).origin;
  return async (pathname) => {
    const res = await fetch(origin + pathname, {
      redirect: 'manual',
      headers: { 'user-agent': 'ikenga-site-route-test' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer();
    let location = res.headers.get('location') ?? undefined;
    if (location) {
      const target = new URL(location, origin + pathname);
      location = target.origin === origin ? target.pathname + target.search : target.href;
    }
    return { status: res.status, location, via: 'http' };
  };
}

/**
 * Follow a path through permanent redirects until it lands on a 200.
 * Returns `{ ok, hops, reason? }`. Each hop is `{ path, status, location? }`. A temporary redirect,
 * a 404, a loop or a chain longer than `maxHops` is not ok. A permanent redirect to another
 * origin is ok, because nothing past it can be checked from here.
 */
export async function follow(resolve, start, { maxHops = 5 } = {}) {
  const hops = [];
  const seen = new Set();
  let current = start;
  for (let i = 0; i <= maxHops; i += 1) {
    if (seen.has(current)) return { ok: false, hops, reason: `redirect loop at ${current}` };
    seen.add(current);
    const result = await resolve(current);
    hops.push({ path: current, status: result.status, location: result.location, file: result.file });
    if (result.status === 200) return { ok: true, hops };
    if (PERMANENT.has(result.status)) {
      if (!result.location) return { ok: false, hops, reason: `${result.status} with no Location` };
      if (/^https?:\/\//i.test(result.location)) return { ok: true, hops, offsite: true };
      current = result.location;
      continue;
    }
    const reason =
      result.status === 404
        ? 'not found (404)'
        : result.status >= 300 && result.status < 400
          ? `temporary redirect (${result.status}); a moved page needs a permanent one (301)`
          : `unexpected status ${result.status}`;
    return { ok: false, hops, reason };
  }
  return { ok: false, hops, reason: `more than ${maxHops} redirects in a row` };
}

/** `/a 308 -> /a/ 200` style trace of the hops, for log lines. */
export function describeHops(hops) {
  return hops
    .map((hop) => `${hop.status}${hop.location && hop.status !== 200 ? ` -> ${hop.location}` : ''}`)
    .join(', then ');
}
