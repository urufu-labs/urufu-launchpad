/// Minimal JSON-Schema subset for v2 tool inputs. The same schema object is what
/// MCP `tools/list` publishes and what we validate against, so the advertised
/// contract and the enforced one can't drift.
///
/// Every object schema is closed (`additionalProperties: false`). On top of that,
/// any field whose NAME looks like a secret is rejected with its own error before
/// validation runs: no v2 or MCP tool ever accepts or asks for a key (threat T1).

export type JsonSchema =
  | { type: 'string'; description?: string; minLength?: number; maxLength?: number; pattern?: string; enum?: readonly string[]; default?: string }
  | { type: 'integer'; description?: string; minimum?: number; maximum?: number; default?: number }
  | { type: 'boolean'; description?: string; default?: boolean }
  | ObjectSchema;

export interface ObjectSchema {
  type: 'object';
  description?: string;
  properties: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties: false;
}

export class ToolInputError extends Error {
  code: 'INVALID_INPUT' | 'SECRET_FIELD';
  constructor(code: 'INVALID_INPUT' | 'SECRET_FIELD', message: string) {
    super(message);
    this.code = code;
  }
}

/// Field names that look like key material. Matched against every key at any depth,
/// with separators and case ignored.
const SECRET_NAME = /(priv(ate)?key|secret|mnemonic|seedphrase|seed|passphrase|password|passwd|signingkey|signerkey|walletkey|apikey|accesstoken|authtoken|bearer|keystore|xprv|^pk$|^sk$|^key$)/;

function normalizeName(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/// Throws SECRET_FIELD if any key in `input` (recursively) looks like a secret.
export function assertNoSecretFields(input: unknown, path = ''): void {
  if (Array.isArray(input)) {
    input.forEach((v, i) => assertNoSecretFields(v, `${path}[${i}]`));
    return;
  }
  if (input === null || typeof input !== 'object') return;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_NAME.test(normalizeName(k))) {
      throw new ToolInputError(
        'SECRET_FIELD',
        `field "${path ? `${path}.` : ''}${k}" looks like a key or secret. urufu never accepts keys: every tool returns unsigned transactions for your own wallet to sign. Remove the field and do not send keys to any API.`,
      );
    }
    assertNoSecretFields(v, path ? `${path}.${k}` : k);
  }
}

/// Validate `input` against an object schema. `coerce` turns query-string values
/// ("10", "true") into the declared integer / boolean types for GET requests.
export function validateInput<T = Record<string, unknown>>(schema: ObjectSchema, input: unknown, coerce = false): T {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolInputError('INVALID_INPUT', 'input must be a JSON object');
  }
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (!(k in schema.properties)) {
      throw new ToolInputError('INVALID_INPUT', `unknown field "${k}". allowed: ${Object.keys(schema.properties).join(', ') || '(none)'}`);
    }
  }
  for (const [k, s] of Object.entries(schema.properties)) {
    let v = obj[k];
    if (v === undefined || v === '') {
      if (schema.required?.includes(k)) throw new ToolInputError('INVALID_INPUT', `missing required field "${k}"`);
      if (s.type !== 'object' && s.default !== undefined) out[k] = s.default;
      continue;
    }
    if (s.type === 'string') {
      if (typeof v !== 'string') throw new ToolInputError('INVALID_INPUT', `"${k}" must be a string`);
      if (s.minLength !== undefined && v.length < s.minLength) throw new ToolInputError('INVALID_INPUT', `"${k}" is too short (min ${s.minLength})`);
      if (s.maxLength !== undefined && v.length > s.maxLength) throw new ToolInputError('INVALID_INPUT', `"${k}" is too long (max ${s.maxLength})`);
      if (s.pattern !== undefined && !new RegExp(s.pattern).test(v)) throw new ToolInputError('INVALID_INPUT', `"${k}" has the wrong format`);
      if (s.enum !== undefined && !s.enum.includes(v)) throw new ToolInputError('INVALID_INPUT', `"${k}" must be one of: ${s.enum.join(', ')}`);
    } else if (s.type === 'integer') {
      if (coerce && typeof v === 'string' && /^-?\d{1,15}$/.test(v)) v = Number(v);
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolInputError('INVALID_INPUT', `"${k}" must be an integer`);
      if (s.minimum !== undefined && v < s.minimum) throw new ToolInputError('INVALID_INPUT', `"${k}" must be >= ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) throw new ToolInputError('INVALID_INPUT', `"${k}" must be <= ${s.maximum}`);
    } else if (s.type === 'boolean') {
      if (coerce && (v === 'true' || v === 'false')) v = v === 'true';
      if (typeof v !== 'boolean') throw new ToolInputError('INVALID_INPUT', `"${k}" must be true or false`);
    } else {
      v = validateInput(s, v, coerce);
    }
    out[k] = v;
  }
  return out as T;
}

// ---- shared field shapes ----

export const ADDRESS_PATTERN = '^0x[0-9a-fA-F]{40}$';
export const TX_HASH_PATTERN = '^0x[0-9a-fA-F]{64}$';
/// Decimal ETH amount, at most 18 decimals, no sign or exponent.
export const ETH_AMOUNT_PATTERN = '^(0|[1-9]\\d{0,6})(\\.\\d{1,18})?$';

export const addressField = (description: string): JsonSchema => ({ type: 'string', pattern: ADDRESS_PATTERN, description });
