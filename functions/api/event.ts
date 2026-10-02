// Cloudflare Pages Function: POST /api/event
//
// Counts a handful of anonymous product events (see EVENT_NAMES in
// ../_lib/events.ts). Body: { name, path, props? }. Unknown event names are
// rejected with 400. Props are cut down to an allowlist of short tokens. The
// function never reads or stores the IP, User-Agent or any other request header.
//
// Storage: Workers Analytics Engine when the Pages project has a binding named
// EVENTS, else a structured console.log line. See ../_lib/events.ts for the
// binding setup and column layout.
//
// Responses: 204 counted, 400 bad input, 403 cross-origin, 405 wrong method,
// 413 body too large.

import { cleanPath, cleanProps, isEventName, recordEvent, type EventEnv } from '../_lib/events.ts';

const MAX_BODY_BYTES = 2048;

const json = (data: unknown, status: number): Response =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});

export const onRequestPost = async (context: {
	request: Request;
	env: EventEnv;
}): Promise<Response> => {
	const { request, env } = context;

	// Browsers always send Origin on a cross-origin POST. A mismatch means a
	// different site is trying to inflate our counts; refuse it. Requests with no
	// Origin (curl, server-side) are allowed: the allowlist bounds what they can do.
	const origin = request.headers.get('origin');
	if (origin !== null) {
		let sameOrigin = false;
		try {
			sameOrigin = new URL(origin).host === new URL(request.url).host;
		} catch {
			/* unparseable Origin (e.g. the literal "null") falls through to refusal */
		}
		if (!sameOrigin) return json({ error: 'Forbidden.' }, 403);
	}

	const declared = Number(request.headers.get('content-length') ?? 0);
	if (declared > MAX_BODY_BYTES) return json({ error: 'Payload too large.' }, 413);

	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return json({ error: 'Invalid request.' }, 400);
	}
	if (raw.length > MAX_BODY_BYTES) return json({ error: 'Payload too large.' }, 413);

	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return json({ error: 'Invalid request.' }, 400);
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return json({ error: 'Invalid request.' }, 400);
	}
	const { name, path, props } = body as Record<string, unknown>;

	if (!isEventName(name)) return json({ error: 'Unknown event.' }, 400);

	const cleanedPath = cleanPath(path);
	if (cleanedPath === null) return json({ error: 'Invalid path.' }, 400);

	recordEvent(env, { name, path: cleanedPath, props: cleanProps(props) });
	return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};

// Any other method (GET from a crawler, an OPTIONS preflight from another
// origin) gets a plain 405. onRequestPost above takes precedence for POST.
export const onRequest = (): Response =>
	new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
