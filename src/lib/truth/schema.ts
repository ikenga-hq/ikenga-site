/**
 * Ikenga truth layer: data schemas and claim rules.
 *
 * Every feature claim on the site is backed by a row in `src/data/truth/*.json`. This file defines
 * what a valid row looks like. `scripts/verify-truth.mjs` runs it in CI, and the site's pages
 * import the types.
 *
 * Runtime notes
 *   - Zod comes from `astro/zod`, so the site needs no extra dependency. The code uses only the
 *     parts of Zod's API that Zod 3.25 and Zod 4 share (strict objects, superRefine, enum,
 *     literal, nullable, optional, regex, array min/max).
 *   - Erasable TypeScript only (no `enum`, namespaces or parameter properties), so Node's built-in
 *     type stripping (Node 22.18 or later) can import this file directly from a `.mjs` script.
 *   - Pure: no file access and no network. Checking that a release tag really exists is a network
 *     step and belongs to `scripts/verify-truth.mjs`. This file checks shape, the internal
 *     consistency of each row, and cross-references inside the whole set (`TruthSetSchema`).
 *
 * What the schemas enforce
 *   1. Shipped means released. A `status` of shipped or beta requires `since` (a semver version)
 *      and a `ref_public` that is a release reference (a GitHub release/tag page in a public
 *      ikenga-hq repository, or an @ikenga package version page on npm) whose version equals
 *      `since`. Other statuses must not carry `since`, and may only link a public issue, pull
 *      request or discussion.
 *   2. A roadmap lane is derived, never stored. `RoadmapItem` has no `lane` field, and strict
 *      objects make a stray `lane` key a validation error. `deriveLane(status)` is the only source
 *      of a lane.
 *   3. Every feature carries `limits[]` (public caveats; use an empty list when there are none),
 *      a `scope`, and optionally `fresh_install_ready`.
 *   4. A tier has a nullable `price`, `includes` and `coming` lists of feature ids (cross-checked
 *      against each feature's status), `prerequisites` that are public gate slugs, and an
 *      `availability` of early-access, self-serve or unavailable. Every other tier includes at least
 *      what the free tier includes. Only the personal tier carries `personal` (sizes, regions and
 *      prices), and its `price` is the lowest of those prices. A sized add-on may publish its spec,
 *      the members it suits and its regions; a region priced by quote carries no price.
 *   5. Feature ids have the form `<area>.<slug>` (at least one dot, and the first segment equals
 *      `area`), so a claim check can find an id in free prose without false hits on ordinary words.
 *   6. A glossary term whose UI label differs from the canonical term carries `shell_label`, and
 *      copy follows the shipped label until the UI is updated.
 *   7. A tier `cta` of kind `checkout` is allowed only when the tier's availability is `self-serve`.
 *   8. Generated documents (release facts, registry snapshot) carry `asOf` and `origin`
 *      (`live` or `last-good`). A signing verdict of signed or unsigned requires evidence.
 *
 * Currency and period: every price is USD per month. For annual billing, `price` is the
 * per-month figure billed annually and `price_monthly` is the month-to-month figure.
 *
 * Validate a file (Node 22.18 or later):
 *   import { TRUTH_FILE_SCHEMAS, formatIssues } from './schema.ts';
 *   const r = TRUTH_FILE_SCHEMAS['features.json'].safeParse(JSON.parse(text));
 *   if (!r.success) console.error(formatIssues(r.error.issues));
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
 * The dot makes ids distinctive, so a claim check can find a bare id in free prose.
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

/** Public repositories under github.com/ikenga-hq. */
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
 * Parse a release reference: a GitHub release/tag page in a public ikenga-hq repository, or an npm
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

/** A public issue, pull request or discussion in a public ikenga-hq repository. */
export function isPublicThreadRef(url: string): boolean {
  const m = GH_PUBLIC_THREAD_RE.exec(url);
  return !!m && isPublicRepo(m[1] as string);
}

// ───────────────────────────── shared helpers ─────────────────────────────

/** Structural view of a Zod refinement context; satisfied by both Zod 3 and Zod 4. */
interface IssueSink {
  addIssue(issue: { code: 'custom'; message: string; path?: (string | number)[] }): void;
}

function fail(ctx: IssueSink, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
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

/** Public badge words for the Feature component. */
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

/** The three reader paths on the site. */
export const AudienceSchema = z.enum(['individuals', 'builders', 'teams']);
export type Audience = z.infer<typeof AudienceSchema>;

export const FeatureSchema = z
  .object({
    /** `<area>.<slug>`; the first segment must equal `area`. Stable: pages reference it. */
    id: FeatureIdSchema,
    /** Grouping slug (chi, ngwa, vault, terminal, engines, ...). */
    area: SlugSchema,
    /** Plain-English name, used first in copy. */
    plain_name: NonEmptySchema,
    /** Product name when there is one (Chi, Ngwa, ...). */
    lore_name: NonEmptySchema.optional(),
    status: FeatureStatusSchema,
    /** Released version (no "v"). Required when shipped or beta; forbidden otherwise. */
    since: SemverSchema.optional(),
    /** Shipped or beta: the release URL for `since` (required). Otherwise: a public issue, pull request or discussion. */
    ref_public: HttpsUrlSchema.optional(),
    scope: FeatureScopeSchema,
    /** Public caveats, shown with the feature. Required; use [] when there are none. */
    limits: z.array(NonEmptySchema),
    /** Operator apps: does it work on a fresh install with no data of its own? */
    fresh_install_ready: z.boolean().optional(),
    audiences: z.array(AudienceSchema).min(1),
    last_verified: IsoDateSchema,
  })
  .strict()
  .superRefine((f, ctx) => {
    const released = isReleased(f.status);
    if (released && f.since === undefined) {
      fail(ctx, ['since'], `status "${f.status}" requires "since": shipped means released`);
    }
    if (!released && f.since !== undefined) {
      fail(ctx, ['since'], `status "${f.status}" must not carry "since": only released work has a version`);
    }
    if (released) {
      if (f.ref_public === undefined) {
        fail(ctx, ['ref_public'], `status "${f.status}" requires "ref_public": the release URL for its tag`);
      } else {
        const ref = parseReleaseRef(f.ref_public);
        if (!ref) {
          fail(
            ctx,
            ['ref_public'],
            'a shipped/beta row must link a release: https://github.com/ikenga-hq/<public repo>/releases/tag/<tag> or https://www.npmjs.com/package/@ikenga/<name>/v/<version> (PR links are for in-progress, next and exploring rows only)',
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
  });
export type Feature = z.infer<typeof FeatureSchema>;

// ───────────────────────────── lanes (derived, never stored) ─────────────────────────────

export const LANES = ['shipped', 'in-progress', 'next', 'exploring'] as const;
export const LaneSchema = z.enum(LANES);
export type Lane = z.infer<typeof LaneSchema>;

/** Public lane headings on the roadmap page. */
export const LANE_LABELS: Readonly<Record<Lane, string>> = {
  shipped: 'Shipped',
  'in-progress': 'In progress',
  next: 'Next',
  exploring: 'Exploring',
};

/**
 * The only source of a roadmap lane: shipped → Shipped; beta and in-progress → In progress;
 * next → Next; exploring → Exploring.
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
 * `pr-needed`: the UI shows `shell_label` instead, so the UI string needs to change.
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
    /** Terms that copy must not use instead of `term`. */
    avoid: z.array(NonEmptySchema),
    /** Does the shipped shell UI already use `term`? `pr-needed` means the UI string must change. */
    shell_ui_status: ShellUiStatusSchema,
    /** The label the shipped UI shows today. Required when pr-needed: copy uses it until the UI matches. */
    shell_label: NonEmptySchema.optional(),
    /** The public shell pull request that aligns the UI label. */
    pr: HttpsUrlSchema.optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.shell_ui_status === 'pr-needed' && g.shell_label === undefined) {
      fail(ctx, ['shell_label'], 'pr-needed requires "shell_label": copy follows the shipped label until the UI matches');
    }
    if (g.shell_ui_status === 'matches' && g.shell_label !== undefined && g.shell_label !== g.term) {
      fail(ctx, ['shell_label'], 'shell_ui_status "matches" means the UI shows `term`; drop shell_label or set pr-needed');
    }
    const avoidLower = g.avoid.map((a) => a.toLowerCase());
    if (avoidLower.indexOf(g.term.toLowerCase()) !== -1) {
      fail(ctx, ['avoid'], `avoid[] must not contain the term itself ("${g.term}")`);
    }
    if (g.shell_label !== undefined && g.shell_ui_status === 'pr-needed' && avoidLower.indexOf(g.shell_label.toLowerCase()) !== -1) {
      fail(ctx, ['avoid'], `"${g.shell_label}" is still the shipped label; it moves into avoid[] only when shell_ui_status becomes "matches"`);
    }
    if (g.pr !== undefined && !/^https:\/\/github\.com\/ikenga-hq\/[A-Za-z0-9._-]+\/pull\/\d+$/.test(g.pr)) {
      fail(ctx, ['pr'], 'pr must be a public ikenga-hq pull request URL');
    } else if (g.pr !== undefined && !isPublicThreadRef(g.pr)) {
      fail(ctx, ['pr'], 'pr must be in a public ikenga-hq repo');
    }
    checkUnique(ctx, g.avoid, ['avoid'], 'avoid term', true);
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
  .strict();
export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;

// ───────────────────────────── engines[] ─────────────────────────────

/** Support level. A `hidden` engine is not listed on the site. */
export const EngineTierSchema = z.enum(['supported', 'beta', 'experimental', 'hidden']);
export type EngineTier = z.infer<typeof EngineTierSchema>;

export const EngineSchema = z
  .object({
    id: SlugSchema,
    /** npm package, e.g. @ikenga/pkg-engine-claude-code. */
    pkg: NpmNameSchema,
    tier: EngineTierSchema,
    /** Version from npm or the registry. */
    version: SemverSchema,
  })
  .strict();
export type Engine = z.infer<typeof EngineSchema>;

// ───────────────────────────── tiers[] ─────────────────────────────

export const TierIdSchema = z.enum(['free', 'personal', 'team', 'enterprise']);
export type TierId = z.infer<typeof TierIdSchema>;

export const AvailabilitySchema = z.enum(['early-access', 'self-serve', 'unavailable']);
export type Availability = z.infer<typeof AvailabilitySchema>;

/** Public gate slugs: what has to be in place before a tier can be sold. */
export const GATE_IDS = [
  'signing',
  'multi-user-server',
  'sign-in',
  'roles-and-audit',
  'managed-ops',
  'billing',
  'legal-and-intake',
  'provisioning',
] as const;
export const GateIdSchema = z.enum(GATE_IDS);
export type GateId = z.infer<typeof GateIdSchema>;

/** Default public wording for each gate. */
export const GATE_LABELS: Readonly<Record<GateId, string>> = {
  signing: 'Signed installers for macOS and Windows',
  'multi-user-server': 'Multi-user server release',
  'sign-in': 'Sign-in release',
  'roles-and-audit': 'Roles and audit release',
  'managed-ops': 'Managed operations in place',
  billing: 'Billing live',
  'legal-and-intake': 'Terms, privacy and contact intake live',
  provisioning: 'Automated server provisioning live',
};

/** USD per month; null = not published. */
export const PriceSchema = z.number().nonnegative().refine((n) => isFinite(n), 'price must be finite');

/**
 * A region a server can run in. `list` = the published price applies; `quote` = priced on request,
 * so nothing in that region carries a price.
 */
export const RegionSchema = z
  .object({
    id: SlugSchema,
    label: NonEmptySchema,
    pricing: z.enum(['list', 'quote']),
  })
  .strict();
export type Region = z.infer<typeof RegionSchema>;

const PositiveSchema = z.number().positive().refine((n) => isFinite(n), 'must be finite');

/** Published machine spec of a managed server size. */
export const SpecSchema = z
  .object({
    ram_gb: PositiveSchema,
    vcpu: z.number().int().positive(),
    /** True when `vcpu` is a floor ("4 or more vCPU"), not an exact count. */
    vcpu_is_minimum: z.boolean().optional(),
    disk_gb: PositiveSchema,
  })
  .strict();
export type Spec = z.infer<typeof SpecSchema>;

/** How many members a size suits. `estimate` stays true until capacity is measured. */
export const MemberFitSchema = z
  .object({
    up_to: z.number().int().positive(),
    estimate: z.boolean(),
  })
  .strict();
export type MemberFit = z.infer<typeof MemberFitSchema>;

function checkRegions(ctx: IssueSink, regions: readonly Region[] | undefined, path: (string | number)[]): void {
  if (!regions) return;
  checkUnique(
    ctx,
    regions.map((r) => r.id),
    path,
    'region id',
  );
}

export const AddonSchema = z
  .object({
    id: SlugSchema,
    /** Size name for a sized add-on (small, standard, large). */
    size: SlugSchema.optional(),
    price: PriceSchema.nullable(),
    /** `org` = flat fee per organisation; `member` = per member. */
    unit: z.enum(['org', 'member']),
    spec: SpecSchema.optional(),
    members: MemberFitSchema.optional(),
    regions: z.array(RegionSchema).min(1).optional(),
    prerequisites: z.array(GateIdSchema).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    checkRegions(ctx, a.regions, ['regions']);
    if (a.price === null && (a.regions || []).some((r) => r.pricing === 'list')) {
      fail(ctx, ['price'], 'a region at list price needs a published price; use pricing "quote" or set price');
    }
  });
export type Addon = z.infer<typeof AddonSchema>;

// ───────────────────────────── personal tier ─────────────────────────────

/** Machine spec of a personal server size. Only RAM is required: a small sleeping box may publish nothing else. */
export const PersonalSpecSchema = z
  .object({
    ram_gb: PositiveSchema,
    vcpu: z.number().int().positive().optional(),
    disk_gb: PositiveSchema.optional(),
  })
  .strict();

/** One region's price for a size. `price_max` makes it a range ("$28–32"). */
export const RegionPriceSchema = z
  .object({
    region: SlugSchema,
    price: PriceSchema,
    price_max: PriceSchema.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.price_max !== undefined && p.price_max <= p.price) fail(ctx, ['price_max'], 'price_max must be above price');
  });
export type RegionPrice = z.infer<typeof RegionPriceSchema>;

export const PersonalSizeSchema = z
  .object({
    id: SlugSchema,
    spec: PersonalSpecSchema,
    /** The box suspends when idle and resumes on the next request. */
    sleeps_when_idle: z.boolean().optional(),
    prices: z.array(RegionPriceSchema).min(1),
  })
  .strict();
export type PersonalSize = z.infer<typeof PersonalSizeSchema>;

/**
 * The personal plan: one small server per person, either run by us in a region the buyer picks
 * (`hosted`) or deployed into the buyer's own cloud account (`own-cloud`, no server charge). Both
 * include an allowance of decision tokens; use beyond it is metered.
 */
export const PersonalPlanSchema = z
  .object({
    delivery: z.array(z.enum(['hosted', 'own-cloud'])).min(1),
    regions: z.array(RegionSchema).min(1),
    sizes: z.array(PersonalSizeSchema).min(1),
    decision_tokens: z
      .object({
        allowance: z.literal('included'),
        overage: z.enum(['metered', 'packs']),
      })
      .strict(),
    /** Prices are before VAT. */
    prices_exclude_vat: z.boolean(),
    /** Prices are indicative until launch. */
    indicative: z.boolean(),
  })
  .strict()
  .superRefine((p, ctx) => {
    checkRegions(ctx, p.regions, ['regions']);
    checkUnique(
      ctx,
      p.delivery,
      ['delivery'],
      'delivery mode',
    );
    checkUnique(
      ctx,
      p.sizes.map((s) => s.id),
      ['sizes'],
      'size id',
    );
    const byId: Record<string, Region> = {};
    p.regions.forEach((r) => {
      byId[r.id] = r;
    });
    p.sizes.forEach((s, si) => {
      checkUnique(
        ctx,
        s.prices.map((x) => x.region),
        ['sizes', si, 'prices'],
        'region',
      );
      s.prices.forEach((x, pi) => {
        const r = byId[x.region];
        if (!r) fail(ctx, ['sizes', si, 'prices', pi, 'region'], `unknown region "${x.region}"`);
        else if (r.pricing === 'quote') fail(ctx, ['sizes', si, 'prices', pi, 'region'], `region "${x.region}" is priced by quote; it cannot carry a price`);
      });
    });
  });
export type PersonalPlan = z.infer<typeof PersonalPlanSchema>;

/** The lowest list price across a personal plan's sizes and regions: its "from" figure. */
export function personalFrom(p: PersonalPlan): number {
  return Math.min(...p.sizes.flatMap((s) => s.prices.map((x) => x.price)));
}

export const CtaSchema = z
  .object({
    /** A checkout button is allowed only on self-serve tiers. */
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
    /** Month-to-month price when `price` is the annual-billing figure (for example 25 against 20). */
    price_monthly: PriceSchema.optional(),
    billing_period: z.enum(['monthly', 'annual']).optional(),
    /** Billing unit; "member" is the only one defined so far. */
    unit: z.literal('member').optional(),
    min_members: z.number().int().positive().optional(),
    addons: z.array(AddonSchema),
    /** Released features the tier delivers today (feature ids; shipped or beta only). */
    includes: z.array(FeatureIdSchema),
    /** Features the tier will deliver as they release (feature ids; not yet released). */
    coming: z.array(FeatureIdSchema),
    /** Gates that must clear before the tier can be sold. */
    prerequisites: z.array(GateIdSchema),
    availability: AvailabilitySchema,
    cta: CtaSchema,
    /** The personal plan's sizes, regions and prices. Required on the personal tier, forbidden elsewhere. */
    personal: PersonalPlanSchema.optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.id === 'personal' && t.personal === undefined) fail(ctx, ['personal'], 'the personal tier needs "personal": its sizes, regions and prices');
    if (t.id !== 'personal' && t.personal !== undefined) fail(ctx, ['personal'], `"personal" belongs to the personal tier only, not "${t.id}"`);
    if (t.personal !== undefined && t.personal.delivery.indexOf('hosted') !== -1) {
      const from = personalFrom(t.personal);
      if (t.price !== from) fail(ctx, ['price'], `the personal tier's price is its "from" figure: the lowest size price, ${from}`);
    }
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
      fail(ctx, ['cta', 'kind'], 'checkout buttons are allowed only when availability is "self-serve"');
    }
  });
export type Tier = z.infer<typeof TierSchema>;

// ───────────────────────────── generated: release ─────────────────────────────

/** Where a generated document came from: fetched during this build, or the committed last-good copy. */
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
 * Get-AuthenticodeSignature) and never set by hand. `unknown` = not inspected yet.
 */
export const SigningVerdictSchema = z
  .object({
    state: z.enum(['signed', 'unsigned', 'unknown']),
    /** macOS only: notarization ticket present. */
    notarized: z.boolean().optional(),
    method: z.literal('ci-asset-inspection'),
    /** The CI run or job that inspected the assets. Required for a signed or unsigned verdict. */
    evidence: HttpsUrlSchema.optional(),
    inspected_at: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.state !== 'unknown' && (s.evidence === undefined || s.inspected_at === undefined)) {
      fail(ctx, ['evidence'], `a "${s.state}" verdict needs evidence and inspected_at from CI asset inspection; a verdict without evidence is hand-set`);
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
 * Pages build.
 */
export const RegistryEntrySchema = z.object({
  name: NpmNameSchema,
  latest: SemverSchema,
  detail: NonEmptySchema,
  description: z.string().optional(),
  /** Upstream hint; not always accurate. */
  kind: z.string().optional(),
  screenshot: HttpsUrlSchema.optional(),
  visibility: z.enum(['public', 'hidden']).optional(),
  /** Site-side corrected kind, used where the registry's own label is wrong. */
  kind_override: SlugSchema.optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistrySnapshotSchema = z
  .object({
    $schemaVersion: z.literal(1),
    /** Upstream: when the registry last changed. */
    updatedAt: IsoDateTimeSchema,
    pkgs: z.array(RegistryEntrySchema),
    /** When this copy was fetched. A staleness check compares it with the current date. */
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
 * Changesets notes. It holds 2-4 headline items, a maturity label and an optional stability note.
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
  .strict();
export type ChangelogHighlight = z.infer<typeof ChangelogHighlightSchema>;

// ───────────────────────────── page front matter (claim rule) ─────────────────────────────

/** Pages and docs declare the features they make claims about. */
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

    // A paid tier never takes away what the free tier gives.
    const free = set.tiers.find((t) => t.id === 'free');
    if (free) {
      set.tiers.forEach((t, ti) => {
        if (t.id === 'free') return;
        free.includes.forEach((id) => {
          if (t.includes.indexOf(id) === -1) fail(ctx, ['tiers', ti, 'includes'], `"${t.id}" must include everything free includes; missing "${id}"`);
        });
      });
    }

    set.tiers.forEach((t, ti) => {
      t.includes.forEach((id, i) => {
        const f = byId[id];
        if (!f) fail(ctx, ['tiers', ti, 'includes', i], `unknown feature id "${id}"`);
        else if (!isReleased(f.status)) {
          fail(ctx, ['tiers', ti, 'includes', i], `"${id}" is ${f.status}; includes[] takes released (shipped or beta) features only. Put it in coming[]`);
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

/** Hand-authored public truth files: `src/data/truth/<name>`. Each is a JSON array. */
export const TRUTH_FILE_SCHEMAS = {
  'features.json': z.array(FeatureSchema),
  'glossary.json': z.array(GlossaryTermSchema),
  'roadmap.json': z.array(RoadmapItemSchema),
  'engines.json': z.array(EngineSchema),
  'tiers.json': z.array(TierSchema),
} as const;
export type TruthFileName = keyof typeof TRUTH_FILE_SCHEMAS;

/** Generated documents: written to an uncommitted build folder; last-good copies are committed. */
export const GENERATED_DOC_SCHEMAS = {
  release: ReleaseFactsSchema,
  registry: RegistrySnapshotSchema,
} as const;

/** One line per issue: `path: message`. Works with Zod 3 and Zod 4 issue objects. */
export function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues.map((i) => `${i.path.map((p) => String(p)).join('.') || '(root)'}: ${i.message}`).join('\n');
}
