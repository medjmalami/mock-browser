const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {
  OriginApplication,
  parseCompleteResponse,
  parseHttpRequest,
  serializeResponse,
  startLabServices,
} = require('../dist');

function parsedRequest(raw) {
  const value = parseHttpRequest(Buffer.from(raw, 'latin1'));
  assert.ok(value, 'request should be complete');
  return value;
}

test('request parser waits for split headers and body, preserving raw bytes', () => {
  const first = Buffer.from('POST /items HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\n\r\nhe', 'latin1');
  assert.equal(parseHttpRequest(first), null);
  const complete = Buffer.concat([first, Buffer.from('llo', 'latin1')]);
  const request = parseHttpRequest(complete);
  assert.ok(request);
  assert.equal(request.method, 'POST');
  assert.equal(request.body.toString(), 'hello');
  assert.equal(request.raw.toString('latin1'), complete.toString('latin1'));
});

test('chunked parser records extensions and computes the course payload length', () => {
  const raw = Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n6; bonjour\r\nZYXWVT\r\n10\r\n0123456789ABCDEF\r\n0\r\n\r\n', 'latin1');
  const response = parseCompleteResponse(raw, 'GET', true);
  assert.equal(response.body.toString('latin1'), 'ZYXWVT0123456789ABCDEF');
  assert.equal(response.body.length, 22);
  assert.deepEqual(response.chunks.map((chunk) => [chunk.sizeHex, chunk.sizeDecimal, chunk.extension]), [['6', 6, 'bonjour'], ['10', 16, undefined], ['0', 0, undefined]]);
});

test('serializer emits controlled CRLF and content length', () => {
  const wire = serializeResponse('HTTP/1.1', { statusCode: 201, reason: 'Created', headers: [{ name: 'X-Test', value: 'yes' }], body: 'abc' });
  assert.equal(wire.toString('latin1'), 'HTTP/1.1 201 Created\r\nX-Test: yes\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 3\r\n\r\nabc');
});

test('origin implements HEAD with GET-equivalent Content-Length and no body', async () => {
  const app = new OriginApplication();
  const get = await app.route(parsedRequest('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
  const head = await app.route(parsedRequest('HEAD / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
  const getWire = app.standardize('HTTP/1.1', get, true, false);
  const headWire = app.standardize('HTTP/1.1', head, true, true);
  const getResponse = parseCompleteResponse(getWire, 'GET', true);
  const headResponse = parseCompleteResponse(headWire, 'HEAD', true);
  const getLength = getResponse.headers.find((item) => item.name.toLowerCase() === 'content-length');
  const headLength = headResponse.headers.find((item) => item.name.toLowerCase() === 'content-length');
  assert.equal(headLength.value, getLength.value);
  assert.equal(headResponse.body.length, 0);
});

test('origin routes cover TRACE, status headers, login cookie, and chunked response', async () => {
  const app = new OriginApplication();
  const traceRaw = 'TRACE /anything HTTP/1.1\r\nHost: localhost\r\nX-Demo: yes\r\n\r\n';
  const trace = await app.route(parsedRequest(traceRaw));
  assert.equal(trace.statusCode, 200);
  assert.equal(trace.body.toString('latin1'), traceRaw);

  const status = await app.route(parsedRequest('GET /status/401 HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  assert.equal(status.statusCode, 401);
  assert.equal(status.headers.find((item) => item.name === 'WWW-Authenticate').value, 'Basic realm="isims"');

  const login = await app.route(parsedRequest('POST /login.cgi HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 31\r\n\r\nusername=mohamed&password=hkm4c'));
  assert.equal(login.statusCode, 201);
  const cookie = login.headers.find((item) => item.name === 'Set-Cookie');
  assert.match(cookie.value, /^SESSID=[^;]+; Path=\//);
  const privatePage = await app.route(parsedRequest(`GET /private/home HTTP/1.1\r\nHost: localhost\r\nCookie: ${cookie.value.split(';')[0]}\r\n\r\n`));
  assert.equal(privatePage.statusCode, 200);

  const chunked = await app.route(parsedRequest('GET /chunked HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  const chunkedWire = app.standardize('HTTP/1.1', chunked, true, false);
  const chunkedResponse = parseCompleteResponse(chunkedWire, 'GET', true);
  assert.equal(chunkedResponse.body.length, 22);
  assert.equal(chunkedResponse.chunks[0].extension, 'bonjour');
});

test('optional raw TCP smoke test (set HTTP_LAB_RUN_NETWORK_TESTS=1)', { skip: process.env.HTTP_LAB_RUN_NETWORK_TESTS !== '1' }, async () => {
  const services = await startLabServices({ origin: { port: 0 }, proxy: { port: 0 }, echo: { port: 0 } });
  try {
    const response = await rawRequest(services.addresses.origin.port, `GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 200 OK\r\n/);
    const trace = await rawRequest(services.addresses.origin.port, 'TRACE / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(trace, /TRACE \/ HTTP\/1\.1/);
  } finally {
    await services.stop();
  }
});

function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let data = Buffer.alloc(0);
    socket.on('connect', () => socket.write(request, 'latin1'));
    socket.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
    socket.on('error', reject);
    socket.on('close', () => resolve(data.toString('latin1')));
  });
}

