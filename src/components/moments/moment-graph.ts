/**
 * moment-graph.ts — "Everything connects" v2, client half only.
 *
 * The radial layout, every info card, the matrix and the flow all render at
 * BUILD TIME in MomentGraph.astro — nothing here imports d3, and the complete
 * four-state sequence is legible with this script absent (the SSG stacked
 * frame). This script only ever ADDS behaviour on top:
 *
 *   1. trace — hover/focus a node → dim all but its incident edges + nodes
 *      (amber outgoing / teal incoming), matching the shell reference.
 *   2. info board — the same node focus/hover swaps the visible detail card
 *      (Beat 2) and announces the selection through a visually-hidden
 *      aria-live region (keyboard-reachable node select, per the DoD).
 *   3. pinned sequence — ONLY when motion is allowed: drive the active
 *      `[data-beat]` from track scroll progress (IO-gated passive listener;
 *      the beat transitions themselves are compositor-safe CSS transitions on
 *      transform/opacity — no CSS scroll-timeline). `data-anim="js"` itself is
 *      set by the component's parse-time inline script so the pinned track's
 *      height is reserved before first paint (zero layout shift).
 *   4. ambient intro — a one-shot edge draw-in, IO- and reduced-motion-gated.
 *      Note: the draw-in animates `strokeDashoffset` (not transform/
 *      opacity) — a recorded, accepted deviation carried over from the original
 *      island: one-shot, 13 edges, reduced-motion-gated, sub-second.
 *
 * Under prefers-reduced-motion the script installs trace + info-board select
 * (interaction, not motion) but registers ZERO animations and never sets
 * `data-anim="js"` → the section stays the static stacked frame.
 */
const EASE = 'cubic-bezier(0.22, 0.61, 0.16, 1)';

interface Board {
	show(id: string): void;
	featured: string;
}

/** Build the info-board controller: swap the visible pre-rendered card and
 * announce the selection. Cards live in the SSG HTML; we only toggle `hidden`. */
function makeBoard(root: HTMLElement): Board | null {
	const info = root.querySelector<HTMLElement>('.mg-l-info');
	const live = root.querySelector<HTMLElement>('.mg-live');
	if (!info) return null;
	const featured = info.dataset.featured ?? '';
	const cards = new Map<string, HTMLElement>();
	for (const c of info.querySelectorAll<HTMLElement>('.mg-gd')) {
		const id = c.dataset.node ?? '';
		if (id) cards.set(id, c);
	}
	function show(id: string): void {
		const target = cards.get(id) ?? cards.get(featured);
		if (!target) return;
		for (const [, c] of cards) c.hidden = c !== target;
		if (live) {
			const name = target.querySelector('.mg-gd-name')?.textContent ?? '';
			const kind = target.querySelector('.mg-gd-kind')?.textContent?.trim() ?? '';
			const conn = target.querySelector('.mg-gd-ch span:last-child')?.textContent ?? '';
			live.textContent = `Selected ${name} — ${kind}, ${conn} connections`;
		}
	}
	return { show, featured };
}

function wireTrace(svg: SVGSVGElement, board: Board | null): void {
	const edges = Array.from(svg.querySelectorAll<SVGPathElement>('.mg-edge'));
	const nodeEls = Array.from(svg.querySelectorAll<SVGGElement>('.mg-node'));

	function clear(): void {
		svg.classList.remove('mg-tracing');
		for (const e of edges) e.classList.remove('mg-edge-out', 'mg-edge-in', 'mg-edge-dim');
		for (const n of nodeEls) n.classList.remove('mg-node-dim', 'mg-node-hot');
	}

	function trace(id: string): void {
		svg.classList.add('mg-tracing');
		const keep = new Set<string>([id]);
		for (const e of edges) {
			const isOut = e.dataset.source === id;
			const isIn = e.dataset.target === id;
			e.classList.toggle('mg-edge-out', isOut);
			e.classList.toggle('mg-edge-in', isIn);
			e.classList.toggle('mg-edge-dim', !isOut && !isIn);
			if (isOut && e.dataset.target) keep.add(e.dataset.target);
			if (isIn && e.dataset.source) keep.add(e.dataset.source);
		}
		for (const n of nodeEls) {
			const nid = n.dataset.nodeId ?? '';
			n.classList.toggle('mg-node-hot', nid === id);
			n.classList.toggle('mg-node-dim', !keep.has(nid));
		}
	}

	for (const n of nodeEls) {
		const id = n.dataset.nodeId ?? '';
		const enter = () => {
			trace(id);
			board?.show(id);
		};
		n.addEventListener('pointerenter', enter);
		n.addEventListener('focus', enter);
		n.addEventListener('pointerleave', clear);
		n.addEventListener('blur', clear);
	}
	svg.addEventListener('pointerleave', clear);

	// expose for the beat driver (Beat 2 pre-traces the featured node)
	(svg as SVGSVGElement & { _trace?: (id: string) => void; _clear?: () => void })._trace = trace;
	(svg as SVGSVGElement & { _trace?: (id: string) => void; _clear?: () => void })._clear = clear;
}

/** Draw-in intro: staggered arc/node fade + edge stroke-dashoffset reveal. */
function playIntro(svg: SVGSVGElement): void {
	const edges = Array.from(svg.querySelectorAll<SVGPathElement>('.mg-edge'));
	const fadeIn = Array.from(svg.querySelectorAll<SVGElement>('.mg-arc, .mg-node'));

	for (const el of fadeIn) {
		el.animate([{ opacity: 0 }, { opacity: 1 }], {
			duration: 480,
			easing: EASE,
			fill: 'both',
			delay: 40 + Math.random() * 200,
		});
	}
	for (const e of edges) {
		const len = e.getTotalLength();
		e.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
			duration: 900,
			easing: EASE,
			fill: 'both',
			delay: 100 + Math.random() * 340,
		});
	}
}

/** Pinned-sequence beat driver: active [data-beat] derived from track scroll
 * progress. An IO on the track gates a passive rAF-throttled scroll listener,
 * so the beat is recomputed from geometry on every frame the track is on
 * screen — robust under jump scrolls (PageDown/End/scrollbar drags), where the
 * old sentinel-crossing IO could strand the stage on a stale beat. */
function wireBeats(root: HTMLElement, svg: SVGSVGElement, board: Board | null): void {
	const sticky = root.querySelector<HTMLElement>('.mg-sticky');
	const track = root.querySelector<HTMLElement>('.mg-track');
	const dots = Array.from(root.querySelectorAll<HTMLElement>('.mg-progress i'));
	if (!sticky || !track) return;
	const beats = root.querySelectorAll('.mg-step').length || 4;

	const traceFn = (svg as SVGSVGElement & { _trace?: (id: string) => void })._trace;
	const clearFn = (svg as SVGSVGElement & { _clear?: () => void })._clear;
	let beat = 1;

	function setBeat(b: number): void {
		if (b === beat) return;
		beat = b;
		sticky!.dataset.beat = String(b);
		dots.forEach((d, i) => d.classList.toggle('on', i === b - 1));
		// Beat 2 pre-traces the featured hub + opens its card
		if (b === 2 && board && traceFn) {
			traceFn(board.featured);
			board.show(board.featured);
		} else if (clearFn) {
			clearFn();
		}
	}

	function beatFromProgress(): number {
		const r = track!.getBoundingClientRect();
		const span = r.height - innerHeight;
		if (span <= 0) return 1;
		const p = Math.min(Math.max(-r.top / span, 0), 1);
		return Math.min(beats, Math.floor(p * beats) + 1);
	}

	let raf = 0;
	let watching = false;
	const update = (): void => {
		raf = 0;
		setBeat(beatFromProgress());
	};
	const onScroll = (): void => {
		if (!raf) raf = requestAnimationFrame(update);
	};

	const io = new IntersectionObserver((entries) => {
		for (const e of entries) {
			if (e.isIntersecting && !watching) {
				watching = true;
				addEventListener('scroll', onScroll, { passive: true });
				update();
			} else if (!e.isIntersecting && watching) {
				watching = false;
				removeEventListener('scroll', onScroll);
				if (raf) {
					cancelAnimationFrame(raf);
					raf = 0;
				}
			}
		}
	});
	io.observe(track);
}

function mountMomentGraph(root: HTMLElement): void {
	const svg = root.querySelector<SVGSVGElement>('svg.mg-svg');
	if (!svg) return;

	const board = makeBoard(root);
	wireTrace(svg, board);

	// Interaction (trace + info board) is available regardless of motion pref;
	// only the pinned choreography + ambient intro are motion-gated.
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

	// Upgrade to the pinned sequence (CSS gates the actual pin to >=721px).
	root.dataset.anim = 'js';
	wireBeats(root, svg, board);

	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (e.isIntersecting) {
					playIntro(svg);
					io.disconnect();
				}
			}
		},
		{ threshold: 0.3 },
	);
	io.observe(root);
}

function init(): void {
	for (const el of document.querySelectorAll<HTMLElement>('[data-moment="graph"]')) {
		mountMomentGraph(el);
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
