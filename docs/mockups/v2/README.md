# v2 mockups (Phase 0 of the UI revamp)

> **Status:** for review
> _last updated: 2026-10-16_

Static HTML for judging the new direction before any app code changes. See
`docs/PLAN-ui-revamp.md` for the full plan.

| File | What it shows |
|---|---|
| `home.html` | Home + Explore: hero (one of the few spots with house art), live stats, token grid/list with filter tabs, live trades, fee split, how it works |
| `trade.html` | Trade terminal: token header, themed candlestick chart, trades/holders/modules tabs, buy/sell panel, graduation meter |
| `create.html` | Launch flow step 1 (Basics) and step 2 (Trading rules), live preview card, cost summary. Add `?filled` for a filled-in example |
| `tokens.css` | Color/type tokens for light (default) and dark, plus primitives (buttons, inputs, tabs, segmented, panels, tables, meters) |
| `shell.js` | Header, mobile tab bar, theme toggle, sample data, small motion helpers |

## How to view

Serve the repo root so the hero video in `web/public/` resolves:

```bash
python -m http.server 4599
```

Then open `http://localhost:4599/docs/mockups/v2/home.html`. The moon/sun button switches
theme (saved per browser). `?theme=dark` forces dark for screenshots.

## Notes

- Token art and names are real launches pulled from Pinata, numbers are made up.
- GSAP 3.13 (with SplitText, ScrollTrigger, Flip) and lightweight-charts 5 load from CDN here.
  In the app they become npm deps.
- Motion turns off under `prefers-reduced-motion`.
- The dark mode hero still uses the light altar art. A dark variant is a Higgsfield task.
