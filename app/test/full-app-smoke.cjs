// End-to-end: production renderer -> preload -> IPC -> embedded view -> raw HTTP.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { startLabServices } = require('@http-lab/server');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'http-lab-full-app-test-')));
process.env.HTTP_LAB_ORIGIN_PORT = '0';
process.env.HTTP_LAB_PROXY_PORT = '0';
process.env.HTTP_LAB_ECHO_PORT = '0';
delete process.env.ELECTRON_RENDERER_URL;
require('../dist/main');
const waitFor = async (check, message) => {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
};
(async () => {
  await app.whenReady();
  const logs = [];
  const services = await startLabServices({ origin: { port: 0 }, proxy: { port: 0 }, echo: { port: 0 }, onEvent: event => logs.push(event) });
  try {
    await waitFor(() => BrowserWindow.getAllWindows().length === 1, 'Lab window missing');
    const lab = BrowserWindow.getAllWindows()[0].webContents;
    await waitFor(() => lab.executeJavaScript('Boolean(document.querySelector(".url-input"))'), 'UI did not mount');
    const target = `http://127.0.0.1:${services.addresses.origin.port}/live-demo`;
    await lab.executeJavaScript(`{
      const input = document.querySelector('.url-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(target)});
      input.dispatchEvent(new Event('input', {bubbles:true}));
    }`);
    await new Promise(resolve => setTimeout(resolve, 80));
    await lab.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Send ↵').click()`);
    await waitFor(async () => {
      const error = await lab.executeJavaScript('document.querySelector(".error-banner")?.textContent');
      if (error) throw new Error(error);
      return BrowserWindow.getAllWindows()[0].contentView.children.length === 1;
    }, 'Send did not embed a rendered page');
    const parent = BrowserWindow.getAllWindows()[0];
    const embedded = parent.contentView.children.find(view => view.webContents && view.webContents !== lab);
    const live = embedded.webContents;
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'No separate window');
    await waitFor(() => live.executeJavaScript('document.querySelector("#script-status")?.textContent === "JavaScript loaded and running"'), 'Live JavaScript did not run');
    assert.equal(await live.executeJavaScript('getComputedStyle(document.querySelector("h1")).color'), 'rgb(37, 99, 235)');
    await waitFor(() => lab.executeJavaScript('document.querySelectorAll(".live-requests .history-row").length >= 2'), 'Resource capture missing in UI');
    assert.equal(logs.filter(event => event.type === 'request-received' && event.details?.rawRequest?.startsWith('GET /live-demo HTTP/')).length, 1, 'Displaying HTML must not repeat the document request');
    const rect = await lab.executeJavaScript('(()=>{const r=document.querySelector(".embedded-preview").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
    assert.ok(Math.abs(embedded.getBounds().x - rect.x) <= 2, 'Preview aligned with rendered panel');
    await live.executeJavaScript('document.querySelector("form").requestSubmit()');
    await waitFor(() => live.executeJavaScript('document.body.textContent.includes("Login successful")'), 'Native form did not submit in place');
    assert.equal(logs.filter(event => event.type === 'request-received' && event.details?.rawRequest?.startsWith('POST /login.cgi HTTP/')).length, 1, 'Submit only once');
    await lab.executeJavaScript('Array.from(document.querySelectorAll(".body-tabs button")).find(button=>button.textContent==="raw").click()');
    await waitFor(() => parent.contentView.children.length === 0, 'Raw tab should remove live view');
    await lab.executeJavaScript('Array.from(document.querySelectorAll(".body-tabs button")).find(button=>button.textContent==="rendered").click()');
    await waitFor(() => parent.contentView.children.length === 1, 'Rendered tab should restore live view');
    assert.equal(logs.filter(event => event.type === 'request-received' && event.details?.rawRequest?.startsWith('POST /login.cgi HTTP/')).length, 1, 'Tab switching must not replay POST');
    await lab.executeJavaScript('Array.from(document.querySelectorAll(".live-requests .history-row")).find(row=>row.textContent.includes("POST /login.cgi")).click()');
    await waitFor(() => parent.contentView.children.some(view => view.webContents && !view.webContents.isDestroyed()), 'Captured POST preview missing');
    const postView = parent.contentView.children[0].webContents;
    await waitFor(() => postView.executeJavaScript('document.body.textContent.includes("Login successful")'), 'Captured POST body should render without resubmitting');
    assert.equal(logs.filter(event => event.type === 'request-received' && event.details?.rawRequest?.startsWith('POST /login.cgi HTTP/')).length, 1, 'Inspecting POST does not submit again');
    assert.equal(logs.filter(event => event.type === 'request-received' && event.details?.rawRequest?.startsWith('GET /login.cgi HTTP/')).length, 0, 'Inspecting POST does not fetch its URL with GET');
    console.log('PASS: Send renders CSS/JS inside Response, no second window or duplicate document request, native form, captured resources, tab cleanup');
    await lab.executeJavaScript('window.httpLab.stop()');
  } finally { await services.stop(); }
})().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
