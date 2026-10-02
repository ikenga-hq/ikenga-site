/**
 * moment-hero.ts — the proving-moment hero's beat, on the shared timeline engine.
 *
 * WP-14 hybrid: the shell content is a real capture (see MomentHero.astro), so
 * this beat no longer types a command or reveals recreated panes. It drives the
 * overlay theatre over the real pixels — three pane scrims power on in sequence
 * (tasks → terminal → artifact), a light sweep passes once, and a highlight ring
 * settles on the assembled artifact — then clears to the clean capture. The
 * rotating-agent H1 is unchanged.
 *
 * Motion rules (island contract): compositor-friendly properties only
 * (transform / opacity) via WAAPI; durations + easing from the token ramp below.
 * `mountMomentHero` wires the beat on the generic engine; the module
 * self-initialises every `[data-moment="hero"]` root on load.
 */
import { MomentTimeline, type MomentTimelineOptions, type ScheduledStep } from './timeline';

// ── Token ramp (mirrors the scoped CSS --mh-ease / durations) ─────────────
const EASE = 'cubic-bezier(0.22, 0.61, 0.16, 1)';
const LIFT_MS = 460; // a pane powering on

// ── Hero-specific wiring ──────────────────────────────────────────────────

/** Lift a pane scrim (opacity → 0), committing the final state inline. */
function liftScrim(el: HTMLElement): void {
	el.style.opacity = '0';
	el.animate([{ opacity: 0.86 }, { opacity: 0 }], { duration: LIFT_MS, easing: EASE, fill: 'both' });
}

export function mountMomentHero(root: HTMLElement): MomentTimeline {
	const scrim = (k: string) => root.querySelector<HTMLElement>(`[data-fx="${k}"]`);
	const scrims = Array.from(root.querySelectorAll<HTMLElement>('.mh-scrim'));
	const sweep = root.querySelector<HTMLElement>('[data-sweep]');
	const ring = root.querySelector<HTMLElement>('[data-ring]');

	const reset = (): void => {
		for (const el of scrims) {
			el.getAnimations().forEach((a) => a.cancel());
			el.style.opacity = ''; // → CSS armed state (0.86 under [data-anim=js])
		}
		if (sweep) {
			sweep.getAnimations().forEach((a) => a.cancel());
			sweep.style.opacity = '0';
			sweep.style.transform = '';
		}
		if (ring) {
			ring.getAnimations().forEach((a) => a.cancel());
			ring.style.opacity = '0';
		}
	};

	const finalFrame = (): void => {
		// Clean capture: every overlay off (also the reduced-motion frame).
		for (const el of scrims) {
			el.getAnimations().forEach((a) => a.cancel());
			el.style.opacity = '0';
		}
		if (sweep) sweep.style.opacity = '0';
		if (ring) ring.style.opacity = '0';
	};

	// Beat: sweep passes → tasks pane on → terminal on → artifact on + ring.
	const build = (): ScheduledStep[] => {
		const steps: ScheduledStep[] = [];
		steps.push({
			at: 220,
			fn: () => {
				if (!sweep) return;
				sweep.style.opacity = '1';
				sweep.animate(
					[
						{ transform: 'translateX(-160%) skewX(-12deg)', opacity: 0 },
						{ transform: 'translateX(-40%) skewX(-12deg)', opacity: 1, offset: 0.5 },
						{ transform: 'translateX(180%) skewX(-12deg)', opacity: 0 },
					],
					{ duration: 1100, easing: EASE, fill: 'both' },
				);
			},
		});
		const order: Array<[string, number]> = [
			['tasks', 360],
			['term', 620],
			['art', 900],
		];
		for (const [k, at] of order) {
			const el = scrim(k);
			if (el) steps.push({ at, fn: () => liftScrim(el) });
		}
		steps.push({
			at: 900 + LIFT_MS - 60,
			fn: () => {
				if (!ring) return;
				ring.animate([{ opacity: 0 }, { opacity: 0.9, offset: 0.28 }, { opacity: 0.9, offset: 0.72 }, { opacity: 0 }], {
					duration: 1500,
					easing: EASE,
					fill: 'both',
				});
			},
		});
		return steps;
	};

	const autoplay = (root.dataset.autoplay as MomentTimelineOptions['autoplay']) || 'viewport';
	const timeline = new MomentTimeline({ root, build, reset, finalFrame, autoplay, once: true });
	timeline.mount();

	const replayBtn = root.querySelector<HTMLElement>('[data-replay]');
	if (replayBtn) {
		if (timeline.prefersReducedMotion) replayBtn.style.display = 'none';
		else replayBtn.addEventListener('click', () => timeline.replay());
	}

	mountAgentRotator(root, timeline.prefersReducedMotion);
	return timeline;
}

/**
 * Rotating-agent H1 (Claude Code → Codex → ). Independent of the
 * one-shot moment: an interval loop that pauses when the tab is hidden.
 * Reduced-motion pins the first slot (CSS shows only `.cur`).
 */
function mountAgentRotator(root: HTMLElement, reduce: boolean): void {
	const rot = root.querySelector<HTMLElement>('[data-rot]');
	if (!rot) return;
	const slots = Array.from(rot.querySelectorAll<HTMLElement>('.mh-slot'));
	if (slots.length < 2) return;

	rot.style.display = 'inline-flex';
	if (reduce) return;

	// Reflow discipline (founder call — supersedes the WP-21 fixed-width pin).
	// The pin reserved the WIDEST slot ("Claude Code") and centred names inside
	// it, so short engines ("Codex") sat in dead space and "a home." never
	// tucked against the word. The mockups instead breathe: the rotator sizes to
	// the CURRENT name and the whole centred H1 re-centres as it changes. We
	// animate the width (CSS `transition: width`) so that reflow is smooth, not a
	// jump — the small periodic shift keeps CLS well inside the "good" band.
	//
	// Widths are read from the REAL display face: a bare rAF can fire before the
	// webfont `--site-font-display` loads and would fit to the narrower fallback
	// metrics, snapping wider when the real face swaps in. Fit immediately (warm
	// cache) and again once `document.fonts.ready` resolves (no-op if loaded).
	const fit = (el: HTMLElement): void => {
		rot.style.width = `${Math.ceil(el.getBoundingClientRect().width)}px`;
	};
	let idx = 0;
	requestAnimationFrame(() => fit(slots[idx]));
	if (document.fonts?.ready) document.fonts.ready.then(() => requestAnimationFrame(() => fit(slots[idx])));

	let timer = 0;
	const tick = () => {
		const prev = slots[idx];
		idx = (idx + 1) % slots.length;
		const next = slots[idx];
		prev.animate(
			[
				{ opacity: 1, transform: 'translateY(0)' },
				{ opacity: 0, transform: 'translateY(-0.3em)' },
			],
			{ duration: 320, easing: EASE, fill: 'forwards' },
		);
		prev.classList.remove('cur');
		next.classList.add('cur');
		fit(next); // reflow the box to the incoming name (CSS eases the width)
		next.animate(
			[
				{ opacity: 0, transform: 'translateY(0.3em)' },
				{ opacity: 1, transform: 'translateY(0)' },
			],
			{ duration: 320, delay: 120, easing: EASE, fill: 'forwards' },
		);
	};

	const start = () => {
		if (!timer) timer = window.setInterval(tick, 2600);
	};
	const stop = () => {
		if (timer) {
			clearInterval(timer);
			timer = 0;
		}
	};
	start();
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stop();
		else start();
	});
}

// ── Self-init ─────────────────────────────────────────────────────────────
function init(): void {
	for (const el of document.querySelectorAll<HTMLElement>('[data-moment="hero"]')) {
		mountMomentHero(el);
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
