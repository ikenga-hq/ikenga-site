import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import icon from 'astro-icon';
import tailwindcss from '@tailwindcss/vite';

// Disable Astro's build-time telemetry. The site carries no analytics.
process.env.ASTRO_TELEMETRY_DISABLED = '1';

// https://astro.build/config
export default defineConfig({
	site: 'https://ikenga.dev',
	integrations: [
		starlight({
			// The site ships its own src/pages/404.astro (WP-18); Starlight's default
			// 404 route would collide (hard error in a future Astro version).
			disable404Route: true,
			title: 'Ikenga',
			description:
				'Your personal seat of strength for AI-augmented work.',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/Royalti-io/ikenga',
				},
			],
			customCss: ['./src/styles/global.css'],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'What is Ikenga?', slug: 'docs' },
						{ label: 'Install', slug: 'docs/getting-started' },
						{ label: 'Build your first pkg', slug: 'docs/build-a-pkg' },
					],
				},
				{
					label: 'Groundwork',
					autogenerate: { directory: 'docs/groundwork' },
				},
				{
					label: 'Studio',
					autogenerate: { directory: 'docs/studio' },
				},
				{
					label: 'Pkgs',
					autogenerate: { directory: 'docs/pkgs' },
				},
				{
					label: 'Engines',
					autogenerate: { directory: 'docs/engines' },
				},
				{
					label: 'MCP',
					items: [{ label: 'mcp-iyke', slug: 'docs/mcp-iyke' }],
				},
				{
					label: 'Contribute',
					items: [{ label: 'Contributing', slug: 'docs/contributing' }],
				},
			],
		}),
		react(),
		icon(),
		sitemap({
			// WP-18: exclude the internal moment/graph preview harnesses — they
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
