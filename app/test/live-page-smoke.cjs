// Run after npm run build:main: electron app/test/live-page-smoke.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { HttpClient } = require('@http-lab/client-core');
const { startLabServices } = require('@http-lab/server');
const { LivePage } = require('../dist/live-page');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'http-lab-live-test-')));
app.on('window-all-closed', () => {});
const captures = [];
const errors = [];
const waitFor = async (check, message) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};
(async () => {
  await app.whenReady();
  const client = new HttpClient();
  const services = await startLabServices({ origin: { port: 0 }, proxy: { port: 0 }, echo: { port: 0 } });
  const base = `http://127.0.0.1:${services.addresses.origin.port}`;
  const parent = new BrowserWindow({ width: 1100, height: 800 });
  const bounds = { x: 0, y: 0, width: 1100, height: 800 };
  const live = new LivePage(client, exchange => captures.push(exchange), error => errors.push(error));
  try {
    await live.open(`${base}/live-demo`, 'HTTP/1.1', parent, bounds, 'demo');
    let page = parent.contentView.children.find(view => view.webContents && view.webContents !== parent.webContents).webContents;
    assert.equal(await page.executeJavaScript('document.querySelector("#script-status").textContent'), 'JavaScript loaded and running');
    assert.equal(await page.executeJavaScript('getComputedStyle(document.querySelector("h1")).color'), 'rgb(37, 99, 235)');
    assert.equal(await page.executeJavaScript('document.querySelector("#counter").click(); document.querySelector("#counter").textContent'), 'Clicked 1 times');
    assert.deepEqual(await page.executeJavaScript('[typeof require, typeof process, typeof window.httpLab]'), ['undefined', 'undefined', 'undefined']);
    for (const target of ['/live-demo', '/live-demo.css', '/live-demo.js']) {
      assert.ok(captures.some(e => e.request.requestLine === `GET ${target} HTTP/1.1`), `Captured ${target}`);
    }
    assert.equal(await page.executeJavaScript('fetch("/live-demo.css?script-request").then(r => r.text()).then(text => text.includes("body{"))'), true);
    await page.executeJavaScript('import("/live-demo.js?module").then(() => true)');
    assert.ok(captures.some(e => e.request.requestLine.includes('/live-demo.css?script-request')), 'Captured JavaScript request');
    assert.ok(captures.some(e => e.request.requestLine.includes('/live-demo.js?module')), 'Captured module import');
    await page.executeJavaScript('document.querySelector("form").requestSubmit()');
    await waitFor(() => captures.some(e => e.request.requestLine.startsWith('POST /login.cgi ')), 'Missing form POST');
    const post = captures.find(e => e.request.requestLine.startsWith('POST /login.cgi '));
    assert.equal(post.response.statusCode, 201);
    assert.equal(post.request.body.toString(), 'username=mohamed&password=hkm4c');
    assert.match(post.request.raw, new RegExp(`referer: ${base}/live-demo\\r\\n`, 'i'));
    await waitFor(() => page.executeJavaScript('Boolean(document.querySelector("a"))'), 'Login page did not render');
    await page.executeJavaScript('document.querySelector("a").click()');
    await waitFor(() => captures.some(e => e.request.requestLine.startsWith('GET /private/home ')), 'Missing private page request');
    assert.equal(captures.find(e => e.request.requestLine.startsWith('GET /private/home ')).response.statusCode, 200, 'Browser retained login cookie');
    await live.open(`${base}/old`, 'HTTP/1.1', parent, bounds, 'redirect');
    assert.ok(captures.some(e => e.response?.statusCode === 301 && e.response.headers.some(h => h.name.toLowerCase() === 'location')));
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: CSS, script execution, click, JavaScript requests, module imports, native form POST, Referer, cookies, redirects, raw captures, and page isolation');
    if (process.env.HTTP_LAB_TEST_WIKIPEDIA === '1') {
      const start = captures.length;
      await live.open('https://www.wikipedia.org/', 'HTTP/1.1', parent, bounds, 'wikipedia');
      page = parent.contentView.children.find(view => view.webContents && view.webContents !== parent.webContents).webContents;
      console.log('Wikipedia responses', captures.slice(start).map(e => ({url: e.redirectChain[0], status: e.response?.statusCode, error: e.error})), errors);
      await waitFor(() => page.executeJavaScript('[...document.images].some(image => image.complete && image.naturalWidth > 0)'), 'Wikipedia images did not render');
      const loaded = await page.executeJavaScript('[...document.images].filter(image => image.complete && image.naturalWidth > 0).map(image => ({src: image.currentSrc, width: image.naturalWidth}))');
      assert.ok(captures.slice(start).some(e => e.response?.headers.some(h => h.name.toLowerCase() === 'content-type' && h.value.startsWith('image/'))), 'Image loaded through raw client');
      console.log('PASS: Wikipedia rendered images', JSON.stringify(loaded));
    }
  } finally {
    live.close(); client.closeAll(); await services.stop();
  }
})().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
