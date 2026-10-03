// Where the calls to action on /teams and /security point.
//
// The contact, pricing and roadmap pages are being built alongside these pages.
// Each link points at its page once that page exists in this build, and at the
// closest page that exists today until then, so no build ships a link to a
// missing page and none needs editing when the pages land.
const PAGES = Object.keys(import.meta.glob('/src/pages/**/*.{astro,md,mdx}'));

/** True when this build has a page at `/<route>/`. */
export function hasPage(route: string): boolean {
	return PAGES.some((p) => {
		const rel = p.replace(/^\/src\/pages\//, '').replace(/\.(astro|mdx?)$/, '');
		return rel === route || rel === `${route}/index`;
	});
}

export type ContactTopic = 'team' | 'enterprise' | 'other';

const MAIL_SUBJECT: Record<ContactTopic, string> = {
	team: 'Ikenga for teams',
	enterprise: 'Ikenga Enterprise',
	other: 'Ikenga security questionnaire',
};

/** "Talk to us": the contact page with its topic set, or email until that page exists. */
export function contactHref(topic: ContactTopic): string {
	return hasPage('contact')
		? `/contact/?topic=${topic}`
		: `mailto:hello@royalti.io?subject=${encodeURIComponent(MAIL_SUBJECT[topic])}`;
}

/** Plans and prices. */
export const PRICING_HREF = hasPage('pricing') ? '/pricing/' : '/#pricing';

/** The roadmap. */
export const ROADMAP_HREF = hasPage('roadmap') ? '/roadmap/' : '/#coming';

/** The organisation's security policy, with how to report a vulnerability. */
export const SECURITY_POLICY_HREF = 'https://github.com/ikenga-hq/.github/blob/main/SECURITY.md';
