// SSRF guard for upload_image (threat T12): private IPs, encodings, redirects,
// DNS answers that point inside, DNS rebinding, size caps and content sniffing.
// Uses a loopback HTTP fixture; the policy is widened to that one IP + port only.
// Run: pnpm --filter web test:agent
import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';

import { checkDataUrl, checkUrl, isPublicIp, safeFetchImage, sniffImage } from './safeFetch.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

describe('isPublicIp', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.8',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::1', '2001::1',
    '::127.0.0.1', 'not-an-ip', '',
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4001:80b::200e'];
  for (const ip of blocked) it(`blocks ${ip || '(empty)'}`, () => assert.equal(isPublicIp(ip), false));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isPublicIp(ip), true));
});

describe('checkUrl', () => {
  const bad = [
    'http://127.0.0.1/x.png', 'http://[::1]/x.png', 'http://2130706433/x.png', 'http://0x7f.1/x.png', 'http://0177.0.0.1/x.png',
    'http://localhost/x.png', 'http://LOCALHOST./x.png', 'http://metadata.google.internal/x', 'http://printer.local/x',
    'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:169.254.169.254]/', 'http://[fd00::1]/',
    'ftp://example.com/x.png', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)',
    'https://user:pass@example.com/x.png', 'https://example.com:8443/x.png', 'https://example.com:22/x.png', 'not a url',
  ];
  for (const u of bad) it(`refuses ${u}`, () => assert.throws(() => checkUrl(u)));
  it('accepts a normal public https URL', () => assert.equal(checkUrl('https://example.com/a.png').hostname, 'example.com'));
});

describe('sniffImage / checkDataUrl', () => {
  it('sniffs real formats only', () => {
    assert.equal(sniffImage(PNG), 'image/png');
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffImage(Buffer.from('GIF89a')), 'image/gif');
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(sniffImage(Buffer.from('<!doctype html>')), null);
  });
  it('data URL: size cap and type taken from bytes', () => {
    assert.throws(() => checkDataUrl('data:image/png;base64,' + Buffer.alloc(513 * 1024, 0x89).toString('base64')), /too large/);
    assert.throws(() => checkDataUrl('data:image/svg+xml;base64,PHN2Zy8+'));
    assert.throws(() => checkDataUrl('data:text/html;base64,PGh0bWw+'));
    const ok = checkDataUrl('data:image/png;base64,' + PNG.toString('base64'));
    assert.equal(ok.mime, 'image/png');
  });
});

describe('safeFetchImage against a loopback fixture', () => {
  let server;
  let port;
  const hits = [];
  // The fixture is allowed by IP + port; nothing else on loopback, link-local or private is.
  const allowIp = (ip) => ip === '127.0.0.1' || isPublicIp(ip);
  const allowPort = (p) => p === String(port);
  const resolver = (map) => async (host) => {
    const a = map[host];
    if (!a) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return (Array.isArray(a) ? a : [a]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url);
      const go = (loc) => { res.writeHead(302, { location: loc }); res.end(); };
      switch (req.url) {
        case '/png': res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); break;
        case '/svg': res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg onload="alert(1)"/>'); break;
        case '/html-as-png': res.writeHead(200, { 'content-type': 'image/png' }); res.end('<html>'); break;
        case '/big': res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.concat([PNG, Buffer.alloc(600 * 1024)])); break;
        case '/big-chunked': {
          res.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
          res.write(PNG);
          for (let i = 0; i < 700; i++) res.write(Buffer.alloc(1024));
          res.end();
          break;
        }
        case '/to-metadata': go('http://169.254.169.254/latest/meta-data/iam'); break;
        case '/to-file': go('file:///etc/passwd'); break;
        case '/to-ipv6-loop': go('http://[::1]/png'); break;
        case '/to-rebind': go(`http://rebind.test:${port}/png`); break;
        case '/to-png': go('/png'); break;
        case '/loop': go('/loop'); break;
        case '/500': res.writeHead(500); res.end(); break;
        default: res.writeHead(404); res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());

  const base = () => `http://fixture.test:${port}`;
  const opts = (map = {}) => ({ resolve: resolver({ 'fixture.test': '127.0.0.1', ...map }), allowIp, allowPort });

  it('fetches a real image', async () => {
    const r = await safeFetchImage(`${base()}/png`, opts());
    assert.equal(r.mime, 'image/png');
    assert.equal(r.bytes, PNG.length);
  });

  it('follows a same-site redirect', async () => {
    const r = await safeFetchImage(`${base()}/to-png`, opts());
    assert.equal(r.mime, 'image/png');
  });

  it('refuses a redirect to cloud metadata', async () => {
    await assert.rejects(safeFetchImage(`${base()}/to-metadata`, opts()), /private|loopback|reserved/);
  });

  it('refuses a redirect to file:// and to [::1]', async () => {
    await assert.rejects(safeFetchImage(`${base()}/to-file`, opts()), /http/);
    await assert.rejects(safeFetchImage(`${base()}/to-ipv6-loop`, opts()), /private|loopback|reserved/);
  });

  it('refuses a redirect to a name that resolves inside', async () => {
    await assert.rejects(safeFetchImage(`${base()}/to-rebind`, opts({ 'rebind.test': '10.0.0.7' })), /resolves to a private/);
  });

  it('stops redirect loops', async () => {
    await assert.rejects(safeFetchImage(`${base()}/loop`, opts()), /too many redirects/);
  });

  it('refuses a host whose DNS answer is private, without connecting', async () => {
    const before = hits.length;
    await assert.rejects(safeFetchImage(`http://evil.test:${port}/png`, opts({ 'evil.test': '192.168.1.10' })), /resolves to a private/);
    assert.equal(hits.length, before);
  });

  it('refuses when ANY address in the answer is private (mixed A records)', async () => {
    await assert.rejects(safeFetchImage(`http://mixed.test:${port}/png`, opts({ 'mixed.test': ['93.184.216.34', '127.0.0.2'] })), /resolves to a private/);
  });

  it('DNS rebinding: the address checked is the address connected to', async () => {
    // First answer is the fixture (allowed), every later answer is metadata. The guard
    // resolves once inside the socket lookup, so there is no second lookup to swap.
    let n = 0;
    const flip = async () => [{ address: n++ === 0 ? '127.0.0.1' : '169.254.169.254', family: 4 }];
    const before = hits.length;
    const r = await safeFetchImage(`http://flip.test:${port}/png`, { resolve: flip, allowIp, allowPort });
    assert.equal(r.mime, 'image/png');
    assert.equal(n, 1);
    assert.equal(hits.length, before + 1);
    // A second fetch gets the rebound answer and is refused before connecting.
    await assert.rejects(safeFetchImage(`http://flip.test:${port}/png`, { resolve: flip, allowIp, allowPort }), /resolves to a private/);
    assert.equal(hits.length, before + 1);
  });

  it('size cap with and without Content-Length', async () => {
    await assert.rejects(safeFetchImage(`${base()}/big`, opts()), /too large/);
    await assert.rejects(safeFetchImage(`${base()}/big-chunked`, opts()), /too large/);
  });

  it('content is sniffed, not trusted from headers', async () => {
    await assert.rejects(safeFetchImage(`${base()}/svg`, opts()), /png, jpeg/);
    await assert.rejects(safeFetchImage(`${base()}/html-as-png`, opts()), /png, jpeg/);
  });

  it('upstream errors', async () => {
    await assert.rejects(safeFetchImage(`${base()}/500`, opts()), /HTTP 500/);
  });

  it('default policy refuses the loopback fixture outright', async () => {
    await assert.rejects(safeFetchImage(`http://127.0.0.1:${port}/png`), /port|private/);
  });
});
