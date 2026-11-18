import type { Cookie, Header } from './types.js';
import { getHeader } from './serializer.js';

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function defaultPath(pathname: string): string {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  const normalizedDomain = domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  return hostOnly ? normalizedHost === normalizedDomain : normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || pathname[cookiePath.length] === '/';
}

export class CookieJar {
  private cookies = new Map<string, Cookie>();

  setFromHeader(setCookie: string, requestUrl: string): Cookie | undefined {
    const url = new URL(requestUrl);
    const parts = setCookie.split(';').map((part) => part.trim());
    const pair = parts.shift();
    if (!pair) return undefined;
    const equals = pair.indexOf('=');
    if (equals <= 0) return undefined;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (!COOKIE_NAME.test(name)) return undefined;
    let domain = url.hostname.toLowerCase().replace(/\.$/, '');
    let hostOnly = true;
    let path = defaultPath(url.pathname);
    let expiresAt: number | undefined;
    let maxAgeSeen = false;
    let secure = false;
    let httpOnly = false;
    for (const attribute of parts) {
      const separator = attribute.indexOf('=');
      const rawName = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
      const rawValue = separator < 0 ? '' : attribute.slice(separator + 1).trim();
      if (rawName === 'domain' && rawValue) {
        const candidate = rawValue.replace(/^\./, '').replace(/\.$/, '').toLowerCase();
        // A server can only widen a cookie to its own domain. Reject an
        // invalid Domain attribute rather than allowing cross-site leakage.
        if (!domainMatches(url.hostname, candidate, false)) return undefined;
        domain = candidate;
        hostOnly = false;
      } else if (rawName === 'path' && rawValue.startsWith('/')) {
        path = rawValue;
      } else if (rawName === 'expires' && !maxAgeSeen) {
        const time = Date.parse(rawValue);
        if (!Number.isNaN(time)) expiresAt = time;
      } else if (rawName === 'max-age' && /^-?\d+$/.test(rawValue)) {
        expiresAt = Date.now() + Number(rawValue) * 1000;
        maxAgeSeen = true;
      } else if (rawName === 'secure') {
        secure = true;
      } else if (rawName === 'httponly') {
        httpOnly = true;
      }
    }
    const cookie: Cookie = { name, value, domain, path, expiresAt, hostOnly, secure, httpOnly };
    const key = this.key(cookie);
    if (expiresAt !== undefined && expiresAt <= Date.now()) this.cookies.delete(key);
    else this.cookies.set(key, cookie);
    return cookie;
  }

  store(headers: Header[], requestUrl: string): Cookie[] {
    return headers
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => this.setFromHeader(header.value, requestUrl))
      .filter((cookie): cookie is Cookie => Boolean(cookie));
  }

  headerFor(urlString: string): string | undefined {
    const url = new URL(urlString);
    const now = Date.now();
    const selected: Cookie[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.secure && url.protocol !== 'https:') continue;
      if (!domainMatches(url.hostname, cookie.domain, cookie.hostOnly)) continue;
      if (!pathMatches(url.pathname || '/', cookie.path)) continue;
      selected.push(cookie);
    }
    selected.sort((left, right) => right.path.length - left.path.length);
    return selected.length ? selected.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') : undefined;
  }

  delete(name: string, domain?: string, path = '/'): boolean {
    const normalizedDomain = domain?.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
    let deleted = false;
    for (const [key, cookie] of this.cookies) {
      if (cookie.name === name && (!normalizedDomain || cookie.domain === normalizedDomain) && cookie.path === path) {
        this.cookies.delete(key);
        deleted = true;
      }
    }
    return deleted;
  }

  edit(name: string, value: string, domain?: string, path = '/'): boolean {
    const normalizedDomain = domain?.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
    for (const cookie of this.cookies.values()) {
      if (cookie.name === name && (!normalizedDomain || cookie.domain === normalizedDomain) && cookie.path === path) {
        cookie.value = value;
        return true;
      }
    }
    return false;
  }

  list(): Cookie[] {
    this.purgeExpired();
    return [...this.cookies.values()].map((cookie) => ({ ...cookie }));
  }

  clear(): void {
    this.cookies.clear();
  }

  private key(cookie: Cookie): string {
    return `${cookie.domain}|${cookie.path}|${cookie.name}`;
  }

  private purgeExpired(now = Date.now()): void {
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) this.cookies.delete(key);
    }
  }
}

export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function extractSetCookies(headers: Header[]): string[] {
  return headers.filter((header) => header.name.toLowerCase() === 'set-cookie').map((header) => header.value);
}

export function cookieHeader(headers: Header[]): string | undefined {
  return getHeader(headers, 'Cookie');
}
