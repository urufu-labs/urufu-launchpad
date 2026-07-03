# VENDING MACHINE — PROJECT PLAN

> Codename: **VM** (pending final brand)
> Solo build. Mainnet first. Full v4 hook v1. ~6–8 months to public launch.

---

## 0. Elevator pitch

A launchpad where every launch is configured from a **mix-and-match menu of audited contract modules** instead of one hardcoded shape. Teams pick a base (ERC-20 / ERC-721 / ERC-1155), a launch mechanic (bonding curve / fixed sale / LBP / allowlist mint / etc.), and stack feature modules (fee-on-transfer, vesting, anti-bot, v4 hook add-ons, allocation bundles). VM compiles, tests, deploys. Bonding-curve tokens graduate to a Uniswap v4 pool with **VendingMachineHook** installed — LP locked forever, fees redirect to platform / creator / holders, cross-token loyalty discounts, anti-vamping penalty.

**Revenue:** launch fee (scales with complexity) + ongoing swap fees on hook-installed pools + curve trade fees pre-graduation.

**Moat:**
1. Composability of audited modules (nobody else offers this — pump.fun has one shape)
2. Forever-fee capture via v4 hook (pump.fun loses fees after Raydium graduation)
3. Cross-token loyalty (ecosystem stickiness — forks start from zero)
4. Frontend skills library (v2 upsell — NASA / Deco / Nouveau / Brutalist / Kawaii per-launch aesthetic)

---

## 1. Locked decisions

| # | Decision | Value | Rationale |
|---|---|---|---|
| 1 | Deployment | VM deploys via factory (not user self-deploy) | Frictionless UX, matches launchpad expectations |
| 2 | Chain order | **Ethereum mainnet first**, Base month 2–3 | Trust signal, capital density, serious teams |
| 3 | Ownership default | Renounce (with multisig / EOA opt-out) | Best trust signal, permits legit use cases |
| 4 | Anti-vamping | Onchain name/ticker registry + 2× fee vampire tax in hook | Blocks casual forks, doesn't block competition legally |
| 5 | Fee: bonding curve | 1% trade fee, 0.7 platform / 0.3 creator | Matches pump.fun creator take, keeps traders |
| 6 | Fee: v4 hook | 0.7% swap fee, 0.2 platform / 0.3 creator / 0.2 holders | Compounding platform revenue, creator alignment |
| 7 | Loyalty tiers | Count-of-VM-tokens-held with $10 floor: 1 = 15% off, 5 = 30% off, 10 = 50% off | Platform network effect, spam-resistant |
| 8 | Curve shape | 800M for sale / 200M reserved for graduated LP, ~10 ETH mainnet threshold (~4 ETH on Base equivalent) | Familiar to pump.fun users |
| 9 | Compile approach | Template-injection + pinned Foundry, backend caches by config hash | Simpler than diamond, verifiable on Etherscan, cheap deploys |
| 10 | Menu scope | Token-launch primitives only. NO multisig, splitter, escrow, prediction, 4626 | Sharp focus on "team launches token" use case |
| 11 | Frontend skills | v2 — ship shop + default frontend v1 | Ship faster, upsell later |
| 12 | Neochibi | v2 — generative NFT factory as premium item | Requires offchain generation pipeline, not blocker for v1 |

---

## 2. Contract catalog (v1 shelf)

### Bases (pick 1)
- ERC-20
- ERC-721A
- ERC-1155

### Launch mechanic — ERC-20 (pick 1)
- **Bonding curve → graduate to v4 pool with VendingMachineHook** (default / memecoin path)
- Fixed-price public sale
- LBP (Balancer-style fair launch)
- Direct-to-LP (team brings ETH + tokens, v4 pool created at deploy)
- No sale (transfer-only, for airdrop/allocation-only tokens)

### Launch mechanic — NFT (pick 1)
- Fixed-price public mint
- Allowlist merkle mint (with optional public phase)
- Dutch auction
- Free mint (spam-guarded)
- Bonding-curve mint (ArtBlocks-style)

### Token feature modules (ERC-20, stack any compatible)
- Fee-on-transfer (configurable splits: treasury / burn / LP / holders / creator)
- Anti-bot (block-N gating + allowlist + optional commit-reveal)
- Anti-whale (max wallet, max tx, cooldown — with auto-expiry after N blocks)
- ERC-20 Votes (governance-ready — required for governance bundle)
- ERC-2612 Permit (gasless approvals)
- Pausable (⚠️ flagged as reducing decentralization)
- Blacklist (⚠️ flagged, compliance mode)
- Cross-chain (LayerZero OFT wrapper)

### NFT feature modules (stack any compatible)
- On-chain SVG metadata
- Delayed reveal
- Progressive reveal
- ERC-2981 royalties
- Soulbound
- Refundable mint

### Allocation bundles (stack any, split total supply at launch)
- Team vesting (linear / cliff / stepped)
- Investor vesting (per-round schedules)
- Advisor vesting
- Merkle airdrop for community (Brandon's `airdrop-mint.mjs` pattern productized)
- Staking rewards pool (deploys paired staking contract)
- LP allocation (auto-seeds initial pool)
- Treasury allocation (sends to address, typically Safe)

### Governance add-on (only with ERC-20 Votes module)
- OZ Governor + Timelock bundle, pre-wired, ready for proposals

### v4 hook add-ons (only with LP-present ERC-20 launches)
- LP locked forever (default when hook installed)
- Fee redirect to holders (default when hook installed)
- Fee redirect to creator (default)
- Dynamic fee (volatility-based)
- MEV / JIT protection
- Cross-token VM loyalty (default when hook installed)
- Anti-vamping penalty (default when hook installed)
- Buyback-and-burn on volume threshold

### B20-native (Base-only, ERC-20)
- PolicyRegistry-aware
- Blocklist-enabled
- Jailable (Cops & Robbers pattern productized)

### v2 additions
- Frontend skill picker (NASA / Deco / Nouveau / Brutalist / Kawaii Motion)
- Neochibi generative NFT factory
- Custom skill submissions marketplace

---

## 3. Timeline — 6 months, phased

**Assumption: solo dev, ~40 hrs/week, no unplanned delays.** Real world adds 30–50% — plan for 8 months.

### Phase 0 — Foundation (weeks 1–2)
- Repo scaffold (Foundry, Next.js, monorepo layout)
- Onchain `NameRegistry.sol` deployed to Sepolia
- Base template contracts: `ERC20Template.sol`, `ERC721ATemplate.sol`, `ERC1155Template.sol` — bare, no modules yet
- Compile-service scaffolding (Node backend, Foundry container, config-hash cache stub)
- Shop UI scaffold: chain picker, base picker, name/ticker input, registry check, mock config screen

**Gate:** shop UI can select base + name + ticker, registry rejects duplicates, dummy compile returns green.

### Phase 1 — Simple launches shipping (weeks 3–6)
- Complete `ERC20Template.sol` + 5 highest-priority modules: fee-on-transfer, anti-bot, anti-whale, permit, votes
- Complete `ERC721ATemplate.sol` + on-chain SVG, delayed reveal, ERC-2981
- Template-injection compile pipeline (real)
- Module compatibility matrix, live in frontend
- Full shop flow for **non-curve, non-hook launches only**: fixed sale ERC-20, allowlist NFT mint, direct-to-LP ERC-20
- Factory contracts + Router
- Purchase flow with ETH payment, deploy transaction, token page URL
- Simple token page (metadata, holders, transfers, no trading widget yet)
- Testnet deploy on Sepolia

**Gate:** friend can launch a real ERC-20 with fee-on-transfer + vesting on Sepolia end-to-end.

**Ship-to-mainnet gate:** Phase 1 modules audited (solo auditor, ~$15–25k). **This is the earliest you can start earning launch fees on mainnet.**

### Phase 2 — Bonding curve + graduation (weeks 7–12)
- `Curve.sol` — constant-product virtual reserves, 800M/200M split, ~10 ETH threshold
- Trade fees (1%, 0.7/0.3 split)
- Anti-sniper (first-3-blocks buy caps)
- Graduation logic — atomic drain → create v4 pool → mint LP position → transfer to hook
- **Minimal hook v1** shipped alongside curve: LP-lock only, platform fee capture only (no holder redirect, no loyalty, no anti-vamping yet). This is the shortest path to shipping curve launches.
- Trading page (chart, buy/sell widget, holders, transaction feed, curve progress bar)
- Comments (SIWE auth)
- Discovery feeds: New, Trending, Almost Graduated, Recently Graduated
- Indexer (Ponder or Rindexer) for price history, holders, events
- Postgres + IPFS pinning (Pinata)
- Testnet soak: 2 weeks minimum with real users

**Gate:** 10+ friends launch curve tokens on Sepolia, at least 3 graduate, trading works end-to-end.

### Phase 3 — Full hook (weeks 13–18)
- Full `VendingMachineHook.sol`: fee redirect (platform/creator/holders), holder claim pull pattern, `LoyaltyOracle` integration, anti-vamping 2× penalty, dynamic fee toggle, MEV/JIT protection toggle, buyback-and-burn toggle
- `LoyaltyOracle.sol` — cross-token holder registry, tier calculation, snapshot refresh
- Portfolio + claim page (all VM tokens held, unclaimed fees across positions, one-click claim-all)
- Governance bundle (Governor + Timelock deployed as set, wired to Votes token)
- Allocation bundles: vesting, airdrop, staking (all as add-ons at deploy)
- Slither + Aderyn clean pass
- Internal review + fuzz coverage >95% on hook

**Gate:** hook passes fuzz + invariants, cross-token loyalty works on testnet with 5+ mock tokens.

### Phase 4 — Audit & mainnet (weeks 19–26)
- External audit — Spearbit / Cantina / trusted solo (Trust, Pashov, etc.). Budget $50–80k for hook + curve + factories.
- Fix findings, re-audit critical/high issues
- Bug bounty on Immunefi announced with $100k pool (initial funding: profit from phase 1 launches + your budget)
- Mainnet deploy of all contracts
- 2-week soft launch with allowlist (friends, invited teams)
- **Public mainnet launch**

**Gate:** mainnet TVL crosses $500k without incident. Then begin Base deployment.

### Phase 5 — Base + v2 features (months 7–8)
- Deploy full stack to Base
- B20-native modules (Base only)
- Frontend skills v2 — NASA / Deco / Nouveau / Brutalist / Kawaii pickable per launch, one-click skin apply
- Neochibi generative NFT factory (integrate `neochibi-studio` + `chibi-wolf-game` pipeline)
- LayerZero OFT for cross-chain launches

---

## 4. Budget

### Money out
| Item | Amount | Timing |
|---|---|---|
| Personal runway (6–8 months solo) | $30–60k (depends on life) | Ongoing |
| Domain, hosting, RPC (Alchemy paid tier) | $500–1000/mo | Ongoing |
| Legal (LLC + terms + disclaimer) | $2–5k | Month 1 |
| Solo audit round 1 (Phase 1 contracts) | $15–25k | Month 2 |
| Full audit round 2 (curve + hook) | $50–80k | Month 5 |
| Bug bounty seed pool | $50–100k (from profits + reserve) | Month 6 |
| Testnet gas + mainnet deploy gas | ~2 ETH | Ongoing |
| **Total pre-launch cash** | **~$150–250k** | |

### Money in (projections — conservative)
| Source | Assumption | Monthly |
|---|---|---|
| Phase 1 launch fees | 5 launches/day @ 0.05 ETH avg (mainnet) | ~7.5 ETH ≈ $22k |
| Phase 3 curve fees | 5 curves/day, $5k avg volume × 1% × 0.7 | ~$5k |
| Phase 4 hook fees (post-graduation) | 10 graduated tokens, $200k avg pool, 3% daily turnover × 0.7% × 0.29 | ~$3.5k |
| **Total by month 6** | | **~$30k/month** |

By month 12 (if hypothesis correct): ~$100k/month recurring. This is not going to make you rich in year one. It compounds because hook fees are permanent — every graduated token adds to the base forever.

---

## 5. What can go wrong (and mitigations)

1. **Audit finds critical in hook** — reserve 2-week buffer, refactor, re-audit critical/high only (~$10k)
2. **Compile service can't handle load** — cache by config hash, warm popular combos, scale to multi-container by month 3
3. **v4 pool creation reverts under adversarial conditions** — extensive fuzz + fork tests against real v4 deployments
4. **Users complain the hook takes too much fee** — 0.7% is defensible, matches Uniswap default; discount via loyalty is the answer
5. **Solo dev exhaustion / burnout** — realistic hours (40/week), gate reviews between phases, hire contractor for frontend if needed
6. **Regulatory** — the "VM deploys but never touches funds beyond launch fee" model is defensible. Get a lawyer to review terms of service before mainnet. Don't promote specific tokens.
7. **Copycat launches** — expected. Your defense is hook depth (cross-token loyalty, LP lock, forever-fee capture). Ship those.
8. **Uniswap v4 changes** — v4 is now stable (post-audit, live). Risk is low but pin the contract version explicitly.

---

## 6. Success criteria — how you know it's working

- **Month 3:** 50+ non-curve launches on mainnet (Phase 1 launches), ~$25k revenue
- **Month 5:** first 10 curve tokens graduated, hook fees accruing
- **Month 8:** $100k+ total platform revenue, 5+ launches/day sustained
- **Month 12:** $50k+ monthly recurring from hook fees alone (compounding independent of new launches)

If month 3 doesn't hit 20+ launches, product-market-fit is wrong — pause phase 2, iterate on shop UX / pricing / catalog before continuing.

---

## 7. What you decide next

Before phase 0 starts:

1. **Codename → real name.** "Vending Machine" works internally. Public name TBD — consider: `.vend`, `Machina`, `Assembly`, `Shelf`, `Compose`. Don't call it "Launchpad X" — the mix-and-match is the story.
2. **Solo vs. contractor for frontend.** You can do it, but frontend is 40% of solo time. Consider hiring a contractor for the shop UI (weeks 3–6) to accelerate.
3. **Legal entity.** Delaware C-corp or LLC. Consult a lawyer month 1. Non-negotiable before mainnet.
4. **Audit firm shortlist.** Reach out **now** to Spearbit, Cantina, Pashov, Trust, Zellic. Booking is 4–8 weeks out. Get on the calendar for month 5.
