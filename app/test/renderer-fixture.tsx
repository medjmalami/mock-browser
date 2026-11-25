import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../renderer/App';

const bytes = (s = '') => ({ base64: btoa(s), length: s.length });
const request = (target: string) => ({ requestLine: `GET ${target} HTTP/1.1`, raw: `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n`, headers: [], body: bytes(), bytes: bytes() });
const response = (code: number, body = '', headers: any[] = []) => ({ version: 'HTTP/1.1', statusCode: code, reason: code === 301 ? 'Moved Permanently' : 'OK', headers, body: bytes(body), decodedBody: bytes(body), raw: bytes(`HTTP/1.1 ${code}\r\n${headers.map(h => `${h.name}: ${h.value}\r\n`).join('')}\r\n${body}`), rawHeaders: bytes(), compressedBody: bytes(body), chunks: [], trailers: [] });
const first = { request: request('/old'), response: response(301, 'Moved', [{ name: 'Location', value: '/new' }]) };
const last = { request: request('/new'), response: response(200, 'Final response', [{ name: 'Content-Type', value: 'text/plain' }]) };
let calls: any[] = [];
const listeners = new Map<string, (value: any) => void>();
const opened: any[] = [];
const closed: string[] = [];
(window as any).httpLab = {
  subscribe: (channel: string, listener: (value: any) => void) => { listeners.set(channel, listener); return () => listeners.delete(channel); },
  openLivePage: async (id: string, attempt: number, token: string, bounds: unknown) => { opened.push({ id, attempt, token, bounds }); },
  setLivePageBounds: async () => {},
  closeLivePage: async (token: string) => { closed.push(token); }, state: async () => ({ connections: [], cookies: [], cache: [] }),
  request: async (options: any) => {
    calls.push(options);
    if (options.url.endsWith('/old')) return { id: 'redirect', ...last, attempts: [first, last], redirectChain: [options.url, 'http://127.0.0.1:8080/new'], timeline: [] };
    const req = request('/login');
    const res = options.method === 'POST' ? response(201, 'Logged in') : response(200, '<form method="post" action="/login.cgi"></form>', [{ name: 'Content-Type', value: 'text/html' }]);
    return { id: options.method === 'POST' ? 'post' : 'page', request: req, response: res, attempts: [{ request: req, response: res }], redirectChain: [options.url], timeline: [] };
  },
};
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const click = async (label: string) => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === label);
  check(button, `Missing button: ${label}`); button!.click(); await tick();
};
const scenario = async (name: string) => {
  await click('Scenarios ▾');
  const button = [...document.querySelectorAll<HTMLButtonElement>('.scenario-option')].find(b => b.querySelector('strong')?.textContent === name);
  check(button, `Missing scenario: ${name}`); button!.click(); await tick(); await click('Send ↵');
};
createRoot(document.getElementById('root')!).render(<App />);
(async () => {
  try {
    await tick();
    await scenario('301 redirect');
    check(document.querySelector('.status-line')?.textContent?.includes('301'), 'First redirect response is visible');
    check(document.querySelector('.headers-table')?.textContent?.includes('Location/new'), 'Location is visible');
    check(document.querySelector('.wire')?.textContent?.includes('Location: /new␍␊'), 'Raw redirect preserves CRLF');
    const selector = document.querySelector<HTMLSelectElement>('[aria-label="Exchange step"]')!;
    selector.value = '1'; selector.dispatchEvent(new Event('change', { bubbles: true })); await tick();
    check(document.querySelector('.status-line')?.textContent?.includes('200'), 'Final response selectable');
    await click('request');
    check(document.querySelector('.request-line')?.textContent?.includes('/new'), 'Request matches selected response');
    await scenario('Form POST + Referer');
    check(calls.at(-1).method === 'GET' && calls.at(-1).url.endsWith('/login'), 'Scenario first fetches page');
    check(document.querySelector('.embedded-preview'), 'HTML renders inside the response panel');
    check(opened.at(-1)?.id === 'page', 'Rendered tab opens captured response automatically');
    check(![...document.querySelectorAll('button')].some(b => b.textContent === 'Live page (JS + CSS)'), 'No separate live-page button');
    const previewToken = opened.at(-1).token;
    await click('raw');
    check(closed.includes(previewToken), 'Leaving rendered cleans up native view');
    await click('rendered');
    check(opened.at(-1).token !== previewToken, 'Returning opens the correct response');
    listeners.get('lab:live-exchange')?.({ id: 'live-css', ...last, attempts: [last], redirectChain: ['http://127.0.0.1:8080/live-demo.css'], timeline: [] });
    await tick();
    const countBeforeInspection = calls.length;
    document.querySelector<HTMLButtonElement>('.live-requests .history-row')!.click(); await tick();
    check(calls.length === countBeforeInspection, 'Inspecting page traffic must not replay requests');
    check(document.querySelector('.status-line')?.textContent?.includes('200'), 'Captured resource response displayed');
    document.body.dataset.testResult = 'passed';
  } catch (error) { document.body.dataset.testResult = String(error); }
})();
