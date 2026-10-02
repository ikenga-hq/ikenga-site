// Checks for the analytics Pages Functions (functions/api/event.ts,
// functions/download/[os].ts). Manual, like scripts/contrast-check.mjs: CI does
// not run it.
//
//   node --test scripts/test-functions.mjs           offline, GitHub API stubbed
//   LIVE=1 node --test scripts/test-functions.mjs    also hits the real GitHub API
//
// Needs Node with TypeScript type stripping (24, or 22.18+). On an older 22.x add
// --experimental-strip-types.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest, onRequestPost } from '../functions/api/event.ts';
import { onRequestGet, onRequestHead } from '../functions/download/[os].ts';

const ALLOWED = ['cta_download', 'install_copy', 'pricing_view', 'contact_submit', 'newsletter_subscribe'];

const eventRequest = (body, headers = {}) =>
	new Request('https://ikenga.dev/api/event', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});

const fakeDataset = () => ({
	points: [],
	writeDataPoint(point) {
		this.points.push(point);
	},
});

/** Run fn with console.log captured; returns the captured lines. */
async function capturingLog(fn) {
	const lines = [];
	const original = console.log;
	console.log = (...args) => lines.push(args.join(' '));
	try {
		await fn();
	} finally {
		console.log = original;
	}
	return lines;
}

// ---- POST /api/event --------------------------------------------------------

test('accepts every allowlisted event (Analytics Engine binding present)', async () => {
	for (const name of ALLOWED) {
		const EVENTS = fakeDataset();
		const res = await onRequestPost({
			request: eventRequest({ name, path: '/pricing', props: { tier: 'team' } }),
			env: { EVENTS },
		});
		assert.equal(res.status, 204, name);
		assert.equal(EVENTS.points.length, 1, name);
		assert.deepEqual(EVENTS.points[0], {
			indexes: [name],
			blobs: [name, '/pricing', '', '', 'team', '', '', ''],
			doubles: [1],
		});
	}
});

test('falls back to a structured console.log line when no binding exists', async () => {
	const lines = await capturingLog(async () => {
		const res = await onRequestPost({
			request: eventRequest({ name: 'install_copy', path: '/?utm=x#frag' }),
			env: {},
		});
		assert.equal(res.status, 204);
	});
	assert.equal(lines.length, 1);
	assert.deepEqual(JSON.parse(lines[0]), {
		type: 'ikenga_event',
		name: 'install_copy',
		path: '/', // query string and fragment are dropped
		props: {},
	});
});

test('rejects names outside the allowlist, and stores nothing', async () => {
	const EVENTS = fakeDataset();
	for (const name of ['page_view', 'CTA_DOWNLOAD', '', 'cta_download ', null, 42, ['install_copy'], { a: 1 }, undefined]) {
		const res = await onRequestPost({
			request: eventRequest({ name, path: '/' }),
			env: { EVENTS },
		});
		assert.equal(res.status, 400, String(JSON.stringify(name)));
	}
	assert.equal(EVENTS.points.length, 0);
});

test('rejects malformed bodies and bad paths', async () => {
	const EVENTS = fakeDataset();
	const bad = [
		'not json',
		'null',
		'[]',
		'"install_copy"',
		JSON.stringify({ name: 'install_copy' }), // no path
		JSON.stringify({ name: 'install_copy', path: 'no-leading-slash' }),
		JSON.stringify({ name: 'install_copy', path: 'https://evil.example/x' }),
		JSON.stringify({ name: 'install_copy', path: '/has space' }),
		JSON.stringify({ name: 'install_copy', path: '/' + 'a'.repeat(250) }),
	];
	for (const body of bad) {
		const res = await onRequestPost({ request: eventRequest(body), env: { EVENTS } });
		assert.equal(res.status, 400, body.slice(0, 40));
	}
	assert.equal(EVENTS.points.length, 0);
});

test('rejects oversized bodies', async () => {
	const EVENTS = fakeDataset();
	const big = JSON.stringify({ name: 'install_copy', path: '/', props: { os: 'x'.repeat(5000) } });
	const res = await onRequestPost({ request: eventRequest(big), env: { EVENTS } });
	assert.equal(res.status, 413);
	const declared = await onRequestPost({
		request: eventRequest({ name: 'install_copy', path: '/' }, { 'content-length': '999999' }),
		env: { EVENTS },
	});
	assert.equal(declared.status, 413);
	assert.equal(EVENTS.points.length, 0);
});

test('refuses cross-origin POSTs, accepts same-origin and Origin-less ones', async () => {
	const body = { name: 'install_copy', path: '/' };
	for (const origin of ['https://evil.example', 'null', 'http://ikenga.dev.evil.example']) {
		const EVENTS = fakeDataset();
		const res = await onRequestPost({ request: eventRequest(body, { origin }), env: { EVENTS } });
		assert.equal(res.status, 403, origin);
		assert.equal(EVENTS.points.length, 0, origin);
	}
	for (const headers of [{ origin: 'https://ikenga.dev' }, {}]) {
		const res = await onRequestPost({ request: eventRequest(body, headers), env: { EVENTS: fakeDataset() } });
		assert.equal(res.status, 204, JSON.stringify(headers));
	}
});

test('drops props that are not allowlisted tokens (no PII can be stored)', async () => {
	const EVENTS = fakeDataset();
	await onRequestPost({
		request: eventRequest({
			name: 'newsletter_subscribe',
			path: '/newsletter',
			props: {
				source: 'footer',
				os: 'someone@example.com', // looks like an email: dropped
				tier: 'two words', // not a token: dropped
				tag: 'x'.repeat(41), // too long: dropped
				email: 'someone@example.com', // key not allowlisted: dropped
				method: 7, // not a string: dropped
			},
		}),
		env: { EVENTS },
	});
	assert.equal(EVENTS.points.length, 1);
	assert.deepEqual(EVENTS.points[0].blobs, ['newsletter_subscribe', '/newsletter', '', 'footer', '', '', '', '']);
	assert.ok(!JSON.stringify(EVENTS.points).includes('example.com'));
});

test('never stores IP, user agent or cookies', async () => {
	const headers = {
		'user-agent': 'SECRET-UA/1.0',
		'cf-connecting-ip': '203.0.113.77',
		'x-forwarded-for': '203.0.113.78',
		cookie: 'session=SECRET-COOKIE',
		referer: 'https://ikenga.dev/secret-referrer',
	};
	const EVENTS = fakeDataset();
	const lines = await capturingLog(async () => {
		await onRequestPost({ request: eventRequest({ name: 'install_copy', path: '/' }, headers), env: { EVENTS } });
		await onRequestPost({ request: eventRequest({ name: 'install_copy', path: '/' }, headers), env: {} });
	});
	const everything = JSON.stringify(EVENTS.points) + lines.join('\n');
	for (const secret of ['SECRET-UA', '203.0.113', 'SECRET-COOKIE', 'secret-referrer']) {
		assert.ok(!everything.includes(secret), secret);
	}
});

test('non-POST methods get 405', () => {
	const res = onRequest();
	assert.equal(res.status, 405);
	assert.equal(res.headers.get('allow'), 'POST');
});

// ---- GET /download/<os> -----------------------------------------------------

const RELEASE_BASE = 'https://github.com/ikenga-hq/ikenga/releases/download/v0.18.6';
const RELEASE_FIXTURE = {
	tag_name: 'v0.18.6',
	// Same asset names as the real v0.18.6 release, .sig files included.
	assets: [
		'Ikenga_0.18.6_amd64.AppImage',
		'Ikenga_0.18.6_amd64.AppImage.sig',
		'Ikenga_0.18.6_amd64.deb',
		'Ikenga_0.18.6_amd64.deb.sig',
		'Ikenga_0.18.6_universal.dmg',
		'Ikenga_0.18.6_x64-setup.exe',
		'Ikenga_0.18.6_x64-setup.exe.sig',
		'Ikenga_universal.app.tar.gz',
		'Ikenga_universal.app.tar.gz.sig',
		'latest.json',
	].map((name) => ({ name, browser_download_url: `${RELEASE_BASE}/${name}` })),
};
const EXPECTED = {
	mac: 'Ikenga_0.18.6_universal.dmg',
	windows: 'Ikenga_0.18.6_x64-setup.exe',
	'linux-appimage': 'Ikenga_0.18.6_amd64.AppImage',
	'linux-deb': 'Ikenga_0.18.6_amd64.deb',
};

async function withFetch(impl, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}
const stubRelease = (body = RELEASE_FIXTURE, status = 200) => async () =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const downloadContext = (os, method = 'GET', env = {}) => ({
	request: new Request(`https://ikenga.dev/download/${os}`, { method }),
	env,
	params: { os },
});

test('redirects each OS to its release asset and records cta_download', async () => {
	for (const [os, asset] of Object.entries(EXPECTED)) {
		const EVENTS = fakeDataset();
		const res = await withFetch(stubRelease(), () => onRequestGet(downloadContext(os, 'GET', { EVENTS })));
		assert.equal(res.status, 302, os);
		assert.equal(res.headers.get('location'), `${RELEASE_BASE}/${asset}`, os);
		assert.equal(res.headers.get('cache-control'), 'no-store');
		assert.equal(EVENTS.points.length, 1, os);
		assert.deepEqual(EVENTS.points[0].blobs.slice(0, 3), ['cta_download', `/download/${os}`, os]);
		assert.equal(EVENTS.points[0].blobs[5], 'v0.18.6'); // tag
	}
});

test('unknown OS gets 404 and records nothing', async () => {
	for (const os of ['linux', 'macos', 'toString', '__proto__', 'constructor', '']) {
		const EVENTS = fakeDataset();
		const res = await withFetch(stubRelease(), () => onRequestGet(downloadContext(os, 'GET', { EVENTS })));
		assert.equal(res.status, 404, JSON.stringify(os));
		assert.equal(EVENTS.points.length, 0);
	}
});

test('falls back to the releases page if GitHub is down, still counts the click', async () => {
	const EVENTS = fakeDataset();
	const down = async () => {
		throw new Error('network');
	};
	const res = await withFetch(down, () => onRequestGet(downloadContext('mac', 'GET', { EVENTS })));
	assert.equal(res.status, 302);
	assert.equal(res.headers.get('location'), 'https://github.com/ikenga-hq/ikenga/releases/latest');
	assert.equal(EVENTS.points.length, 1);
	assert.equal(EVENTS.points[0].blobs[5], ''); // no tag known

	const limited = await withFetch(stubRelease({ message: 'rate limit' }, 403), () =>
		onRequestGet(downloadContext('windows', 'GET', { EVENTS: fakeDataset() })),
	);
	assert.equal(limited.headers.get('location'), 'https://github.com/ikenga-hq/ikenga/releases/latest');
});

test('never redirects off the repo, even if the API response says to', async () => {
	const hostile = {
		tag_name: 'v9.9.9',
		assets: [{ name: 'Ikenga_9.9.9_universal.dmg', browser_download_url: 'https://evil.example/Ikenga_9.9.9_universal.dmg' }],
	};
	const res = await withFetch(stubRelease(hostile), () => onRequestGet(downloadContext('mac', 'GET', { EVENTS: fakeDataset() })));
	assert.equal(res.headers.get('location'), 'https://github.com/ikenga-hq/ikenga/releases/latest');
});

test('HEAD redirects like GET but is not counted', async () => {
	const EVENTS = fakeDataset();
	const res = await withFetch(stubRelease(), () => onRequestHead(downloadContext('mac', 'HEAD', { EVENTS })));
	assert.equal(res.status, 302);
	assert.equal(res.headers.get('location'), `${RELEASE_BASE}/${EXPECTED.mac}`);
	assert.equal(EVENTS.points.length, 0);
});

test('download redirect never records IP or user agent', async () => {
	const EVENTS = fakeDataset();
	const request = new Request('https://ikenga.dev/download/mac', {
		headers: { 'user-agent': 'SECRET-UA/1.0', 'cf-connecting-ip': '203.0.113.77' },
	});
	await withFetch(stubRelease(), () => onRequestGet({ request, env: { EVENTS }, params: { os: 'mac' } }));
	const stored = JSON.stringify(EVENTS.points);
	assert.ok(!stored.includes('SECRET-UA') && !stored.includes('203.0.113'));
});

test('LIVE: each OS resolves against the real GitHub API', { skip: !process.env.LIVE }, async () => {
	for (const os of Object.keys(EXPECTED)) {
		const lines = await capturingLog(async () => {
			const res = await onRequestGet(downloadContext(os));
			assert.equal(res.status, 302, os);
			const location = res.headers.get('location');
			assert.match(location, /^https:\/\/github\.com\/ikenga-hq\/ikenga\/releases\/download\/v[^/]+\/Ikenga_/, os);
			const head = await fetch(location, { method: 'HEAD', redirect: 'manual' });
			assert.ok([200, 302].includes(head.status), `${os} asset ${location} -> ${head.status}`);
			console.error(`  ${os} -> ${location} (${head.status})`);
		});
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).name, 'cta_download');
	}
});
