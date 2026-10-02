/**
 * timeline.ts — the Moment island timeline engine.
 *
 * `MomentTimeline` is the reusable spine every "shell moment" on ikenga.dev
 * drives. It owns:
 *   · a virtual-clock step schedule (setTimeout-based, rebuilt per play so
 *     replay is always clean),
 *   · lazy mount on viewport via IntersectionObserver (box reserved by CSS
 *     aspect-ratio — zero CLS), with teardown-on-exit for looping moments,
 *   · replay,
 *   · reduced-motion: renders the composed final frame, schedules nothing,
 *   · visibility-pause: when the tab is hidden the clock pauses and resumes
 *     exactly where it left off (no janky catch-up, no wasted timers).
 *
 * Extracted from the proving-moment hero so the tasks and install moments
 * can share it verbatim. Behavior is unchanged —
 * this is a lift, not a rewrite. See `./CONTRACT.md` for the island contract
 * every moment (hero, tasks, install, …) implements on top of this engine.
 */

export type StepFn = () => void;
export interface ScheduledStep {
	at: number; // ms offset from play start
	fn: StepFn;
}

export interface MomentTimelineOptions {
	/** Island root — observed for viewport mount; carries `data-anim`. */
	root: HTMLElement;
	/** Produce the step schedule. Called fresh on every play (clean replay). */
	build: () => ScheduledStep[];
	/** Return the DOM to its pre-play state (called before each play). */
	reset: () => void;
	/** Compose the static final frame (reduced-motion / no-viewport-play). */
	finalFrame: () => void;
	autoplay?: 'viewport' | 'immediate' | 'manual';
	/** once=true → play a single time then unobserve; false → loop on re-entry. */
	once?: boolean;
	threshold?: number;
}

export class MomentTimeline {
	private o: Required<MomentTimelineOptions>;
	private reduce: boolean;
	private timers: number[] = [];
	private pending: ScheduledStep[] = [];
	private startedAt = 0;
	private consumed = 0; // ms of the schedule already elapsed across pauses
	private playing = false;
	private io: IntersectionObserver | null = null;
	private mounted = false;

	constructor(opts: MomentTimelineOptions) {
		this.o = {
			autoplay: 'viewport',
			once: true,
			threshold: 0.35,
			...opts,
		} as Required<MomentTimelineOptions>;
		this.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	/** Wire the island. Reduced-motion short-circuits to the final frame. */
	mount(): void {
		if (this.mounted) return;
		this.mounted = true;

		if (this.reduce) {
			this.o.root.dataset.anim = 'static';
			this.o.finalFrame();
			return;
		}

		// data-anim="js" is the CSS signal to hide the .mh-m elements so they
		// can animate in. Without JS (or under reduced-motion) they stay
		// visible → the SSG-rendered final frame is correct with zero script.
		this.o.root.dataset.anim = 'js';
		this.o.reset();
		document.addEventListener('visibilitychange', this.onVisibility);

		if (this.o.autoplay === 'immediate') {
			this.play();
		} else if (this.o.autoplay === 'viewport') {
			this.io = new IntersectionObserver(
				(entries) => {
					for (const e of entries) {
						if (e.isIntersecting) {
							this.play();
							if (this.o.once) this.io?.disconnect();
						} else if (!this.o.once) {
							this.stop();
							this.o.reset();
						}
					}
				},
				{ threshold: this.o.threshold },
			);
			this.io.observe(this.o.root);
		}
	}

	play(): void {
		if (this.reduce || this.playing) return;
		this.o.reset();
		this.pending = this.o.build().slice().sort((a, b) => a.at - b.at);
		this.consumed = 0;
		this.playing = true;
		this.schedule();
	}

	replay(): void {
		if (this.reduce) return;
		this.stop();
		this.play();
	}

	/** Full teardown — for hot-reload / route change. */
	teardown(): void {
		this.stop();
		this.io?.disconnect();
		this.io = null;
		document.removeEventListener('visibilitychange', this.onVisibility);
		this.mounted = false;
	}

	get prefersReducedMotion(): boolean {
		return this.reduce;
	}

	// ── internals ──────────────────────────────────────────────────────────
	private schedule(): void {
		this.startedAt = performance.now();
		const base = this.consumed;
		for (const step of this.pending) {
			const delay = Math.max(0, step.at - base);
			const id = window.setTimeout(() => {
				step.fn();
				this.pending = this.pending.filter((s) => s !== step);
				if (this.pending.length === 0) this.playing = false;
			}, delay);
			this.timers.push(id);
		}
	}

	private clearTimers(): void {
		for (const id of this.timers) clearTimeout(id);
		this.timers = [];
	}

	private stop(): void {
		this.clearTimers();
		this.pending = [];
		this.playing = false;
		this.consumed = 0;
	}

	private pause(): void {
		if (!this.playing) return;
		this.clearTimers();
		this.consumed += performance.now() - this.startedAt;
	}

	private resume(): void {
		if (!this.playing) return;
		this.schedule();
	}

	private onVisibility = (): void => {
		if (document.hidden) this.pause();
		else this.resume();
	};
}
