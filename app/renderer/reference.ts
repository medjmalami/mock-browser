export const METHOD_REFERENCE: Record<string, { name: string; description: string }> = {
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

export const STATUS_REFERENCE = [
  [100, 'Continue', 'informational response; not used in HTTP/1.0'], [101, 'Switching Protocols', 'informational response; not used in HTTP/1.0'], [102, 'Processing', 'informational response; not used in HTTP/1.0'], [103, 'Early Hints', 'informational response; not used in HTTP/1.0'],
  [200, 'OK', 'request succeeded'], [201, 'Created', 'new resource created'], [202, 'Accepted', 'received, processing not finished'], [203, 'Non-Authoritative Information', 'content modified by a non-certified source such as a proxy'], [204, 'No Content', 'request succeeded without a response body'], [205, 'Reset Content', 'client should reset the document view'], [206, 'Partial Content', 'partial representation returned with Content-Range'],
  [300, 'Multiple Choices', 'multiple representations are available'], [301, 'Moved Permanently', 'new address · Déplacé'], [302, 'Found', 'temporarily moved'], [303, 'See Other', 'retrieve the result at another address'], [304, 'Not Modified', 'cached representation remains valid'], [305, 'Use Proxy', 'client should use a proxy'],
  [400, 'Bad Request', 'request syntax is invalid'], [401, 'Unauthorized', 'authentication is needed'], [403, 'Forbidden', 'request understood but refused'], [404, 'Not Found', 'resource does not exist · Non trouvé'], [405, 'Method Not Allowed', 'method is known but not allowed for this resource'], [406, 'Not Acceptable', 'nothing matches the Accept headers'], [407, 'Proxy Authentication Required', 'proxy authentication is needed'], [408, 'Request Timeout', 'server timed out waiting for the request'], [409, 'Conflict', 'request conflicts with current resource state'], [410, 'Gone', 'resource was deliberately removed'],
  [500, 'Internal Server Error', 'unexpected server failure'], [501, 'Not Implemented', 'unknown method is not implemented'], [502, 'Bad Gateway', 'proxy received an invalid upstream response'], [503, 'Service Unavailable', 'service is temporarily unavailable'], [504, 'Gateway Timeout', 'proxy did not receive an upstream response in time'], [505, 'HTTP Version Not Supported', 'HTTP version is not supported'],
].map(([code, name, meaning]) => ({ code: code as number, name: name as string, meaning: meaning as string }));

export function statusMeaning(code: number): { code: number; name: string; meaning: string } | undefined {
  return STATUS_REFERENCE.find((status) => status.code === code);
}
