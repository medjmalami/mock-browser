import type { Server } from 'node:net';
import { createEchoServer } from './echo.js';
import { createOriginServer } from './origin.js';
import { createProxyServer } from './proxy.js';
import type { EchoOptions, LabServiceAddresses, LabServices, OriginOptions, ProxyOptions, ServerEvent, ServerEventSink } from './types.js';

export type StartLabServicesOptions = {
  origin?: OriginOptions;
  proxy?: ProxyOptions;
  echo?: EchoOptions;
  onEvent?: ServerEventSink;
};

function listen(server: Server, host: string, port: number): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not expose a TCP address'));
        return;
      }
      resolve({ host, port: address.port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startLabServices(options: StartLabServicesOptions = {}): Promise<LabServices> {
  const onEvent = options.onEvent;
  const emit = (event: ServerEvent) => onEvent?.(event);
  const echoOptions = { ...options.echo, onEvent: emit };
  const originOptions = { ...options.origin, onEvent: emit };
  const echoServer = createEchoServer(echoOptions);
  const originServer = createOriginServer(originOptions);
  let proxyServer: Server | undefined;
  try {
    const echoAddress = await listen(echoServer, echoOptions.host ?? '127.0.0.1', echoOptions.port ?? 9000);
    const originAddress = await listen(originServer, originOptions.host ?? '127.0.0.1', originOptions.port ?? 8080);
    const proxyOptions: ProxyOptions = {
      ...options.proxy,
      originHost: options.proxy?.originHost ?? originAddress.host,
      originPort: options.proxy?.originPort ?? originAddress.port,
      echoHost: options.proxy?.echoHost ?? echoAddress.host,
      echoPort: options.proxy?.echoPort ?? echoAddress.port,
      onEvent: emit,
    };
    proxyServer = createProxyServer(proxyOptions);
    const proxyAddress = await listen(proxyServer, proxyOptions.host ?? '127.0.0.1', proxyOptions.port ?? 8888);
    const runningProxyServer = proxyServer;
    const addresses: LabServiceAddresses = { origin: originAddress, proxy: proxyAddress, echo: echoAddress };
    onEvent?.({ id: `services-${Date.now()}`, at: new Date().toISOString(), service: 'origin', type: 'services-started', message: 'HTTP Lab services started', details: addresses });
    return {
      addresses,
      originServer,
      proxyServer: runningProxyServer,
      echoServer,
      stop: async () => {
        await Promise.all([close(runningProxyServer), close(originServer), close(echoServer)]);
        onEvent?.({ id: `services-${Date.now()}`, at: new Date().toISOString(), service: 'origin', type: 'services-stopped', message: 'HTTP Lab services stopped' });
      },
    };
  } catch (error) {
    await Promise.all([proxyServer ? close(proxyServer) : Promise.resolve(), close(originServer), close(echoServer)]);
    throw error;
  }
}

