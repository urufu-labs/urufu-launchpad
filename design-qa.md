# Culture Bulletin design QA

**Source visual truth**

- Selected option 2 from this task: `/Users/tacopaco/.codex/generated_images/019fdeaf-a66a-7143-9587-f4ed0763f62f/exec-af34fc11-682b-4800-a74a-5be2dbefa459.png`
- Rendered local implementation: `/Users/tacopaco/workspace/fun/code/urufu-launchpad/.omx/state/culture-first-parity-audit/16-culture-bulletin-final-local.png`
- Combined comparison: `/Users/tacopaco/workspace/fun/code/urufu-launchpad/.omx/state/culture-first-parity-audit/16-culture-bulletin-comparison.png`

**Comparison setup**

- Route/state: `/` with local review fixtures enabled, light theme, no wallet.
- Implementation viewport: `1280 × 720` CSS px at device scale factor 1; full-page capture is `1280 × 2038` px.
- Source capture: `929 × 1693` px. The combined comparison scales the source proportionally to the implementation’s full-page height before placing the two images side by side; it is a composition comparison, not a pixel-perfect clone target.
- Focused regions reviewed: the release shelf, the Culture Bulletin panel, artwork crop, launch signal, and the artist strip. The desktop capture makes the typography and live-data treatment readable, so a separate zoomed crop was not needed.

**Findings**

- No actionable P0, P1, or P2 differences. The implementation preserves the selected option’s editorial hierarchy—release artwork, a creator-facing release note, launch signal, collector activity, selected hook protections, artist strip, and closing launch CTA—while deliberately retaining the approved Urufu navigation, ticker, launch shelf, activity rail, and flywheel controls.
- The selected concept used a bespoke editorial illustration and fictional release prose. The implementation intentionally uses the token’s real metadata image and existing launch data instead, which better supports review of the production layout and avoids decorative placeholder artwork or unapproved product copy.

**Required fidelity surfaces**

- Fonts and typography: existing Urufu display, pixel, mono, and handwritten type roles are retained; the bulletin adds no generic UI font or cramped desktop wrapping.
- Spacing and layout rhythm: the bulletin is a bordered, three-column editorial spread at desktop and a single-column stack at mobile; tested mobile `390 × 844` has no horizontal overflow.
- Colors and tokens: the paper, ink, pink, mint, and dashed-border system is inherited from the existing home. The theme toggle was verified through `localhost`: light → dark → light, with the accessible label updating both ways.
- Image quality and asset fidelity: the featured panel uses the release’s actual artwork through the same safe metadata image path as the ticket. Its `contain` crop keeps the full token art visible instead of substituting an icon or CSS illustration.
- Copy and content: the user-approved hero is unchanged. The new bulletin labels are short structural labels from the selected direction; token names, tickers, creators, curve data, raised value, trades, and collectors come from existing review fixtures or live data.

**Comparison history**

1. The first 127.0.0.1 capture held a stale stylesheet and rendered the new section unstyled. The local dev process was restarted, producing the styled desktop capture at `12-culture-bulletin-styled.png`.
2. The first styled panel omitted the concept’s recent-collector readout. It was added alongside the selected-hook signal; the initial inline collector layout was then corrected to separate rows. Final evidence is the combined comparison listed above.

**Implementation checklist**

- [x] Move the three-step creation guidance from home to `/create`.
- [x] Remove the non-choice “pick a base” control from `/create`; ERC-20 remains fixed.
- [x] Add the Culture Bulletin to the home route using real token artwork and launch data.
- [x] Verify desktop, mobile overflow, creation-route handoff, theme toggle, and browser console.

**Follow-up polish**

- [P3] Replace local review fixtures with indexed release metadata and activity once representative Robinhood data is available.
- [P3] The legacy docs route still contains an ERC-721/ERC-1155 “pick a base” explainer at `web/src/app/docs/page.tsx:151`; remove it when that page receives its culture-first pass, as already tracked in `docs/mockups/culture-first-follow-through.md`.

final result: passed
