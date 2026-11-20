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

test('response parser skips informational headers and keeps the final response ordered', () => {
  const wire = Buffer.from('HTTP/1.1 100 Continue\r\nX-Interim: yes\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok', 'latin1');
  const response = parseCompleteResponse(wire, 'GET', false);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString(), 'ok');
  assert.equal(response.interim.length, 1);
  assert.equal(response.interim[0].statusCode, 100);
  assert.equal(response.raw.toString('latin1'), wire.toString('latin1'));
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

test('origin emits a bodyless, correctly framed 304 and a consistent 206 range', async () => {
  const app = new OriginApplication();
  const initial = await app.route(parsedRequest('GET /static/course.txt HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  const etag = initial.headers.find((item) => item.name === 'ETag');
  const notModified = await app.route(parsedRequest(`GET /static/course.txt HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: ${etag.value}\r\n\r\n`));
  const notModifiedWire = app.standardize('HTTP/1.1', notModified, false, false);
  const parsed304 = parseCompleteResponse(notModifiedWire, 'GET', false);
  assert.equal(parsed304.statusCode, 304);
  assert.equal(parsed304.body.length, 0);
  assert.equal(parsed304.headers.some((item) => item.name.toLowerCase() === 'content-length'), false);

  const partial = await app.route(parsedRequest('GET /status/206 HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  const partialWire = app.standardize('HTTP/1.1', partial, false, false);
  const parsed206 = parseCompleteResponse(partialWire, 'GET', false);
  assert.equal(parsed206.statusCode, 206);
  assert.equal(parsed206.body.length, 5);
  assert.equal(parsed206.headers.find((item) => item.name === 'Content-Range').value, 'bytes 0-4/10');
  assert.equal(parsed206.headers.find((item) => item.name === 'Content-Length').value, '5');
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

test('origin accepts binary uploads and reports the exact received bytes', async () => {
  const app = new OriginApplication();
  const image = Buffer.from([0xff, 0xd8, 0x00, 0x7f, 0x00, 0xd9]);
  const request = parsedRequest(Buffer.concat([
    Buffer.from('POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: image/jpeg\r\nX-File-Name: soleil.jpg\r\nContent-Length: 6\r\n\r\n', 'latin1'),
    image,
  ]));
  const upload = await app.route(request);
  assert.equal(upload.statusCode, 201);
  assert.deepEqual(JSON.parse(upload.body.toString()), {
    receivedBytes: 6,
    contentType: 'image/jpeg',
    fileName: 'soleil.jpg',
    sha256: '06c8fc3e011e2e90167a8453667d45e8c0e71dc42b82a6e186b28486cc3457ca',
  });
});

test('origin stores PUT uploads at their URL and serves the exact bytes later', async () => {
  const app = new OriginApplication();
  const image = Buffer.from([0xff, 0xd8, 0x00, 0x7f, 0x00, 0xd9]);
  const put = await app.route(parsedRequest(Buffer.concat([
    Buffer.from('PUT /uploads/soleil.jpg HTTP/1.1\r\nHost: localhost\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\n', 'latin1'),
    image,
  ])));
  assert.equal(put.statusCode, 201);
  assert.equal(put.headers.find((item) => item.name === 'Location').value, '/uploads/soleil.jpg');
  assert.deepEqual(JSON.parse(put.body.toString()), {
    url: '/uploads/soleil.jpg',
    stored: true,
    receivedBytes: 6,
    contentType: 'image/jpeg',
    sha256: '06c8fc3e011e2e90167a8453667d45e8c0e71dc42b82a6e186b28486cc3457ca',
  });

  const get = await app.route(parsedRequest('GET /uploads/soleil.jpg HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers.find((item) => item.name === 'Content-Type').value, 'image/jpeg');
  assert.deepEqual(get.body, image);

  const replacement = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const overwrite = await app.route(parsedRequest(Buffer.concat([
    Buffer.from('PUT /uploads/soleil.jpg HTTP/1.1\r\nHost: localhost\r\nContent-Type: image/png\r\nContent-Length: 4\r\n\r\n', 'latin1'),
    replacement,
  ])));
  assert.equal(overwrite.statusCode, 200);
  const updated = await app.route(parsedRequest('GET /uploads/soleil.jpg HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  assert.equal(updated.headers.find((item) => item.name === 'Content-Type').value, 'image/png');
  assert.deepEqual(updated.body, replacement);

  const unauthorized = await app.route(parsedRequest('DELETE /uploads/soleil.jpg HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.headers.find((item) => item.name === 'WWW-Authenticate').value, 'Basic realm="isims"');

  const authorization = Buffer.from('mohamed:hkm4c').toString('base64');
  const deleted = await app.route(parsedRequest(`DELETE /uploads/soleil.jpg HTTP/1.1\r\nHost: localhost\r\nAuthorization: Basic ${authorization}\r\n\r\n`));
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body.length, 0);
  const missing = await app.route(parsedRequest('GET /uploads/soleil.jpg HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  assert.equal(missing.statusCode, 404);
});

test('optional raw TCP smoke test (set HTTP_LAB_RUN_NETWORK_TESTS=1)', { skip: process.env.HTTP_LAB_RUN_NETWORK_TESTS !== '1' }, async () => {
  const services = await startLabServices({ origin: { port: 0 }, proxy: { port: 0, auth: { username: 'proxy', password: 'proxy' } }, echo: { port: 0 } });
  try {
    const response = await rawRequest(services.addresses.origin.port, `GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 200 OK\r\n/);
    const trace = await rawRequest(services.addresses.origin.port, 'TRACE / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(trace, /TRACE \/ HTTP\/1\.1/);
    const proxy = await rawRequest(services.addresses.proxy.port, `GET http://127.0.0.1:${services.addresses.origin.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${services.addresses.origin.port}\r\nProxy-Authorization: Basic cHJveHk6cHJveHk=\r\nConnection: close\r\n\r\n`);
    assert.match(proxy, /^HTTP\/1\.1 200 OK\r\n/);
    assert.doesNotMatch(proxy, /,Host:/);
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

