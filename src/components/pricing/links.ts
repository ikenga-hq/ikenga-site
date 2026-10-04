// Where the pricing page's links point.
//
// The contact, teams, security and roadmap pages are being built alongside this
// page. Each link points at its page once that page exists in this build, and at
// the closest thing that exists today until then, so no build ships a link to a
// missing page and none needs editing when the pages land.
const PAGES = Object.keys(import.meta.glob('/src/pages/**/*.{astro,md,mdx}'));

/** True when this build has a page at `/<route>/`. */
export function hasPage(route: string): boolean {
	return PAGES.some((p) => {
		const rel = p.replace(/^\/src\/pages\//, '').replace(/\.(astro|mdx?)$/, '');
		return rel === route || rel === `${route}/index`;
	});
}

const MAIL_SUBJECT: Record<string, string> = {
	personal: 'Ikenga Personal',
	team: 'Ikenga for teams',
	enterprise: 'Ikenga Enterprise',
	managed: 'Ikenga managed instance',
};

/**
 * A call to action from the truth data. A `/contact/?topic=<topic>` link stays as it is once the
 * contact page exists; until then it becomes an email with the topic in the subject.
 */
export function ctaHref(href: string): string {
	const m = /^\/contact\/?\?topic=([a-z-]+)$/.exec(href);
	if (!m || hasPage('contact')) return href;
	const subject = MAIL_SUBJECT[m[1] as string] ?? 'Ikenga';
	return `mailto:hello@royalti.io?subject=${encodeURIComponent(subject)}`;
}

/** "Talk to us" about a topic the truth data has no call to action for (the managed instance). */
export function contactHref(topic: keyof typeof MAIL_SUBJECT): string {
	return ctaHref(`/contact/?topic=${topic}`);
}

export const TEAMS_HREF = hasPage('teams') ? '/teams/' : '/#teams';
export const SECURITY_HREF = hasPage('security') ? '/security/' : '/#trust';
export const ROADMAP_HREF = hasPage('roadmap') ? '/roadmap/' : '/#coming';
