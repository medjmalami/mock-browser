import { HttpClient, type Exchange, type HttpVersion, type Header, type ParsedResponse } from '@http-lab/client-core';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Adapt Chromium's request to the raw client; Chromium owns redirects and cookies. */
export async function serveLiveRequest(request: Request, client: HttpClient, version: HttpVersion, capture: (exchange: Exchange) => void): Promise<Response> {
  const url = new URL(request.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Live pages require HTTP or HTTPS');
  const headers: Header[] = [];
  request.headers.forEach((value, name) => {
    if (!hopHeaders.has(name) && !['host', 'content-length', 'accept-encoding'].includes(name)) headers.push({ name, value });
  });
  // Electron exposes the browser-computed referrer separately from headers.
  if (request.referrer && /^https?:/.test(request.referrer) && !headers.some(h => h.name.toLowerCase() === 'referer')) headers.push({ name: 'Referer', value: request.referrer });
  // The lab decoder supports gzip/deflate, not every encoding Chromium advertises.
  headers.push({ name: 'Accept-Encoding', value: 'gzip, deflate, identity' });
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
  const exchange = await client.request({ url: request.url, method: request.method, version, headers, body, autoRedirect: false, cookies: false, cache: false });
  capture(exchange);
  const response = exchange.response;
  if (!response || exchange.error) throw new Error(exchange.error || 'No HTTP response (connection failed)' );
  return renderLiveResponse(response, request.method);
}

/** The initial preview uses captured bytes, so displaying a POST never submits it twice. */
export function renderLiveResponse(response: ParsedResponse, method = 'GET', snapshot = false): Response {
  const renderedHeaders = new Headers();
  const connectionTokens = response.headers.filter(h => h.name.toLowerCase() === 'connection').flatMap(h => h.value.toLowerCase().split(',').map(v => v.trim()));
  for (const header of response.headers) {
    const name = header.name.toLowerCase();
    // This is only the browser representation. Captured response bytes stay intact.
    if (!hopHeaders.has(name) && !connectionTokens.includes(name) && !['content-encoding', 'content-length'].includes(name)) renderedHeaders.append(header.name, header.value);
  }
  // Workers and sockets would bypass the observable HTTP request/response model.
  renderedHeaders.append('Content-Security-Policy', "worker-src 'none'; object-src 'none'; connect-src http: https:");
  const noBody = method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
  return new Response(noBody ? null : new Uint8Array(response.decodedBody), { status: snapshot && response.statusCode >= 300 && response.statusCode < 400 ? 200 : response.statusCode, statusText: response.reason, headers: renderedHeaders });
}

