import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { topicSchema } from 'starlight-sidebar-topics/schema';
import type { Loader } from 'astro/loaders';

// `docsLoader()` is typed against a duplicate `astro` install pnpm hoists for
// `@astrojs/starlight` (structurally identical, nominally distinct `Loader`).
// Cast to this project's own `Loader` type — no behavior change, just aligns
// the type identity so `astro check` doesn't flag a false mismatch.
export const collections = {
	docs: defineCollection({
		loader: docsLoader() as Loader,
		// SPIKE (WP-06): `topic` frontmatter lets an unlisted page join a topic.
		schema: docsSchema({ extend: topicSchema }),
	}),
};
