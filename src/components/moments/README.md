# Moment islands

Self-contained Astro islands that recreate one Ikenga app beat at display
fidelity — token-driven, WAAPI + IntersectionObserver, reduced-motion-safe.
See `CONTRACT.md` for the island contract that every moment implements.

## `cast.json` — provenance

`cast.json` in this folder is the staged-cast fixture every moment draws its
content from. It lives in this repository so the site builds standalone,
without any files outside the repo on disk.

The fixture's own `source` block records the base design
(`home-hero-theatre.html` rev 2), the registry snapshot it was verified
against, and the verification date — all content shown by a moment traces
back to that record (honesty rule: only registry-published pkgs are
depicted; no music-vertical flavor).
