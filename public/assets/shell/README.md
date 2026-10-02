# Shell hero assets

Product visuals of the Ikenga shell for the launch site hero, the shell
README, and the OG/social card.

| File | Surface | Notes |
|------|---------|-------|
| `ngwa-cockpit.png` | Ngwa cockpit — Browse + selected skill detail | hero candidate |
| `oba-store.png` | Ọba (store) surface + entry detail | the package-manager surface |
| `capability-graph.png` | Capability graph — radial bundle **with kind-band arcs** | most striking |
| `store-map.png` | Store-map presence matrix (entry × scope) | distinctive |
| `og-card.png` | 1200×630 social card (cropped from the cockpit) | OG/Twitter |

## Provenance

Rendered headlessly from the hi-fi **design prototypes**
at 1680×1050, Theme A · Dusk Wood (dark). Design files were first reconciled to
the current shipped surfaces from source — notably `cockpit-ngwa-hifi.html` was
corrected so **Ọba (store)** is a MANAGE *surface* (Browse · Registry · Ọba store)
and KIND lists only the five primitives, matching `ngwa-mode.tsx`. The
capability-graph arcs shipped into the shell too (`graph-view.tsx`, branch
`feat/bundle-kind-arcs`).

Placeholder data only (ss-a11y, verify, groundwork, …) — no real client data, so
no redaction needed.

## Known gaps / follow-ups

- **Dark-only.** The hi-fi designs are not token-driven for light mode, so light
  variants need design-CSS work (or a render of the real app, which supports
  light). Deferred.
- These are faithful **design renders**, not live-app screenshots. They match the
  shipped surfaces; for a "this is the real app" proof, pair with a real
  (redacted) screenshot. The arcs are visually confirmed only in the design until
  a dev/tauri build is captured.
