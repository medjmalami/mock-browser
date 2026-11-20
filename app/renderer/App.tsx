import { useEffect, useMemo, useRef, useState, type ChangeEvent, type JSX, type RefObject } from 'react';
import { METHOD_REFERENCE, REQUEST_HEADER_REFERENCE, RESPONSE_HEADER_REFERENCE, STATUS_REFERENCE, statusMeaning } from './reference';
import type { CacheMode, Header, HttpMethod, HttpVersion } from '@http-lab/client-core';

type WireBuffer = { base64: string; length: number; truncated?: boolean };
type WireChunk = { sizeHex: string; sizeDecimal: number; data: WireBuffer; extension?: string };
type WireRequest = { raw: string; requestLine: string; headers: Header[]; body: WireBuffer; bytes: WireBuffer; largeBody?: boolean };
type WireResponse = { version: string; statusCode: number; reason: string; headers: Header[]; body: WireBuffer; raw: WireBuffer; rawHeaders: WireBuffer; chunks: WireChunk[]; trailers: Header[]; complete: boolean; connectionClose: boolean; usedChunked: boolean; compressedBody: WireBuffer; decodedBody: WireBuffer; largeBody?: boolean };
type WireExchange = { id: string; request: WireRequest; response?: WireResponse; cacheResponse?: WireResponse; attempts: Array<{ request: WireRequest; response?: WireResponse; error?: string; connectionId?: string }>; timeline: any[]; redirectChain: string[]; fromCache: boolean; cacheRevalidated: boolean; connectionId?: string; connectionReuseCount?: number; error?: string };
type Scenario = { name: string; description: string; options: any };
type EditableHeader = Header & { enabled: boolean };
type UploadFile = { file: File; bytes: Uint8Array; name: string; type: string; size: number };
type BodyMode = 'raw' | 'form' | 'json' | 'binary';

const METHODS = Object.keys(METHOD_REFERENCE) as HttpMethod[];
const MAX_RENDERED_WIRE_BYTES = 64 * 1024;
const MAX_RENDERED_LOG_CHARS = 12 * 1024;
const scenarios: Scenario[] = [
  { name: 'Page + images (HTTP/1.1)', description: 'Automatically validate the HTML page and each uploaded image independently over a reusable connection.', options: { method: 'GET', url: 'http://127.0.0.1:8080/', version: 'HTTP/1.1', loadImages: true, autoRedirect: false, cache: true, cacheMode: 'revalidate', cookies: false } },
  { name: 'Upload image (PUT)', description: 'Choose an image and store it at /uploads/soleil.jpg.', options: { method: 'PUT', url: 'http://127.0.0.1:8080/uploads/soleil.jpg', version: 'HTTP/1.1', bodyMode: 'binary', autoRedirect: false, cache: false, cookies: false } },
  { name: 'Delete image (authenticated)', description: 'Delete /uploads/soleil.jpg with the course Basic credentials.', options: { method: 'DELETE', url: 'http://127.0.0.1:8080/uploads/soleil.jpg', version: 'HTTP/1.1', auth: { username: 'mohamed', password: 'hkm4c' }, autoRedirect: false, cache: false, cookies: false } },
  { name: 'Conditional GET → 304', description: 'Enable cache, fetch twice, then inspect the conditional request.', options: { method: 'GET', url: 'http://127.0.0.1:8080/static/course.txt', version: 'HTTP/1.1', headers: [{ name: 'Cache-Control', value: 'no-cache' }], cache: true, cookies: false, autoRedirect: false } },
  { name: 'ETag → 304', description: 'Exercise If-None-Match with the static resource.', options: { method: 'GET', url: 'http://127.0.0.1:8080/static/etag.txt', version: 'HTTP/1.1', headers: [{ name: 'Cache-Control', value: 'no-cache' }], cache: true, cookies: false, autoRedirect: false } },
  { name: 'Basic auth 401 → 200', description: 'Challenge and retry against /protected/.', options: { method: 'GET', url: 'http://127.0.0.1:8080/protected/', version: 'HTTP/1.1', auth: { username: 'mohamed', password: 'hkm4c' }, autoRedirect: false, cache: false, cookies: false } },
  { name: 'Proxy 407 → 200', description: 'Use the local proxy with its optional course credentials.', options: { method: 'GET', url: 'http://127.0.0.1:8080/', version: 'HTTP/1.1', proxy: { host: '127.0.0.1', port: 8888, enabled: true, credentials: { username: 'proxy', password: 'proxy' } }, autoRedirect: false, cache: false, cookies: false } },
  { name: '301 redirect', description: 'Follow /old and show Referer on the next request.', options: { method: 'GET', url: 'http://127.0.0.1:8080/old', version: 'HTTP/1.1', autoRedirect: true, cache: false, cookies: false } },
  { name: 'Cookie login', description: 'POST the course form, then request the private page with Cookie.', options: { method: 'POST', url: 'http://127.0.0.1:8080/login.cgi', version: 'HTTP/1.1', headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }], body: 'username=mohamed&password=hkm4c', autoRedirect: false, cache: false, cookies: true } },
  { name: 'Chunked response', description: 'Display every chunk and the 22-byte course total.', options: { method: 'GET', url: 'http://127.0.0.1:8080/chunked', version: 'HTTP/1.1', autoRedirect: false, cache: false, cookies: false } },
  { name: 'Form POST + Referer', description: 'Send a form body with the course Referer header.', options: { method: 'POST', url: 'http://127.0.0.1:8080/login.cgi', version: 'HTTP/1.1', headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }, { name: 'Referer', value: 'http://127.0.0.1:8080/' }], body: 'username=mohamed&password=hkm4c', autoRedirect: false, cache: false, cookies: true } },
  { name: 'Keep-alive vs close', description: 'Toggle the Connection header and compare the connection timeline.', options: { method: 'GET', url: 'http://127.0.0.1:8080/', version: 'HTTP/1.1', headers: [{ name: 'Connection', value: 'close' }], autoRedirect: false, cache: false, cookies: false } },
  { name: 'Range → 206', description: 'Request a byte range from a static file.', options: { method: 'GET', url: 'http://127.0.0.1:8080/static/course.txt', version: 'HTTP/1.1', headers: [{ name: 'Range', value: 'bytes=0-9' }], autoRedirect: false, cache: false, cookies: false } },
  { name: 'TRACE echo', description: 'Ask the server to return the exact request it received.', options: { method: 'TRACE', url: 'http://127.0.0.1:8080/', version: 'HTTP/1.1', autoRedirect: false, cache: false, cookies: false } },
  { name: 'CONNECT tunnel', description: 'Open the allow-listed proxy tunnel to the echo service.', options: { method: 'CONNECT', url: 'http://127.0.0.1:9001', version: 'HTTP/1.1', proxy: { host: '127.0.0.1', port: 8888, enabled: true }, autoRedirect: false, cache: false, cookies: false } },
];

function decode(value?: WireBuffer): Uint8Array {
  if (!value) return new Uint8Array();
  const binary = atob(value.base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodePrefix(value?: WireBuffer, maxBytes = MAX_RENDERED_WIRE_BYTES): Uint8Array {
  if (!value || value.truncated) return new Uint8Array();
  const binary = atob(value.base64).slice(0, maxBytes);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function text(value?: WireBuffer): string {
  if (value?.truncated) return `[${value.length.toLocaleString()} bytes omitted from the renderer]`;
  return new TextDecoder('latin1').decode(decode(value));
}

function textPreview(value?: WireBuffer, maxBytes = MAX_RENDERED_WIRE_BYTES): { text: string; truncated: boolean } {
  if (!value) return { text: '', truncated: false };
  if (value.truncated) return { text: `[${value.length.toLocaleString()} bytes omitted from the renderer]`, truncated: true };
  const binary = atob(value.base64);
  const limited = binary.length > maxBytes ? binary.slice(0, maxBytes) : binary;
  return { text: new TextDecoder('latin1').decode(Uint8Array.from(limited, (char) => char.charCodeAt(0))), truncated: binary.length > maxBytes };
}

function visible(value: string): string {
  return value.replace(/\r/g, '␍').replace(/\n/g, '␊\n');
}

function headerValue(headers: Header[] | undefined, name: string): string | undefined {
  return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function cachedRepresentation(exchange?: WireExchange): WireResponse | undefined {
  if (!exchange?.response) return undefined;
  return exchange.response.statusCode === 304 ? exchange.cacheResponse ?? exchange.response : exchange.response;
}

function inlineFetchedImages(html: string, pageUrl: string, sources: string[], images: WireExchange[]): string {
  const previews = new Map<string, string>();
  sources.forEach((source, index) => {
    const response = cachedRepresentation(images[index]);
    const contentType = headerValue(response?.headers, 'Content-Type') ?? '';
    const body = response?.decodedBody;
    if (!response || response.statusCode < 200 || response.statusCode >= 300 || !contentType.toLowerCase().startsWith('image/') || !body?.base64 || body.truncated) return;
    try {
      previews.set(new URL(source, pageUrl).toString(), `data:${contentType};base64,${body.base64}`);
    } catch {
      // Keep an invalid image source unchanged in the teaching preview.
    }
  });
  return html.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (match: string, prefix: string, quote: string, source: string) => {
    try {
      const dataUrl = previews.get(new URL(source, pageUrl).toString());
      return dataUrl ? `${prefix}${quote}${dataUrl}${quote}` : match;
    } catch {
      return match;
    }
  });
}

function jsonBody(response?: WireResponse): string {
  const raw = textPreview(response?.decodedBody).text;
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function hexDump(bytes: Uint8Array, totalLength = bytes.length): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const part = bytes.slice(offset, offset + 16);
    const hex = [...part].map((value) => value.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = [...part].map((value) => value >= 32 && value < 127 ? String.fromCharCode(value) : '.').join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  if (totalLength > bytes.length) lines.push(`… hex preview truncated; ${totalLength.toLocaleString()} bytes total`);
  return lines.join('\n');
}

function logText(log: unknown): string {
  const value = typeof log === 'string' ? log : JSON.stringify(log, null, 0);
  return value.length > MAX_RENDERED_LOG_CHARS ? `${value.slice(0, MAX_RENDERED_LOG_CHARS)}\n… log preview truncated` : value;
}

function classNameFor(code: number): string {
  return `${Math.floor(code / 100)}xx`;
}

function ScenarioMenu({ onSelect }: { onSelect: (scenario: Scenario) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return <div className="scenario-menu">
    <button className="secondary" onClick={() => setOpen(!open)}>Scenarios ▾</button>
    {open && <div className="scenario-popover">{scenarios.map((scenario) => <button key={scenario.name} className="scenario-option" onClick={() => { onSelect(scenario); setOpen(false); }}><strong>{scenario.name}</strong><span>{scenario.description}</span></button>)}</div>}
  </div>;
}

function HeaderEditor({ headers, setHeaders }: { headers: EditableHeader[]; setHeaders: (headers: EditableHeader[] | ((current: EditableHeader[]) => EditableHeader[])) => void }): JSX.Element {
  const activeCount = headers.filter((header) => header.enabled && header.name.trim()).length;
  const update = (index: number, patch: Partial<EditableHeader>) => setHeaders(headers.map((header, current) => current === index ? { ...header, ...patch } : header));
  return <div className="headers-editor">
    <div className="header-editor-heading"><span>Headers</span><span className="muted">{activeCount} active · sent in order</span></div>
    <div className="table-head"><span>On</span><span>Name</span><span>Value</span><span /></div>
    {headers.map((header, index) => <div className="header-row" key={index}>
      <input type="checkbox" checked={header.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} aria-label={`Enable ${header.name || 'header'}`} />
      <input list="course-request-headers" value={header.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="Header-Name" aria-label="Header name" />
      <input value={header.value} onChange={(event) => update(index, { value: event.target.value })} placeholder="value" aria-label="Header value" />
      <button type="button" className="icon-button" onClick={() => setHeaders(headers.filter((_item, current) => current !== index))} aria-label={`Remove ${header.name || 'header'}`}>×</button>
    </div>)}
    <button type="button" className="small-button" onClick={() => setHeaders([...headers, { name: '', value: '', enabled: true }])}>+ Add header</button>
    <datalist id="course-request-headers">{Object.keys(REQUEST_HEADER_REFERENCE).map((name) => <option key={name} value={name}>{REQUEST_HEADER_REFERENCE[name]}</option>)}</datalist>
  </div>;
}

function toEditableHeaders(input?: Header[] | Record<string, string>): EditableHeader[] {
  if (!input) return [];
  const values = Array.isArray(input) ? input : Object.entries(input).map(([name, value]) => ({ name, value }));
  return values.map((header) => ({ ...header, enabled: true }));
}

function defaultFileType(name: string, browserType: string): string {
  if (browserType) return browserType;
  const extension = name.toLowerCase().split('.').pop();
  const types: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' };
  return types[extension ?? ''] ?? 'application/octet-stream';
}

function RequestBodyEditor({
  body,
  bodyMode,
  uploadFile,
  uploadPreviewUrl,
  fileInputRef,
  setBody,
  setBodyMode,
  chooseUpload,
  clearUpload,
}: {
  body: string;
  bodyMode: BodyMode;
  uploadFile?: UploadFile;
  uploadPreviewUrl?: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  setBody: (value: string) => void;
  setBodyMode: (value: BodyMode) => void;
  chooseUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  clearUpload: () => void;
}): JSX.Element {
  return <div className="body-editor-wrap">
    <div className="body-toolbar"><div><span>Body</span><span className="muted body-hint">{bodyMode === 'binary' ? 'raw bytes' : 'editable text'}</span></div><select value={bodyMode} onChange={(event) => setBodyMode(event.target.value as BodyMode)}><option value="raw">raw</option><option value="form">form-urlencoded</option><option value="json">JSON</option><option value="binary">binary / image</option></select></div>
    {bodyMode === 'binary' ? <div className="binary-picker">
      <input ref={fileInputRef} className="file-input" type="file" accept="image/*,.bin,.dat" onChange={(event) => void chooseUpload(event)} />
      {uploadFile ? <div className="selected-file"><div className="file-meta"><strong>{uploadFile.name}</strong><span>{uploadFile.type} · {uploadFile.size.toLocaleString()} bytes</span></div><button type="button" className="small-button" onClick={clearUpload}>remove</button></div> : <p className="empty">Choose an image or binary file. Its bytes will be sent unchanged.</p>}
      {uploadFile?.type.startsWith('image/') && uploadPreviewUrl && <img className="upload-preview" src={uploadPreviewUrl} alt={`Preview of ${uploadFile.name}`} />}
    </div> : <textarea className="body-editor" value={body} onChange={(event) => setBody(event.target.value)} placeholder={bodyMode === 'json' ? '{"title":"…"}' : bodyMode === 'form' ? 'key=value&other=value' : 'Request body bytes…'} />}
  </div>;
}

export default function App(): JSX.Element {
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [url, setUrl] = useState('http://127.0.0.1:8080/');
  const [version, setVersion] = useState<HttpVersion>('HTTP/1.1');
  const [headers, setHeaders] = useState<EditableHeader[]>([{ name: 'Accept', value: '*/*', enabled: true }, { name: 'Accept-Encoding', value: 'gzip, identity', enabled: true }]);
  const [body, setBody] = useState('');
  const [bodyMode, setBodyMode] = useState<BodyMode>('raw');
  const [uploadFile, setUploadFile] = useState<UploadFile>();
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cache, setCache] = useState(false);
  const [cacheMode, setCacheMode] = useState<CacheMode>('default');
  const [cookies, setCookies] = useState(false);
  const [redirects, setRedirects] = useState(false);
  const [proxy, setProxy] = useState(false);
  const [proxyHost, setProxyHost] = useState('127.0.0.1');
  const [proxyPort, setProxyPort] = useState('8888');
  const [proxyUsername, setProxyUsername] = useState('proxy');
  const [proxyPassword, setProxyPassword] = useState('proxy');
  const [auth, setAuth] = useState(false);
  const [credentials, setCredentials] = useState({ username: 'mohamed', password: 'hkm4c' });
  const [activeTab, setActiveTab] = useState('response');
  const [exchange, setExchange] = useState<WireExchange | undefined>();
  const [history, setHistory] = useState<WireExchange[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [serverLogs, setServerLogs] = useState<any[]>([]);
  const [state, setState] = useState<any>({ connections: [], cookies: [], cache: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dnsName, setDnsName] = useState('localhost');
  const [dnsRecords, setDnsRecords] = useState<any[]>([]);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [tunnel, setTunnel] = useState<{ id: string; connectionId: string; statusCode: number; reason: string }>();
  const [tunnelInput, setTunnelInput] = useState('hello from HTTP Lab\n');
  const [tunnelOutput, setTunnelOutput] = useState('');
  const [pageComparison, setPageComparison] = useState<{ http10: { objects: number; tcpConnections: number }; http11: { objects: number; tcpConnections: number } }>();
  const [pageSequence, setPageSequence] = useState<any[]>([]);
  const [pagePreviewHtml, setPagePreviewHtml] = useState<string>();
  const [loadImages, setLoadImages] = useState(false);

  useEffect(() => {
    const unsubscribeEvent = window.httpLab.subscribe('lab:event', (event: any) => setTimeline((items) => [...items.slice(-199), event]));
    const unsubscribeLog = window.httpLab.subscribe('lab:server-log', (log: any) => setServerLogs((items) => [...items.slice(-199), log]));
    const unsubscribeTunnel = window.httpLab.subscribe('lab:tunnel-data', (payload: any) => {
      if (payload?.id !== tunnel?.id) return;
      const binary = atob(payload.base64);
      setTunnelOutput((value) => `${value}${new TextDecoder('latin1').decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))}`);
    });
    void refreshState();
    return () => { unsubscribeEvent(); unsubscribeLog(); unsubscribeTunnel(); };
  }, [tunnel?.id]);

  useEffect(() => {
    if (!uploadFile) {
      setUploadPreviewUrl(undefined);
      return;
    }
    const previewUrl = URL.createObjectURL(uploadFile.file);
    setUploadPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [uploadFile]);

  const refreshState = async () => setState(await window.httpLab.state());
  const clearUpload = () => {
    setUploadFile(undefined);
    setBodyMode('raw');
    setBody('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const chooseUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      const type = defaultFileType(file.name, file.type);
      setUploadFile({ file, bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, type, size: file.size });
      setBodyMode('binary');
      setBody('');
      setHeaders((items) => {
        const contentTypeIndex = items.findIndex((item) => item.name.toLowerCase() === 'content-type');
        if (contentTypeIndex < 0) return [...items, { name: 'Content-Type', value: type, enabled: true }];
        return items.map((item, index) => index === contentTypeIndex ? { ...item, value: type, enabled: true } : item);
      });
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const selectScenario = (scenario: Scenario) => {
    const options = scenario.options;
    setMethod(options.method);
    setUrl(options.url);
    setVersion(options.version);
    setHeaders(toEditableHeaders(options.headers));
    clearUpload();
    setPageSequence([]);
    setPagePreviewHtml(undefined);
    setLoadImages(Boolean(options.loadImages));
    setBody(options.body ?? '');
    setBodyMode(options.bodyMode ?? (headerValue(options.headers, 'Content-Type')?.includes('json') ? 'json' : headerValue(options.headers, 'Content-Type')?.includes('form') ? 'form' : 'raw'));
    setCache(Boolean(options.cache));
    setCacheMode(options.cacheMode ?? 'default');
    setCookies(Boolean(options.cookies));
    setRedirects(Boolean(options.autoRedirect));
    setProxy(Boolean(options.proxy));
    if (options.proxy) {
      setProxyHost(options.proxy.host ?? '127.0.0.1');
      setProxyPort(String(options.proxy.port ?? 8888));
      setProxyUsername(options.proxy.credentials?.username ?? 'proxy');
      setProxyPassword(options.proxy.credentials?.password ?? 'proxy');
    }
    setAuth(Boolean(options.auth));
    if (options.auth) setCredentials(options.auth);
  };

  const requestOptions = useMemo(() => {
    const outgoingHeaders: Header[] = headers
      .filter((header) => header.enabled && header.name.trim())
      .map(({ enabled: _enabled, ...header }) => header);
    const hasContentTypeRow = outgoingHeaders.some((header) => header.name.trim().toLowerCase() === 'content-type');
    const inferredContentType = bodyMode === 'json' ? 'application/json' : bodyMode === 'form' ? 'application/x-www-form-urlencoded' : undefined;
    if (inferredContentType && !hasContentTypeRow) outgoingHeaders.push({ name: 'Content-Type', value: inferredContentType });
    let outgoingBody: string | Uint8Array | undefined = bodyMode === 'binary' ? uploadFile?.bytes : body || undefined;
    if (bodyMode === 'json' && body) {
      try { outgoingBody = JSON.stringify(JSON.parse(body)); } catch { outgoingBody = body; }
    }
    return {
    cache, cacheMode, cookies, autoRedirect: redirects, maxRedirects: 5,
    method, url, version, headers: outgoingHeaders, body: outgoingBody,
    proxy: proxy ? { host: proxyHost, port: Number(proxyPort) || 8888, enabled: true, credentials: proxyUsername && proxyPassword ? { username: proxyUsername, password: proxyPassword } : undefined } : undefined,
    auth: auth ? credentials : undefined,
    };
  }, [method, url, version, headers, body, bodyMode, uploadFile, cache, cacheMode, cookies, redirects, proxy, proxyHost, proxyPort, proxyUsername, proxyPassword, auth, credentials]);

  const loadImageObjects = async (page: WireExchange, pageUrl: string, loadVersionValue: HttpVersion) => {
    const html = text(cachedRepresentation(page)?.decodedBody);
    const imageSources = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((match) => match[1]);
    const images = await Promise.all(imageSources.map((source) => window.httpLab.request({ ...requestOptions, method: 'GET', version: loadVersionValue, url: new URL(source, pageUrl).toString(), body: undefined, autoRedirect: true }) as Promise<WireExchange>));
    return { images, previewHtml: inlineFetchedImages(html, pageUrl, imageSources, images), objects: imageSources.length + 1 };
  };

  const send = async () => {
    setBusy(true); setError(''); setTimeline([]); setPageSequence([]); setPagePreviewHtml(undefined);
    try {
      if (method === 'CONNECT') {
        const opened = await window.httpLab.openTunnel(requestOptions);
        setTunnel(opened);
        setActiveTab('timeline');
        return;
      }
      const result = await window.httpLab.request(requestOptions) as WireExchange;
      const pageObjects = loadImages && headerValue(result.response?.headers, 'Content-Type')?.toLowerCase().includes('text/html') ? await loadImageObjects(result, url, version) : undefined;
      setExchange(result); setHistory((items) => [result, ...items.filter((item) => item.id !== result.id)].slice(0, 30));
      if (pageObjects) {
        setPageSequence([result, ...pageObjects.images].flatMap((item) => item.timeline ?? []));
        setPagePreviewHtml(pageObjects.previewHtml);
      }
      await refreshState();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const loadPage = async () => {
    setBusy(true); setError(''); setTimeline([]); setPageSequence([]); setPagePreviewHtml(undefined);
    try {
      const before = await window.httpLab.state() as any;
      const loadVersion = async (loadVersionValue: HttpVersion) => {
        const page = await window.httpLab.request({ ...requestOptions, method: 'GET', version: loadVersionValue, url, body: undefined, autoRedirect: true }) as WireExchange;
        const pageObjects = await loadImageObjects(page, url, loadVersionValue);
        return { page, ...pageObjects };
      };
      const [http10, http11] = await Promise.all([loadVersion('HTTP/1.0'), loadVersion('HTTP/1.1')]);
      setExchange(http11.page); setHistory((items) => [http11.page, http10.page, ...items].slice(0, 30));
      setPageSequence([http11.page, ...http11.images].flatMap((item) => item.timeline ?? []));
      setPagePreviewHtml(http11.previewHtml);
      const after = await window.httpLab.state() as any;
      const oldEventIds = new Set((before.events ?? []).map((item: any) => item.payload?.id));
      const newTcpEvents = (after.events ?? []).filter((item: any) => item.channel === 'lab:event' && item.payload?.type === 'tcp-connect' && !oldEventIds.has(item.payload?.id));
      const newTcp = [...new Map(newTcpEvents.map((item: any) => [item.payload?.connectionId, item])).values()];
      setPageComparison({
        http10: { objects: http10.objects, tcpConnections: newTcp.filter((item: any) => item.payload?.details?.version === 'HTTP/1.0').length },
        http11: { objects: http11.objects, tcpConnections: newTcp.filter((item: any) => item.payload?.details?.version === 'HTTP/1.1').length },
      });
      await refreshState();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const lookupDns = async () => { setDnsRecords(await window.httpLab.dns(dnsName) as any[]); };
  const loadRequestWire = async (id: string) => await window.httpLab.requestWire(id) as WireRequest;
  const loadExchangeWire = async (id: string) => await window.httpLab.exchangeWire(id) as WireExchange;
  const replay = async (item: WireExchange) => {
    setBusy(true);
    try {
      const request = item.request.largeBody ? await loadRequestWire(item.id) : item.request;
      const [replayMethod, replayTarget, replayVersion] = request.requestLine.split(' ');
      const replayHost = headerValue(request.headers, 'Host') ?? '127.0.0.1:8080';
      const replayUrl = replayTarget.startsWith('http://') || replayTarget.startsWith('https://') ? replayTarget : `http://${replayHost}${replayTarget}`;
      const replayBody = decode(request.body);
      const result = await window.httpLab.request({ method: replayMethod as HttpMethod, url: replayUrl, version: replayVersion as HttpVersion, headers: request.headers, body: replayBody.length ? replayBody : undefined, autoRedirect: false, cache: false, cookies: false }) as WireExchange;
      setExchange(result);
      setTimeline(result.timeline ?? []);
      setPageSequence([]);
      setPagePreviewHtml(undefined);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const response = exchange?.response;
  const contentType = headerValue(response?.headers, 'Content-Type') ?? '';
  const bodyRepresentation = cachedRepresentation(exchange);
  const bodyText = bodyRepresentation && (/^text\//i.test(contentType) || /json|javascript|xml/i.test(contentType)) ? textPreview(bodyRepresentation.decodedBody).text : '';
  const matchesReference = (value: string) => value.toLowerCase().includes(referenceQuery.trim().toLowerCase());

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">↔</span><div><strong>HTTP Lab</strong><small>Chapitre II · Protocol microscope</small></div></div><div className="service-state"><span className="live-dot" /> origin 8080 · proxy 8888 · echo 9001</div><ScenarioMenu onSelect={selectScenario} /></header>
    <section className="request-bar panel">
      <select value={method} onChange={(event) => setMethod(event.target.value as HttpMethod)}>{METHODS.map((item) => <option key={item} value={item}>{item}</option>)}</select>
      <input className="url-input" value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void send(); }} />
      <select value={version} onChange={(event) => setVersion(event.target.value as HttpVersion)}><option>HTTP/1.0</option><option>HTTP/1.1</option></select>
      <button className="primary" disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send ↵'}</button>
      <button className="secondary" disabled={busy} onClick={() => void loadPage()}>{loadImages ? 'Load page + images' : 'Load page'}</button>
    </section>
    <div className="method-note"><span className="method-pill">{method}</span><span>{METHOD_REFERENCE[method]?.description}</span></div>
    <section className="workspace">
      <aside className="left-column">
        <section className="panel request-panel"><div className="panel-title"><span>Request</span><span className="muted">editable wire intent</span></div><HeaderEditor headers={headers} setHeaders={setHeaders} /><RequestBodyEditor body={body} bodyMode={bodyMode} uploadFile={uploadFile} uploadPreviewUrl={uploadPreviewUrl} fileInputRef={fileInputRef} setBody={setBody} setBodyMode={setBodyMode} chooseUpload={chooseUpload} clearUpload={clearUpload} /><div className="toggles">{[['cache', cache, setCache, 'cache'], ['cookies', cookies, setCookies, 'cookies'], ['redirects', redirects, setRedirects, 'redirects'], ['proxy', proxy, setProxy, 'proxy'], ['auth', auth, setAuth, 'auth helper']].map(([key, value, setter, label]) => <label key={key as string}><input type="checkbox" checked={value as boolean} onChange={(event) => (setter as (value: boolean) => void)(event.target.checked)} /> {label as string}</label>)}</div>{proxy && <div className="proxy-settings"><span className="muted">proxy endpoint</span><input value={proxyHost} onChange={(event) => setProxyHost(event.target.value)} placeholder="host" /><input value={proxyPort} onChange={(event) => setProxyPort(event.target.value)} placeholder="port" /><input value={proxyUsername} onChange={(event) => setProxyUsername(event.target.value)} placeholder="proxy user (optional)" /><input type="password" value={proxyPassword} onChange={(event) => setProxyPassword(event.target.value)} placeholder="proxy password (optional)" /></div>}{auth && <div className="credential-row"><input value={credentials.username} onChange={(event) => setCredentials({ ...credentials, username: event.target.value })} placeholder="username" /><input type="password" value={credentials.password} onChange={(event) => setCredentials({ ...credentials, password: event.target.value })} placeholder="password" /><code>Authorization: Basic {btoa(`${credentials.username}:${credentials.password}`)} · Base64 is not encryption</code></div>}</section>
        <section className="panel side-panel"><div className="panel-title">Connections</div>{state.connections?.length ? state.connections.map((connection: any) => <div className="connection-card" key={connection.id}><span className={connection.open ? 'status-dot' : 'status-dot closed'} /> <code>{connection.id}</code><span>{connection.host}:{connection.port}</span><small>{connection.requestCount} requests · {connection.reuseCount} reuse</small></div>) : <p className="empty">No sockets yet. Send a request to watch them appear.</p>}</section>
        <section className="panel side-panel"><div className="panel-title">Cookie jar <span className="muted">{state.cookies?.length ?? 0}</span></div>{state.cookies?.map((cookie: any) => <div className="cookie-card" key={`${cookie.domain}-${cookie.path}-${cookie.name}`}><code>{cookie.name}={cookie.value}</code><small>{cookie.domain}{cookie.path}</small><button className="icon-button" onClick={() => void window.httpLab.deleteCookie(cookie.name, cookie.domain, cookie.path).then(refreshState)}>×</button></div>)}</section>
      </aside>
      <section className="center-column">
        <div className="tabs">{['request', 'response', 'timeline', 'sequence'].map((tab) => <button className={activeTab === tab ? 'active' : ''} key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>)}</div>
        {error && <div className="error-banner">{error}</div>}
        {pageComparison && <section className="panel comparison-panel"><div className="panel-title">Load page · connection comparison</div><div className="comparison-grid"><div><strong>HTTP/1.0</strong><span>{pageComparison.http10.objects} objects · {pageComparison.http10.tcpConnections} TCP connections</span><small>new connection per object</small></div><div><strong>HTTP/1.1</strong><span>{pageComparison.http11.objects} objects · {pageComparison.http11.tcpConnections} TCP connections</span><small>persistent connection reuse</small></div></div></section>}
        {tunnel && <section className="panel tunnel-panel"><div className="panel-title"><span>CONNECT tunnel</span><span className="muted">{tunnel.connectionId} · {tunnel.statusCode} {tunnel.reason}</span></div><div className="tunnel-layout"><div><textarea value={tunnelInput} onChange={(event) => setTunnelInput(event.target.value)} /><button className="primary" onClick={() => void window.httpLab.sendTunnel(tunnel.id, tunnelInput)}>send bytes</button><button className="secondary" onClick={() => void window.httpLab.closeTunnel(tunnel.id).then(() => setTunnel(undefined))}>close</button></div><pre>{tunnelOutput || 'Echoed bytes will appear here…'}</pre></div></section>}
        {activeTab === 'request' && <RequestView exchange={exchange} loadWire={loadRequestWire} />}
        {activeTab === 'response' && <ResponseView exchange={exchange} contentType={contentType} bodyText={bodyText} htmlPreview={pagePreviewHtml} loadWire={loadExchangeWire} />}
        {activeTab === 'timeline' && <TimelineView events={timeline.length ? timeline : exchange?.timeline ?? []} />}
        {activeTab === 'sequence' && <SequenceView events={pageSequence.length ? pageSequence : timeline.length ? timeline : exchange?.timeline ?? []} />}
      </section>
      <aside className="right-column">
        <section className="panel side-panel"><div className="panel-title">Cache <button className="small-button" onClick={() => void window.httpLab.clearCache().then(refreshState)}>clear</button></div>{state.cache?.length ? state.cache.map((entry: any) => <div className="cache-card" key={entry.key}><code>{entry.url}</code><small>{entry.etag ?? 'no ETag'} · {entry.fresh ? `${Math.max(0, Math.round((entry.remainingMs ?? 0) / 1000))}s fresh` : 'stale'}</small></div>) : <p className="empty">Cache is empty.</p>}</section>
        <section className="panel side-panel"><div className="panel-title">History</div>{history.map((item) => <button className="history-row" key={item.id} onClick={() => void replay(item)}><span>{item.request.requestLine}</span><small>{item.response?.statusCode ?? 'error'} · click to replay</small></button>)}</section>
        <section className="panel side-panel"><div className="panel-title">DNS</div><div className="dns-form"><input value={dnsName} onChange={(event) => setDnsName(event.target.value)} /><button className="small-button" onClick={() => void lookupDns()}>lookup</button></div>{dnsRecords.length ? <div className="dns-table"><div>name | class | TTL | type | data</div>{dnsRecords.map((record) => <div key={`${record.type}-${record.data}`}>{record.name} | IN | {record.ttl ?? '—'} | {record.type} | {record.data}</div>)}</div> : <p className="empty">Offline or no records. Try localhost.</p>}</section>
        <section className="panel side-panel logs"><div className="panel-title">Server log</div>{serverLogs.slice(-20).reverse().map((log, index) => <pre key={index}>{logText(log)}</pre>)}</section>
      </aside>
    </section>
    <section className="reference panel"><div className="panel-title"><span>Course reference</span><input className="reference-search" value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} placeholder="search methods, headers, statuses…" /></div><div className="reference-grid"><div><h3>Methods</h3>{Object.values(METHOD_REFERENCE).filter((item) => matchesReference(`${item.name} ${item.description}`)).map((item) => <div className="reference-row" key={item.name}><code>{item.name}</code><span>{item.description}</span></div>)}</div><div><h3>Statuses</h3>{STATUS_REFERENCE.filter((item) => matchesReference(`${item.code} ${item.name} ${item.meaning}`)).map((item) => <div className="reference-row" key={item.code}><code>{item.code}</code><span>{item.name}: {item.meaning}</span></div>)}</div><div><h3>Headers</h3>{Object.entries({ ...REQUEST_HEADER_REFERENCE, ...RESPONSE_HEADER_REFERENCE }).filter(([name, explanation]) => matchesReference(`${name} ${explanation}`)).map(([name, explanation]) => <div className="reference-row" key={name}><code>{name}</code><span>{explanation}</span></div>)}</div></div></section>
  </main>;
}

function RequestView({ exchange, loadWire }: { exchange?: WireExchange; loadWire: (id: string) => Promise<WireRequest> }): JSX.Element {
  const [loadedRaw, setLoadedRaw] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => { setLoadedRaw(undefined); setLoading(false); }, [exchange?.id]);
  const raw = loadedRaw ?? exchange?.request.raw ?? '';
  const separator = raw.indexOf('\r\n\r\n');
  const head = separator >= 0 ? raw.slice(0, separator + 4) : raw;
  const body = separator >= 0 ? raw.slice(separator + 4) : '';
  const loadFullWire = async () => {
    if (!exchange) return;
    setLoading(true);
    try {
      const request = await loadWire(exchange.id);
      setLoadedRaw(request.raw);
    } catch {
      setLoadedRaw('[The full request wire is no longer available]');
    } finally {
      setLoading(false);
    }
  };
  return <div className="view-stack"><section className="panel"><div className="panel-title">Request as sent</div>{exchange ? <>
    <div className="request-line"><span className="token-method">{exchange.request.requestLine.split(' ')[0]}</span><span className="token-url">{exchange.request.requestLine.split(' ')[1]}</span><span className="token-version">{exchange.request.requestLine.split(' ')[2]}</span></div>
    {exchange.request.largeBody && !loadedRaw && <div className="large-wire-note"><span>{exchange.request.body.length.toLocaleString()} body bytes are kept out of the automatic UI transfer.</span><button className="small-button" disabled={loading} onClick={() => void loadFullWire()}>{loading ? 'Loading…' : 'Load full request wire'}</button></div>}
    <pre className="wire">{visible(head)}<span className="blank-marker">↵ blank line</span>{visible(body)}</pre>
  </> : <p className="empty">Send a request to inspect the exact request bytes.</p>}</section></div>;
}

function ResponseView({ exchange, contentType, bodyText, htmlPreview, loadWire }: { exchange?: WireExchange; contentType: string; bodyText: string; htmlPreview?: string; loadWire: (id: string) => Promise<WireExchange> }): JSX.Element {
  const [loadedResponse, setLoadedResponse] = useState<WireResponse>();
  const [loading, setLoading] = useState(false);
  useEffect(() => { setLoadedResponse(undefined); setLoading(false); }, [exchange?.id]);
  const response = loadedResponse ?? exchange?.response;
  const cachedResponse = exchange?.cacheResponse;
  const representation = response?.statusCode === 304 ? cachedResponse ?? response : response;
  const [bodyTab, setBodyTab] = useState('rendered');
  const status = response ? statusMeaning(response.statusCode) : undefined;
  const image = contentType.startsWith('image/');
  const renderedImage = image && Boolean(representation?.decodedBody.base64) && !representation?.decodedBody.truncated;
  const rawPreview = textPreview(response?.raw);
  const bodyPreview = textPreview(response?.body);
  const loadFullResponse = async () => {
    if (!exchange) return;
    setLoading(true);
    try {
      const fullExchange = await loadWire(exchange.id);
      setLoadedResponse(fullExchange.response);
    } finally {
      setLoading(false);
    }
  };
  return <div className="view-stack">
    <section className="panel">{response ? <>
      <div className="status-line"><span>{response.version}</span><strong>{response.statusCode}</strong><span>{response.reason}</span><em className={`status-badge status-${classNameFor(response.statusCode)}`}>{classNameFor(response.statusCode)}</em></div>
      <p className="status-explanation">{status?.meaning}</p>
      {cachedResponse && <p className="status-explanation">304 received on the wire; the cached representation is shown below.</p>}
      <div className="section-label">Response headers</div>
      <div className="headers-table">{response.headers.map((header, index) => <div className="response-header" key={`${index}-${header.name}`} title={RESPONSE_HEADER_REFERENCE[header.name] ?? REQUEST_HEADER_REFERENCE[header.name] ?? 'HTTP header'}><code>{header.name}</code><span>{header.value}</span></div>)}</div>
    </> : <p className="empty">No response yet.</p>}</section>
    {response && <section className="panel body-panel"><div className="body-tabs">{['rendered', 'raw', 'hex', 'chunks'].map((tab) => <button className={bodyTab === tab ? 'active' : ''} key={tab} onClick={() => setBodyTab(tab)}>{tab}</button>)}</div>
      {response.largeBody && !loadedResponse && <div className="large-wire-note"><span>Large response wire is summarized to keep the renderer responsive.</span><button className="small-button" disabled={loading} onClick={() => void loadFullResponse()}>{loading ? 'Loading…' : 'Load full response wire'}</button></div>}
      {bodyTab === 'rendered' && (image ? renderedImage ? <img className="image-preview" src={`data:${contentType};base64,${representation?.decodedBody.base64}`} /> : <p className="empty">This image is too large to render in the UI ({(representation?.decodedBody.length ?? 0).toLocaleString()} bytes).</p> : contentType.includes('text/html') ? <iframe className="render-frame" sandbox="" srcDoc={htmlPreview ?? textPreview(representation?.decodedBody).text} title="Sandboxed response preview" /> : <pre className="body-output">{contentType.includes('json') ? jsonBody(representation) : bodyText}</pre>)}
      {bodyTab === 'raw' && <pre className="body-output">{visible(bodyPreview.text)}{bodyPreview.truncated ? '\n… raw body preview truncated' : ''}</pre>}
      {bodyTab === 'hex' && <pre className="body-output">{hexDump(decodePrefix(response.body), response.body.length)}</pre>}
      {bodyTab === 'chunks' && <div className="chunk-view"><div className="chunk-summary">{response.chunks.length} chunks · decoded total <strong>{response.chunks.reduce((sum, chunk) => sum + chunk.sizeDecimal, 0)} bytes</strong> · course example expects 10h + 6h = 22</div>{response.chunks.map((chunk, index) => <div className="chunk-row" key={index}><code>{chunk.sizeHex}</code><span>{chunk.sizeDecimal}</span><pre>{text(chunk.data)}</pre><small>{chunk.extension ?? ''}</small></div>)}{response.trailers.length > 0 && <div className="trailers">Trailers: {response.trailers.map((header) => `${header.name}: ${header.value}`).join(' · ')}</div>}</div>}
    </section>}
    {response && <section className="panel"><div className="panel-title">Raw response wire</div><pre className="wire">{visible(rawPreview.text)}{rawPreview.truncated ? '\n… raw response wire preview truncated' : ''}</pre><div className="compression-note">compressed {response.compressedBody.length} B · decoded {response.decodedBody.length} B</div></section>}
  </div>;
}

function TimelineView({ events }: { events: any[] }): JSX.Element {
  return <div className="view-stack"><section className="panel timeline">{events.length ? events.map((event, index) => <div className="timeline-row" key={event.id ?? index}><span className="timeline-time">+{event.elapsedMs ?? 0} ms</span><span className={`timeline-dot event-${event.type}`} /><div><strong>{event.type}</strong><p>{event.message}</p>{event.connectionId && <code>{event.connectionId}</code>}</div></div>) : <p className="empty">The exchange timeline will appear here.</p>}</section></div>;
}

function SequenceView({ events }: { events: any[] }): JSX.Element {
  const rows = events.length ? events : [{ type: 'tcp-connect', message: 'Etablissement TCP' }, { type: 'request-sent', message: 'GET / HTTP/1.1' }, { type: 'headers-received', message: 'HTTP/1.1 200 OK' }, { type: 'body-complete', message: 'Data' }, { type: 'connection-closed', message: 'Liberation TCP' }];
  return <div className="view-stack"><section className="panel sequence"><div className="sequence-head"><span>client</span><span>proxy</span><span>server</span></div>{rows.map((event, index) => <div className="sequence-row" key={index}><span className="sequence-label">{event.message}</span><span className="sequence-arrow">{event.type.includes('request') ? 'client ───────────────▶ server' : event.type.includes('headers') || event.type.includes('body') ? 'client ◀─────────────── server' : event.type.includes('proxy') ? 'client ─────▶ proxy ─────▶ server' : event.type}</span></div>)}</section></div>;
}
