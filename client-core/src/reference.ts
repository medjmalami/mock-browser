export const METHOD_REFERENCE: Record<string, { name: string; french?: string; description: string }> = {
  GET: { name: 'GET', description: 'request the resource at the URL' },
  HEAD: { name: 'HEAD', description: 'only information about the resource, not the resource itself' },
  POST: { name: 'POST', description: 'request that modifies the resource at the URL; body sent to the server, usually processed by a script' },
  PUT: { name: 'PUT', description: 'add a resource on the server at the URL' },
  DELETE: { name: 'DELETE', description: 'delete the resource at the URL' },
  TRACE: { name: 'TRACE', description: 'server returns what it received, for diagnostics' },
  CONNECT: { name: 'CONNECT', description: 'use a proxy as a communication tunnel' },
  PATCH: { name: 'PATCH', description: 'partial modification (RFC 5789), not covered in the course' },
};

export const REQUEST_HEADER_REFERENCE: Record<string, string> = {
  Accept: 'Media types the client can display.',
  'Accept-Encoding': 'Content codings accepted by the client, such as gzip.',
  'Accept-Charset': 'Accepted character sets, including q factors.',
  'Accept-Language': 'Preferred natural languages, such as fr or en.',
  Host: 'Origin host and port required by HTTP/1.1.',
  Connection: 'Connection policy: close or keep-alive.',
  'Keep-Alive': 'Keep-alive parameters such as timeout and max request count.',
  'User-Agent': 'Client software identification.',
  Cookie: 'Cookies sent back to the origin.',
  Referer: 'URL of the page the request came from; the spelling is really Referer.',
  Pragma: 'HTTP/1.0 cache directive, commonly no-cache.',
  'Cache-Control': 'HTTP/1.1 cache directives such as no-cache or max-age=0.',
  'If-Modified-Since': 'Conditional GET date; a match can produce 304 Not Modified.',
  'If-None-Match': 'Conditional GET ETag; a match can produce 304 Not Modified.',
  'If-Match': 'Only perform the operation when the resource has this ETag.',
  'Content-Length': 'Number of bytes in the message body.',
  'Content-Type': 'Media type and optional charset of the body.',
  'Transfer-Encoding': 'Message framing, including chunked.',
  Authorization: 'Origin authentication credentials, commonly Basic.',
  'Proxy-Authorization': 'Client-to-proxy credentials; never forwarded to the origin.',
};

export const RESPONSE_HEADER_REFERENCE: Record<string, string> = {
  Date: 'Time at which the response was generated.',
  Server: 'Origin server software identification.',
  'Last-Modified': 'Last modification time of the representation.',
  ETag: 'Opaque representation validator for conditional requests.',
  Expires: 'Absolute cache expiration time.',
  'Cache-Control': 'Caching policy, including max-age, public, or private.',
  'Accept-Ranges': 'Advertises byte range support.',
  'Content-Length': 'Number of bytes in the message body.',
  'Content-Type': 'Media type of the body.',
  'Content-Range': 'Range returned by a 206 Partial Content response.',
  'Keep-Alive': 'Keep-alive parameters such as timeout and max request count.',
  Connection: 'Whether the connection is kept alive or closed.',
  'Transfer-Encoding': 'Message framing, including chunked.',
  Location: 'Target URL for a redirect or created resource.',
  'Set-Cookie': 'Cookie state the client may store.',
  'WWW-Authenticate': 'Authentication challenge from the origin.',
  'Proxy-Authenticate': 'Authentication challenge from the proxy.',
};

export type StatusReference = { code: number; name: string; french?: string; meaning: string };

export const STATUS_REFERENCE: StatusReference[] = [
  { code: 100, name: 'Continue', meaning: 'informational response; not used in HTTP/1.0' },
  { code: 101, name: 'Switching Protocols', meaning: 'protocol switch accepted; not used in HTTP/1.0' },
  { code: 102, name: 'Processing', meaning: 'informational response; not used in HTTP/1.0' },
  { code: 103, name: 'Early Hints', meaning: 'informational response; not used in HTTP/1.0' },
  { code: 200, name: 'OK', meaning: 'request succeeded' },
  { code: 201, name: 'Created', meaning: 'new resource created' },
  { code: 202, name: 'Accepted', meaning: 'received, processing not finished' },
  { code: 203, name: 'Non-Authoritative Information', meaning: 'content modified by a non-certified source such as a proxy' },
  { code: 204, name: 'No Content', meaning: 'request succeeded without a response body' },
  { code: 205, name: 'Reset Content', meaning: 'client should reset the document view' },
  { code: 206, name: 'Partial Content', meaning: 'partial representation returned with Content-Range' },
  { code: 300, name: 'Multiple Choices', meaning: 'multiple representations are available' },
  { code: 301, name: 'Moved Permanently', french: 'Déplacé', meaning: 'new address' },
  { code: 302, name: 'Found', meaning: 'temporarily moved' },
  { code: 303, name: 'See Other', meaning: 'retrieve the result at another address' },
  { code: 304, name: 'Not Modified', meaning: 'cached representation remains valid' },
  { code: 305, name: 'Use Proxy', meaning: 'client should use a proxy' },
  { code: 400, name: 'Bad Request', meaning: 'request syntax is invalid' },
  { code: 401, name: 'Unauthorized', meaning: 'authentication is needed' },
  { code: 403, name: 'Forbidden', meaning: 'request understood but refused' },
  { code: 404, name: 'Not Found', french: 'Non trouvé', meaning: 'resource does not exist' },
  { code: 405, name: 'Method Not Allowed', meaning: 'method is known but not allowed for this resource' },
  { code: 406, name: 'Not Acceptable', meaning: 'nothing matches the Accept headers' },
  { code: 407, name: 'Proxy Authentication Required', meaning: 'proxy authentication is needed' },
  { code: 408, name: 'Request Timeout', meaning: 'server timed out waiting for the request' },
  { code: 409, name: 'Conflict', meaning: 'request conflicts with current resource state' },
  { code: 410, name: 'Gone', meaning: 'resource was deliberately removed' },
  { code: 500, name: 'Internal Server Error', meaning: 'unexpected server failure' },
  { code: 501, name: 'Not Implemented', meaning: 'unknown method is not implemented' },
  { code: 502, name: 'Bad Gateway', meaning: 'proxy received an invalid upstream response' },
  { code: 503, name: 'Service Unavailable', meaning: 'service is temporarily unavailable' },
  { code: 504, name: 'Gateway Timeout', meaning: 'proxy did not receive an upstream response in time' },
  { code: 505, name: 'HTTP Version Not Supported', meaning: 'HTTP version is not supported' },
];

export function statusMeaning(code: number): StatusReference | undefined {
  return STATUS_REFERENCE.find((status) => status.code === code);
}

export function headerExplanation(name: string): string | undefined {
  const key = Object.keys(REQUEST_HEADER_REFERENCE).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return REQUEST_HEADER_REFERENCE[key ?? name] ?? RESPONSE_HEADER_REFERENCE[key ?? name];
}
