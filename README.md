# ikenga-site

Marketing site and documentation for [Ikenga](https://ikenga.dev) — your personal seat of strength for AI-augmented work.

User-facing copy follows the locked vocabulary in `design/shell/05-lore-and-nomenclature.md` (Tier-1 surface terms: Ikenga, Obi, Chi, Iyke, plus the rituals — consecration, daily address, share kola).

**Status**: private, pre-launch. Flip to public + Apache-2.0 at announce.

## Stack

- **Astro 5** + **Starlight** — one site, two sections: marketing at `/`, docs at `/docs/*`
- **Tailwind CSS 4** via the official Vite plugin
- **React 19** for the handful of interactive islands (AppBridge sandbox, token explorer)
- **`@ikenga/tokens`** consumed via `workspace:*` so the site stays visually locked to the shell
- **Pagefind** for static, infra-free search (Starlight default)

## Develop

```bash
# from the workspace root, once
pnpm install

# then
cd site
pnpm dev          # http://localhost:4321
pnpm build        # static output to dist/
pnpm preview      # serve dist/
pnpm check        # astro + typescript checks
```

### Checks

CI (`.github/workflows/ci.yml`) runs these on every push and pull request. Run `pnpm build` first, then:

```bash
node scripts/redirect-test.mjs                             # every public route, both slash forms (list: scripts/routes.txt)
node scripts/check-links.mjs                               # broken links and #anchors in dist/ (--external also checks other sites)
pnpm build 2>&1 | tee build.log
node scripts/check-registry-fallback.mjs --log build.log   # the /packages catalog was built from live registry data
node scripts/contrast-check.mjs                            # colour contrast of the design tokens
pnpm dlx @lhci/cli@0.15.1 autorun                          # Lighthouse on /, /packages/ and /docs/ (needs Chrome)
```

Every script except Lighthouse takes `--self-test`, which proves the check fails on a seeded problem and passes on a good one. `node scripts/redirect-test.mjs --base https://ikenga.dev` tests a deployed site with real requests instead of the build.

## Content layout

```
src/
├── pages/
│   └── index.astro                  → /            marketing landing
└── content/docs/docs/               (the inner "docs" is part of the URL prefix)
    ├── index.mdx                    → /docs/
    ├── getting-started.mdx          → /docs/getting-started
    ├── pkgs/index.mdx               → /docs/pkgs
    ├── engines/index.mdx            → /docs/engines
    └── mcp-iyke.mdx                 → /docs/mcp-iyke
```

Add marketing pages under `src/pages/`. Add docs under `src/content/docs/docs/` and they show up in the Starlight sidebar automatically (configured in `astro.config.mjs`).

## Deploy

Target: **Cloudflare Pages**, Git-connected to this repo, auto-deploy on push to `main`.

Build settings:

- **Framework preset**: `Astro`
- **Build command**: `pnpm build` (set `PNPM_VERSION=10` env var) — or fall back to `npm run build`
- **Build output directory**: `dist`
- **Root directory**: `/`
- **Node version**: pinned by `.nvmrc` (22)

Custom domain: `ikenga.dev` (apex). The Cloudflare zone is already onboarded; attach via Pages → Custom domains → Set up a custom domain → `ikenga.dev`.

### Note on `@ikenga/tokens`

The dep is declared as `^0.1.0` (a real npm version, not `workspace:*`) so Cloudflare's standalone clone can resolve it from the registry. Locally inside the meta-repo, pnpm's `link-workspace-packages` (default `true`) still overrides with the workspace copy — both worlds work without changing imports.
