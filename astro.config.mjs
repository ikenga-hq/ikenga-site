import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import icon from 'astro-icon';
import tailwindcss from '@tailwindcss/vite';

// Disable Astro's build-time telemetry (Astro's own, unrelated to visitor
// analytics). Visitor analytics are two things, neither bundled from this repo:
// Cloudflare Web Analytics, a cookie-free page-view beacon that Cloudflare
// injects when it is enabled for the Pages project in the dashboard, and an
// anonymous event counter at functions/api/event.ts (plus the countable
// functions/download/[os].ts redirect). The Footer states exactly what is collected.
process.env.ASTRO_TELEMETRY_DISABLED = '1';

// https://astro.build/config
export default defineConfig({
	site: 'https://ikenga.dev',
	integrations: [
		starlight({
			// The site ships its own src/pages/404.astro; Starlight's default
			// 404 route would collide (hard error in a future Astro version).
			disable404Route: true,
			title: 'Ikenga',
			description:
				'Your personal seat of strength for AI-augmented work.',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/ikenga-hq/ikenga',
				},
			],
			customCss: ['./src/styles/global.css'],
			// Five sections, one per audience: Use, Build, Reference, Operate, Contribute.
			// Every docs page must appear in exactly one of them.
			sidebar: [
				{
					label: 'Use',
					items: [
						'docs',
						{
							label: 'Get started',
							items: ['docs/use/install', 'docs/use/first-launch', 'docs/use/offline-install'],
						},
						{ label: 'Your workspace', items: ['docs/use/engines'] },
						{ label: 'Studio', autogenerate: { directory: 'docs/use/studio' } },
						{ label: 'Groundwork', autogenerate: { directory: 'docs/use/groundwork' } },
					],
				},
				{
					label: 'Build',
					items: ['docs/build/archetypes', 'docs/build/first-pkg', 'docs/build/manifest'],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Overview', slug: 'docs/reference' },
						'docs/reference/glossary',
						{ label: 'Catalogue', autogenerate: { directory: 'docs/reference/catalogue' } },
					],
				},
				{
					label: 'Operate',
					badge: { text: 'Beta', variant: 'caution' },
					items: ['docs/operate'],
				},
				{
					label: 'Contribute',
					items: ['docs/contribute'],
				},
			],
		}),
		react(),
		icon(),
		sitemap({
			// Exclude the internal moment/graph preview harnesses — they
			// carry their own `noindex, nofollow` meta (see moment-lab.astro,
			// moment-lab-2.astro, graph-lab.astro) but @astrojs/sitemap doesn't
			// read page-level robots meta, so list them here too.
			filter: (page) => !/\/(moment-lab|moment-lab-2|graph-lab)\/?$/.test(page),
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
