/// Request body reader with a hard byte cap (threat T7). Checks Content-Length up
/// front, then counts streamed bytes so a missing or lying header can't get past it.

export class BodyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new BodyError(`body too large (max ${maxBytes} bytes)`, 413);
  const ct = req.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(ct)) throw new BodyError('content-type must be application/json', 415);
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyError(`body too large (max ${maxBytes} bytes)`, 413);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder().decode(buf);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError('body must be valid JSON', 400);
  }
}
