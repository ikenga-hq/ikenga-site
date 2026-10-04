// Build-time readers over the truth data in src/data/truth/.
//
// Pages read status, version and limits from here instead of typing them by
// hand, so a truth refresh changes the page on the next build. A lookup of an
// id that does not exist, or of a row whose status a page does not allow, fails
// the build: a claim with nothing behind it should never reach the site.

import featuresData from '../../data/truth/features.json';
import enginesData from '../../data/truth/engines.json';

export type Status = 'shipped' | 'beta' | 'in-progress' | 'next' | 'exploring';

export interface FeatureRow {
	id: string;
	plain_name: string;
	status: Status;
	since?: string;
	ref_public?: string;
	scope: string;
	limits: string[];
}

export interface EngineRow {
	id: string;
	pkg: string;
	tier: 'supported' | 'beta' | 'experimental' | 'hidden';
	version: string;
}

const FEATURES = featuresData as FeatureRow[];
const ENGINES = enginesData as EngineRow[];

/** The truth row for `id`. Throws when the id is unknown or its status is not in `allowed`. */
export function feature(id: string, allowed: Status[] = ['shipped', 'beta']): FeatureRow {
	const row = FEATURES.find((f) => f.id === id);
	if (!row) throw new Error(`truth: no feature row "${id}"`);
	if (!allowed.includes(row.status)) {
		throw new Error(`truth: "${id}" is ${row.status}; this page only shows ${allowed.join(' or ')}`);
	}
	return row;
}

/** "Since 0.11.0" or "Beta since 0.16.1", from the row. */
export function sinceLabel(id: string): string {
	const row = feature(id);
	return row.status === 'beta' ? `Beta since ${row.since}` : `Since ${row.since}`;
}

/** Rows in `ids` whose status is `status`, in the order given. Rows with another status are left out. */
export function withStatus(ids: string[], status: Status): FeatureRow[] {
	return ids
		.map((id) => FEATURES.find((f) => f.id === id))
		.filter((f): f is FeatureRow => !!f && f.status === status);
}

const ENGINE_TIERS = ['supported', 'beta', 'experimental'] as const;
export type EngineTier = (typeof ENGINE_TIERS)[number];

/** Engine display names grouped by public tier. Hidden engines are never listed. */
export function enginesByTier(): { tier: EngineTier; names: string[] }[] {
	return ENGINE_TIERS.map((tier) => ({
		tier,
		names: ENGINES.filter((e) => e.tier === tier).map((e) => {
			const row = FEATURES.find((f) => f.id === `engines.${e.id}`);
			return row ? row.plain_name.replace(/ engine$/, '') : e.id;
		}),
	})).filter((g) => g.names.length > 0);
}
