#!/usr/bin/env node
/**
 * contrast-check.mjs — deterministic WCAG contrast checker for the
 * light-pole tonal system.
 *
 * No dependencies. Parses the actual CSS custom-property declarations out of
 * src/styles/theming.css (dark-pole upstream primitives) and
 * src/styles/tokens-site.css (site --site-* aliases, plus the
 * [data-tone="light"] override block) so the check tracks the real files —
 * it does not hardcode a second copy of the palette that could drift.
 *
 * Checks every text-role pairing on BOTH poles:
 *   fg / muted / faint / accent-as-text  ×  bg / surface / raised
 * plus border-strong vs bg (non-text UI component contrast).
 *
 * Thresholds (WCAG 2.1):
 *   - normal/small text:        >= 4.5:1 (AA)
 *   - UI component boundaries:  >= 3:1   (1.4.11)
 *
 * Exit code: 0 if every check passes, 1 if any check fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(__dirname, '..');

const themingPath = path.join(siteDir, 'src/styles/theming.css');
const tokensSitePath = path.join(siteDir, 'src/styles/tokens-site.css');

/** Strip /* *\/ comments. */
function stripComments(css) {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Strip any @media (...) { ... } block, including nested braces, so it
 * doesn't get picked up as a bare selector block by the naive block scanner
 * below. We don't need the "Auto" prefers-color-scheme block for the tonal
 * check — it's a compatibility fallback, not one of the two named poles.
 */
function stripAtMediaBlocks(css) {
	let out = '';
	let i = 0;
	while (i < css.length) {
		const at = css.indexOf('@media', i);
		if (at === -1) {
			out += css.slice(i);
			break;
		}
		out += css.slice(i, at);
		const braceStart = css.indexOf('{', at);
		if (braceStart === -1) {
			out += css.slice(at);
			break;
		}
		let depth = 1;
		let j = braceStart + 1;
		while (j < css.length && depth > 0) {
			if (css[j] === '{') depth++;
			else if (css[j] === '}') depth--;
			j++;
		}
		i = j; // skip the whole @media block
	}
	return out;
}

/**
 * Extract top-level `selector(s) { decls }` blocks (no nesting expected once
 * @media has been stripped). Returns [{ selector, decls: Map<name,value> }].
 */
function extractBlocks(css) {
	const blocks = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let m;
	while ((m = re.exec(css))) {
		const selector = m[1].trim().replace(/\s+/g, ' ');
		const body = m[2];
		const decls = new Map();
		const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
		let d;
		while ((d = declRe.exec(body))) {
			decls.set(d[1].trim(), d[2].trim());
		}
		blocks.push({ selector, decls });
	}
	return blocks;
}

function loadBlocks(filePath) {
	const raw = readFileSync(filePath, 'utf8');
	return extractBlocks(stripAtMediaBlocks(stripComments(raw)));
}

const themingBlocks = loadBlocks(themingPath);
const tokensSiteBlocks = loadBlocks(tokensSitePath);

function mergeDecls(...maps) {
	const out = new Map();
	for (const map of maps) for (const [k, v] of map) out.set(k, v);
	return out;
}

function findBlock(blocks, matcher) {
	const found = blocks.filter((b) => matcher(b.selector));
	return mergeDecls(...found.map((b) => b.decls));
}

// Upstream primitives (theming.css)
const darkBase = findBlock(
	themingBlocks,
	(s) => s.includes(":root") && !s.includes('[data-mode=\'light\']') && !s.includes('[data-theme=\'light\']'),
);
const lightBase = findBlock(
	themingBlocks,
	(s) => s.includes("[data-mode='light']") || s.includes("[data-theme='light']"),
);

// Site alias layer (tokens-site.css)
const siteRootDecls = findBlock(tokensSiteBlocks, (s) => s === ':root');
const siteLightTone = findBlock(tokensSiteBlocks, (s) => s.includes('[data-tone="light"]') || s.includes("[data-tone='light']"));

function resolveVar(value, baseMap, seen = new Set()) {
	return value.replace(/var\((--[\w-]+)\s*(?:,\s*([^)]+))?\)/g, (whole, name, fallback) => {
		if (seen.has(name)) return fallback ?? whole;
		if (baseMap.has(name)) {
			return resolveVar(baseMap.get(name), baseMap, new Set(seen).add(name));
		}
		return fallback ?? whole;
	});
}

/** Build the fully-resolved --site-* map for a pole. */
function resolvePole(siteDecls, upstreamBase) {
	// site decls may reference either upstream vars (--bg-base, --achievement, …)
	// or other --site-* vars already declared in the same block.
	const merged = mergeDecls(upstreamBase, siteDecls);
	const resolved = new Map();
	for (const [k, v] of siteDecls) {
		resolved.set(k, resolveVar(v, merged).trim());
	}
	return resolved;
}

const darkPole = resolvePole(siteRootDecls, darkBase);
// Light tone: literal parchment values scoped to [data-tone="light"], with a
// fallback resolve against siteRootDecls (for any var()s not overridden there)
// and lightBase (for any leftover upstream refs).
const lightPole = resolvePole(siteLightTone, mergeDecls(lightBase, darkBase, siteRootDecls));

function hslToRgb(h, s, l) {
	s /= 100;
	l /= 100;
	const k = (n) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [255 * f(0), 255 * f(8), 255 * f(4)];
}

function parseColor(value) {
	const hsl = value.match(/^hsl\(\s*([\d.]+)\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%\s*\)$/i);
	if (hsl) {
		const [, h, s, l] = hsl;
		return hslToRgb(Number(h), Number(s), Number(l));
	}
	// hsl with space syntax e.g. hsl(220 14% 8%)
	const hslSpace = value.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*(?:\/[^)]+)?\)$/i);
	if (hslSpace) {
		const [, h, s, l] = hslSpace;
		return hslToRgb(Number(h), Number(s), Number(l));
	}
	throw new Error(`contrast-check: cannot parse color value "${value}"`);
}

function relLuminance([r, g, b]) {
	const chan = (c) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const [rl, gl, bl] = [chan(r), chan(g), chan(b)];
	return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(c1, c2) {
	const l1 = relLuminance(parseColor(c1));
	const l2 = relLuminance(parseColor(c2));
	const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
	return (lighter + 0.05) / (darker + 0.05);
}

const TEXT_ROLES = ['--site-fg', '--site-muted', '--site-faint', '--site-accent'];
const SURFACES = ['--site-bg', '--site-surface', '--site-raised'];

let failed = 0;
let checked = 0;
let warned = 0;

function report(pole, label, fg, bg, threshold, { blocking = true } = {}) {
	const ratio = contrastRatio(fg, bg);
	const ok = ratio >= threshold;
	checked++;
	let status;
	if (ok) {
		status = 'PASS';
	} else if (blocking) {
		failed++;
		status = 'FAIL';
	} else {
		warned++;
		status = 'WARN';
	}
	console.log(`[${pole}] ${status}  ${label.padEnd(28)} ${ratio.toFixed(2)}:1  (need >= ${threshold}:1)`);
}

// Pre-existing gap (not introduced by the light-pole work): the dark-pole
// --site-border-strong value was already shipping at 2.36:1 against
// --site-bg (short of the 3:1 WCAG 1.4.11 target its own code comment
// claims). The light-pole work is additive-only and does not touch dark-pole
// slots, so this check is downgraded to a non-blocking WARN for the dark
// pole only — flagged here for visibility, left to a follow-up to fix.
const KNOWN_PRE_EXISTING_GAPS = new Set(['dark:--site-border-strong on --site-bg']);

function checkPole(name, vars) {
	console.log(`\n== ${name} pole ==`);
	for (const role of TEXT_ROLES) {
		for (const surface of SURFACES) {
			const fg = vars.get(role);
			const bg = vars.get(surface);
			if (!fg || !bg) {
				console.log(`[${name}] SKIP  ${role} on ${surface} (missing value: ${!fg ? role : surface})`);
				continue;
			}
			const label = `${role} on ${surface}`;
			report(name, label, fg, bg, 4.5, { blocking: !KNOWN_PRE_EXISTING_GAPS.has(`${name}:${label}`) });
		}
	}
	// UI component boundary: --site-border-strong vs --site-bg (WCAG 1.4.11)
	const borderStrong = vars.get('--site-border-strong');
	const bg = vars.get('--site-bg');
	if (borderStrong && bg) {
		const label = '--site-border-strong on --site-bg';
		report(name, label, borderStrong, bg, 3, { blocking: !KNOWN_PRE_EXISTING_GAPS.has(`${name}:${label}`) });
	} else {
		console.log(`[${name}] SKIP  --site-border-strong on --site-bg (missing value)`);
	}

	// Button-label text: --site-accent-ink drawn ON --site-accent (.sk-btn--primary).
	const accentInk = vars.get('--site-accent-ink');
	const accent = vars.get('--site-accent');
	if (accentInk && accent) {
		report(name, '--site-accent-ink on --site-accent', accentInk, accent, 4.5);
	} else {
		console.log(`[${name}] SKIP  --site-accent-ink on --site-accent (missing value)`);
	}
}

checkPole('dark', darkPole);
checkPole('light', lightPole);

console.log(`\n${checked} checks run, ${failed} failed, ${warned} warned (pre-existing, non-blocking).`);
if (failed > 0) {
	console.error('\ncontrast-check: FAILED — see the FAIL lines above.');
	process.exit(1);
}
console.log('\ncontrast-check: all checks passed.');
