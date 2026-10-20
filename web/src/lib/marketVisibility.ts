/// Which urufu collections the marketplace shows: the same hide lists the
/// rest of the site uses (test launches), and the lane flags.

import { DN404_LAUNCHES_ENABLED, NFT_LAUNCHES_ENABLED } from './config';
import { isHiddenNftCollection } from './hiddenNftCollections';
import { isHiddenToken } from './hiddenTokens';
import { MARKET_CHAIN_ID } from './market';

export function marketCollectionVisible(c: { collection: string; lane: 'nft' | 'dn404'; pairedToken?: string }): boolean {
  if (isHiddenNftCollection(MARKET_CHAIN_ID, c.collection)) return false;
  if (c.lane === 'dn404') {
    if (DN404_LAUNCHES_ENABLED.robinhood !== true) return false;
    if (c.pairedToken && !/^0x0{40}$/i.test(c.pairedToken) && isHiddenToken(MARKET_CHAIN_ID, c.pairedToken)) return false;
    return true;
  }
  return NFT_LAUNCHES_ENABLED.robinhood === true;
}
