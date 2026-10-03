// Build-time reader for the pricing page: the tiers in src/data/truth/tiers.json,
// validated against the truth schema, plus the small formatting helpers the
// page's components share. A tiers file that does not validate fails the
// build, so /pricing never shows a price the truth data does not back.
import { z } from 'astro/zod';
import tiersData from '../../data/truth/tiers.json';
import { TierSchema, GATE_LABELS, formatIssues, type Tier, type TierId, type GateId, type Addon } from '../../lib/truth/schema';
import { feature, type FeatureRow } from '../../lib/truth/read';

const parsed = z.array(TierSchema).safeParse(tiersData);
if (!parsed.success) throw new Error(`truth: tiers.json does not validate\n${formatIssues(parsed.error.issues)}`);

/** Every tier, in the file's order (free, personal, team, enterprise). */
export const TIERS: Tier[] = parsed.data;

/** The tier with this id. Throws when the data has none. */
export function tier(id: TierId): Tier {
	const t = TIERS.find((x) => x.id === id);
	if (!t) throw new Error(`truth: no tier "${id}" in tiers.json`);
	return t;
}

/** Display names for the tiers. "Enterprise" on the site; the add-on is "Managed instance". */
export const TIER_NAMES: Record<TierId, string> = {
	free: 'Free',
	personal: 'Personal',
	team: 'Team',
	enterprise: 'Enterprise',
};

export const money = (n: number) => `$${n}`;
export const range = (lo: number, hi?: number) => (hi === undefined ? money(lo) : `${money(lo)}–${hi}`);

/** Title case for a slug such as `small` or `standard`. */
export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The public wording for each gate a tier waits on. */
export function gateLabels(gates: GateId[]): string[] {
	return gates.map((g) => GATE_LABELS[g]);
}

/** Feature ids in every tier's `includes`, in the free tier's order. */
export function sharedIncludes(): string[] {
	const [first, ...rest] = TIERS;
	if (!first) return [];
	return first.includes.filter((id) => rest.every((t) => t.includes.includes(id)));
}

/** Feature ids in every tier's `coming`, in the first tier's order. */
export function sharedComing(): string[] {
	const [first, ...rest] = TIERS;
	if (!first) return [];
	return first.coming.filter((id) => rest.every((t) => t.coming.includes(id)));
}

/** Features a tier includes beyond the ones every tier includes. */
export function extraIncludes(t: Tier): string[] {
	const shared = sharedIncludes();
	return t.includes.filter((id) => !shared.includes(id));
}

/** Released rows (shipped or beta) for ids, in order. */
export function releasedRows(ids: string[]): FeatureRow[] {
	return ids.map((id) => feature(id));
}

/** Rows that have not released yet (next or exploring), in order. */
export function comingRows(ids: string[]): FeatureRow[] {
	return ids.map((id) => feature(id, ['in-progress', 'next', 'exploring']));
}

/** The sized add-ons on a tier (the managed instance), smallest price first. */
export function sizedAddons(t: Tier): Addon[] {
	return t.addons.filter((a) => a.size !== undefined).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
}

/** The lowest published add-on price, for "from $N". */
export function addonFrom(t: Tier): number | null {
	const prices = t.addons.map((a) => a.price).filter((p): p is number => p !== null);
	return prices.length ? Math.min(...prices) : null;
}
