/**
 * moment-tasks.ts — the tasks/agenda beat, on the shared timeline engine.
 *
 * Real-capture hybrid: the agenda is a real capture (see MomentTasks.astro), so this
 * beat drives the overlay theatre over the real pixels — a highlight ring
 * settles on the overdue card and a spark rides the real now-line — then clears
 * to the clean capture. Same WAAPI + `MomentTimeline` grammar as the other
 * moments (transform/opacity only; see `./timeline.ts` + `./CONTRACT.md`).
 * `mountMomentTasks` wires the beat; the module self-initialises every
 * `[data-moment="tasks"]` root on load.
 */
import { MomentTimeline, type ScheduledStep } from './timeline';

const EASE = 'cubic-bezier(0.22, 0.61, 0.16, 1)';

export function mountMomentTasks(root: HTMLElement): MomentTimeline {
	const ring = root.querySelector<HTMLElement>('[data-ring]');
	const spark = root.querySelector<HTMLElement>('[data-spark]');

	const reset = (): void => {
		for (const el of [ring, spark]) {
			if (!el) continue;
			el.getAnimations().forEach((a) => a.cancel());
			el.style.opacity = '0';
			el.style.transform = '';
		}
	};

	// Clean capture: every overlay off (also the reduced-motion frame).
	const finalFrame = reset;

	// Beat: the spark travels the now-line while the ring settles on the overdue card.
	const build = (): ScheduledStep[] => {
		const steps: ScheduledStep[] = [];
		steps.push({
			at: 300,
			fn: () => {
				if (!spark) return;
				spark.style.opacity = '1';
				spark.animate(
					[
						{ transform: 'translateX(0)', opacity: 0 },
						{ transform: 'translateX(0)', opacity: 1, offset: 0.08 },
						{ transform: 'translateX(100cqw)', opacity: 1, offset: 0.9 },
						{ transform: 'translateX(100cqw)', opacity: 0 },
					],
					{ duration: 1200, easing: EASE, fill: 'both' },
				);
			},
		});
		steps.push({
			at: 520,
			fn: () => {
				if (!ring) return;
				ring.animate(
					[{ opacity: 0 }, { opacity: 0.9, offset: 0.25 }, { opacity: 0.9, offset: 0.72 }, { opacity: 0 }],
					{ duration: 1500, easing: EASE, fill: 'both' },
				);
			},
		});
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
	for (const el of document.querySelectorAll<HTMLElement>('[data-moment="tasks"]')) {
		mountMomentTasks(el);
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
