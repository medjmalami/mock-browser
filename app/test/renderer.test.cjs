const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('redirect steps and embedded preview lifecycle in the renderer', { skip: process.env.HTTP_LAB_BROWSER_TESTS !== '1' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'http-lab-ui-'));
  try {
    const bundle = buildSync({
      entryPoints: [path.join(__dirname, 'renderer-fixture.tsx')], bundle: true,
      write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    }).outputFiles[0].text;
    writeFileSync(path.join(directory, 'bundle.js'), bundle);
    const html = path.join(directory, 'index.html');
    writeFileSync(html, '<div id="root"></div><script src="bundle.js"></script>');
    const output = execFileSync(process.env.CHROME_PATH || 'google-chrome-stable', [
      '--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${directory}/profile`,
      '--allow-file-access-from-files', '--virtual-time-budget=5000', '--dump-dom', `file://${html}`,
    ], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(output, /data-test-result="passed"/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
