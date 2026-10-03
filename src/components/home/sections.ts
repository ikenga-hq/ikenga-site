// The home page's sections, in page order. The Explorer, the tablet and phone
// section menu and the scroll tracking all read this list. `ctx` is the
// Companion panel a section brings up; `meta` is the version a row shows,
// read from the truth data.
import { feature } from '../../lib/truth/read';

export type Ctx = 'get' | 'ask' | 'consent' | 'local' | 'plan' | 'pair' | 'tiers';

export interface Section {
	id: string;
	label: string;
	icon: string;
	ctx: Ctx;
	tint?: 'project' | 'chi' | 'ngwa';
	meta?: string;
}

const since = (id: string) => feature(id).since;

export const SECTIONS: Section[] = [
	{ id: 'overview', label: 'Overview', icon: 'home', ctx: 'get' },
	{ id: 'trust', label: 'Trust', icon: 'shield', ctx: 'local' },
	{ id: 'projects', label: 'Projects', icon: 'folder', ctx: 'get', meta: since('workspace.explorer') },
	{ id: 'chi', label: 'Chi · companion', icon: 'person', ctx: 'ask', tint: 'chi', meta: since('chi.companion') },
	{ id: 'ngwa', label: 'Ngwa · store', icon: 'box', ctx: 'consent', tint: 'ngwa', meta: since('ngwa.store') },
	{ id: 'vault', label: 'Vault & lock', icon: 'lock', ctx: 'local', meta: since('vault.passphrase') },
	{ id: 'keys', label: 'Actions & keys', icon: 'keyboard', ctx: 'get', meta: since('actions.custom') },
	{ id: 'terminal', label: 'Terminal', icon: 'terminal', ctx: 'get', meta: since('terminal.continuity') },
	{ id: 'groundwork', label: 'Groundwork', icon: 'layers', ctx: 'plan' },
	{ id: 'engines', label: 'Engines', icon: 'chip', ctx: 'get' },
	{ id: 'teams', label: 'Remote & teams', icon: 'devices', ctx: 'pair', meta: since('server.multi-user') },
	{ id: 'coming', label: 'Coming', icon: 'clock', ctx: 'get' },
	{ id: 'pricing', label: 'Pricing', icon: 'tag', ctx: 'tiers' },
];

/** Companion head titles per context. */
export const CTX_TITLES: Record<Ctx, string> = {
	get: 'Get Ikenga',
	ask: 'Chi · permission inbox',
	consent: 'Ngwa · install sheet',
	local: 'On your machine',
	plan: 'Groundwork · plan folder',
	pair: 'Remote · device pairing',
	tiers: 'Pricing',
};

export const ELSEWHERE = [
	{ href: '/docs/', label: 'Docs', icon: 'doc' },
	{ href: '/packages/', label: 'Catalogue', icon: 'box' },
	{ href: 'https://github.com/ikenga-hq/ikenga/releases', label: 'Changelog', icon: 'list' },
	{ href: 'https://github.com/ikenga-hq/ikenga', label: 'GitHub', icon: 'github' },
];
