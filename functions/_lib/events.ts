// Shared event recording for the analytics Pages Functions.
//
// Used by:
//   functions/api/event.ts        POST /api/event       (client beacons)
//   functions/download/[os].ts    GET  /download/<os>   (countable download redirect)
//
// This file exports no onRequest* handler, so Pages does not turn it into a route.
//
// What an event is: a name from a fixed allowlist, the page path, and at most a
// few short, charset-restricted props. That is everything we store. Nothing here
// reads the client IP, the User-Agent, cookies or any other request header, so
// there is nothing of the sort to leak into storage or logs.
//
// Storage, in order of preference:
//
//   1. Workers Analytics Engine, when the Pages project has an Analytics Engine
//      binding named EVENTS (Pages -> Settings -> Bindings -> Add -> Analytics
//      engine; variable name EVENTS, dataset ikenga_events). Column layout, fixed
//      so queries stay stable:
//        index1 = event name
//        blob1  = event name      blob2 = page path
//        blob3  = os              blob4 = source     blob5 = tier
//        blob6  = tag             blob7 = method     blob8 = variant   ('' when absent)
//        double1 = 1
//      Example (7-day counts per event):
//        SELECT blob1 AS event, SUM(_sample_interval) AS n
//        FROM ikenga_events WHERE timestamp > NOW() - INTERVAL '7' DAY
//        GROUP BY event ORDER BY n DESC
//
//   2. Otherwise one structured console.log line per event, tagged
//      "ikenga_event", which Cloudflare's log tooling (real-time tail, and Workers
//      Logs when enabled) captures. This keeps the endpoint working before the
//      binding exists; it is a stopgap, not a database.

export const EVENT_NAMES = [
	'cta_download',
	'install_copy',
	'pricing_view',
	'contact_submit',
	'newsletter_subscribe',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** The prop keys we accept, in Analytics Engine blob order (blob3 onward). */
export const PROP_KEYS = ['os', 'source', 'tier', 'tag', 'method', 'variant'] as const;
export type PropKey = (typeof PROP_KEYS)[number];
export type EventProps = Partial<Record<PropKey, string>>;

// Minimal structural type for the Analytics Engine binding, so this file needs
// no @cloudflare/workers-types.
export interface AnalyticsDataset {
	writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface EventEnv {
	EVENTS?: AnalyticsDataset;
}

// Prop values are short tokens (an OS id, a release tag, a tier slug). Anything
// else, an email address included, fails this and is dropped, never stored.
const SAFE_VALUE = /^[A-Za-z0-9._:-]{1,40}$/;
const PATH_MAX = 200;

export function isEventName(value: unknown): value is EventName {
	return typeof value === 'string' && (EVENT_NAMES as readonly string[]).includes(value);
}

/** Keep only allowlisted keys with token-shaped string values. Never throws. */
export function cleanProps(input: unknown): EventProps {
	const out: EventProps = {};
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return out;
	const src = input as Record<string, unknown>;
	for (const key of PROP_KEYS) {
		const value = src[key];
		if (typeof value === 'string' && SAFE_VALUE.test(value)) out[key] = value;
	}
	return out;
}

/**
 * Normalise a page path: must start with "/", query string and fragment are
 * dropped, printable ASCII only, at most 200 chars. Returns null if unusable.
 */
export function cleanPath(input: unknown): string | null {
	if (typeof input !== 'string') return null;
	const path = input.split(/[?#]/, 1)[0];
	if (path.length === 0 || path.length > PATH_MAX || path[0] !== '/') return null;
	if (!/^[\x21-\x7e]+$/.test(path)) return null;
	return path;
}

/** Store one event. Returns which sink took it, which the tests assert on. */
export function recordEvent(
	env: EventEnv,
	event: { name: EventName; path: string; props?: EventProps },
): 'analytics-engine' | 'log' {
	const props = event.props ?? {};
	if (env.EVENTS && typeof env.EVENTS.writeDataPoint === 'function') {
		env.EVENTS.writeDataPoint({
			indexes: [event.name],
			blobs: [event.name, event.path, ...PROP_KEYS.map((key) => props[key] ?? '')],
			doubles: [1],
		});
		return 'analytics-engine';
	}
	console.log(
		JSON.stringify({ type: 'ikenga_event', name: event.name, path: event.path, props }),
	);
	return 'log';
}
