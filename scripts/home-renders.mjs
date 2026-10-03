#!/usr/bin/env node
/**
 * home-renders.mjs: cut the home page's product images from their source files.
 *
 * Reads src/data/home-renders.json. For every entry it crops each source (dark, and light when
 * there is one) to `crop`, and to `cropPhone` when the entry has one, and writes AVIF, WebP and a
 * PNG fallback to public/assets/home/ at the crop's own pixel size. The page then serves only the
 * region that proves the claim, instead of a full 3000px window.
 *
 * Usage
 *   node scripts/home-renders.mjs --src <folder>   folder that holds the source images
 *   node scripts/home-renders.mjs --check          verify every output file exists (no sources needed)
 *
 * Swapping a design render for a live capture: put the capture in the source folder, edit its entry
 * in home-renders.json (file name, width, height, crop, tag, alt) and run this script again.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'src/data/home-renders.json');
const OUT = path.join(ROOT, 'public/assets/home');
const FORMATS = ['avif', 'webp', 'png'];

/** Every output file for one entry: [{ file, source, crop }]. */
function outputsFor(entry) {
	const out = [];
	const modes = [['', entry.source.dark]];
	if (entry.source.light) modes.push(['-light', entry.source.light]);
	for (const [mode, source] of modes) {
		out.push({ base: `${entry.id}${mode}`, source, crop: entry.crop });
		if (entry.cropPhone) out.push({ base: `${entry.id}${mode}-phone`, source, crop: entry.cropPhone });
	}
	return out;
}

function parseArgs(argv) {
	const opts = { src: null, check: false };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--src') opts.src = argv[++i];
		else if (argv[i] === '--check') opts.check = true;
		else throw new Error(`unknown argument ${argv[i]}`);
	}
	if (!opts.check && !opts.src) throw new Error('pass --src <folder> or --check');
	return opts;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const { renders } = JSON.parse(readFileSync(DATA, 'utf8'));
	const jobs = renders.flatMap(outputsFor);

	if (opts.check) {
		const missing = jobs.flatMap((j) => FORMATS.map((f) => `${j.base}.${f}`)).filter((f) => !existsSync(path.join(OUT, f)));
		if (missing.length) {
			console.error(`missing ${missing.length} file(s) in public/assets/home:\n  ${missing.join('\n  ')}`);
			process.exit(1);
		}
		console.log(`all ${jobs.length * FORMATS.length} home render files are present`);
		return;
	}

	const { default: sharp } = await import('sharp');
	mkdirSync(OUT, { recursive: true });
	for (const job of jobs) {
		const src = path.join(opts.src, job.source);
		const { x, y, w, h } = job.crop;
		const cut = () => sharp(src).extract({ left: x, top: y, width: w, height: h });
		await cut().avif({ quality: 60, effort: 6 }).toFile(path.join(OUT, `${job.base}.avif`));
		await cut().webp({ quality: 82, effort: 6 }).toFile(path.join(OUT, `${job.base}.webp`));
		await cut().png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(path.join(OUT, `${job.base}.png`));
		console.log(`${job.base}  ${w}x${h}  from ${job.source}`);
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
