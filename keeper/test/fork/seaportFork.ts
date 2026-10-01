/**
 * Fork stand-in for OpenSea: a seller signs a REAL Seaport 1.6 order on the
 * fork (EIP-712, live Seaport contract), and this provider hands the keeper
 * the listing + fulfillment data in the same shape the OpenSea API returns
 * (`function` signature + nested `input_data`). The keeper encodes it with
 * its production encodeFulfillment and submits it to Seaport.
 */
import type { Address, Hex, PublicClient } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { RH } from '../../src/constants.ts';
import type { FulfillmentTx, Listing, ListingsProvider } from '../../src/opensea.ts';
import { abis, tx, walletFor } from './harness.ts';

const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const FULFILL_ORDER =
  'fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32)';

export class ForkSeaportProvider implements ListingsProvider {
  readonly orders = new Map<string, { listing: Listing; tx: FulfillmentTx; mirror: Address }>();

  async list(pc: PublicClient, seller: PrivateKeyAccount, mirror: Address, tokenId: bigint, priceWei: bigint): Promise<Listing> {
    await tx(pc, walletFor(seller), { address: mirror, abi: abis.mirror, functionName: 'setApprovalForAll', args: [RH.seaport, true] });
    const counter = await pc.readContract({ address: RH.seaport, abi: abis.seaport, functionName: 'getCounter', args: [seller.address] });
    const now = (await pc.getBlock()).timestamp;
    const offer = [{ itemType: 2, token: mirror, identifierOrCriteria: tokenId, startAmount: 1n, endAmount: 1n }];
    const consideration = [{ itemType: 0, token: ZERO, identifierOrCriteria: 0n, startAmount: priceWei, endAmount: priceWei, recipient: seller.address }];
    const salt = BigInt(Date.now());
    const components = {
      offerer: seller.address, zone: ZERO, offer, consideration, orderType: 0,
      startTime: now - 60n, endTime: now + 86_400n, zoneHash: ZERO32, salt, conduitKey: ZERO32, counter,
    };
    const signature = await seller.signTypedData({
      domain: { name: 'Seaport', version: '1.6', chainId: 4663, verifyingContract: RH.seaport },
      primaryType: 'OrderComponents',
      types: {
        OrderComponents: [
          { name: 'offerer', type: 'address' }, { name: 'zone', type: 'address' },
          { name: 'offer', type: 'OfferItem[]' }, { name: 'consideration', type: 'ConsiderationItem[]' },
          { name: 'orderType', type: 'uint8' }, { name: 'startTime', type: 'uint256' }, { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' }, { name: 'salt', type: 'uint256' }, { name: 'conduitKey', type: 'bytes32' },
          { name: 'counter', type: 'uint256' },
        ],
        OfferItem: [
          { name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' },
          { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' },
        ],
        ConsiderationItem: [
          { name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' },
          { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' },
        ],
      },
      message: components,
    });
    // JSON-like input_data exactly as an API would serialize it (strings for uints).
    const s = (x: bigint) => x.toString();
    const input_data = {
      order: {
        parameters: {
          offerer: seller.address, zone: ZERO,
          offer: offer.map((o) => ({ itemType: o.itemType, token: o.token, identifierOrCriteria: s(o.identifierOrCriteria), startAmount: '1', endAmount: '1' })),
          consideration: consideration.map((c) => ({ itemType: c.itemType, token: c.token, identifierOrCriteria: '0', startAmount: s(c.startAmount), endAmount: s(c.endAmount), recipient: c.recipient })),
          orderType: 0, startTime: s(components.startTime), endTime: s(components.endTime), zoneHash: ZERO32, salt: s(salt), conduitKey: ZERO32,
          totalOriginalConsiderationItems: 1,
        },
        signature,
      },
      fulfillerConduitKey: ZERO32,
    };
    const listing: Listing = { orderHash: signature.slice(0, 66) as Hex, protocolAddress: RH.seaport, tokenId, priceWei };
    this.orders.set(listing.orderHash, { listing, mirror, tx: { to: RH.seaport, value: priceWei, function: FULFILL_ORDER, input_data } });
    return listing;
  }

  async bestListings(mirror: Address): Promise<Listing[]> {
    return [...this.orders.values()].filter((o) => o.mirror.toLowerCase() === mirror.toLowerCase()).map((o) => o.listing);
  }

  async fulfillment(listing: Listing): Promise<FulfillmentTx> {
    const o = this.orders.get(listing.orderHash);
    if (!o) throw new Error('unknown listing');
    return o.tx;
  }
}
