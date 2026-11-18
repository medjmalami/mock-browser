import { startLabServices } from './services.js';

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function optionalCredential(): { username: string; password: string } | undefined {
  const username = process.env.PROXY_AUTH_USER;
  const password = process.env.PROXY_AUTH_PASSWORD;
  return username && password ? { username, password } : undefined;
}

async function main(): Promise<void> {
  const services = await startLabServices({
    origin: { host: process.env.ORIGIN_HOST ?? '127.0.0.1', port: numberEnv('ORIGIN_PORT', 8080) },
    proxy: { host: process.env.PROXY_HOST ?? '127.0.0.1', port: numberEnv('PROXY_PORT', 8888), auth: optionalCredential() },
    echo: { host: process.env.ECHO_HOST ?? '127.0.0.1', port: numberEnv('ECHO_PORT', 9000) },
    onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  process.stdout.write(`HTTP Lab origin listening on http://${services.addresses.origin.host}:${services.addresses.origin.port}\n`);
  process.stdout.write(`HTTP Lab proxy listening on http://${services.addresses.proxy.host}:${services.addresses.proxy.port}\n`);
  process.stdout.write(`HTTP Lab echo listening on tcp://${services.addresses.echo.host}:${services.addresses.echo.port}\n`);
  const shutdown = async () => {
    await services.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

