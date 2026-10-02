# Moment island contract

_The proving-moment hero (`MomentHero.astro` + `moment-hero.ts`) is the
reference implementation; every moment implements this same contract._

A **moment** is a self-contained Astro island that recreates one Ikenga app
beat at display fidelity. It renders its DOM at **build time** from a fixtures
slice (no runtime fetch), themes from the site tokens, animates via WAAPI +
IntersectionObserver, and degrades to a composed static frame under
`prefers-reduced-motion`. It is marketing theatre calibrated against real
captures — it never fabricates a feature (honesty rule).

## Props

| Prop | Type | Default | Meaning |
|------|------|---------|---------|
| `tone` | `'dark' \| 'light'` | `'dark'` | Tone pole for the **outer copy only** (headline, sub, ghost row, foot) via `--site-*`. The shell recreation is a tone-**independent** dark app object and never flips. |
| `autoplay` | `'viewport' \| 'immediate' \| 'manual'` | `'viewport'` | Handed to the timeline engine. `viewport` = play once when scrolled into view; `immediate` = play on mount; `manual` = only on `replay()`. |
| `cast` | cast object | vendored `./cast.json` | The **fixtures slice**. Defaults to the vendored fixture; a caller may pass a different cast to drive the same island with other content. |

## Lifecycle

- **Lazy mount on viewport.** The animated path is armed only after the root
  intersects (`IntersectionObserver`, threshold 0.35). With `once: true` (the
  hero) it plays a single time then unobserves; with `once: false` a looping
  moment resets on exit and replays on re-entry (**teardown on exit**).
- **Box reserved → zero CLS.** The stage carries an explicit
  `aspect-ratio: 1056 / 512` (verified: `getComputedStyle(...).aspectRatio ===
  '1056 / 512'`) so the layout is stable at first paint. Because the DOM is
  SSG-rendered (no fetch, no client framework hydration), the box is never
  empty regardless. Below 860px the shell reflows (`aspect-ratio: auto`,
  sidebar hidden, panes stack) — a mobile aspect lock would be wrong.
- **Visibility pause.** A virtual clock drives the schedule; when the tab is
  hidden the remaining steps are cleared and the elapsed time banked, then
  rescheduled exactly on resume — no catch-up burst, no timers firing off-screen.
- **`teardown()`** clears timers, disconnects the observer, and unbinds the
  visibility listener (for hot-reload / route change).

## Motion rules

- **Engine baseline: WAAPI + IntersectionObserver only.** No CSS
  `scroll-timeline` dependency (Firefox still flag-gates `animation-timeline`
  mid-2026); it is permitted only as progressive enhancement, and this island
  uses none.
- **Compositor-friendly properties only.** Every reveal animates `transform`
  + `opacity` (WAAPI `el.animate([...])`). The single exception is the
  rotating-agent H1 container's `width` transition — a bounded, secondary
  headline reflow off the moment's critical path (inherited from the home design).
- **Durations / easing from the token ramp.** `--mh-ease:
  cubic-bezier(0.22,0.61,0.16,1)`; reveal 300ms; the beat pacing is the home
  design's locked timeline (type → +420 status → +700 board → +900 artifact → +900
  settle), staggers 160/130/150/120ms per group.
- **60fps headroom.** Concurrently-animating nodes are bounded: max reveal
  group is 5 elements staggered 150ms over 300ms reveals (≈3 in flight at
  once), plus the blinking cursor and ≤2 rotator slots mid-swap ≈ **6 peak** —
  well under the **24-node** ceiling. (An instrumented trace is a manual
  review step; this states the design bound.)

## Reduced motion

`prefers-reduced-motion: reduce` renders the **composed final frame with zero
animation**, guaranteed two independent ways:

1. **JS path** — `MomentTimeline.mount()` checks `matchMedia` first; when
   reduced it sets `data-anim="static"` (never `"js"`), calls `finalFrame()`
   (types the full command, hides the cursor, sets every `.mh-m` to
   opacity 1), and schedules nothing.
2. **CSS path** — a `@media (prefers-reduced-motion: reduce)` block forces
   `.mh-m { opacity:1 !important; transform:none !important }`, hides the
   cursor, drops the headline glow, and pins the first rotator slot. This
   composes the frame even if the script never runs.

Because the animated path is gated behind `data-anim="js"` (set only by JS,
only when motion is allowed), the **no-JS** state is also the correct static
frame — the command text and all pane content are in the SSG HTML.

_Tested:_ verified by code path (both branches above) and confirmed the built
CSS ships `.mh-m{opacity:1!important;transform:none!important}`; the composed
frame captured in the browser **is** the reduced-motion
target frame.

## JS budget

**Hard budget: ≤ 4 KB gzipped** for this island's JavaScript (comfortably
under the 30 KB island ceiling).

**Measured:** the built bundle (`dist/_astro/page.*.js`, the sole script on the
page — no framework runtime) is **2242 B raw / 1028 B gzip (~1.0 KB)**. Within
budget with ~4× headroom.

## Dependencies

The consuming page must load the site token layer (`src/styles/global.css`,
which imports `@ikenga/tokens` → `theming.css` → `tokens-site.css`) and pin
`data-theme="A" data-mode="dark"` on `<html>` — the `--site-*` slots (and the
`--achievement`-derived accent) resolve only under that pin. The `--moment-*`
shell locals are self-contained in the component and need no upstream slot.

## Fixtures provenance

`cast.json` here is the vendored staged-cast fixture (see `README.md`). All
depicted content traces to that fixture's `source` block (base design
`home-hero-theatre.html` rev 2, registry snapshot, verification date).
