// Unit tests for Cloudflare Pages Function: functions/api/contact.ts
//
// Tests:
// 1. Validation for every field (name, email, company, team size, topic, message, consent)
// 2. Honeypot field handling (silent acceptance without calling email service)
// 3. IP-based rate limiting
// 4. Missing secret path (503 and "Email hello@royalti.io instead")
// 5. Non-JS plain form POST redirection to /contact?sent=1
// 6. Resend email dispatch contract

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	onRequestPost,
	resetRateLimits,
	ALLOWED_TOPICS,
	ALLOWED_TEAM_SIZES,
} from './contact.ts';

const VALID_DATA = {
	name: 'Ada Lovelace',
	email: 'ada@analytical.dev',
	company: 'Analytical Engines Ltd',
	team_size: '2-10',
	topic: 'enterprise',
	message: 'We are evaluating Ikenga for our coding agent workflows.',
	consent: true,
};

const DEFAULT_ENV = {
	RESEND_API_KEY: 're_test_123456789',
	CONTACT_TO: 'team@royalti.io',
	CONTACT_FROM: 'Ikenga Contact <contact@ikenga.dev>',
};

let requestCount = 0;
function createJsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
	requestCount += 1;
	return new Request('https://ikenga.dev/api/contact', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'cf-connecting-ip': `203.0.113.${requestCount % 250}`,
			...headers,
		},
		body: JSON.stringify(body),
	});
}

function createFormRequest(formData: Record<string, string>, headers: Record<string, string> = {}): Request {
	requestCount += 1;
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(formData)) {
		params.append(key, value);
	}
	return new Request('https://ikenga.dev/api/contact', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'cf-connecting-ip': `203.0.113.${requestCount % 250}`,
			...headers,
		},
		body: params.toString(),
	});
}

/** Mock global fetch to intercept Resend calls */
function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = handler as typeof globalThis.fetch;
	return () => {
		globalThis.fetch = originalFetch;
	};
}

beforeEach(() => {
	resetRateLimits();
});

// ─── 1. Validation ─────────────────────────────────────────────────────────────

test('validation: accepts valid payload with all fields', async () => {
	let fetchCalled = false;
	const restore = mockFetch(async (_url, init) => {
		fetchCalled = true;
		assert.equal(init?.method, 'POST');
		return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 });
	});

	try {
		const res = await onRequestPost({
			request: createJsonRequest(VALID_DATA),
			env: DEFAULT_ENV,
		});
		assert.equal(res.status, 200);
		const json = (await res.json()) as { ok?: boolean };
		assert.equal(json.ok, true);
		assert.equal(fetchCalled, true);
	} finally {
		restore();
	}
});

test('validation: rejects invalid or missing email', async () => {
	const invalidEmails = ['', 'not-an-email', 'missing-at.com', 'a@b', 'foo@.com', null, undefined];
	for (const email of invalidEmails) {
		const res = await onRequestPost({
			request: createJsonRequest({ ...VALID_DATA, email }),
			env: DEFAULT_ENV,
		});
		assert.equal(res.status, 400, `Expected 400 for email: ${email}`);
		const json = (await res.json()) as { error?: string };
		assert.match(json.error ?? '', /email/i);
	}
});

test('validation: rejects missing or empty name', async () => {
	const invalidNames = ['', '   ', null, undefined, 'a'.repeat(101)];
	for (const name of invalidNames) {
		const res = await onRequestPost({
			request: createJsonRequest({ ...VALID_DATA, name }),
			env: DEFAULT_ENV,
		});
		assert.equal(res.status, 400);
		const json = (await res.json()) as { error?: string };
		assert.match(json.error ?? '', /name/i);
	}
});

test('validation: rejects company name that is too long', async () => {
	const res = await onRequestPost({
		request: createJsonRequest({ ...VALID_DATA, company: 'x'.repeat(101) }),
		env: DEFAULT_ENV,
	});
	assert.equal(res.status, 400);
	const json = (await res.json()) as { error?: string };
	assert.match(json.error ?? '', /company/i);
});

test('validation: rejects missing or invalid team size', async () => {
	const invalidSizes = ['', '1000+', 'massive', null, undefined];
	for (const team_size of invalidSizes) {
		const res = await onRequestPost({
			request: createJsonRequest({ ...VALID_DATA, team_size }),
			env: DEFAULT_ENV,
		});
		assert.equal(res.status, 400);
		const json = (await res.json()) as { error?: string };
		assert.match(json.error ?? '', /team size/i);
	}

	// Every allowed team size must pass
	for (const team_size of ALLOWED_TEAM_SIZES) {
		const restore = mockFetch(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 }));
		try {
			const res = await onRequestPost({
				request: createJsonRequest({ ...VALID_DATA, team_size }, { 'cf-connecting-ip': `10.0.0.${team_size}` }),
				env: DEFAULT_ENV,
			});
			assert.equal(res.status, 200, `Team size ${team_size} should pass`);
		} finally {
			restore();
		}
	}
});

test('validation: rejects invalid topic and accepts all allowed topics', async () => {
	const invalidTopics = ['', 'billing', 'press', 'random', null, undefined];
	for (const topic of invalidTopics) {
		const res = await onRequestPost({
			request: createJsonRequest({ ...VALID_DATA, topic }),
			env: DEFAULT_ENV,
		});
		assert.equal(res.status, 400);
		const json = (await res.json()) as { error?: string };
		assert.match(json.error ?? '', /topic/i);
	}

	for (const topic of ALLOWED_TOPICS) {
		const restore = mockFetch(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 }));
		try {
			const res = await onRequestPost({
				request: createJsonRequest({ ...VALID_DATA, topic }, { 'cf-connecting-ip': `10.0.1.${topic}` }),
				env: DEFAULT_ENV,
			});
			assert.equal(res.status, 200, `Topic ${topic} should pass`);
		} finally {
			restore();
		}
	}
});

test('validation: rejects missing or empty message', async () => {
	const invalidMessages = ['', '   ', null, undefined, 'a'.repeat(5001)];
	for (const message of invalidMessages) {
		const res = await onRequestPost({
			request: createJsonRequest({ ...VALID_DATA, message }),
			env: DEFAULT_ENV,
		});
		assert.equal(res.status, 400);
		const json = (await res.json()) as { error?: string };
		assert.match(json.error ?? '', /message/i);
	}
});

test('validation: rejects missing consent checkbox', async () => {
	const invalidConsents = [false, 'false', '', null, undefined, 'off'];
	for (const consent of invalidConsents) {
		const res = await onRequestPost({
			request: createJsonRequest({ ...VALID_DATA, consent }),
			env: DEFAULT_ENV,
		});
		assert.equal(res.status, 400);
		const json = (await res.json()) as { error?: string };
		assert.match(json.error ?? '', /agree|consent/i);
	}
});

// ─── 2. Honeypot ───────────────────────────────────────────────────────────────

test('honeypot: silently accepts submission without sending email when honeypot field is filled', async () => {
	let fetchCalled = false;
	const restore = mockFetch(async () => {
		fetchCalled = true;
		return new Response(JSON.stringify({ id: '1' }), { status: 200 });
	});

	try {
		// Even if env is completely missing or invalid, honeypot accepts silently
		const res = await onRequestPost({
			request: createJsonRequest({ ...VALID_DATA, website: 'https://spam-bot.example.com' }),
			env: {},
		});
		assert.equal(res.status, 200);
		const json = (await res.json()) as { ok?: boolean };
		assert.equal(json.ok, true);
		assert.equal(fetchCalled, false, 'Honeypot submission must not send email');
	} finally {
		restore();
	}
});

test('honeypot: redirects non-JS form submission when honeypot is filled', async () => {
	let fetchCalled = false;
	const restore = mockFetch(async () => {
		fetchCalled = true;
		return new Response(JSON.stringify({ id: '1' }), { status: 200 });
	});

	try {
		const res = await onRequestPost({
			request: createFormRequest({
				name: VALID_DATA.name,
				email: VALID_DATA.email,
				team_size: VALID_DATA.team_size,
				topic: VALID_DATA.topic,
				message: VALID_DATA.message,
				consent: 'on',
				website: 'bot-content',
			}),
			env: {},
		});
		assert.equal(res.status, 303);
		assert.match(res.headers.get('location') ?? '', /\/contact\?sent=1/);
		assert.equal(fetchCalled, false);
	} finally {
		restore();
	}
});

// ─── 3. Rate Limiting ──────────────────────────────────────────────────────────

test('rate limit: allows up to 5 requests per IP, then returns 429', async () => {
	const restore = mockFetch(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 }));
	const testIp = '198.51.100.42';

	try {
		// First 5 requests must succeed
		for (let i = 0; i < 5; i++) {
			const res = await onRequestPost({
				request: createJsonRequest(VALID_DATA, { 'cf-connecting-ip': testIp }),
				env: DEFAULT_ENV,
			});
			assert.equal(res.status, 200, `Request ${i + 1} should succeed`);
		}

		// 6th request from the same IP must be rate limited
		const blockedRes = await onRequestPost({
			request: createJsonRequest(VALID_DATA, { 'cf-connecting-ip': testIp }),
			env: DEFAULT_ENV,
		});
		assert.equal(blockedRes.status, 429);
		const json = (await blockedRes.json()) as { error?: string };
		assert.match(json.error ?? '', /too many requests/i);

		// Different IP should still succeed
		const otherIpRes = await onRequestPost({
			request: createJsonRequest(VALID_DATA, { 'cf-connecting-ip': '198.51.100.99' }),
			env: DEFAULT_ENV,
		});
		assert.equal(otherIpRes.status, 200);
	} finally {
		restore();
	}
});

// ─── 4. Missing Secrets ────────────────────────────────────────────────────────

test('missing secret: returns 503 and prompt to email hello@royalti.io when RESEND_API_KEY is unset', async () => {
	const res = await onRequestPost({
		request: createJsonRequest(VALID_DATA),
		env: { CONTACT_TO: 'team@royalti.io' },
	});
	assert.equal(res.status, 503);
	const json = (await res.json()) as { error?: string };
	assert.equal(json.error, 'Email hello@royalti.io instead');
});

test('missing secret: returns 503 and prompt to email hello@royalti.io when CONTACT_TO is unset', async () => {
	const res = await onRequestPost({
		request: createJsonRequest(VALID_DATA),
		env: { RESEND_API_KEY: 're_secret_key' },
	});
	assert.equal(res.status, 503);
	const json = (await res.json()) as { error?: string };
	assert.equal(json.error, 'Email hello@royalti.io instead');
});

// ─── 5. Non-JS Plain Form POST ─────────────────────────────────────────────────

test('form POST: non-JS submission redirects to /contact?sent=1 with 303', async () => {
	const restore = mockFetch(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 }));
	try {
		const res = await onRequestPost({
			request: createFormRequest({
				name: VALID_DATA.name,
				email: VALID_DATA.email,
				company: VALID_DATA.company,
				team_size: VALID_DATA.team_size,
				topic: VALID_DATA.topic,
				message: VALID_DATA.message,
				consent: 'on',
				website: '',
			}),
			env: DEFAULT_ENV,
		});
		assert.equal(res.status, 303);
		assert.match(res.headers.get('location') ?? '', /\/contact\?sent=1/);
	} finally {
		restore();
	}
});

// ─── 6. Privacy: Never log message body or email ────────────────────────────────

test('privacy: message body and email are never printed to console logs', async () => {
	const logs: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	console.log = (...args) => logs.push(args.join(' '));
	console.error = (...args) => logs.push(args.join(' '));

	const sensitiveEmail = 'super-secret-donor@example.com';
	const sensitiveMessage = 'A secret message body with proprietary info';

	const restore = mockFetch(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 }));

	try {
		await onRequestPost({
			request: createJsonRequest({
				...VALID_DATA,
				email: sensitiveEmail,
				message: sensitiveMessage,
			}),
			env: DEFAULT_ENV,
		});

		const fullOutput = logs.join('\n');
		assert.equal(fullOutput.includes(sensitiveEmail), false, 'Email must never appear in logs');
		assert.equal(fullOutput.includes(sensitiveMessage), false, 'Message must never appear in logs');
	} finally {
		console.log = originalLog;
		console.error = originalError;
		restore();
	}
});
