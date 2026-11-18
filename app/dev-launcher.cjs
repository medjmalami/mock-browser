const { spawn } = require('node:child_process');
const net = require('node:net');

const children = [];
const renderer = spawn(process.platform === 'win32' ? 'vite.cmd' : 'vite', ['--host', '127.0.0.1', '--config', 'vite.config.ts'], { stdio: 'inherit', cwd: __dirname, shell: false });
children.push(renderer);

function waitForPort(host, port, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`Timed out waiting for ${host}:${port}`));
        else setTimeout(check, 100);
      });
    };
    check();
  });
}

void waitForPort('127.0.0.1', 5173).then(() => {
  const electron = spawn(process.platform === 'win32' ? 'electron.cmd' : 'electron', ['dist/main.js'], { stdio: 'inherit', cwd: __dirname, env: { ...process.env, ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173' }, shell: false });
  children.push(electron);
  electron.once('exit', (code, signal) => shutdown(code ?? (signal ? 1 : 0)));
}).catch((error) => {
  console.error(error);
  shutdown(1);
});

function shutdown(code) {
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  process.exitCode = code;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(0));
