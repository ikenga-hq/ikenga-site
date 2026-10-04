// Latest desktop release, resolved at build time.
//
// One place for the GitHub "latest release" lookup that the download buttons
// read: the tag, the publish date and the installer assets. A rebuild tracks a
// new release automatically. When the lookup fails (offline, rate limited) the
// pinned fallback below is used, and the browser re-checks the live release on
// page load (see the download scripts), so a stale build still corrects itself.
//
// Keep FALLBACK in step with the newest release: a stale asset name here
// silently removes a platform from the download lists of an offline build.

export const RELEASE_REPO = 'ikenga-hq/ikenga';
export const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases/latest`;

const FALLBACK = { tag: 'v0.19.1', date: '2026-10-03', checksums: true };

/** The checksum file attached to each release from 0.19.1 on. */
export const CHECKSUM_FILE = 'SHA256SUMS.txt';

/** A platform the desktop app ships for. `os` is the id the /download/<os> redirect takes. */
export interface Platform {
	id: 'mac' | 'windows' | 'linux-deb' | 'linux-appimage';
	os: 'mac' | 'windows' | 'linux';
	label: string;
	detail: string;
	name: string;
	/** Direct asset URL on the GitHub release. */
	url: string;
	/** Countable redirect on this site (functions/download/[os].ts). */
	href: string;
}

export interface Release {
	tag: string;
	version: string;
	/** Publish date, YYYY-MM-DD. */
	date: string;
	/** True when the data came from GitHub during this build, false for the pinned fallback. */
	live: boolean;
	/** True when the release carries CHECKSUM_FILE. */
	checksums: boolean;
	platforms: Platform[];
}

function assetNames(version: string) {
	return {
		mac: `Ikenga_${version}_universal.dmg`,
		windows: `Ikenga_${version}_x64-setup.exe`,
		'linux-deb': `Ikenga_${version}_amd64.deb`,
		'linux-appimage': `Ikenga_${version}_amd64.AppImage`,
	} as const;
}

/** Build the platform list for a tag. An empty `available` set trusts the canonical asset names. */
export function platformsFor(tag: string, available: Set<string> = new Set()): Platform[] {
	const version = tag.replace(/^v/, '');
	const names = assetNames(version);
	const base = `https://github.com/${RELEASE_REPO}/releases/download/${tag}`;
	const rows: Omit<Platform, 'url' | 'href' | 'name'>[] = [
		{ id: 'mac', os: 'mac', label: 'macOS', detail: 'universal' },
		{ id: 'windows', os: 'windows', label: 'Windows', detail: 'x64' },
		{ id: 'linux-deb', os: 'linux', label: 'Linux', detail: '.deb' },
		{ id: 'linux-appimage', os: 'linux', label: 'Linux', detail: 'AppImage' },
	];
	return rows
		.map((r) => ({ ...r, name: names[r.id], url: `${base}/${names[r.id]}`, href: `/download/${r.id}` }))
		.filter((p) => available.size === 0 || available.has(p.name));
}

async function fetchLatest(timeoutMs: number): Promise<Release> {
	const fallback = (): Release => ({
		tag: FALLBACK.tag,
		version: FALLBACK.tag.replace(/^v/, ''),
		date: FALLBACK.date,
		live: false,
		checksums: FALLBACK.checksums,
		platforms: platformsFor(FALLBACK.tag),
	});
	try {
		const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
			headers: { accept: 'application/vnd.github+json', 'user-agent': 'ikenga-site-build' },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return fallback();
		const data = (await res.json()) as {
			tag_name?: string;
			published_at?: string;
			assets?: { name: string }[];
		};
		if (!data?.tag_name) return fallback();
		const available = new Set((data.assets ?? []).map((a) => a.name));
		return {
			tag: data.tag_name,
			version: data.tag_name.replace(/^v/, ''),
			date: (data.published_at ?? '').slice(0, 10) || FALLBACK.date,
			live: true,
			checksums: available.has(CHECKSUM_FILE),
			platforms: platformsFor(data.tag_name, available),
		};
	} catch {
		return fallback();
	}
}

const CACHE_KEY = Symbol.for('ikenga.site.latest-release');

/** The latest release. One lookup per build process; never throws. */
export function latestRelease(timeoutMs = 8000): Promise<Release> {
	const g = globalThis as unknown as Record<symbol, Promise<Release> | undefined>;
	g[CACHE_KEY] ??= fetchLatest(timeoutMs);
	return g[CACHE_KEY]!;
}
