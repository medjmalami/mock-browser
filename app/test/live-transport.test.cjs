const test = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { serveLiveRequest } = require('../dist/live-transport');

function fixture(statusCode = 200) {
  const decodedBody = Buffer.from('body { color: blue; }');
  const body = gzipSync(decodedBody);
  const response = { statusCode, reason: 'OK', decodedBody, body, raw: Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n'), body]), headers: [{ name: 'Content-Type', value: 'text/css' }, { name: 'Content-Encoding', value: 'gzip' }, { name: 'Transfer-Encoding', value: 'chunked' }, { name: 'Content-Length', value: String(body.length) }, { name: 'Connection', value: 'X-Hop' }, { name: 'X-Hop', value: 'remove' }] };
  return { response };
}

test('live transport preserves captured compressed wire and adapts decoded body for Chromium', async () => {
  const exchange = fixture();
  const raw = Buffer.from(exchange.response.raw);
  let sent, captured;
  const client = { request: async options => { sent = options; return exchange; } };
  const rendered = await serveLiveRequest(new Request('https://example.test/app.css', { headers: { 'Accept-Encoding': 'br', 'Proxy-Authorization': 'secret' } }), client, 'HTTP/1.1', value => captured = value);
  assert.equal(await rendered.text(), 'body { color: blue; }');
  for (const header of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'x-hop']) assert.equal(rendered.headers.has(header), false, header);
  assert.equal(rendered.headers.get('content-type'), 'text/css');
  assert.match(rendered.headers.get('content-security-policy'), /worker-src 'none'/);
  assert.deepEqual(captured.response.raw, raw);
  assert.equal(sent.autoRedirect, false);
  assert.equal(sent.cookies, false);
  assert.equal(sent.headers.some(h => h.name.toLowerCase() === 'proxy-authorization'), false);
  assert.equal(sent.headers.find(h => h.name.toLowerCase() === 'accept-encoding').value, 'gzip, deflate, identity');
});

test('live transport sends exact form bytes and Referer; leaves redirects to Chromium', async () => {
  const exchange = fixture(303);
  exchange.response.headers = [{ name: 'Location', value: '/next' }];
  let sent;
  const rendered = await serveLiveRequest(new Request('https://example.test/submit', { method: 'POST', referrer: 'https://example.test/form', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=A+%26+B' }), { request: async options => { sent = options; return exchange; } }, 'HTTP/1.1', () => {});
  assert.equal(sent.body.toString(), 'name=A+%26+B');
  assert.equal(sent.headers.find(h => h.name === 'Referer').value, 'https://example.test/form');
  assert.equal(rendered.status, 303);
  assert.equal(rendered.headers.get('location'), '/next');
});

test('HEAD and bodyless status responses are adapted without a body', async () => {
  for (const [method, status] of [['HEAD', 200], ['GET', 204], ['GET', 205], ['GET', 304]]) {
    const rendered = await serveLiveRequest(new Request('https://example.test/', { method }), { request: async () => fixture(status) }, 'HTTP/1.1', () => {});
    assert.equal(await rendered.text(), '');
  }
});
