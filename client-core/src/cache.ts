import type { CacheEntry, CacheLookup, Header, ParsedResponse } from './types.js';
import { getHeader } from './serializer.js';

function parseMaxAge(cacheControl: string | undefined): number | undefined {
  const match = cacheControl?.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function expiryFromHeaders(headers: Header[], now: number): number | undefined {
  const maxAge = parseMaxAge(getHeader(headers, 'Cache-Control'));
  if (maxAge !== undefined) return now + maxAge * 1000;
  const expires = getHeader(headers, 'Expires');
  if (expires) {
    const parsed = Date.parse(expires);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function mergeHeaders(base: Header[], updates: Header[]): Header[] {
  const headers = base.map((header) => ({ ...header }));
  for (const header of updates) {
    const existing = headers.find((candidate) => candidate.name.toLowerCase() === header.name.toLowerCase());
    if (existing) existing.value = header.value;
    else headers.push({ ...header });
  }
  return headers;
}

export class HttpCache {
  private entries = new Map<string, CacheEntry>();

  lookup(url: string, method = 'GET', now = Date.now()): CacheLookup {
    const entry = this.entries.get(this.key(url, method));
    if (!entry) return { state: 'miss' };
    if (entry.expiresAt !== undefined && entry.expiresAt > now) {
      return { state: 'fresh', entry, remainingMs: entry.expiresAt - now };
    }
    return { state: 'stale', entry, remainingMs: entry.expiresAt === undefined ? undefined : entry.expiresAt - now };
  }

  store(url: string, method: string, response: ParsedResponse, now = Date.now(), requestHeaders: Header[] = []): CacheEntry | undefined {
    if (method.toUpperCase() !== 'GET' || response.statusCode !== 200) return undefined;
    const cacheControl = getHeader(response.headers, 'Cache-Control') ?? '';
    if (/\bno-store\b/i.test(cacheControl) || /\bprivate\b/i.test(cacheControl)) return undefined;
    if (getHeader(requestHeaders, 'Authorization') || getHeader(requestHeaders, 'Cookie')) return undefined;
    if (getHeader(response.headers, 'Set-Cookie') || getHeader(response.headers, 'Vary')?.trim() === '*') return undefined;
    const entry: CacheEntry = {
      key: this.key(url, method),
      url,
      version: response.version,
      statusCode: response.statusCode,
      reason: response.reason,
      headers: response.headers.map((header) => ({ ...header })),
      body: Buffer.from(response.decodedBody),
      compressedBody: Buffer.from(response.compressedBody),
      storedAt: now,
      expiresAt: expiryFromHeaders(response.headers, now),
      lastModified: getHeader(response.headers, 'Last-Modified'),
      etag: getHeader(response.headers, 'ETag'),
    };
    this.entries.set(entry.key, entry);
    return entry;
  }

  /** Refresh an existing entry after a validating 304 response. */
  revalidate(url: string, method: string, response: ParsedResponse, now = Date.now()): CacheEntry | undefined {
    const key = this.key(url, method);
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    const headers = mergeHeaders(entry.headers, response.headers);
    const previousLifetime = entry.expiresAt === undefined ? undefined : Math.max(0, entry.expiresAt - entry.storedAt);
    const expiresAt = expiryFromHeaders(headers, now) ?? (previousLifetime === undefined ? undefined : now + previousLifetime);
    const refreshed: CacheEntry = {
      ...entry,
      headers,
      storedAt: now,
      expiresAt,
      lastModified: getHeader(headers, 'Last-Modified'),
      etag: getHeader(headers, 'ETag'),
    };
    this.entries.set(key, refreshed);
    return refreshed;
  }

  remove(url: string, method = 'GET'): boolean {
    return this.entries.delete(this.key(url, method));
  }

  clear(): void {
    this.entries.clear();
  }

  list(now = Date.now()): Array<CacheEntry & { remainingMs?: number; fresh: boolean }> {
    return [...this.entries.values()].map((entry) => ({
      ...entry,
      headers: entry.headers.map((header) => ({ ...header })),
      body: Buffer.from(entry.body),
      compressedBody: entry.compressedBody ? Buffer.from(entry.compressedBody) : undefined,
      remainingMs: entry.expiresAt === undefined ? undefined : entry.expiresAt - now,
      fresh: entry.expiresAt !== undefined && entry.expiresAt > now,
    }));
  }

  private key(url: string, method: string): string {
    return `${method.toUpperCase()} ${url}`;
  }
}

export function merge304(entry: CacheEntry, response: ParsedResponse): ParsedResponse {
  const headers = mergeHeaders(entry.headers, response.headers);
  return {
    ...response,
    statusCode: entry.statusCode,
    reason: entry.reason,
    headers,
    body: Buffer.from(entry.body),
    decodedBody: Buffer.from(entry.body),
    compressedBody: Buffer.from(entry.compressedBody ?? entry.body),
  };
}

export function conditionalHeaders(entry: CacheEntry): Header[] {
  const headers: Header[] = [];
  if (entry.etag) headers.push({ name: 'If-None-Match', value: entry.etag });
  if (entry.lastModified) headers.push({ name: 'If-Modified-Since', value: entry.lastModified });
  return headers;
}
