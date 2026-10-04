// Cloudflare Pages Function — POST /api/contact
//
// Contact form submission handler sending via Resend.
//
// Validates all fields server-side, detects bot spam via honeypot,
// enforces IP-based rate limiting, and forwards submissions to the
// team inbox via Resend when configured.
//
// Env (Pages -> Settings -> Variables; mirror in site/.dev.vars for
// `wrangler pages dev`):
//   RESEND_API_KEY    Resend API key with email sending access (mark as Secret)
//   CONTACT_TO        Destination email address for contact submissions (e.g. hello@royalti.io)
//   CONTACT_FROM      Optional verified sender address (defaults to Ikenga Contact <contact@ikenga.dev>)

export interface Env {
	RESEND_API_KEY?: string;
	CONTACT_TO?: string;
	CONTACT_FROM?: string;
}

export const ALLOWED_TOPICS = ['personal', 'team', 'enterprise', 'managed', 'security', 'other'] as const;
export type Topic = (typeof ALLOWED_TOPICS)[number];

export const ALLOWED_TEAM_SIZES = ['1', '2-10', '11-50', '51-200', '201+'] as const;
export type TeamSize = (typeof ALLOWED_TEAM_SIZES)[number];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const json = (data: unknown, status = 200): Response =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' },
	});

// In-memory sliding-window rate limiter per isolate:
// 5 submissions per 10 minutes per IP address.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const ipRequests = new Map<string, number[]>();

export function getClientIp(request: Request): string {
	return (
		request.headers.get('cf-connecting-ip') ||
		request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
		request.headers.get('x-real-ip') ||
		'127.0.0.1'
	);
}

export function checkRateLimit(
	ip: string,
	limit = MAX_REQUESTS_PER_WINDOW,
	windowMs = RATE_LIMIT_WINDOW_MS,
	now = Date.now(),
): boolean {
	const timestamps = (ipRequests.get(ip) ?? []).filter((t) => now - t < windowMs);
	if (timestamps.length >= limit) {
		return false;
	}
	timestamps.push(now);
	ipRequests.set(ip, timestamps);
	return true;
}

export function resetRateLimits(): void {
	ipRequests.clear();
}

function errorResponse(
	message: string,
	status: number,
	isJson: boolean,
): Response {
	if (isJson) {
		return json({ error: message }, status);
	}
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Error</title></head><body><p>${message}</p><p><a href="/contact">Return to contact form</a></p></body></html>`,
		{
			status,
			headers: { 'content-type': 'text/html; charset=utf-8' },
		},
	);
}

export const onRequestPost = async (context: {
	request: Request;
	env: Env;
}): Promise<Response> => {
	const { request, env } = context;

	const contentType = request.headers.get('content-type') || '';
	const accept = request.headers.get('accept') || '';
	const isJson = contentType.includes('application/json') || accept.includes('application/json');

	let body: Record<string, unknown> = {};

	if (contentType.includes('application/json')) {
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return errorResponse('Invalid JSON request.', 400, isJson);
		}
	} else if (
		contentType.includes('application/x-www-form-urlencoded') ||
		contentType.includes('multipart/form-data')
	) {
		try {
			const formData = await request.formData();
			for (const [key, value] of formData.entries()) {
				body[key] = value;
			}
		} catch {
			return errorResponse('Invalid form data.', 400, isJson);
		}
	} else {
		// Fallback: try parsing JSON first
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return errorResponse('Unsupported content type.', 400, isJson);
		}
	}

	// 1. Honeypot check: hidden field "website" filled by bots. Accept silently without sending.
	const honeypot = typeof body.website === 'string' ? body.website.trim() : '';
	if (honeypot !== '') {
		if (!isJson) {
			return Response.redirect(new URL('/contact?sent=1#sent', request.url).toString(), 303);
		}
		return json({ ok: true });
	}

	// 2. IP Rate Limiting
	const clientIp = getClientIp(request);
	if (!checkRateLimit(clientIp)) {
		return errorResponse('Too many requests. Please try again later.', 429, isJson);
	}

	// 3. Validation
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name || name.length > 100) {
		return errorResponse('Enter your name (up to 100 characters).', 400, isJson);
	}

	const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
	if (!EMAIL_RE.test(email) || email.length > 254) {
		return errorResponse('Enter a valid work email address.', 400, isJson);
	}

	const company = typeof body.company === 'string' ? body.company.trim() : '';
	if (company.length > 100) {
		return errorResponse('Company name must be 100 characters or fewer.', 400, isJson);
	}

	const teamSize = typeof (body.team_size ?? body.teamSize) === 'string'
		? String(body.team_size ?? body.teamSize).trim()
		: '';
	if (!ALLOWED_TEAM_SIZES.includes(teamSize as TeamSize)) {
		return errorResponse('Select a valid team size.', 400, isJson);
	}

	const topic = typeof body.topic === 'string' ? body.topic.trim().toLowerCase() : '';
	if (!ALLOWED_TOPICS.includes(topic as Topic)) {
		return errorResponse('Select a valid topic.', 400, isJson);
	}

	const message = typeof body.message === 'string' ? body.message.trim() : '';
	if (!message || message.length > 5000) {
		return errorResponse('Enter your message (up to 5000 characters).', 400, isJson);
	}

	const consentRaw = body.consent;
	const consent = consentRaw === true || consentRaw === 'true' || consentRaw === 'on' || consentRaw === '1';
	if (!consent) {
		return errorResponse('You must agree to be contacted about this request.', 400, isJson);
	}

	// 4. Missing secret check:
	// If RESEND_API_KEY or CONTACT_TO are unset, return 503 and prompt visitor to email directly.
	if (!env.RESEND_API_KEY || !env.CONTACT_TO) {
		return errorResponse('Email hello@royalti.io instead', 503, isJson);
	}

	// 5. Send via Resend
	// NOTE: Never log email or message body.
	const fromAddress = env.CONTACT_FROM || 'Ikenga Contact <contact@ikenga.dev>';
	const recipients = env.CONTACT_TO.split(',').map((s) => s.trim()).filter(Boolean);

	let res: Response;
	try {
		res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.RESEND_API_KEY}`,
			},
			body: JSON.stringify({
				from: fromAddress,
				to: recipients,
				reply_to: email,
				subject: `[Ikenga Contact] ${topic}: ${name}${company ? ` (${company})` : ''}`,
				text: [
					`Name: ${name}`,
					`Work Email: ${email}`,
					`Company: ${company || 'N/A'}`,
					`Team Size: ${teamSize}`,
					`Topic: ${topic}`,
					'',
					'Message:',
					message,
				].join('\n'),
			}),
		});
	} catch {
		return errorResponse('Could not reach the mailing service. Please try again or email hello@royalti.io.', 502, isJson);
	}

	if (!res.ok) {
		return errorResponse('Could not send message right now. Please try again or email hello@royalti.io.', 502, isJson);
	}

	if (!isJson) {
		return Response.redirect(new URL('/contact?sent=1#sent', request.url).toString(), 303);
	}

	return json({ ok: true });
};
