/**
 * moment-install.ts — the Ọba install beat, on the shared timeline engine.
 *
 * Real-capture hybrid: the store is a real capture (see MomentInstall.astro), so this
 * beat drives the overlay theatre over the real pixels — a light sweep passes,
 * a ring settles on the selected `groundwork` row, then the real Install button
 * pulses ("one click") — then clears to the clean capture. Same WAAPI +
 * `MomentTimeline` grammar as the other moments (transform/opacity only; see
 * `./timeline.ts` + `./CONTRACT.md`). `mountMomentInstall` wires the beat; the
 * module self-initialises every `[data-moment="install"]` root on load.
 */
import { MomentTimeline, type ScheduledStep } from './timeline';

const EASE = 'cubic-bezier(0.22, 0.61, 0.16, 1)';

function pulseRing(el: HTMLElement, hold = 0.72): void {
	el.animate(
		[{ opacity: 0 }, { opacity: 0.9, offset: 0.25 }, { opacity: 0.9, offset: hold }, { opacity: 0 }],
		{ duration: 1400, easing: EASE, fill: 'both' },
	);
}

export function mountMomentInstall(root: HTMLElement): MomentTimeline {
	const rowRing = root.querySelector<HTMLElement>('[data-ring="row"]');
	const btnRing = root.querySelector<HTMLElement>('[data-ring="btn"]');
	const sweep = root.querySelector<HTMLElement>('[data-sweep]');
	const fx = [rowRing, btnRing, sweep];

	const reset = (): void => {
		for (const el of fx) {
			if (!el) continue;
			el.getAnimations().forEach((a) => a.cancel());
			el.style.opacity = '0';
			el.style.transform = '';
		}
	};

	// Clean capture: every overlay off (also the reduced-motion frame).
	const finalFrame = reset;

	// Beat: sweep passes → the selected pkg row rings → the Install button pulses.
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
		steps.push({ at: 520, fn: () => rowRing && pulseRing(rowRing) });
		steps.push({ at: 1180, fn: () => btnRing && pulseRing(btnRing, 0.78) });
		return steps;
	};

	const autoplay = (root.dataset.autoplay as 'viewport' | 'immediate' | 'manual') || 'viewport';
	const timeline = new MomentTimeline({ root, build, reset, finalFrame, autoplay, once: true });
	timeline.mount();

	const replayBtn = root.querySelector<HTMLElement>('[data-replay]');
	if (replayBtn) {
		if (timeline.prefersReducedMotion) replayBtn.style.display = 'none';
		else replayBtn.addEventListener('click', () => timeline.replay());
	}

	return timeline;
}

function init(): void {
	for (const el of document.querySelectorAll<HTMLElement>('[data-moment="install"]')) {
		mountMomentInstall(el);
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
