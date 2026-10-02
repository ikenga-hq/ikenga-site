/**
 * Ikenga truth layer: schema and claim contract v1
 *
 * LANDED-AS: site/src/data/truth/schema.ts (WP-11). Copied from the plan draft
 * `plans/2026-10-02-site-docs-enterprise-overhaul/drafts/truth-schema.ts` (WP-04, gate G-TRUTH).
 * The only delta from the draft is the import line below: `zod` becomes `astro/zod`, which the
 * draft header allows. `astro/zod` re-exports the zod that Astro already depends on, so the
 * site needs no new dependency and `scripts/verify-truth.mjs` (plain Node) resolves it.
 * Change the contract in the plan draft first, then re-copy it here.
 *
 * Original draft header follows.
 * DRAFT-FOR: site/src/data/truth/schema.ts. WP-11 assembles it into `site`. Consumers:
 *   WP-08/09/10 (inventory rows), WP-12 (glossary), WP-31 (tiers), WP-11 (verifier and lints),
 *   WP-20 (truth sync), the <Feature> component (drafts/feature-component.md), /roadmap,
 *   /pricing, /teams, /changelog and the docs.
 * Built fresh in WP-04 (gate G-TRUTH) from 01-plan.md §Architecture rules 1-3,
 * §Shared state contract (locked Round 2: G-01, G-05, G-06, G-08) and §Gates.
 * The draft is the source of truth until it lands (drafts/README.md).
 *
 * Runtime contract
 *   - Zod only (`import { z } from 'zod'`). The code uses only the API that Zod 3.25 and Zod 4
 *     share (object().strict(), superRefine, enum, literal, nullable, optional, regex, array
 *     min/max), so it validates under either major. The site may swap the import for
 *     `astro/zod` without other changes.
 *   - Erasable TypeScript only (no `enum`, namespaces or parameter properties), so Node's
 *     built-in type stripping can import this file directly from a `.mjs` verifier.
 *   - Pure: no fs and no network. Checking that a tag really exists in its repo is a network
 *     step and belongs to the WP-11 verifier. This file checks shape, the internal consistency
 *     of each row, cross-references within the set (TruthSetSchema), and public safety.
 *
 * What the contract encodes (G-TRUTH sign-off checklist)
 *   1. Honest inventory (rule 1, G-01). `status` shipped|beta ⇒ `since` (semver) is required
 *      AND `ref_public` must be a release reference (an ikenga-hq GitHub release/tag URL or an
 *      @ikenga npm version URL) whose version equals `since`. That is the "since + tag"
 *      encoding. Other statuses must not carry `since`, and may only link a public issue, PR or
 *      discussion (PR refs are valid only for in-progress/next/exploring).
 *   2. Lane is derived, never stored. RoadmapItem has no `lane` field, and strict objects make
 *      a stray `lane` key a hard error. `deriveLane(status)` is the only lane source.
 *   3. `limits[]` (public caveats, required, may be empty), `scope`, optional
 *      `fresh_install_ready`.
 *   4. Tier: `price` nullable; `includes`/`coming` are feature-id arrays (cross-checked against
 *      feature status in TruthSetSchema); `prerequisites` are gate ids; `availability` is
 *      early-access|self-serve|unavailable.
 *   5. Public-safety split (rule 3, G-05). Every hand-authored public row is scanned for the
 *      tokens T2, T3, DEC-, WP-, G-ACCESS and "hosted account", plus internal gate/gap ids
 *      (G-XX). Glossary `avoid[]` is exempt, because it exists to list banned terms.
 *
 * Deliberate refinements beyond the 01 field list (each is additive or derived from a lock):
 *   - Gate ids are PUBLIC slugs (`signing`, `multi-user-server`, ...), not internal ids.
 *     tiers.json ships in the public `site` repo, and the internal ids `G-ACCESS-BUILT` and
 *     `G-T1-GA` would trip the G-05 public-safety lint (G-ACCESS, and T1 is in glossary.avoid[]).
 *     The slug → internal gate mapping lives in drafts/truth-private/gate-map.json.
 *   - Feature ids are `<area>.<slug>` (at least one dot, first segment = `area`), so the claim
 *     lint can find an id in free prose without false hits on ordinary words.
 *   - GlossaryTerm gains `shell_label?`. It is required when shell_ui_status is `pr-needed`,
 *     because copy follows the shipped label until the UI matches (G-14). It must not appear in
 *     the same term's avoid[].
 *   - Tier `cta` is `{kind, label, href}`. kind `checkout` requires availability `self-serve`
 *     (DEC-27: no invoice or paid contract during early access).
 *   - Tier addons gain optional `prerequisites[]`. The managed add-on is gated by managed-ops
 *     while the Enterprise tier itself is not (06 §The offering).
 *   - Generated documents (ReleaseFacts, RegistrySnapshot) carry `asOf` and
 *     `origin: live|last-good` (G-06 fallback). `signing[os]` records method
 *     `ci-asset-inspection`, and a verdict (signed/unsigned) requires evidence.
 *
 * Currency and period: every price is USD per month. For annual billing, `price` is the
 * per-month figure billed annually and `price_monthly` is the month-to-month figure (Team:
 * 20 / 25, DEC-25).
 *
 * Validate a file (Node 22.18+ type stripping, run from a dir whose node_modules has zod):
 *   import { TRUTH_FILE_SCHEMAS, formatIssues } from './truth-schema.ts';
 *   const r = TRUTH_FILE_SCHEMAS['features.json'].safeParse(JSON.parse(text));
 *   if (!r.success) console.error(formatIssues(r.error.issues));
 *
 * Round-by-round changes:
 *   - WP-04 (2026-10-02): first freeze for gate G-TRUTH.
 */

import { z } from 'astro/zod';

// ───────────────────────────── primitives ─────────────────────────────

/** Semver 2.0.0 without a leading "v" (`0.18.6`, `1.0.0-rc.1`). */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export const SemverSchema = z.string().regex(SEMVER_RE, 'expected semver without a leading "v", e.g. 0.18.6');

function isRealDate(s: string): boolean {
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
/** Calendar date `YYYY-MM-DD`. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isRealDate, 'not a real calendar date');

/** ISO-8601 instant with an explicit offset (`2026-10-01T13:49:04Z`). */
export const IsoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/, 'expected ISO-8601 date-time with offset')
  .refine((s) => !isNaN(Date.parse(s)), 'not a real date-time');

export const NonEmptySchema = z.string().refine((s) => s.trim().length > 0 && s.trim() === s, 'must be non-empty with no leading or trailing whitespace');

/** Lower-case kebab slug: `chi`, `multi-user-server`. */
export const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SlugSchema = z.string().regex(SLUG_RE, 'expected a lower-case kebab slug');

/**
 * Feature id: `<area>.<slug>[.<slug>…]`, e.g. `chi.seats`, `ngwa.git-install`.
 * The dot makes ids distinctive, so the claim lint can find a bare id in free prose.
 */
export const FEATURE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
export const FeatureIdSchema = z.string().regex(FEATURE_ID_RE, 'expected a feature id "<area>.<slug>", e.g. chi.seats');
export type FeatureId = z.infer<typeof FeatureIdSchema>;

export const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const NpmNameSchema = z.string().regex(NPM_NAME_RE, 'expected an npm package name');

export const HttpsUrlSchema = z.string().regex(/^https:\/\/[^\s/?#]+[^\s]*$/, 'expected an https:// URL');

/** A link target: a site-relative path (`/contact/`) or an https URL. */
export const HrefSchema = z.string().regex(/^(?:\/(?!\/)[^\s]*|https:\/\/[^\s/?#]+[^\s]*)$/, 'expected a site-relative path or an https:// URL');

// ───────────────────────────── public references ─────────────────────────────

/** Public repos under github.com/ikenga-hq (LINKS.md). The workspace meta-repo is private. */
export const PUBLIC_REPOS = [
  'ikenga',
  'ikenga-contract',
  'ikenga-tokens',
  'ikenga-cli',
  'iyke-cli',
  'ikenga-registry',
  'ikenga-pkgs',
  'ikenga-artifact-builder',
  'ikenga-site',
  'ikenga-contribute',
  '.github',
] as const;

function isPublicRepo(repo: string): boolean {
  return (PUBLIC_REPOS as readonly string[]).indexOf(repo) !== -1;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** `v0.18.6` → `0.18.6`; `@ikenga/pkg-git@0.2.1` → `0.2.1`; `0.4.2` → `0.4.2`. */
export function versionFromTag(tag: string): string | null {
  let v = tag;
  const at = tag.lastIndexOf('@');
  if (at > 0) v = tag.slice(at + 1);
  else if (/^v\d/.test(tag)) v = tag.slice(1);
  return SEMVER_RE.test(v) ? v : null;
}

export type ReleaseRef =
  | { kind: 'github-release'; repo: string; tag: string; version: string }
  | { kind: 'npm'; pkg: string; version: string };

const GH_RELEASE_RE = /^https:\/\/github\.com\/ikenga-hq\/([A-Za-z0-9._-]+)\/releases\/tag\/([^?#]+)$/;
const NPM_VERSION_RE = /^https:\/\/www\.npmjs\.com\/package\/((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)\/v\/([^/?#]+)$/;
const GH_PUBLIC_THREAD_RE = /^https:\/\/github\.com\/ikenga-hq\/([A-Za-z0-9._-]+)\/(issues|pull|discussions)\/(\d+)$/;

/**
 * Parse a release reference: a GitHub release/tag page in a public ikenga-hq repo, or an npm
 * version page in the @ikenga scope. Returns null for anything else.
 */
export function parseReleaseRef(url: string): ReleaseRef | null {
  const gh = GH_RELEASE_RE.exec(url);
  if (gh) {
    const repo = gh[1] as string;
    const tag = safeDecode(gh[2] as string);
    if (!tag || !isPublicRepo(repo)) return null;
    const version = versionFromTag(tag);
    return version ? { kind: 'github-release', repo, tag, version } : null;
  }
  const npm = NPM_VERSION_RE.exec(url);
  if (npm) {
    const pkg = npm[1] as string;
    const version = safeDecode(npm[2] as string);
    if (!version || !SEMVER_RE.test(version) || pkg.indexOf('@ikenga/') !== 0) return null;
    return { kind: 'npm', pkg, version };
  }
  return null;
}

/** A public issue, pull request or discussion in a public ikenga-hq repo. */
export function isPublicThreadRef(url: string): boolean {
  const m = GH_PUBLIC_THREAD_RE.exec(url);
  return !!m && isPublicRepo(m[1] as string);
}

// ───────────────────────────── public safety (G-05) ─────────────────────────────

export interface PublicSafetyPattern {
  token: string;
  re: RegExp;
  /** `01`: listed in 01 §Architecture rule 3. `extension`: added by WP-04 (see header). */
  source: '01' | 'extension';
}

export const PUBLIC_SAFETY_PATTERNS: readonly PublicSafetyPattern[] = [
  { token: 'T2', re: /\bT2\b/, source: '01' },
  { token: 'T3', re: /\bT3\b/, source: '01' },
  { token: 'DEC-', re: /\bDEC-/i, source: '01' },
  { token: 'WP-', re: /\bWP-/i, source: '01' },
  { token: 'G-ACCESS', re: /\bG-ACCESS/i, source: '01' },
  { token: 'hosted account', re: /\bhosted[\s-]+accounts?\b/i, source: '01' },
  { token: 'internal gate or gap id (G-…)', re: /\bG-(?:[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*|\d{2})\b/, source: 'extension' },
];

/** Keys whose string values are exempt from the scan (glossary avoid[] lists banned terms). */
export const PUBLIC_SAFETY_EXEMPT_KEYS: readonly string[] = ['avoid'];

export interface PublicSafetyViolation {
  path: (string | number)[];
  token: string;
  value: string;
}

/** Walk any JSON value and report public-safety hits. Used by the row schemas and by WP-11. */
export function publicSafetyViolations(value: unknown, path: (string | number)[] = []): PublicSafetyViolation[] {
  const out: PublicSafetyViolation[] = [];
  if (typeof value === 'string') {
    for (const p of PUBLIC_SAFETY_PATTERNS) {
      if (p.re.test(value)) out.push({ path, token: p.token, value });
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      out.push(...publicSafetyViolations(v, path.concat(i)));
    });
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (PUBLIC_SAFETY_EXEMPT_KEYS.indexOf(k) !== -1) continue;
      out.push(...publicSafetyViolations(obj[k], path.concat(k)));
    }
  }
  return out;
}

/** Structural view of a Zod refinement context; satisfied by both Zod 3 and Zod 4. */
interface IssueSink {
  addIssue(issue: { code: 'custom'; message: string; path?: (string | number)[] }): void;
}

function fail(ctx: IssueSink, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
}

function checkPublicSafety(row: unknown, ctx: IssueSink): void {
  for (const v of publicSafetyViolations(row)) {
    fail(ctx, v.path, `public-safety: "${v.token}" must not appear in public truth (01 rule 3, G-05)`);
  }
}

function checkUnique(ctx: IssueSink, values: readonly string[], path: (string | number)[], what: string, fold = false): void {
  const seen: Record<string, true> = {};
  values.forEach((raw, i) => {
    const v = fold ? raw.toLowerCase() : raw;
    if (seen[v]) fail(ctx, path.concat(i), `duplicate ${what} "${raw}"`);
    seen[v] = true;
  });
}

// ───────────────────────────── features[] ─────────────────────────────

export const FEATURE_STATUSES = ['shipped', 'beta', 'in-progress', 'next', 'exploring'] as const;
export const FeatureStatusSchema = z.enum(FEATURE_STATUSES);
export type FeatureStatus = z.infer<typeof FeatureStatusSchema>;

/** Public badge words for <Feature> (drafts/feature-component.md). WP-12/WP-23 may refine them. */
export const STATUS_LABELS: Readonly<Record<FeatureStatus, string>> = {
  shipped: 'Shipped',
  beta: 'Beta',
  'in-progress': 'In progress',
  next: 'Next',
  exploring: 'Exploring',
};

/** Statuses that are released: they need `since` plus a release ref, and can appear in tiers[].includes. */
export const RELEASED_STATUSES: readonly FeatureStatus[] = ['shipped', 'beta'];
export function isReleased(status: FeatureStatus): boolean {
  return RELEASED_STATUSES.indexOf(status) !== -1;
}

export const FeatureScopeSchema = z.enum(['desktop', 'single-user-server', 'multi-user-server']);
export type FeatureScope = z.infer<typeof FeatureScopeSchema>;

/** The three site paths (DEC-3). */
export const AudienceSchema = z.enum(['individuals', 'builders', 'teams']);
export type Audience = z.infer<typeof AudienceSchema>;

export const FeatureSchema = z
  .object({
    /** `<area>.<slug>`; the first segment must equal `area`. Stable: pages reference it. */
    id: FeatureIdSchema,
    /** Grouping slug (chi, ngwa, vault, terminal, engines, ...). Kept open until G-IA. */
    area: SlugSchema,
    /** Plain-English name used first in copy (DEC-9). */
    plain_name: NonEmptySchema,
    /** Lore/product name when there is one (Chi, Ngwa, ...). */
    lore_name: NonEmptySchema.optional(),
    status: FeatureStatusSchema,
    /** Released version (no "v"). Required when shipped/beta; forbidden otherwise. */
    since: SemverSchema.optional(),
    /** shipped/beta: the release URL for `since` (required). Otherwise: a public issue, PR or discussion. */
    ref_public: HttpsUrlSchema.optional(),
    scope: FeatureScopeSchema,
    /** Public caveats, rendered by <Feature>. Required; use [] when there are none. */
    limits: z.array(NonEmptySchema),
    /** Operator apps: does it work on a fresh install with no founder data? (G-13, WP-16) */
    fresh_install_ready: z.boolean().optional(),
    audiences: z.array(AudienceSchema).min(1),
    last_verified: IsoDateSchema,
  })
  .strict()
  .superRefine((f, ctx) => {
    const released = isReleased(f.status);
    if (released && f.since === undefined) {
      fail(ctx, ['since'], `status "${f.status}" requires "since": shipped means released (01 rule 1, G-01)`);
    }
    if (!released && f.since !== undefined) {
      fail(ctx, ['since'], `status "${f.status}" must not carry "since": only released work has a version (G-01)`);
    }
    if (released) {
      if (f.ref_public === undefined) {
        fail(ctx, ['ref_public'], `status "${f.status}" requires "ref_public": the release URL for its tag (01 rule 1)`);
      } else {
        const ref = parseReleaseRef(f.ref_public);
        if (!ref) {
          fail(
            ctx,
            ['ref_public'],
            'a shipped/beta row must link a release: https://github.com/ikenga-hq/<public repo>/releases/tag/<tag> or https://www.npmjs.com/package/@ikenga/<name>/v/<version> (PR refs are for in-progress/next/exploring only)',
          );
        } else if (f.since !== undefined && ref.version !== f.since) {
          fail(ctx, ['ref_public'], `release ref version ${ref.version} does not match since ${f.since}`);
        }
      }
    } else if (f.ref_public !== undefined && !isPublicThreadRef(f.ref_public)) {
      fail(ctx, ['ref_public'], 'a non-released row may only link a public issue, PR or discussion in a public ikenga-hq repo');
    }
    const prefix = f.id.split('.')[0];
    if (prefix !== f.area) {
      fail(ctx, ['id'], `feature id must start with its area: expected "${f.area}.…", got "${f.id}"`);
    }
    checkUnique(ctx, f.audiences, ['audiences'], 'audience');
    checkUnique(ctx, f.limits, ['limits'], 'limit');
    checkPublicSafety(f, ctx);
  });
export type Feature = z.infer<typeof FeatureSchema>;

// ───────────────────────────── lanes (derived, never stored) ─────────────────────────────

export const LANES = ['shipped', 'in-progress', 'next', 'exploring'] as const;
export const LaneSchema = z.enum(LANES);
export type Lane = z.infer<typeof LaneSchema>;

/** Public lane headings on /roadmap (DEC-8). */
export const LANE_LABELS: Readonly<Record<Lane, string>> = {
  shipped: 'Shipped',
  'in-progress': 'In progress',
  next: 'Next',
  exploring: 'Exploring',
};

/**
 * The only source of a roadmap lane (01 §Shared state contract): shipped → Shipped;
 * beta, in-progress → In progress; next → Next; exploring → Exploring.
 */
export function deriveLane(status: FeatureStatus): Lane {
  switch (status) {
    case 'shipped':
      return 'shipped';
    case 'beta':
    case 'in-progress':
      return 'in-progress';
    case 'next':
      return 'next';
    case 'exploring':
      return 'exploring';
    default: {
      const unreachable: never = status;
      throw new Error(`deriveLane: unknown status ${String(unreachable)}`);
    }
  }
}

// ───────────────────────────── glossary[] ─────────────────────────────

/**
 * `matches`: the shipped UI already says `term`, or never shows the concept (nothing to rename).
 * `pr-needed`: the UI shows `shell_label` instead; WP-13 renames the string.
 */
export const ShellUiStatusSchema = z.enum(['matches', 'pr-needed']);
export type ShellUiStatus = z.infer<typeof ShellUiStatusSchema>;

export const GlossaryTermSchema = z
  .object({
    /** Canonical term as copy writes it ("Chi", "Artifact grid", "Multi-user server"). */
    term: NonEmptySchema,
    /** Plain-English gloss ("agent companion"). */
    plain: NonEmptySchema,
    /** Lore gloss, where the term is a lore name. Long-form lore lives on the story page. */
    lore: NonEmptySchema.optional(),
    definition: NonEmptySchema,
    /** Terms copy must not use instead. Exempt from the public-safety scan (may hold T1/T2/T3). */
    avoid: z.array(NonEmptySchema),
    /** Does the shipped shell UI already use `term`? `pr-needed` → WP-13 renames the string. */
    shell_ui_status: ShellUiStatusSchema,
    /** The label the shipped UI shows today. Required when pr-needed: copy uses it until matches (G-14). */
    shell_label: NonEmptySchema.optional(),
    /** The public shell PR that aligns the UI label. */
    pr: HttpsUrlSchema.optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.shell_ui_status === 'pr-needed' && g.shell_label === undefined) {
      fail(ctx, ['shell_label'], 'pr-needed requires "shell_label": copy follows the shipped label until the UI matches (G-14)');
    }
    if (g.shell_ui_status === 'matches' && g.shell_label !== undefined && g.shell_label !== g.term) {
      fail(ctx, ['shell_label'], 'shell_ui_status "matches" means the UI shows `term`; drop shell_label or set pr-needed');
    }
    const avoidLower = g.avoid.map((a) => a.toLowerCase());
    if (avoidLower.indexOf(g.term.toLowerCase()) !== -1) {
      fail(ctx, ['avoid'], `avoid[] must not contain the term itself ("${g.term}")`);
    }
    if (g.shell_label !== undefined && g.shell_ui_status === 'pr-needed' && avoidLower.indexOf(g.shell_label.toLowerCase()) !== -1) {
      fail(ctx, ['avoid'], `"${g.shell_label}" is still the shipped label; it moves into avoid[] only when shell_ui_status becomes "matches" (G-14)`);
    }
    if (g.pr !== undefined && !/^https:\/\/github\.com\/ikenga-hq\/[A-Za-z0-9._-]+\/pull\/\d+$/.test(g.pr)) {
      fail(ctx, ['pr'], 'pr must be a public ikenga-hq pull request URL');
    } else if (g.pr !== undefined && !isPublicThreadRef(g.pr)) {
      fail(ctx, ['pr'], 'pr must be in a public ikenga-hq repo');
    }
    checkUnique(ctx, g.avoid, ['avoid'], 'avoid term', true);
    checkPublicSafety(g, ctx);
  });
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;

// ───────────────────────────── roadmap[] ─────────────────────────────

/**
 * Roadmap presentation only. There is NO `lane` field: the lane is deriveLane(feature.status).
 * The object is strict, so a `lane` key fails validation.
 */
export const RoadmapItemSchema = z
  .object({
    feature_id: FeatureIdSchema,
    /** Public card title, e.g. "Multi-user server". */
    public_label: NonEmptySchema,
    public_note: NonEmptySchema.optional(),
    /** Offer a "notify me" affordance for this card. */
    notify: z.boolean(),
  })
  .strict()
  .superRefine((r, ctx) => {
    checkPublicSafety(r, ctx);
  });
export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;

// ───────────────────────────── engines[] ─────────────────────────────

/** DEC-12: Supported = Claude Code; Beta = Codex, OpenRouter, Antigravity; Experimental = OpenCode, Pi; cursor-agent hidden. */
export const EngineTierSchema = z.enum(['supported', 'beta', 'experimental', 'hidden']);
export type EngineTier = z.infer<typeof EngineTierSchema>;

export const EngineSchema = z
  .object({
    id: SlugSchema,
    /** npm package, e.g. @ikenga/pkg-engine-claude-code. */
    pkg: NpmNameSchema,
    tier: EngineTierSchema,
    /** Version from npm or the registry (WP-09 DoD). */
    version: SemverSchema,
  })
  .strict()
  .superRefine((e, ctx) => {
    checkPublicSafety(e, ctx);
  });
export type Engine = z.infer<typeof EngineSchema>;

// ───────────────────────────── tiers[] ─────────────────────────────

export const TierIdSchema = z.enum(['free', 'team', 'enterprise']);
export type TierId = z.infer<typeof TierIdSchema>;

export const AvailabilitySchema = z.enum(['early-access', 'self-serve', 'unavailable']);
export type Availability = z.infer<typeof AvailabilitySchema>;

/**
 * Public gate ids. These are slugs safe for the public repo. The mapping to internal gate ids
 * lives in drafts/truth-private/gate-map.json:
 *   signing → G-SIGNING · multi-user-server → G-T1-GA · sign-in → OIDC (01 Phase 4) ·
 *   roles-and-audit → G-ACCESS-BUILT · managed-ops → G-MANAGED-OPS · billing → G-BILLING ·
 *   legal-and-intake → G-OFFER (legal pack) + contact intake (G-LAUNCH must-have).
 */
export const GATE_IDS = [
  'signing',
  'multi-user-server',
  'sign-in',
  'roles-and-audit',
  'managed-ops',
  'billing',
  'legal-and-intake',
] as const;
export const GateIdSchema = z.enum(GATE_IDS);
export type GateId = z.infer<typeof GateIdSchema>;

/** Default public wording for gates, in the 06 vocabulary. WP-12/WP-23 may refine it. */
export const GATE_LABELS: Readonly<Record<GateId, string>> = {
  signing: 'Signed installers for macOS and Windows',
  'multi-user-server': 'Multi-user server release',
  'sign-in': 'Sign-in release',
  'roles-and-audit': 'Roles and audit release',
  'managed-ops': 'Managed operations in place',
  billing: 'Billing live',
  'legal-and-intake': 'Terms, privacy and contact intake live',
};

/** USD per month; null = not published. */
export const PriceSchema = z.number().nonnegative().refine((n) => isFinite(n), 'price must be finite');

export const AddonSchema = z
  .object({
    id: SlugSchema,
    price: PriceSchema.nullable(),
    /** `org` = flat per-org fee (the managed add-on, DEC-26); `member` = per member. */
    unit: z.enum(['org', 'member']),
    prerequisites: z.array(GateIdSchema).optional(),
  })
  .strict();
export type Addon = z.infer<typeof AddonSchema>;

export const CtaSchema = z
  .object({
    /** checkout is allowed only for self-serve tiers (DEC-27). */
    kind: z.enum(['download', 'contact', 'waitlist', 'checkout']),
    label: NonEmptySchema,
    href: HrefSchema,
  })
  .strict();
export type Cta = z.infer<typeof CtaSchema>;

export const TierSchema = z
  .object({
    id: TierIdSchema,
    /** Per unit per month in USD on `billing_period`; null = not published ("talk to us"). */
    price: PriceSchema.nullable(),
    /** Month-to-month price when `price` is the annual-billing figure (Team 25 vs 20). */
    price_monthly: PriceSchema.optional(),
    billing_period: z.enum(['monthly', 'annual']).optional(),
    /** No universal unit (G-08). "member" = an Owner or Operator principal (DEC-28). */
    unit: z.literal('member').optional(),
    min_members: z.number().int().positive().optional(),
    addons: z.array(AddonSchema),
    /** Released features the tier delivers today (feature ids; shipped/beta only). */
    includes: z.array(FeatureIdSchema),
    /** Features the tier will deliver as they release (feature ids; not yet released). */
    coming: z.array(FeatureIdSchema),
    /** Gates that must clear before the tier can be sold. */
    prerequisites: z.array(GateIdSchema),
    availability: AvailabilitySchema,
    cta: CtaSchema,
  })
  .strict()
  .superRefine((t, ctx) => {
    checkUnique(ctx, t.includes, ['includes'], 'feature id');
    checkUnique(ctx, t.coming, ['coming'], 'feature id');
    checkUnique(ctx, t.prerequisites, ['prerequisites'], 'gate id');
    checkUnique(
      ctx,
      t.addons.map((a) => a.id),
      ['addons'],
      'addon id',
    );
    t.coming.forEach((id, i) => {
      if (t.includes.indexOf(id) !== -1) fail(ctx, ['coming', i], `"${id}" cannot be both included and coming`);
    });
    if (t.min_members !== undefined && t.unit !== 'member') {
      fail(ctx, ['min_members'], 'min_members requires unit "member"');
    }
    if (t.price_monthly !== undefined && (t.price === null || t.billing_period !== 'annual')) {
      fail(ctx, ['price_monthly'], 'price_monthly is the month-to-month alternative to an annual price: requires a non-null price and billing_period "annual"');
    }
    if (t.cta.kind === 'checkout' && t.availability !== 'self-serve') {
      fail(ctx, ['cta', 'kind'], 'checkout CTAs are allowed only when availability is "self-serve" (DEC-27: no invoice or paid contract during early access)');
    }
    checkPublicSafety(t, ctx);
  });
export type Tier = z.infer<typeof TierSchema>;

// ───────────────────────────── generated: release ─────────────────────────────

/** Where a generated document came from (G-06): fetched this build, or the committed last-good copy. */
export const OriginSchema = z.enum(['live', 'last-good']);
export type Origin = z.infer<typeof OriginSchema>;

export const OsSchema = z.enum(['macos', 'windows', 'linux']);
export type Os = z.infer<typeof OsSchema>;

/** `.sig` files are Tauri updater (minisign) signatures, NOT OS code signatures. */
export const AssetKindSchema = z.enum([
  'dmg',
  'app-tarball',
  'nsis-exe',
  'msi',
  'deb',
  'appimage',
  'rpm',
  'updater-signature',
  'updater-manifest',
  'checksums',
  'other',
]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const ReleaseAssetSchema = z
  .object({
    name: NonEmptySchema,
    url: HttpsUrlSchema,
    /** null for cross-platform assets (latest.json, checksums). */
    os: OsSchema.nullable(),
    kind: AssetKindSchema,
    size: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'expected lower-case hex sha256').optional(),
  })
  .strict();
export type ReleaseAsset = z.infer<typeof ReleaseAssetSchema>;

/**
 * OS code-signing verdict. It is derived from CI asset inspection (spctl/codesign,
 * Get-AuthenticodeSignature) and never set by hand (G-07). `unknown` = not inspected yet.
 */
export const SigningVerdictSchema = z
  .object({
    state: z.enum(['signed', 'unsigned', 'unknown']),
    /** macOS only: notarization ticket present. */
    notarized: z.boolean().optional(),
    method: z.literal('ci-asset-inspection'),
    /** The CI run or job that inspected the assets. Required for a signed/unsigned verdict. */
    evidence: HttpsUrlSchema.optional(),
    inspected_at: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.state !== 'unknown' && (s.evidence === undefined || s.inspected_at === undefined)) {
      fail(ctx, ['evidence'], `a "${s.state}" verdict needs evidence and inspected_at from CI asset inspection; a verdict without evidence is hand-set (G-07)`);
    }
    if (s.notarized === true && s.state !== 'signed') {
      fail(ctx, ['notarized'], 'notarized requires state "signed"');
    }
  });
export type SigningVerdict = z.infer<typeof SigningVerdictSchema>;

export const ReleaseFactsSchema = z
  .object({
    asOf: IsoDateTimeSchema,
    origin: OriginSchema,
    repo: z.literal('ikenga-hq/ikenga'),
    /** Latest shell release tag, `v` + version. */
    tag: z.string().regex(/^v/, 'shell tags start with "v"'),
    version: SemverSchema,
    published_at: IsoDateTimeSchema,
    url: HttpsUrlSchema,
    assets: z.array(ReleaseAssetSchema).min(1),
    signing: z
      .object({
        macos: SigningVerdictSchema,
        windows: SigningVerdictSchema,
        linux: SigningVerdictSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.tag !== 'v' + r.version) fail(ctx, ['tag'], `tag must be "v${r.version}"`);
    const expectedUrl = `https://github.com/${r.repo}/releases/tag/${r.tag}`;
    if (r.url !== expectedUrl) fail(ctx, ['url'], `url must be ${expectedUrl}`);
    const dl = `https://github.com/${r.repo}/releases/download/${r.tag}/`;
    r.assets.forEach((a, i) => {
      if (a.url !== dl + a.name) fail(ctx, ['assets', i, 'url'], `asset url must be ${dl}${a.name}`);
    });
    checkUnique(
      ctx,
      r.assets.map((a) => a.name),
      ['assets'],
      'asset name',
    );
    if (r.signing.windows.notarized !== undefined) fail(ctx, ['signing', 'windows', 'notarized'], 'notarized applies to macOS only');
    if (r.signing.linux.notarized !== undefined) fail(ctx, ['signing', 'linux', 'notarized'], 'notarized applies to macOS only');
    if (Date.parse(r.asOf) < Date.parse(r.published_at)) fail(ctx, ['asOf'], 'asOf cannot predate the release');
  });
export type ReleaseFacts = z.infer<typeof ReleaseFactsSchema>;

// ───────────────────────────── generated: registry ─────────────────────────────

/**
 * Mirrors @ikenga/contract RegistryEntrySchema (contract/src/registry.ts). It is NOT strict:
 * unknown upstream fields are stripped, never fatal, so a registry change cannot break a
 * Pages build (G-06).
 */
export const RegistryEntrySchema = z.object({
  name: NpmNameSchema,
  latest: SemverSchema,
  detail: NonEmptySchema,
  description: z.string().optional(),
  /** Upstream hint; mislabelled today (03 §10). */
  kind: z.string().optional(),
  screenshot: HttpsUrlSchema.optional(),
  visibility: z.enum(['public', 'hidden']).optional(),
  /** Site-side corrected kind (the "kind override"; WP-05/WP-27). */
  kind_override: SlugSchema.optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistrySnapshotSchema = z
  .object({
    $schemaVersion: z.literal(1),
    /** Upstream: when the registry last changed. */
    updatedAt: IsoDateTimeSchema,
    pkgs: z.array(RegistryEntrySchema),
    /** When this copy was fetched. The staleness job compares it with now (> 14 days fails). */
    asOf: IsoDateTimeSchema,
    origin: OriginSchema,
    /** The index that was fetched, e.g. https://registry.ikenga.dev/index.json. */
    url: HttpsUrlSchema,
  })
  .superRefine((r, ctx) => {
    checkUnique(
      ctx,
      r.pkgs.map((p) => p.name),
      ['pkgs'],
      'pkg name',
    );
    if (Date.parse(r.asOf) < Date.parse(r.updatedAt)) fail(ctx, ['asOf'], 'asOf cannot predate updatedAt');
  });
export type RegistrySnapshot = z.infer<typeof RegistrySnapshotSchema>;

// ───────────────────────────── changelog highlights ─────────────────────────────

export const MaturitySchema = z.enum(['stable', 'beta', 'experimental']);
export type Maturity = z.infer<typeof MaturitySchema>;

/**
 * Front matter of the hand-written `highlights/<version>.md`, which sits over the raw
 * Changesets notes (G-06). It holds 2-4 headline items, a maturity label and an optional
 * stability note.
 */
export const ChangelogHighlightSchema = z
  .object({
    version: SemverSchema,
    date: IsoDateSchema,
    maturity: MaturitySchema,
    items: z
      .array(
        z
          .object({
            title: NonEmptySchema,
            body: NonEmptySchema.optional(),
            feature_ids: z.array(FeatureIdSchema).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(4),
    stability_note: NonEmptySchema.optional(),
  })
  .strict()
  .superRefine((h, ctx) => {
    checkPublicSafety(h, ctx);
  });
export type ChangelogHighlight = z.infer<typeof ChangelogHighlightSchema>;

// ───────────────────────────── page front matter (claim contract) ─────────────────────────────

/** Pages and docs declare the features they make claims about (drafts/feature-component.md). */
export const FeatureFrontmatterSchema = z.object({
  features: z.array(FeatureIdSchema).optional(),
});
export type FeatureFrontmatter = z.infer<typeof FeatureFrontmatterSchema>;

// ───────────────────────────── whole set: cross-references ─────────────────────────────

export const TruthSetSchema = z
  .object({
    features: z.array(FeatureSchema),
    glossary: z.array(GlossaryTermSchema),
    roadmap: z.array(RoadmapItemSchema),
    engines: z.array(EngineSchema),
    tiers: z.array(TierSchema),
    highlights: z.array(ChangelogHighlightSchema).optional(),
  })
  .strict()
  .superRefine((set, ctx) => {
    const byId: Record<string, Feature> = {};
    set.features.forEach((f) => {
      byId[f.id] = f;
    });
    checkUnique(
      ctx,
      set.features.map((f) => f.id),
      ['features'],
      'feature id',
    );
    checkUnique(
      ctx,
      set.glossary.map((g) => g.term),
      ['glossary'],
      'glossary term',
      true,
    );
    checkUnique(
      ctx,
      set.roadmap.map((r) => r.feature_id),
      ['roadmap'],
      'roadmap feature_id',
    );
    checkUnique(
      ctx,
      set.engines.map((e) => e.id),
      ['engines'],
      'engine id',
    );
    checkUnique(
      ctx,
      set.engines.map((e) => e.pkg),
      ['engines'],
      'engine pkg',
    );
    checkUnique(
      ctx,
      set.tiers.map((t) => t.id),
      ['tiers'],
      'tier id',
    );

    const terms = set.glossary.map((g) => g.term.toLowerCase());
    set.glossary.forEach((g, gi) => {
      g.avoid.forEach((a, ai) => {
        if (terms.indexOf(a.toLowerCase()) !== -1) {
          fail(ctx, ['glossary', gi, 'avoid', ai], `"${a}" is a canonical glossary term elsewhere; it cannot also be avoided`);
        }
      });
    });

    set.roadmap.forEach((r, i) => {
      if (!byId[r.feature_id]) fail(ctx, ['roadmap', i, 'feature_id'], `unknown feature id "${r.feature_id}"`);
    });

    set.tiers.forEach((t, ti) => {
      t.includes.forEach((id, i) => {
        const f = byId[id];
        if (!f) fail(ctx, ['tiers', ti, 'includes', i], `unknown feature id "${id}"`);
        else if (!isReleased(f.status)) {
          fail(ctx, ['tiers', ti, 'includes', i], `"${id}" is ${f.status}; includes[] takes released (shipped/beta) features only. Put it in coming[] (01 Risk 1)`);
        }
      });
      t.coming.forEach((id, i) => {
        const f = byId[id];
        if (!f) fail(ctx, ['tiers', ti, 'coming', i], `unknown feature id "${id}"`);
        else if (isReleased(f.status)) {
          fail(ctx, ['tiers', ti, 'coming', i], `"${id}" is already ${f.status}; move it to includes[]`);
        }
      });
    });

    (set.highlights || []).forEach((h, hi) => {
      h.items.forEach((item, ii) => {
        (item.feature_ids || []).forEach((id, fi) => {
          if (!byId[id]) fail(ctx, ['highlights', hi, 'items', ii, 'feature_ids', fi], `unknown feature id "${id}"`);
        });
      });
    });
  });
export type TruthSet = z.infer<typeof TruthSetSchema>;

// ───────────────────────────── file map + helpers ─────────────────────────────

/** Hand-authored public truth files: site/src/data/truth/<name>. Each is a JSON array. */
export const TRUTH_FILE_SCHEMAS = {
  'features.json': z.array(FeatureSchema),
  'glossary.json': z.array(GlossaryTermSchema),
  'roadmap.json': z.array(RoadmapItemSchema),
  'engines.json': z.array(EngineSchema),
  'tiers.json': z.array(TierSchema),
} as const;
export type TruthFileName = keyof typeof TRUTH_FILE_SCHEMAS;

/** Generated documents: written to an uncommitted build folder; last-good copies are committed (G-06). */
export const GENERATED_DOC_SCHEMAS = {
  release: ReleaseFactsSchema,
  registry: RegistrySnapshotSchema,
} as const;

/** One line per issue: `path: message`. Works with Zod 3 and Zod 4 issue objects. */
export function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues.map((i) => `${i.path.map((p) => String(p)).join('.') || '(root)'}: ${i.message}`).join('\n');
}
