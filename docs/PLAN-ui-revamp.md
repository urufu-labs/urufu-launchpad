# UI/UX revamp plan

> **Status:** proposal, not started
> _last updated: 2026-10-16_

## Where we are today

Reviewed live (urufulabs.xyz, light + dark, 1440px) and in code.

**Visual system.** "Kawaiicore scrapbook": cream paper, double-line borders, tape strips, stamps,
Win95 offset-shadow buttons, five fonts (Yusei Magic, Klee One, Pixelify Sans, DotGothic16,
Georgia body) plus JetBrains Mono. It has personality, but it reads as a theme laid over a
trading app instead of a product designed for trading.

**Concrete problems found**
- Dark mode is a palette swap of the cream theme: plum surfaces, cream text, pink glows. Low
  contrast on muted text, and every panel keeps the 3px double border, so the dark pages look busy.
- The trade chart canvas stays cream in dark mode (big bright rectangle on the trade page).
- The home hero art is blank in dark mode until the video loads.
- Pixel font is used for labels, inputs and data at 9 to 12px. Hard to read, and it makes
  everything look the same weight.
- Header has 9 nav links plus 5 toggles plus search, chain and wallet. No hierarchy.
- Ticker says "no launches yet on Robinhood" while launches exist below it.
- Footer still says "last updated 2026-07-14".
- Disabled "connect wallet" on the trade panel is nearly invisible in both themes.
- Nested frames (shell > inner > inner-inner) eat space; the trade page fits less data than it should.

**Code shape**
- `globals.css` is 1,862 lines and defines ~126 `.uru-*` classes plus theme tokens.
- 828 inline `style={{}}` blocks (create 154, trade 105, profile 81). Most hardcode
  `var(--cream)`, `var(--anchor)` and similar, so tokens are named after colors, not roles.
- 15 CSS modules, ~6,300 lines total.
- No shared primitives: no Button, Card, Modal, Tabs component. Two modals are hand-built.
- Mega-pages mix logic and markup: `trade/[address]/page.tsx` 3,315 lines, `create/page.tsx`
  2,687, `profile/[address]` 1,542, `collection/[address]` 1,212.
- framer-motion is only used in `CartItem` and `ShelfItem`. Everything else is CSS keyframes.

## Ground rules (what must not break)

- **Do not touch:** `web/src/lib/**` (wagmi, `config.ts`, `abis.ts`, `indexer.ts`, all API
  clients, swap math, price formatting), `web/src/app/api/**`, `indexer/`, `compile-service/`,
  keepers, contracts, Railway env or services. The revamp is presentation only.
- Logic extraction from mega-pages is **mechanical**: move hooks and handlers verbatim into
  `useXxx.ts` files next to the page, no renames of query keys, no change to read/write args.
  One page per PR, reviewed as "pure move".
- `pnpm run build` (not `tsc`) before every web commit (wagmi generics).
- Keep `chainId` on every `useReadContracts` contract entry when touching those files.
- Each phase ships on its own branch, gets a Vercel preview, is smoke-tested on mainnet RH
  (small buy, small sell, create in mock mode, NFT mint view, DN404 trade view), then merges.
- Copy rules still apply: plain language, no em dashes, `URU` and `urufu gemu nft` spelled exactly.

## Direction: pro trading first (decided 2026-10-16)

Decision: go harder than "keep the soul". The product reads as a pro trading tool. The mascot and
house art appear only in a few marketing spots (home hero, 404, empty states, OG images). Token art
uploaded by launchers is the main color on tool surfaces. Kanji labels are dropped from UI chrome.
Light is the default theme. The notes below still apply except where they mention the mascot or
kanji in product UI.

### Earlier framing: keep the soul, drop the costume

What makes urufu distinct is the **art** (the chibi characters, the wolf, the altar piece) and
a Japanese-inflected voice. What makes it look dated is the **chrome** (tape, stamps, double
borders, Win95 shadows, five novelty fonts). The plan keeps the first and replaces the second.

**Anti-slop rules** (things we will not do)
- No purple to blue gradients, no gradient headline text, no floating glowing orbs.
- No glassmorphism on every surface. No blanket `rounded-2xl` + soft shadow cards.
- No sparkle emoji or symbol bullets in UI chrome (✿ ✦ ❁ ♡ go).
- No centered hero with a one-line tagline and two buttons as the whole pitch.
- No animation that delays a trade. Motion on trading surfaces must be under 250ms and never block input.

**What we do instead**
- Editorial layout on marketing surfaces (home, docs, collection pages): big type, real art,
  strong grid, asymmetry.
- Dense, quiet, precise UI on tool surfaces (trade, create, profile): like a good exchange
  terminal, with the art as the only loud element.
- One signature accent used sparingly, so when it appears it means "action" or "brand".
- Japanese accents kept as small labels (kanji section markers like 取引, 発見) in one face,
  not sprinkled everywhere.

### Proposed color system (light is the default, dark is a full first-class theme)

Tokens are named by role. Old names get aliased to these during migration (see Phase 1).

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0D0C0B` warm ink | `#F5F2EC` paper | page |
| `--surface-1` | `#151413` | `#FFFFFF` | panels |
| `--surface-2` | `#1D1B19` | `#F0ECE5` | inputs, nested rows |
| `--surface-3` | `#26231F` | `#E6E0D6` | hover, selected |
| `--line` | `#2B2825` | `#DDD6CB` | 1px borders |
| `--line-strong` | `#3B3733` | `#C5BCAE` | focused borders |
| `--fg` | `#F3EEE6` | `#15130F` | primary text |
| `--fg-muted` | `#A39A90` | `#6B6359` | secondary text (AA on surface-1) |
| `--fg-faint` | `#6E665E` | `#9A9187` | tertiary, disabled |
| `--accent` | `#FF4F87` sakura | `#E8326E` | brand, primary CTA |
| `--accent-fg` | `#140A0E` | `#FFFFFF` | text on accent |
| `--buy` | `#2BD98F` | `#0E9F63` | buy, up |
| `--sell` | `#FF6A4D` vermilion | `#D9452A` | sell, down (distinct from accent pink) |
| `--info` | `#8FB3FF` | `#2F5BD3` | links, neutral highlights |
| `--warn` | `#F5C451` | `#B7860B` | warnings |

Warm near-black instead of plum: it lets the colorful chibi art be the color, and it stops the
"everything is purple" look. Sell moves to vermilion so pink always means brand and never "loss".

### Type

- **UI and body:** one clean grotesk with real weights, e.g. *Hanken Grotesk* or *Onest*
  (Google Fonts, variable). Not Inter/Geist, to avoid looking like every template.
- **Display:** one face with character for big headlines only, e.g. *Instrument Serif* (italic
  for editorial moments) or keep *Yusei Magic* only at 48px+ where it reads as intentional.
- **Numbers:** keep JetBrains Mono with tabular figures (`.uru-num` survives).
- **JP accent:** *Zen Kaku Gothic New* or DotGothic16 for small kanji labels only.
- Drop Klee One, Pixelify Sans and Georgia. Five fonts down to three or four.
- Scale: 12 / 13 / 14 / 16 / 20 / 28 / 40 / 64 / 96. Minimum UI text 12px, data 13px.

### Motion (GSAP)

GSAP is fully free now (including SplitText, ScrollTrigger, Flip, MorphSVG). Use `gsap` +
`@gsap/react` (`useGSAP` handles cleanup in React 19 / App Router).

- `web/src/lib/motion/` holds shared eases, durations and a `gsap.matchMedia()` wrapper that
  turns everything off under `prefers-reduced-motion`.
- **Where:**
  - Home: SplitText headline reveal, ScrollTrigger pinned "how it works" sequence, parallax on the art.
  - Discover: Flip for filter/sort reorders of the token grid.
  - Trade: number tickers on price/mcap, trade-tape row insert, buy/sell flash (replaces CSS keyframes),
    a one-time graduation moment when a curve hits 100%.
  - Create: step transitions, live preview card that reacts to inputs, launch success sequence.
  - Global: page-enter stagger (short), toast/sheet transitions.
- **Where not:** inputs, buttons that submit transactions, the chart, wallet modals. No smooth-scroll
  hijack (Lenis) site-wide; it fights trading UX.
- Retire framer-motion once `CartItem`/`ShelfItem` move to GSAP (or `@dnd-kit` transforms alone).
- Cursor mascot and sparkles become opt-in (off by default), audio stays behind its toggle.

### Higgsfield (art, not chrome)

Use it for assets only, never UI elements:
- Hero loop: a short, seamless 6 to 8s loop of the altar piece / wolf, with a static poster
  for both themes (fixes the blank dark hero).
- Empty states (no tokens, no holdings, no trades) in the house chibi style, 3 to 5 pieces.
- OG image backgrounds for trade and collection pages.
- Note: the Higgsfield connector needs to be authorized in claude.ai connector settings before
  it can be used from here.

## Phases

### Phase 0: Lock the direction (no app code)
_Status 2026-10-16: first pass built in `docs/mockups/v2/` (home, trade, create), awaiting review._
- Build three static mockups in `docs/mockups/v2/`: home, trade terminal, create step 1. Both themes,
  desktop + 390px mobile. Plain HTML/CSS + GSAP so motion can be judged too.
- Pick fonts and finalize the token table from the mockups.
- **Exit:** you approve the mockups. Nothing ships before this.

### Phase 1: Foundation
_Status 2026-10-16: done on branch `ui-revamp`. What landed:_
- _`web/src/styles/tokens.css`: role tokens (light default + dark) and the legacy alias block. Old
  color and font names (`--cream`, `--anchor`, `--pink-hot`, `--font-pixel`, ...) now resolve to v2
  roles, so every page re-skinned at once with no per-page edits._
- _Shared `.uru-*` classes in `globals.css` restyled flat (hairline panels, v2 buttons/inputs/chips,
  stamps as badges, tape hidden). The hardcoded plum dark-mode overrides for home were removed._
- _Mechanical sweep across CSS modules and inline styles: thick ink borders became `1px solid
  var(--line)`, offset sticker shadows became none. Style strings only._
- _Fonts: Hanken Grotesk + JetBrains Mono via `next/font`; five novelty faces dropped._
- _`theme-bootstrap.js`: light default kept; `?theme=dark|light` forces a theme for screenshots._
- _GSAP 3.13 + `@gsap/react`. Primitives and motion helpers live in `web/src/components/ui/`
  (not `lib/`, which stays logic-only) with styles in `web/src/styles/ui.css`._
- _`/ui-kit` gallery (404 in production unless `NEXT_PUBLIC_SHOW_UI_KIT=1`)._
- _TradeChart reads its canvas colors from tokens and repaints on theme change (fixes the cream
  chart in dark mode)._

_Known leftovers for later phases: small text that used the pixel font at 9 to 10px is now tiny
sans; lowercase copy everywhere; per-page layouts unchanged._

Original scope:
- `web/src/styles/tokens.css`: new role tokens for both themes, plus an **alias layer**
  (`--cream: var(--surface-1)`, `--anchor: var(--fg)`, `--pink-hot: var(--accent)`, ...) so the 828
  inline styles keep rendering while pages migrate one at a time.
- Theme: light stays the default for first-time visitors, the toggle switches to dark and the
  choice is saved in localStorage (existing `urufu-theme` key, so returning users keep their pick).
  Update `theme-bootstrap.js` and the `themeColor` meta to the new values. Every mockup, primitive
  and page is designed and reviewed in both themes; dark is not allowed to be a palette swap.
- Fonts swapped in `layout.tsx` via `next/font`.
- Install `gsap` + `@gsap/react`; add `lib/motion/`.
- Primitives in `web/src/components/ui/`: Button, IconButton, Card/Panel, Input, NumberInput,
  Select, Tabs, SegmentedControl (buy/sell, ETH/URU), Chip, Badge, Stat, Table, Modal, Sheet
  (mobile), Tooltip, Toast, Skeleton, Progress (curve bar), Address (copy + truncate).
  Each is a thin styled wrapper with no data logic.
- A `/_ui` route (dev only) that renders every primitive in both themes for review.

### Phase 2: App shell
_Status 2026-10-16: done on `ui-revamp` (uncommitted). `components/shell/` holds SiteHeader, SettingsMenu,
SiteFooter, MobileTabBar and icons; `components/ui/Menu.tsx` is the shared popover. Header: Explore,
Trade, Launch menu (token / NFT / DN404), Feed, Flywheel, search, USD/ETH, chain, settings, wallet.
Wallet menu adds Profile, Feed, Copy address, Disconnect. Settings holds dark mode, sound and the
cursor buddy (now opt-in, off by default) plus docs/options/recover and external links. Ticker hides
when empty. Mobile: bottom tab bar + a full-height menu sheet portaled to body. Logo + favicon come
from wolf #0598 via `web/scripts/make-brand-icons.py`. Header is solid (no backdrop-filter) so fixed
children are not clipped._

Original scope:
- Header: logo, 4 primary links (Launch, Explore, Trade, Flywheel), Cmd+K search (reuses
  `UserSearchModal` logic, extended to tokens), then a right cluster: price unit, chain, wallet.
  Theme/audio/cursor move into a small settings menu. Feed and profile live under the wallet menu.
- Ticker: thinner, real data only, hides when empty, pauses on hover, GSAP-driven.
- Mobile: bottom tab bar (Explore, Trade, Launch, Profile) replacing the hamburger for main routes.
- Footer: simple, current date removed, links grouped.

### Phase 3: Trade terminal (biggest win)
- Split `trade/[address]/page.tsx` (3,315 lines) into `useTradeTerminal.ts` + presentational
  pieces: `TokenHeader`, `StatsBar`, `ChartPanel`, `OrderPanel`, `TradeTape`, `HoldersPanel`,
  `CurveProgress`, `ModulesPanel`, `OwnerPanel`. Pure move first PR, restyle second PR.
- Layout: header + stat bar, chart left (themed via tokens, fixes the cream canvas), order panel
  right sticky, tabs under the chart (Trades, Holders, Modules, Pool info, About).
- Order panel: segmented buy/sell, big amount input, quick picks, clear "you receive", one
  obvious CTA with real disabled and loading states, slippage in a popover.
- Curve progress as a proper meter with the graduation target, animated once on load.

### Phase 4: Explore + home
- Discover: token grid with art-first cards (image, name, ticker, mcap, curve %, 24h change),
  list/grid toggle, sticky filter bar, Flip reorder, skeletons while the indexer loads.
- Home: editorial hero with the new loop video, live stats strip with tickers, trending row,
  "how it works" (curve, graduation, LP locked, fees to urufu gemu nft holders) as a short
  scroll sequence, NFT and DN404 lanes, flywheel numbers.

### Phase 5: Create flows (ERC-20, NFT, DN404)
- Split the three create pages the same way (logic hook + views).
- One shared `LaunchWizard` shell: left step rail, center form, right live preview card that
  matches the Discover card exactly. Advanced modules in a drawer, not inline.
- Launch success screen with share card and a link straight to the trade page.

### Phase 6: Collection, profile, feed, flywheel
- Collection: art-forward header, mint panel reusing Order panel styles, holders + tiers in tabs.
- Profile: header with avatar/socials, tabs for Holdings, Created, Earnings, Activity. The earnings
  widgets (CreatorEarnings, NftLauncherEarnings, FlywheelRewards, GraduatorRefund) get a common
  "claimable" card pattern.
- Flywheel: one clear diagram of the 40/35/25 split with live numbers.
- Feed: clean activity list.

### Phase 7: Long tail
- Catalog, docs, recover, 404, OG images (`opengraph-image.tsx`) restyled with tokens.

### Phase 8: Cleanup and hardening
- Delete the alias layer and every unused `.uru-*` class; target `globals.css` under 300 lines.
- Remove framer-motion if unused.
- Accessibility: contrast AA everywhere, focus rings, keyboard paths for trade and create,
  reduced-motion verified.
- Performance: fonts subset, hero video lazy with poster, LCP and CLS checked on trade and home.
- Playwright screenshot suite for each route in both themes and at 390px to catch regressions.

## Suggested order and size

| Phase | Rough size | Risk to logic |
|---|---|---|
| 0 Mockups | 2 to 3 days | none |
| 1 Foundation | 3 to 4 days | none (additive) |
| 2 Shell | 2 days | low |
| 3 Trade | 4 to 5 days | medium (split needs care) |
| 4 Explore + home | 3 days | low |
| 5 Create x3 | 5 to 6 days | medium (split needs care) |
| 6 Collection/profile/feed/flywheel | 4 days | low to medium |
| 7 Long tail | 2 days | low |
| 8 Cleanup | 2 days | low |

Phases 1 and 2 must land first. After that, 3, 4, 5 and 6 can run in parallel sessions because
they touch separate files, as long as each one only uses Phase 1 primitives and tokens.

## Open decisions for you

1. ~~Identity~~ Decided 2026-10-16: pro-trading look, mascot/art only in marketing spots.
2. ~~Default theme~~ Decided 2026-10-16: light is the main theme, dark is fully supported.
3. Display font: Instrument Serif vs keeping Yusei Magic for big headlines only.
4. Cursor mascot: opt-in (recommended) or remove.
