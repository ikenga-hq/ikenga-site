// Cloudflare Pages Function: GET /download/<os>
//
// A countable download redirect. 302s to the matching asset of the latest
// ikenga-hq/ikenga GitHub release and records a `cta_download` event first, so
// download clicks become a number instead of a guess.
//
//   /download/mac             Ikenga_<ver>_universal.dmg
//   /download/windows         Ikenga_<ver>_x64-setup.exe
//   /download/linux-appimage  Ikenga_<ver>_amd64.AppImage
//   /download/linux-deb       Ikenga_<ver>_amd64.deb
//
// Assets are matched by suffix, not by exact name, so a version bump needs no
// change here. The release lookup goes through Cloudflare's edge cache (5 min) to
// stay clear of GitHub's unauthenticated rate limit. If the lookup fails, or no
// asset matches, the visitor is sent to the releases page instead of a dead end.
//
// Optional env: GITHUB_TOKEN (Secret) lifts the rate limit if it is ever hit.
// Nothing needs it today.
//
// Counted: GET only. HEAD (link checkers, redirect tests) redirects but is not
// counted. Records event name, the path /download/<os>, and props os + tag. Never
// the IP or User-Agent. See ../_lib/events.ts.

import { recordEvent, type EventEnv, type EventProps } from '../_lib/events.ts';

const REPO = 'ikenga-hq/ikenga';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const CACHE_SECONDS = 300;

// Public os id -> suffix of the release asset it maps to. A suffix check, so
// "...AppImage.sig" does not match "...AppImage".
const ASSET_SUFFIX: Record<string, string> = {
	mac: '_universal.dmg',
	windows: '_x64-setup.exe',
	'linux-appimage': '_amd64.AppImage',
	'linux-deb': '_amd64.deb',
};

interface Env extends EventEnv {
	GITHUB_TOKEN?: string;
}

interface Release {
	tag: string;
	assets: { name: string; url: string }[];
}

async function latestRelease(env: Env): Promise<Release | null> {
	try {
		const headers: Record<string, string> = {
			accept: 'application/vnd.github+json',
			// GitHub rejects API requests that carry no User-Agent.
			'user-agent': 'ikenga-site-download-redirect',
		};
		if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
		const res = await fetch(RELEASE_API, {
			headers,
			// Workers-only fetch option: serve from the edge cache for 5 minutes.
			cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
		} as RequestInit);
		if (!res.ok) return null;
		const data = (await res.json()) as {
			tag_name?: unknown;
			assets?: { name?: unknown; browser_download_url?: unknown }[];
		};
		if (typeof data?.tag_name !== 'string' || !Array.isArray(data.assets)) return null;
		const assets: Release['assets'] = [];
		for (const a of data.assets) {
			if (typeof a?.name === 'string' && typeof a?.browser_download_url === 'string') {
				assets.push({ name: a.name, url: a.browser_download_url });
			}
		}
		return { tag: data.tag_name, assets };
	} catch {
		return null;
	}
}

const redirect = (location: string): Response =>
	new Response(null, {
		status: 302,
		headers: {
			location,
			// Never cache the redirect: every click has to reach this function.
			'cache-control': 'no-store',
			'x-robots-tag': 'noindex',
		},
	});

const handle = async (
	context: { request: Request; env: Env; params: Record<string, string | string[]> },
	count: boolean,
): Promise<Response> => {
	const { request, env, params } = context;
	const raw = Array.isArray(params.os) ? params.os[0] : params.os;
	const os = typeof raw === 'string' && Object.hasOwn(ASSET_SUFFIX, raw) ? raw : null;
	if (os === null) {
		return new Response('Unknown platform. Use mac, windows, linux-appimage or linux-deb.', {
			status: 404,
			headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
		});
	}

	const release = await latestRelease(env);
	const asset = release?.assets.find(
		(a) => a.name.startsWith('Ikenga_') && a.name.endsWith(ASSET_SUFFIX[os]),
	);
	// Only ever redirect to a GitHub release asset of our own repo.
	const target = asset?.url.startsWith(DOWNLOAD_PREFIX) ? asset.url : RELEASES_PAGE;

	if (count) {
		const props: EventProps = { os };
		if (release && /^[A-Za-z0-9._:-]{1,40}$/.test(release.tag)) props.tag = release.tag;
		recordEvent(env, {
			name: 'cta_download',
			path: new URL(request.url).pathname,
			props,
		});
	}
	return redirect(target);
};

export const onRequestGet = (context: Parameters<typeof handle>[0]): Promise<Response> =>
	handle(context, true);

export const onRequestHead = (context: Parameters<typeof handle>[0]): Promise<Response> =>
	handle(context, false);
