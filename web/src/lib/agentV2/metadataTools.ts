/// Token page details for agent launches: description, image and links, on the
/// token lane and the Fair lane. Same signed write the website does after a launch
/// (compile-service `POST /token/:chainId/:address/metadata`): the launcher wallet
/// signs one EIP-191 message (personal_sign), the compile-service checks the signer
/// is the token's launcher and saves it.
///
///   prepare_metadata  launch tx hash + fields -> the exact message to sign
///   attach_metadata   same fields + timestamp + signature -> saved
///
/// attach rebuilds the payload from the same inputs with the same function, so the
/// agent never has to echo a nested object back byte for byte.

import { decodeEventLog, getAddress, verifyMessage, type Address, type Hex } from 'viem';

import { fairLaunchFactoryAbi, routerAbi } from '../abis';
import { TX_HASH_PATTERN } from './schema';
import { AGENT_V2_CHAIN_ID, MINUTE, SITE, ToolError, type AgentDeps, type ToolDef } from './tools';
import { cleanUserText, untrustedBlock } from './untrusted';

/// compile-service accepts a signature for 5 minutes; leave the agent most of it.
const SIGN_WINDOW_MS = 5 * 60 * 1000;
const PENDING_RETRIES = 3;
const PENDING_WAIT_MS = 5_000;

interface MetaInput {
  txHash: string;
  description?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  tiktok?: string;
}

const urlField = (what: string) => ({ type: 'string', maxLength: 500, pattern: '^https?://[^\\s]+$', description: what }) as const;
const handleField = (what: string) => ({ type: 'string', maxLength: 80, description: what }) as const;

const metaProperties = {
  txHash: { type: 'string', pattern: TX_HASH_PATTERN, description: 'Hash of the launch tx (token lane or Fair lane)' },
  description: { type: 'string', maxLength: 500, description: 'One or two sentences about the token' },
  imageUrl: urlField('Token image: the gatewayUrl from upload_image'),
  website: urlField('Website (http/https)'),
  twitter: handleField('X / Twitter handle or link'),
  telegram: handleField('Telegram handle or link'),
  discord: handleField('Discord invite or link'),
  tiktok: handleField('TikTok handle or link'),
} as const;

/// Find the token and its launcher from a launch receipt. Only logs from the urufu
/// Router (token lane) or the Fair launch factory count.
async function launchFromTx(deps: AgentDeps, txHash: Hex): Promise<{ token: Address; launcher: Address; lane: 'token' | 'fair' }> {
  let receipt: Awaited<ReturnType<AgentDeps['client']['getTransactionReceipt']>>;
  try {
    receipt = await deps.client.getTransactionReceipt({ hash: txHash });
  } catch {
    throw new ToolError('NOT_FOUND', 'No receipt for this tx yet. Wait for the launch to confirm, then try again.', 404);
  }
  if (receipt.status !== 'success') throw new ToolError('LAUNCH_FAILED', 'That launch tx reverted, so there is no token to describe.', 409);
  for (const log of receipt.logs) {
    const at = log.address.toLowerCase();
    if (at === deps.book.Router.toLowerCase()) {
      try {
        const ev = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
        if (ev.eventName === 'Launched') return { token: getAddress(ev.args.token), launcher: getAddress(ev.args.launchedBy), lane: 'token' };
      } catch { /* other Router event */ }
    } else if (at === deps.book.FairLaunchFactory.toLowerCase()) {
      try {
        const ev = decodeEventLog({ abi: fairLaunchFactoryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === 'FairLaunched') return { token: getAddress(ev.args.token), launcher: getAddress(ev.args.launcher), lane: 'fair' };
      } catch { /* other factory event */ }
    }
  }
  throw new ToolError('NOT_A_LAUNCH', 'This tx is not a token-lane or Fair-lane launch on urufu. (NFT and DN404 collection pages are edited on the website.)', 400);
}

function text(v: string | undefined, max: number): string | null {
  if (v === undefined) return null;
  const c = cleanUserText(v, max);
  return c && c.text.length > 0 ? c.text : null;
}

/// The payload compile-service verifies. Field set, order-independence and caps
/// match MetadataSaveBody in compile-service/src/routes/social.ts.
export function buildMetadataPayload(token: Address, input: MetaInput) {
  return {
    chainId: AGENT_V2_CHAIN_ID,
    tokenAddress: token.toLowerCase(),
    imageUrl: input.imageUrl ?? null,
    description: text(input.description, 500),
    website: input.website ?? null,
    twitter: text(input.twitter, 80),
    telegram: text(input.telegram, 80),
    discord: text(input.discord, 80),
    tiktok: text(input.tiktok, 80),
    wlListCid: null,
  };
}

/// Same canonical form as compile-service/src/auth.ts canonicalMessage.
export function metadataMessage(payload: Record<string, unknown>, timestamp: number): string {
  const canonical: Record<string, unknown> = {};
  for (const k of Object.keys(payload).sort()) canonical[k] = payload[k];
  return `urufu:metadata:save:${JSON.stringify(canonical)}:${timestamp}`;
}

export const prepareMetadataTool: ToolDef<MetaInput> = {
  name: 'prepare_metadata',
  title: 'Prepare token page details',
  description:
    'After a launch confirms, set the token page description, image and links (token lane or Fair lane). Returns a plain text `message` the LAUNCHER wallet signs with personal_sign (EIP-191), then call attach_metadata with the same fields, `timestamp` and the signature within 5 minutes.',
  inputSchema: { type: 'object', properties: metaProperties, required: ['txHash'], additionalProperties: false },
  rate: { limit: 20, windowMs: MINUTE },
  cacheTtlMs: 0,
  async handler(deps, input) {
    const { token, launcher, lane } = await launchFromTx(deps, input.txHash.toLowerCase() as Hex);
    const payload = buildMetadataPayload(token, input);
    const timestamp = deps.now();
    return {
      data: {
        lane, tokenAddress: token, launcher, signWith: launcher,
        timestamp, message: metadataMessage(payload, timestamp),
        signBy: new Date(timestamp + SIGN_WINDOW_MS).toISOString(),
        next: `Sign \`message\` with the launcher wallet (${launcher}) using personal_sign. Then call attach_metadata with the same txHash and fields, this timestamp, and the signature.`,
      },
      untrusted: untrustedBlock(payloadText(payload), { description: 'description', imageUrl: 'link', website: 'link', twitter: 'handle', telegram: 'handle', discord: 'handle', tiktok: 'handle' }),
    };
  },
};

interface AttachInput extends MetaInput { timestamp: number; signature: string }

export const attachMetadataTool: ToolDef<AttachInput> = {
  name: 'attach_metadata',
  title: 'Save token page details',
  description: 'Save the details signed in prepare_metadata. Pass the same txHash and fields, the timestamp it returned, and the launcher\'s signature. Retries while the indexer is still picking up a brand new launch.',
  inputSchema: {
    type: 'object',
    properties: {
      ...metaProperties,
      timestamp: { type: 'integer', minimum: 0, maximum: 99_999_999_999_999, description: 'timestamp from prepare_metadata' },
      signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$', description: 'Launcher\'s personal_sign signature over `message`' },
    },
    required: ['txHash', 'timestamp', 'signature'],
    additionalProperties: false,
  },
  rate: { limit: 20, windowMs: MINUTE },
  cacheTtlMs: 0,
  async handler(deps, input) {
    if (Math.abs(deps.now() - input.timestamp) > SIGN_WINDOW_MS) {
      throw new ToolError('EXPIRED', 'This signature is older than 5 minutes. Run prepare_metadata again and sign the new message.', 409);
    }
    const { token, launcher, lane } = await launchFromTx(deps, input.txHash.toLowerCase() as Hex);
    const payload = buildMetadataPayload(token, input);
    const message = metadataMessage(payload, input.timestamp);
    const signature = input.signature as Hex;
    const ok = await verifyMessage({ address: launcher, message, signature }).catch(() => false);
    if (!ok) {
      throw new ToolError('BAD_SIGNATURE', `The signature is not from the launcher ${launcher} over these exact fields and timestamp. Sign the message prepare_metadata returned, and pass the same fields again.`, 401);
    }
    const body = { address: launcher.toLowerCase(), signature, timestamp: input.timestamp, payload };
    let res = await deps.saveMetadata(token, body);
    for (let i = 0; i < PENDING_RETRIES && res.status === 409 && res.code === 'INDEXER_PENDING'; i++) {
      await deps.sleep(PENDING_WAIT_MS);
      res = await deps.saveMetadata(token, body);
    }
    if (res.status === 409 && res.code === 'INDEXER_PENDING') {
      throw new ToolError('INDEXER_PENDING', 'The new token is not indexed yet. Call attach_metadata again with the same inputs in about 30 seconds (the signature stays valid for 5 minutes from prepare_metadata).', 409);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ToolError(res.code ?? 'SAVE_FAILED', `The details were not saved (${res.code ?? `HTTP ${res.status}`}).`, res.status >= 400 && res.status < 600 ? res.status : 502);
    }
    return {
      data: { saved: true, lane, tokenAddress: token, launcher, links: { trade: `${SITE}/trade/${token}` }, next: 'The token page now shows these details.' },
      untrusted: untrustedBlock(payloadText(payload), { description: 'description', imageUrl: 'link', website: 'link', twitter: 'handle', telegram: 'handle', discord: 'handle', tiktok: 'handle' }),
    };
  },
};

function payloadText(p: ReturnType<typeof buildMetadataPayload>) {
  return { description: p.description, imageUrl: p.imageUrl, website: p.website, twitter: p.twitter, telegram: p.telegram, discord: p.discord, tiktok: p.tiktok };
}

export const METADATA_TOOLS = [prepareMetadataTool, attachMetadataTool] as unknown as ReadonlyArray<ToolDef<never>>;

