import { randomUUID } from 'node:crypto';
import net, { type Server, type Socket } from 'node:net';
import type { EchoOptions, ServerEvent, ServerEventSink } from './types.js';

export class EchoApplication {
  private readonly onEvent?: ServerEventSink;

  constructor(options: EchoOptions = {}) {
    this.onEvent = options.onEvent;
  }

  createServer(): Server {
    return net.createServer((socket) => this.attach(socket));
  }

  private emit(type: string, message: string, connectionId: string, details?: Record<string, unknown>): void {
    const event: ServerEvent = { id: randomUUID(), at: new Date().toISOString(), service: 'echo', type, connectionId, message, details };
    this.onEvent?.(event);
  }

  private attach(socket: Socket): void {
    const connectionId = `echo-${randomUUID().slice(0, 8)}`;
    this.emit('connection-opened', `Echo connection ${connectionId} opened`, connectionId, { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort });
    socket.on('data', (chunk) => {
      this.emit('bytes-received', `Echoed ${chunk.length} bytes`, connectionId, { bytes: chunk.length, data: chunk.toString('latin1') });
      socket.write(chunk);
    });
    socket.on('error', (error) => this.emit('socket-error', error.message, connectionId));
    socket.on('close', () => this.emit('connection-closed', `Echo connection ${connectionId} closed`, connectionId));
  }
}

export function createEchoServer(options: EchoOptions = {}): Server {
  return new EchoApplication(options).createServer();
}

