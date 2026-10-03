// Home page behaviour. Everything here is an enhancement: without it the page
// still reads top to bottom, every link works, the Companion shows its download
// panel and the headline stays static.

const root = document.documentElement;
const $$ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) =>
	Array.from(scope.querySelectorAll<T>(sel) as NodeListOf<T>);

interface PageData {
	titles: Record<string, string>;
	release: { tag: string; repo: string };
}
function pageData(): PageData | null {
	try {
		return JSON.parse(document.getElementById('home-data')?.textContent ?? 'null');
	} catch {
		return null;
	}
}

/* Colour mode: the head script already applied a saved choice or the system setting. */
function mode() {
	const saved = (): string | null => {
		try {
			return localStorage.getItem('ik-mode');
		} catch {
			return null;
		}
	};
	const sync = () => {
		const light = root.dataset.mode === 'light';
		$$('[data-mode-label]').forEach((el) => (el.textContent = light ? 'Dark mode' : 'Light mode'));
		$$('.mode-btn[data-mode-toggle]').forEach((b) =>
			b.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode'),
		);
	};
	$$('[data-mode-toggle]').forEach((b) =>
		b.addEventListener('click', () => {
			const next = root.dataset.mode === 'light' ? 'dark' : 'light';
			root.dataset.mode = next;
			try {
				localStorage.setItem('ik-mode', next);
			} catch {
				/* storage blocked: the choice lasts for this page view */
			}
			sync();
		}),
	);
	// Follow the system setting live until the visitor picks a mode.
	const mq = window.matchMedia?.('(prefers-color-scheme: light)');
	mq?.addEventListener?.('change', (e) => {
		const s = saved();
		if (s === 'dark' || s === 'light') return;
		root.dataset.mode = e.matches ? 'light' : 'dark';
		sync();
	});
	sync();
}

/* Downloads: point every Download at the countable redirect for the detected OS. */
function downloads(data: PageData | null) {
	const apply = () => {
		const os = root.dataset.os;
		const link = os ? document.querySelector<HTMLAnchorElement>(`[data-os-link="${os}"]`) : null;
		if (!link) return;
		$$<HTMLAnchorElement>('[data-os-cta], [data-os-href]').forEach((a) => (a.href = link.href));
	};
	apply();
	// Linux on ARM has no prebuilt build: fall back to the neutral label and the release page.
	const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string }> } }).userAgentData;
	if (root.dataset.os === 'linux' && uad?.getHighEntropyValues) {
		uad
			.getHighEntropyValues(['architecture'])
			.then((v) => {
				if (/arm/i.test(v.architecture ?? '')) {
					delete root.dataset.os;
					$$<HTMLAnchorElement>('[data-os-cta], [data-os-href]').forEach(
						(a) => (a.href = `https://github.com/${data?.release.repo ?? 'ikenga-hq/ikenga'}/releases/latest`),
					);
				}
			})
			.catch(() => {});
	}
	// A build can be older than the latest release: re-check it and update the release line.
	if (!data) return;
	fetch(`https://api.github.com/repos/${data.release.repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
		.then((r) => (r.ok ? r.json() : null))
		.then((rel: { tag_name?: string; published_at?: string } | null) => {
			if (!rel?.tag_name || rel.tag_name === data.release.tag) return;
			$$('[data-rel-tag]').forEach((el) => (el.textContent = rel.tag_name!));
			const date = (rel.published_at ?? '').slice(0, 10);
			$$('[data-rel-line]').forEach((el) => (el.textContent = date ? `${rel.tag_name} · ${date}` : rel.tag_name!));
		})
		.catch(() => {});
}

/* Copy the install command; count copies of the install.sh line (event name and page only). */
function copy() {
	const count = () => {
		try {
			const body = JSON.stringify({ name: 'install_copy', path: location.pathname });
			const queued = navigator.sendBeacon?.('/api/event', new Blob([body], { type: 'application/json' }));
			if (!queued) {
				void fetch('/api/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
			}
		} catch {
			/* counting must never break copying */
		}
	};
	$$<HTMLButtonElement>('[data-copy]').forEach((b) =>
		b.addEventListener('click', async () => {
			const text = b.dataset.copy ?? '';
			try {
				await navigator.clipboard.writeText(text);
				b.setAttribute('aria-label', 'Install command copied');
				if (text.includes('install.sh')) count();
				setTimeout(() => b.setAttribute('aria-label', 'Copy install command'), 2000);
			} catch {
				b.setAttribute('aria-label', 'Copy failed. Select the command and copy it.');
			}
		}),
	);
}

/* Illustrative samples: consent sheets, permission cards, pairing cards. Nothing leaves the page. */
function samples() {
	$$('[data-consent]').forEach((host) => {
		const sheets = $$('[data-sheet]', host);
		const update = (sheet: HTMLElement) => {
			const boxes = $$<HTMLInputElement>('input[type=checkbox]', sheet);
			const n = boxes.filter((b) => b.checked).length;
			const install = sheet.querySelector<HTMLButtonElement>('[data-install]');
			const state = sheet.querySelector<HTMLElement>('[data-state]');
			if (install) install.disabled = n !== boxes.length;
			if (state) state.textContent = n === boxes.length ? 'All groups reviewed' : `${n} of ${boxes.length} groups ticked`;
		};
		sheets.forEach((sheet) => {
			sheet.addEventListener('change', () => update(sheet));
			sheet.querySelector('[data-install]')?.addEventListener('click', () => {
				const state = sheet.querySelector<HTMLElement>('[data-state]');
				if (state) state.textContent = 'This page is a demo, so nothing installed.';
			});
		});
		$$<HTMLButtonElement>('.switcher button', host).forEach((b) =>
			b.addEventListener('click', () => {
				$$<HTMLButtonElement>('.switcher button', host).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
				sheets.forEach((s) => (s.hidden = s.dataset.sheet !== b.dataset.pkg));
			}),
		);
	});
	$$<HTMLButtonElement>('[data-ask]').forEach((b) =>
		b.addEventListener('click', () => {
			const card = b.closest<HTMLElement>('[data-ask-card]');
			if (!card) return;
			card.dataset.state = b.dataset.ask;
			const state = card.querySelector('.ask-state');
			if (state) state.textContent = b.dataset.ask === 'allow' ? 'Allowed once. The run carries on.' : 'Denied.';
		}),
	);
	$$<HTMLButtonElement>('[data-pair]').forEach((b) =>
		b.addEventListener('click', () => {
			const card = b.closest<HTMLElement>('[data-pair-card]');
			const state = card?.querySelector('.pair-state');
			if (state) state.textContent = b.dataset.pair === 'confirm' ? 'Paired. You can revoke it at any time.' : 'Cancelled.';
		}),
	);
}

/* The Companion follows the scroll: the section in view marks its Explorer row and picks the panel. */
function companion(data: PageData | null) {
	const aside = document.querySelector<HTMLElement>('.companion');
	const title = document.querySelector<HTMLElement>('[data-co-title]');
	const panels = $$('.co-panel');
	const rows = $$('.ex-row[data-target]');
	const sections = $$('main section[id]');
	let current = 'get';
	const show = (ctx: string) => {
		if (ctx === current || !panels.some((p) => p.dataset.panel === ctx)) return;
		current = ctx;
		panels.forEach((p) => {
			const on = p.dataset.panel === ctx;
			p.hidden = !on;
			p.classList.toggle('enter', on);
		});
		if (title && data?.titles[ctx]) title.textContent = data.titles[ctx];
		if (aside) aside.dataset.ctx = ctx;
	};
	const mark = (id: string) =>
		rows.forEach((r) => (r.dataset.target === id ? r.setAttribute('aria-current', 'true') : r.removeAttribute('aria-current')));
	if ('IntersectionObserver' in window) {
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (!e.isIntersecting) continue;
					const el = e.target as HTMLElement;
					mark(el.id);
					show(el.dataset.ctx || 'get');
				}
			},
			{ rootMargin: '-40% 0px -55% 0px' },
		);
		sections.forEach((s) => io.observe(s));
	}
	mark('overview');

	// Short or narrow viewports: the install details start folded so the Companion fits.
	const more = document.querySelector<HTMLDetailsElement>('[data-get-more]');
	const tight = window.matchMedia('(max-width: 1179px), (max-height: 820px)');
	const fold = () => {
		if (more) more.open = !tight.matches;
	};
	fold();
	tight.addEventListener?.('change', fold);
}

/* Tablet and phone: the Sections menu. */
function menu() {
	const btn = document.querySelector<HTMLButtonElement>('[data-menu-btn]');
	const sheet = document.getElementById('sheet-menu');
	if (!btn || !sheet) return;
	const set = (open: boolean) => {
		sheet.classList.toggle('open', open);
		btn.setAttribute('aria-expanded', String(open));
	};
	btn.addEventListener('click', () => set(!sheet.classList.contains('open')));
	sheet.addEventListener('click', (e) => {
		if ((e.target as Element).closest('a')) set(false);
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && sheet.classList.contains('open')) {
			set(false);
			btn.focus();
		}
	});
}

/* The rotating headline. Decorative only: the H1's text never changes. */
function rotate() {
	if (root.dataset.rot !== 'on') return;
	const where = $$('[data-slot="where"] .w');
	const who = $$('[data-slot="who"] .w');
	const pause = document.querySelector<HTMLButtonElement>('[data-rot-pause]');
	const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
	if (!who.length) return;
	const show = (list: HTMLElement[], k: number) =>
		list.forEach((el, n) => (n === k ? el.setAttribute('data-on', '') : el.removeAttribute('data-on')));
	let i = 0;
	let j = 0;
	let paused = false;
	let timer = 0;
	const STEP = 2600;
	const tick = () => {
		i = (i + 1) % who.length;
		if (where.length > 1 && i % 3 === 0) j = (j + 1) % where.length;
		show(who, i);
		show(where, j);
	};
	const stop = () => {
		window.clearInterval(timer);
		timer = 0;
	};
	const run = () => {
		if (!timer && !paused && !document.hidden) timer = window.setInterval(tick, STEP);
	};
	const setPaused = (p: boolean) => {
		paused = p;
		if (pause) {
			pause.setAttribute('aria-label', p ? 'Play the headline animation' : 'Pause the headline animation');
			pause.querySelector<HTMLElement>('[data-icon="pause"]')?.toggleAttribute('hidden', p);
			pause.querySelector<HTMLElement>('[data-icon="play"]')?.toggleAttribute('hidden', !p);
		}
		if (p) stop();
		else run();
	};
	pause?.addEventListener('click', () => setPaused(!paused));
	document.addEventListener('visibilitychange', () => (document.hidden ? stop() : run()));
	reduce.addEventListener?.('change', (e) => {
		if (!e.matches) return;
		stop();
		show(who, 0);
		show(where, 0);
		delete root.dataset.rot;
	});
	run();
}

export function start() {
	const data = pageData();
	mode();
	downloads(data);
	copy();
	samples();
	companion(data);
	menu();
	rotate();
}
