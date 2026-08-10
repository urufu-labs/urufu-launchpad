# urufu labs · launchpad agent skill ✿

> paste this whole file into ur ai agent so it can launch tokens on
> urufu labs for u. works for claude, cursor, clawbot, chatgpt, langchain,
> anything that takes free-form instructions ~

---

## what this is

instructions for an ai agent to launch an erc-20 token on the urufu labs
launchpad (robinhood chain, chainid 4663). the agent talks to four small
http apis on `https://urufulabs.xyz/api/agent/*` for everything that needs
on-chain data. the agent uses ur wallet key locally to sign; the apis never
see it.

only the "quick launch" path is exposed — bonding-curve erc-20, ownership
renounced at launch, 60-second anti-sniper gate, no modules, no whitelist,
no uru-pay. that's ~99% of what humans launch anyway, and its scope keeps
the agent tight enough to trust.

---

## AGENT INSTRUCTIONS

when the human asks u to launch a token on urufu labs, follow these steps
IN ORDER. do NOT skip the confirm step. do NOT change constants. do NOT
launch on any other chain.

### step 0 — collect from the human

- **token name** (up to 30 chars, on-chain unique, no weird chars)
- **token ticker** (up to 8 chars, uppercased, on-chain unique)
- **initial buy in ETH** (optional, defaults to 0 — set to something like
  `0.01` if the human wants to buy their own token at launch so a bot can't
  snipe the first swap)
- **launcher wallet address** — the human's wallet that will sign

### step 1 — check the chain is up

```
GET https://urufulabs.xyz/api/agent/status
```

confirm: `launchpad.paused === false` and `chain.id === 4663`. if paused,
tell the human + stop.

### step 2 — check the name + ticker are free

```
GET https://urufulabs.xyz/api/agent/name-check?name=<name>&ticker=<ticker>
```

if `ok !== true`, tell the human what `name.reason` / `ticker.reason` says
(`AlreadyTaken`, `Reserved`, `InvalidCharacter`, `TooLong`, `TooShort`) and
ask for a different one. do NOT proceed.

### step 3 — get the exact launch payload

```
GET https://urufulabs.xyz/api/agent/quote
  ?name=<name>
  &ticker=<ticker>
  &launcher=<0x...>
  &initialBuyEth=<amount>
```

response fields u need:

- `entrypoint` — either `launch` or `launchAndBuy`. informational; u don't
  need to pick, the calldata already targets the right one
- `to` — router address to send to
- `calldata` — the fully-encoded tx data. sign as-is
- `value` — msg.value in wei (fee + initialBuy). sign as-is
- `warnings` — if this array is non-empty, DO NOT PROCEED. tell the human
  each warning + stop
- `feeFormatted`, `valueFormatted` — human-readable strings for confirmation
- `params.antiSniperSeconds` — freeze window for first trades post-graduation

### step 4 — ✿ CONFIRM WITH THE HUMAN ✿

before signing, show the human:

```
launching a token on urufu labs (robinhood chain):

  name:            <name>
  ticker:          <ticker>
  launcher:        <launcher>
  first buy:       <initialBuyFormatted>
  launch fee:      <feeFormatted>
  total spend:     <valueFormatted>
  anti-sniper:     first ~60 sec of trades gated to prevent bot snipes
  ownership:       renounced at launch (curve requirement)

proceed? (y/n)
```

if they say no or anything ambiguous — do NOT sign. abort and ask them
what they want to change.

**hard rule: NEVER broadcast without an explicit human "yes".** doesn't
matter if the human said "just launch it" earlier. every launch needs a
fresh confirmation with the final numbers.

### step 5 — sign + broadcast

with the human's ok, send the tx from their wallet:

```js
// viem example — swap wallet client for whatever ur stack uses
await walletClient.sendTransaction({
  to: quote.to,
  data: quote.calldata,
  value: BigInt(quote.value),
});
```

cast equivalent:
```bash
cast send $to $calldata --value ${value}wei \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --private-key $HUMAN_PRIVATE_KEY
```

`gasLimit` isn't required — RH estimates well. if u must set it: ~1M for
`launch`, ~1.5M for `launchAndBuy`.

### step 6 — verify + report

```
POST https://urufulabs.xyz/api/agent/verify
Content-Type: application/json

{"txHash": "0x..."}
```

response has `token.address` (the deployed erc-20), `token.curve` (the
bonding curve holding the initial liquidity), `links.trade` (URL to trade
the token), `links.blockscout` (explorer).

report all of that back to the human. u're done ~

---

## api reference (full detail)

### GET /api/agent/status

no params. returns chain state + fees + curve defaults + address book.

```json
{
  "chain": { "id": 4663, "name": "Robinhood Chain", "currentBlock": "32...", "secPerL1Block": 12 },
  "launchpad": { "live": false, "paused": false, "note": "..." },
  "fees": { "erc20": "1000000000000000", "erc20Formatted": "0.001 ETH", ... },
  "curve": { "defaultSupply": "800000000000000000000000000", "graduationTargetEth": "10000000000000000000", "graduationTargetEthFormatted": "10 ETH", "tradeFeeBps": 100 },
  "quickLaunchDefaults": { "antiSniperBlocks": 5, "antiSniperSecondsApprox": 60, "buybackBurnBps": 0, "ownership": "Renounce" },
  "addresses": { "Router": "0xb41e...", "NameRegistry": "0x965A...", "CurveFactory": "0x7FeC...", "MultiHookHost": "0xc282...", "Graduator": "0x1DC4...", "V4SwapRouter": "0xDb3D..." }
}
```

### GET /api/agent/name-check?name=X&ticker=Y

both required. returns availability + specific reason if unavailable.

```json
{
  "name":   { "input": "MyCoin", "available": true, "reason": "Ok" },
  "ticker": { "input": "MYC",    "available": true, "reason": "Ok" },
  "ok": true
}
```

reasons: `Ok` `InvalidCharacter` `TooShort` `TooLong` `AlreadyTaken` `Reserved`

### GET /api/agent/quote?name=X&ticker=Y&launcher=0x...&initialBuyEth=Z

all four required (initialBuyEth = `"0"` if no first buy). returns
everything u need to broadcast + a preflight warnings array.

```json
{
  "launcher": "0x...",
  "name": "MyCoin", "ticker": "MYC",
  "entrypoint": "launchAndBuy",
  "to": "0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269",
  "calldata": "0x...",
  "value": "10800000000000000",
  "valueFormatted": "0.0108 ETH",
  "fee": "800000000000000",
  "feeFormatted": "0.0008 ETH",
  "initialBuy": "10000000000000000",
  "initialBuyFormatted": "0.01 ETH",
  "warnings": [],
  "canBroadcast": true,
  "params": { "antiSniperSeconds": 60, "ownership": "Renounce", ... }
}
```

if `warnings` is non-empty:
- `"Router is currently paused"` → stop, tell human, wait for unpause
- `"Name ... fails validateName"` → stop, ask for new name
- `"Ticker ... fails validateTicker"` → stop, ask for new ticker
- `"Launcher ... has X ETH but needs at least Y"` → stop, tell human to fund
- `"LAUNCHPAD_LIVE is false"` → informational; launch works on chain but
  token won't show in site feed yet. usually safe to proceed if human ok

### POST /api/agent/verify

body: `{"txHash": "0x..."}`. returns token + curve address + trade URL.

```json
{
  "txHash": "0x...",
  "status": "success",
  "token": {
    "address": "0xa204...",
    "launcher": "0x...",
    "curve": "0x1e86..."
  },
  "block": { "number": "323...", "hash": "0x..." },
  "gas": { "used": "1346100" },
  "links": {
    "blockscout": "https://robinhoodchain.blockscout.com/token/0xa204...",
    "trade": "https://urufulabs.xyz/trade/0xa204..."
  }
}
```

if `status === "failed"`, the tx reverted on chain. re-run
`/api/agent/quote` with the same params to see what would have caught it.

if `status === "success-but-no-launched-event"`, the tx hash isn't a
launch tx — check what was signed.

---

## common on-chain reverts (if u skipped preflight)

| revert selector | what it means | fix |
|---|---|---|
| `Router__Paused` (`0x420ac99b`) | owner paused launches | wait, poll `/status` |
| `Router__EmptyName` | name string is empty | pass a real name |
| `Router__EmptyTicker` | ticker string is empty | pass a real ticker |
| `Router__InsufficientFee(uint256 required, uint256 sent)` | msg.value < fee + initialBuy | use the exact `value` from `/quote` |
| `NameRegistry__NameTaken(bytes32)` | someone reserved that name | call `/name-check` first |
| `NameRegistry__TickerTaken(bytes32)` | someone reserved that ticker | call `/name-check` first |
| `NameRegistry__TickerReserved(bytes32)` | ticker is on the blocklist (e.g. ETH, USDC) | pick a different ticker |
| `Router__CurveMustRenounce` | tried non-renounce ownership with a curve | shouldn't hit this — quote hardcodes renounce |

if u see any other selector, POST the full revert bytes back to the human
+ don't retry. weird reverts usually mean the router got rotated or the
apis got out of sync.

---

## example: full round-trip with curl

```bash
# 1. is the chain up?
curl https://urufulabs.xyz/api/agent/status | jq '.launchpad, .fees.erc20Formatted'

# 2. is "MyCoin" / "MYC" free?
curl "https://urufulabs.xyz/api/agent/name-check?name=MyCoin&ticker=MYC" | jq

# 3. get the launch payload for me buying 0.01 ETH of my own coin
curl "https://urufulabs.xyz/api/agent/quote?name=MyCoin&ticker=MYC&launcher=0xMYWALLET&initialBuyEth=0.01" | jq

# 4. show human the numbers, get "yes"

# 5. sign + broadcast
cast send <to from quote> <calldata from quote> \
  --value <value from quote>wei \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --private-key $HUMAN_PRIVATE_KEY

# 6. verify — replace $TX with the hash cast printed
curl -X POST https://urufulabs.xyz/api/agent/verify \
  -H "content-type: application/json" \
  -d "{\"txHash\":\"$TX\"}" | jq
```

---

## what agents should NEVER do

- ✕ launch on any chain other than robinhood (chainid 4663)
- ✕ launch without an explicit human "yes" containing the final numbers
- ✕ set anti-sniper, buyback-burn, or ownership yourself — the api chooses
- ✕ pick a name or ticker for the human — always ask
- ✕ retry a reverted launch without re-running `/quote`
- ✕ store the human's private key anywhere the agent doesn't need it
- ✕ launch tokens as part of any multi-step "agent-decides-what-to-do"
  workflow — always a discrete, confirmed action

## what to tell the human on completion

after `/verify` returns success, message the human like this:

```
✿ launched!

  name:      <name>
  ticker:    <ticker>
  address:   <token.address>
  curve:     <token.curve>
  trade it:  <links.trade>
  explorer:  <links.blockscout>

the curve holds the initial liquidity. it graduates to a uniswap v4 pool
once ~10 ETH of buys have gone through. anti-sniper freeze lifts ~60 sec
after graduation.
```

---

_this skill is served fresh from `https://urufulabs.xyz/agent-skill.md`.
last change: 2026-08-09._
