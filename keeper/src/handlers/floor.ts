/**
 * MirrorFloorSupport: buy mirror NFTs listed below what their tokens are
 * worth in the pool, then burn them; burn every leftover token too, so the
 * mode always contracts supply.
 *
 *   implied NFT value (ETH) = unit * token spot price
 *     (ETH pairs: from the launch pool; URU pairs: launch pool * URU/WETH spot)
 *   buy a listing iff price <= implied * (1 - floorSafetyMarginBps)
 *
 * Steps: sell just enough tokens for the chosen listings' ETH (+ buffer),
 * fulfill each via Seaport, put any unspent sale ETH back into the launch
 * token, then send the keeper's ENTIRE token balance to 0x…dEaD. DN404
 * burns an owner's NFTs when its balance drops below unit * owned, and does
 * so even for skipNFT owners (fork-verified), so every bought NFT burns.
 */
import { parseAbi, type Address, type Hex } from 'viem';
import { dn404TaxTemplateAbi, erc20Abi, mirrorAbi } from '../abis.ts';
import type { KeeperConfig } from '../config.ts';
import { DEAD, ZERO } from '../constants.ts';
import { encodeFulfillment, type Listing, type ListingsProvider } from '../opensea.ts';
import { ethUsdgPoolKey, launchPoolKey, priceOtherPerToken, readSlot0, uruWethPoolKey } from '../pools.ts';
import { ethToUru, ethToUsdg, isEthPaired, pairToToken, tokenToEth, usdgToEth, type LaunchRef } from '../routes.ts';
import { applyBps } from '../swap.ts';
import type { LaunchSnapshot } from '../sweeper.ts';
import { send, sendRaw, type Ctx } from '../tx.ts';

/// ETH per whole launch token, 1e18-scaled.
export async function ethPerToken(ctx: Ctx, cfg: KeeperConfig, l: LaunchRef): Promise<bigint> {
  const key = launchPoolKey(l.base, l.pair, cfg);
  const { sqrtPriceX96 } = await readSlot0(ctx.pc, cfg, key);
  const tokenIs0 = key.currency0.toLowerCase() === l.base.toLowerCase();
  const pairPerToken = priceOtherPerToken(sqrtPriceX96, tokenIs0);
  if (isEthPaired(l)) return pairPerToken;
  const uk = uruWethPoolKey(cfg);
  const u = await readSlot0(ctx.pc, cfg, uk);
  const uruIs0 = uk.currency0.toLowerCase() === cfg.uru.toLowerCase();
  const ethPerUru = priceOtherPerToken(u.sqrtPriceX96, uruIs0);
  return (pairPerToken * ethPerUru) / 10n ** 18n;
}

const conduitControllerAbi = parseAbi(['function getConduit(bytes32 conduitKey) view returns (address conduit, bool exists)']);

/// ETH wei per 1 raw USDG unit, 1e18-scaled, from the native ETH/USDG pool.
export async function ethPerUsdgRaw(ctx: Ctx, cfg: KeeperConfig): Promise<bigint> {
  const { sqrtPriceX96 } = await readSlot0(ctx.pc, cfg, ethUsdgPoolKey(cfg));
  // USDG is currency1; priceOtherPerToken(.., false) = currency0 (ETH) per USDG.
  return priceOtherPerToken(sqrtPriceX96, false);
}

/// Fill priceWei (ETH equivalent) for ERC-20 (USDG) listings. Pure.
export function pricedInEth(listings: Listing[], usdg: Address, ethPerUsdgRawX18: bigint): Listing[] {
  return listings.map((l) => {
    if (BigInt(l.currency) === 0n) return l;
    if (l.currency.toLowerCase() !== usdg.toLowerCase()) return { ...l, priceWei: 0n };
    return { ...l, priceWei: (l.amount * ethPerUsdgRawX18) / 10n ** 18n };
  });
}

/// Address Seaport pulls ERC-20 payment through for a given conduit key.
async function paymentSpender(ctx: Ctx, cfg: KeeperConfig, key: Hex | undefined): Promise<Address> {
  if (!key || BigInt(key) === 0n) return cfg.seaport;
  const [conduit, exists] = await ctx.pc.readContract({ address: cfg.conduitController, abi: conduitControllerAbi, functionName: 'getConduit', args: [key] });
  if (!exists) throw new Error(`conduit for key ${key} does not exist`);
  return conduit;
}

/// Pure selection: cheapest-first listings under the margin, within budget.
export function selectListings(listings: Listing[], impliedWei: bigint, marginBps: bigint, maxBuys: number, budgetWei: bigint): Listing[] {
  const ceiling = applyBps(impliedWei, marginBps);
  const picked: Listing[] = [];
  let spent = 0n;
  for (const l of [...listings].sort((a, b) => (a.priceWei < b.priceWei ? -1 : a.priceWei > b.priceWei ? 1 : 0))) {
    if (picked.length >= maxBuys) break;
    if (l.priceWei > ceiling || l.priceWei === 0n) continue;
    if (spent + l.priceWei > budgetWei) break;
    picked.push(l);
    spent += l.priceWei;
  }
  return picked;
}

export interface FloorResult {
  bought: bigint[];
  burnedTokens: bigint;
}

export async function handleFloor(ctx: Ctx, cfg: KeeperConfig, s: LaunchSnapshot, balance: bigint, provider: ListingsProvider | null): Promise<FloorResult> {
  const l: LaunchRef = { base: s.launch.base, pair: s.launch.pair };
  const mirror = s.launch.mirror;
  const bought: bigint[] = [];

  let listings: Listing[] = [];
  if (provider) {
    try {
      listings = await provider.bestListings(mirror, 20);
    } catch (err) {
      console.warn(`[keeper:floor] ${l.base}: listings fetch failed (${(err as Error).message}); burning only`);
    }
  } else {
    console.warn(`[keeper:floor] ${l.base}: no OpenSea provider configured; burning only`);
  }

  // USDG listings (OpenSea's required currency on Robinhood) are compared
  // in ETH terms through the ETH/USDG pool, so one ceiling/budget applies.
  if (listings.some((x) => BigInt(x.currency) !== 0n)) {
    try {
      listings = pricedInEth(listings, cfg.usdg, await ethPerUsdgRaw(ctx, cfg));
    } catch (err) {
      console.warn(`[keeper:floor] ${l.base}: ETH/USDG price read failed (${(err as Error).message}); skipping USDG listings`);
      listings = listings.filter((x) => BigInt(x.currency) === 0n);
    }
  }

  const price = await ethPerToken(ctx, cfg, l);
  const implied = (s.unitWei * price) / 10n ** 18n;
  // Budget: what the whole balance is worth at spot, minus a 15% haircut
  // for LP/hook fees + impact on the sale.
  const budget = applyBps((balance * price) / 10n ** 18n, 1500n);
  const picked = selectListings(listings, implied, cfg.floorSafetyMarginBps, cfg.floorMaxBuysPerTick, budget);
  console.log(`[keeper:floor] ${l.base}: implied NFT value ${implied} wei, ${listings.length} listings, ${picked.length} under ceiling`);

  if (picked.length > 0) {
    const need = picked.reduce((a, b) => a + b.priceWei, 0n);
    // Tokens to sell ~= need / price, +15% buffer, capped at balance.
    let toSell = price === 0n ? balance : (need * 10n ** 18n * 11_500n) / (price * 10_000n);
    if (toSell > balance) toSell = balance;
    const sale = await tokenToEth(ctx, cfg, l, toSell);
    let ethLeft = sale.amountOut;
    for (const listing of picked) {
      if (listing.priceWei > ethLeft) break;
      try {
        const f = await provider!.fulfillment(listing, ctx.keeper);
        const data = encodeFulfillment(f);
        if (BigInt(listing.currency) !== 0n) {
          // USDG listing: swap just enough ETH (+3% for fee/slippage) to USDG,
          // approve it to the conduit the order names, then fulfill (value 0).
          const have = await ctx.pc.readContract({ address: listing.currency, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.keeper] });
          if (have < listing.amount) {
            const ethIn = (listing.priceWei * 10_300n) / 10_000n + 1n;
            if (ethIn > ethLeft) throw new Error(`need ${ethIn} wei for USDG, have ${ethLeft}`);
            const sw = await ethToUsdg(ctx, cfg, ethIn);
            ethLeft -= sw.amountIn;
          }
          const usdgNow = await ctx.pc.readContract({ address: listing.currency, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.keeper] });
          if (usdgNow < listing.amount) throw new Error(`USDG ${usdgNow} < listing ${listing.amount}`);
          const spender = await paymentSpender(ctx, cfg, f.fulfillerConduitKey);
          await send(ctx, `approve USDG -> ${spender}`, { address: listing.currency, abi: erc20Abi, functionName: 'approve', args: [spender, listing.amount] });
        }
        await sendRaw(ctx, `floor buy #${listing.tokenId} for ${listing.amount} ${BigInt(listing.currency) === 0n ? 'wei' : 'USDG units'}`, f.to, data, f.value);
        const owner = await ctx.pc.readContract({ address: mirror, abi: mirrorAbi, functionName: 'ownerOf', args: [listing.tokenId] });
        if (owner.toLowerCase() !== ctx.keeper.toLowerCase()) throw new Error(`NFT ${listing.tokenId} owner is ${owner}, not keeper`);
        bought.push(listing.tokenId);
        ethLeft -= f.value;
      } catch (err) {
        console.warn(`[keeper:floor] ${l.base}: buy of #${listing.tokenId} failed: ${(err as Error).message}`);
      }
    }
    // Unspent USDG returns to ETH; unspent ETH goes back into the launch
    // token, which is then burned.
    const usdgLeft = await ctx.pc.readContract({ address: cfg.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.keeper] });
    if (usdgLeft > 0n) {
      const back = await usdgToEth(ctx, cfg, usdgLeft);
      ethLeft += back.amountOut;
    }
    if (ethLeft > 0n) {
      if (isEthPaired(l)) await pairToToken(ctx, cfg, l, ethLeft);
      else {
        const uru = await ethToUru(ctx, cfg, ethLeft);
        if (uru.amountOut > 0n) await pairToToken(ctx, cfg, l, uru.amountOut);
      }
    }
  }

  const all = await ctx.pc.readContract({ address: l.base, abi: dn404TaxTemplateAbi, functionName: 'balanceOf', args: [ctx.keeper] });
  if (all > 0n) {
    await send(ctx, `floor burn ${all} tokens -> 0x…dEaD`, { address: l.base, abi: dn404TaxTemplateAbi, functionName: 'transfer', args: [DEAD, all] });
  }
  const leftNfts = await ctx.pc.readContract({ address: mirror, abi: mirrorAbi, functionName: 'balanceOf', args: [ctx.keeper] });
  if (leftNfts !== 0n) throw new Error(`[keeper:floor] ${l.base}: keeper still holds ${leftNfts} NFTs after burn`);
  return { bought, burnedTokens: all };
}

export type { Address };
