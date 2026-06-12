import net from 'node:net';
import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

export interface CodexJsonRpcRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexJsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexJsonRpcSuccess {
  readonly id: number | string;
  readonly result: unknown;
}

export interface CodexJsonRpcFailure {
  readonly id: number | string;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type CodexJsonRpcMessage =
  | CodexJsonRpcRequest
  | CodexJsonRpcNotification
  | CodexJsonRpcSuccess
  | CodexJsonRpcFailure;

export interface CodexServerRequestEvent {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
  respond(result: unknown | Promise<unknown>): void;
  reject(error: Error | { readonly code?: number; readonly message: string; readonly data?: unknown }): void;
}

export interface CodexAppServerClient {
  connect(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(listener: (notification: CodexJsonRpcNotification) => void): () => void;
  onServerRequest(listener: (request: CodexServerRequestEvent) => void): () => void;
  close(): Promise<void>;
}

export interface CodexAppServerSocketClientOptions {
  readonly socketPath?: string;
  readonly webSocketUrl?: string;
  readonly clientInfo?: {
    readonly name?: string;
    readonly title?: string | null;
    readonly version?: string;
  };
  readonly initializeTimeoutMs?: number;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class CodexAppServerSocketClient implements CodexAppServerClient {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number | string, PendingRequest>();
  private ws?: WebSocket;
  private nextId = 1;

  constructor(private readonly options: CodexAppServerSocketClientOptions) {}

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.ws = await this.openWebSocket();
    this.ws.on('message', data => this.handleMessage(data));
    this.ws.on('close', () => this.rejectAll(new Error('Codex App Server socket closed')));
    this.ws.on('error', error => this.rejectAll(error));

    await this.request('initialize', {
      clientInfo: {
        name: this.options.clientInfo?.name ?? '@wyrd-company/ahp-server',
        title: this.options.clientInfo?.title ?? 'AHP Server',
        version: this.options.clientInfo?.version ?? '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: null,
      },
    });
    this.notify('initialized');
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
      });
      this.send(message);
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  onNotification(listener: (notification: CodexJsonRpcNotification) => void): () => void {
    this.events.on('notification', listener);
    return () => this.events.off('notification', listener);
  }

  onServerRequest(listener: (request: CodexServerRequestEvent) => void): () => void {
    this.events.on('serverRequest', listener);
    return () => this.events.off('serverRequest', listener);
  }

  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>(resolve => {
      ws.once('close', () => resolve());
      ws.close();
    });
  }

  private openWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socketPath = this.options.socketPath;
      const ws = new WebSocket(this.options.webSocketUrl ?? 'ws://localhost/rpc', {
        ...(socketPath
          ? { createConnection: () => net.connect(socketPath) }
          : {}),
        maxPayload: 128 << 20,
        perMessageDeflate: false,
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`timed out connecting to Codex App Server ${this.describeEndpoint()}`));
      }, this.options.initializeTimeoutMs ?? 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private describeEndpoint(): string {
    return this.options.socketPath ?? this.options.webSocketUrl ?? '(no endpoint configured)';
  }

  private send(message: CodexJsonRpcMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Codex App Server socket is not open');
    }
    this.ws.send(JSON.stringify(message));
  }

  private handleMessage(data: WebSocket.RawData): void {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const message = JSON.parse(text) as CodexJsonRpcMessage;
    if ('id' in message && 'result' in message) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.resolve(message.result);
      }
      return;
    }
    if ('id' in message && 'error' in message) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
      }
      return;
    }
    if ('id' in message && 'method' in message) {
      let handled = false;
      const respond = (result: unknown | Promise<unknown>): void => {
        handled = true;
        void Promise.resolve(result).then(
          value => this.send({ id: message.id, result: value }),
          error => this.send({
            id: message.id,
            error: jsonRpcError(-32_603, error),
          }),
        );
      };
      const reject = (error: Error | { readonly code?: number; readonly message: string; readonly data?: unknown }): void => {
        handled = true;
        this.send({
          id: message.id,
          error: jsonRpcError('code' in error && error.code !== undefined ? error.code : -32_603, error),
        });
      };
      this.events.emit('serverRequest', {
        id: message.id,
        method: message.method,
        params: message.params,
        respond,
        reject,
      } satisfies CodexServerRequestEvent);
      if (handled) {
        return;
      }
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message: `no handler for Codex server request "${message.method}"`,
        },
      } as never);
      return;
    }
    this.events.emit('notification', message);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function jsonRpcError(code: number, error: unknown): CodexJsonRpcFailure['error'] {
  if (error instanceof Error) {
    return { code, message: error.message };
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = error as { readonly message?: unknown; readonly data?: unknown };
    return {
      code,
      message: typeof value.message === 'string' ? value.message : String(value.message),
      ...(value.data !== undefined ? { data: value.data } : {}),
    };
  }
  return { code, message: String(error) };
}
