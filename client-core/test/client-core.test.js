const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');

const {
  CookieJar,
  HttpCache,
  HttpClient,
  ResponseParser,
  conditionalHeaders,
  merge304,
  parseHttpRequest,
  parseCompleteResponse,
  serializeChunkedResponse,
} = require('../dist/index.js');

function responseFixture(headers, body = 'body') {
  const bytes = Buffer.from(body);
  return {
    version: 'HTTP/1.1',
    statusCode: 200,
    reason: 'OK',
    headers,
    body: bytes,
    raw: Buffer.alloc(0),
    rawHeaders: Buffer.alloc(0),
    chunks: [],
    trailers: [],
    complete: true,
    connectionClose: false,
    usedChunked: false,
    compressedBody: bytes,
    decodedBody: bytes,
  };
}

function parseByteByByte(wire, requestMethod) {
  const parser = new ResponseParser(requestMethod);
  let result = null;
  for (const byte of Buffer.from(wire, 'latin1')) {
    const parsed = parser.feed(Buffer.from([byte]));
    if (parsed) result = parsed;
  }
  assert.ok(result, 'the response should complete after the final byte');
  return { parser, result };
}

test('ResponseParser handles status, headers, and a Content-Length body split across packets', () => {
  const parser = new ResponseParser('GET');
  assert.equal(parser.feed(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n')), null);
  assert.equal(parser.feed(Buffer.from('\r\nhe')), null);
  const result = parser.feed(Buffer.from('lloHTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n'));

  assert.ok(result);
  assert.equal(result.statusCode, 200);
  assert.equal(result.reason, 'OK');
  assert.equal(result.body.toString(), 'hello');
  assert.equal(result.rawHeaders.toString('latin1'), 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n');
  assert.equal(parser.takeRemaining().toString('latin1'), 'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n');
});

test('parseHttpRequest waits for a complete Content-Length body and reports consumed bytes', () => {
  const prefix = Buffer.from('POST /items HTTP/1.1\r\nContent-Length: 4\r\n\r\nte');
  assert.equal(parseHttpRequest(prefix), null);

  const request = parseHttpRequest(Buffer.concat([prefix, Buffer.from('stNEXT')]))
  assert.ok(request);
  assert.equal(request.method, 'POST');
  assert.equal(request.body.toString(), 'test');
  assert.equal(request.consumed, prefix.length + 2);
  assert.equal(request.raw.toString('latin1'), 'POST /items HTTP/1.1\r\nContent-Length: 4\r\n\r\ntest');
});

test('ResponseParser decodes chunk extensions, the terminal zero chunk, trailers, and split framing', () => {
  const wire = [
    'HTTP/1.1 200 OK\r\n',
    'Transfer-Encoding: chunked\r\n',
    '\r\n',
    '6; bonjour\r\nZYXWVT\r\n',
    '10\r\n0123456789ABCDEF\r\n',
    '0\r\nX-Stream-End: yes\r\n\r\n',
  ].join('');
  const { parser, result } = parseByteByByte(wire, 'GET');

  assert.equal(result.body.toString(), 'ZYXWVT0123456789ABCDEF');
  assert.equal(result.body.length, 22);
  assert.deepEqual(result.chunks.map((chunk) => [chunk.sizeHex, chunk.sizeDecimal, chunk.extension]), [
    ['6', 6, 'bonjour'],
    ['10', 16, undefined],
    ['0', 0, undefined],
  ]);
  assert.equal(result.chunks[0].data.toString(), 'ZYXWVT');
  assert.deepEqual(result.trailers, [{ name: 'X-Stream-End', value: 'yes' }]);
  assert.equal(parser.takeRemaining().length, 0);

  const serialized = serializeChunkedResponse('HTTP/1.1', 200, 'OK', [], [
    { data: 'ZYXWVT', extension: 'bonjour' },
    { data: '0123456789ABCDEF' },
  ]);
  assert.equal(serialized.toString('latin1'), [
    'HTTP/1.1 200 OK\r\n',
    'Transfer-Encoding: chunked\r\n',
    '\r\n',
    '6; bonjour\r\nZYXWVT\r\n',
    '10\r\n0123456789ABCDEF\r\n',
    '0\r\n\r\n',
  ].join(''));
});

test('HEAD and 304 responses never consume a body even when Content-Length advertises one', () => {
  const headWire = 'HTTP/1.1 200 OK\r\nContent-Length: 7\r\nETag: "head"\r\n\r\nignored';
  const headParser = new ResponseParser('HEAD');
  const head = headParser.feed(Buffer.from(headWire, 'latin1'));
  assert.ok(head);
  assert.equal(head.body.length, 0);
  assert.equal(head.raw.toString('latin1'), 'HTTP/1.1 200 OK\r\nContent-Length: 7\r\nETag: "head"\r\n\r\n');
  assert.equal(headParser.takeRemaining().toString(), 'ignored');

  const notModified = parseCompleteResponse(
    Buffer.from('HTTP/1.1 304 Not Modified\r\nContent-Length: 7\r\n\r\nignored', 'latin1'),
    'GET',
  );
  assert.equal(notModified.body.length, 0);
  assert.equal(notModified.raw.toString('latin1'), 'HTTP/1.1 304 Not Modified\r\nContent-Length: 7\r\n\r\n');
});

test('CookieJar matches host, domain, path boundaries, secure transport, and expiry', () => {
  const jar = new CookieJar();
  const origin = 'http://example.com/docs/login';
  jar.store([
    { name: 'Set-Cookie', value: 'sid=abc; Path=/app' },
    { name: 'Set-Cookie', value: 'root=one; Path=/' },
    { name: 'Set-Cookie', value: 'wide=yes; Domain=.example.com; Path=/' },
    { name: 'Set-Cookie', value: 'secure=yes; Secure; Path=/' },
    { name: 'Set-Cookie', value: 'default=docs' },
    { name: 'Set-Cookie', value: 'ignored=leak; Domain=evil.example; Path=/' },
  ], origin);

  assert.equal(jar.headerFor('http://example.com/app/page'), 'sid=abc; root=one; wide=yes');
  assert.equal(jar.headerFor('http://example.com/application'), 'root=one; wide=yes');
  assert.equal(jar.headerFor('http://sub.example.com/app/page'), 'wide=yes');
  assert.equal(jar.headerFor('https://example.com/app/page'), 'sid=abc; root=one; wide=yes; secure=yes');
  assert.equal(jar.headerFor('http://example.com/docs/next'), 'default=docs; root=one; wide=yes');
  assert.equal(jar.headerFor('http://example.com/other'), 'root=one; wide=yes');
  assert.equal(jar.headerFor('http://example.com/app/page').includes('ignored='), false);

  jar.setFromHeader('gone=value; Max-Age=0; Path=/', origin);
  assert.equal(jar.headerFor(origin).includes('gone='), false);
  assert.equal(jar.edit('root', 'two', 'EXAMPLE.COM'), true);
  assert.equal(jar.headerFor('http://example.com/'), 'root=two; wide=yes');
  assert.equal(jar.delete('root', '.example.com'), true);
  assert.equal(jar.headerFor('http://example.com/'), 'wide=yes');
});

test('HttpCache tracks freshness, expiry, validators, and refreshes metadata after 304', () => {
  const cache = new HttpCache();
  const url = 'http://example.com/static/soleil.jpg';
  const storedAt = 1_000_000;
  const entry = cache.store(url, 'GET', responseFixture([
    { name: 'Cache-Control', value: 'public, max-age=60' },
    { name: 'ETag', value: '"v1"' },
    { name: 'Last-Modified', value: 'Wed, 01 Jan 2025 00:00:00 GMT' },
  ], 'cached'), storedAt);

  assert.ok(entry);
  assert.equal(cache.lookup(url, 'GET', storedAt - 1).state, 'fresh');
  assert.equal(cache.lookup(url, 'GET', storedAt + 59_999).state, 'fresh');
  assert.equal(cache.lookup(url, 'GET', storedAt + 60_000).state, 'stale');
  assert.deepEqual(conditionalHeaders(entry), [
    { name: 'If-None-Match', value: '"v1"' },
    { name: 'If-Modified-Since', value: 'Wed, 01 Jan 2025 00:00:00 GMT' },
  ]);

  const notModified = {
    ...responseFixture([{ name: 'Date', value: 'Wed, 01 Jan 2025 00:02:00 GMT' }], ''),
    statusCode: 304,
    reason: 'Not Modified',
  };
  const refreshed = cache.revalidate(url, 'GET', notModified, storedAt + 120_000);
  assert.ok(refreshed);
  assert.equal(cache.lookup(url, 'GET', storedAt + 120_000 + 59_999).state, 'fresh');
  assert.equal(merge304(refreshed, notModified).body.toString(), 'cached');

  const expiresUrl = 'http://example.com/expires';
  const expires = cache.store(expiresUrl, 'GET', responseFixture([
    { name: 'Expires', value: 'Thu, 01 Jan 1970 00:10:00 GMT' },
  ]), 0);
  assert.ok(expires);
  assert.equal(cache.lookup(expiresUrl, 'GET', 599_999).state, 'fresh');
  assert.equal(cache.lookup(expiresUrl, 'GET', 600_000).state, 'stale');

  assert.equal(cache.store('http://example.com/no-store', 'GET', responseFixture([{ name: 'Cache-Control', value: 'no-store' }])), undefined);
  assert.equal(cache.store('http://example.com/private', 'GET', responseFixture([{ name: 'Cache-Control', value: 'private, max-age=60' }])), undefined);
});

test('HttpClient uses the URL host and port for direct raw TCP connections', async () => {
  const originalCreateConnection = net.createConnection;
  let connectionOptions;
  net.createConnection = (options) => {
    connectionOptions = options;
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.setNoDelay = () => socket;
    socket.setTimeout = () => socket;
    socket.write = () => {
      queueMicrotask(() => socket.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')));
      return true;
    };
    socket.destroy = () => {
      socket.destroyed = true;
      socket.emit('close');
      return socket;
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };

  const client = new HttpClient();
  try {
    const exchange = await client.request({ url: 'http://127.0.0.1:43210/direct' });
    assert.equal(exchange.response.statusCode, 200);
    assert.equal(exchange.response.body.toString(), 'ok');
    assert.deepEqual(connectionOptions, { host: '127.0.0.1', port: 43210 });
  } finally {
    client.closeAll();
    net.createConnection = originalCreateConnection;
  }
});
