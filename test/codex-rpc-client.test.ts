import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, test } from 'node:test';

import { WebSocketServer, type WebSocket } from 'ws';

import { CodexAppServerSocketClient } from '../src/index.js';

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  servers.length = 0;
});

test('Codex socket client responds to handled server requests', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const response = new Promise<Record<string, unknown>>(resolve => {
    server.on('connection', socket => {
      socket.on('message', data => {
        const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        if (message.method === 'initialize') {
          send(socket, { id: message.id, result: {} });
          queueMicrotask(() => send(socket, {
            id: 'server-request-1',
            method: 'item/tool/call',
            params: { ok: true },
          }));
          return;
        }
        if (message.id === 'server-request-1') {
          resolve(message);
        }
      });
    });
  });

  const client = new CodexAppServerSocketClient({
    webSocketUrl: `ws://127.0.0.1:${address.port}`,
  });
  client.onServerRequest(request => {
    request.respond({
      contentItems: [{ type: 'inputText', text: 'handled' }],
      success: true,
    });
  });

  await client.connect();

  assert.deepEqual(await response, {
    id: 'server-request-1',
    result: {
      contentItems: [{ type: 'inputText', text: 'handled' }],
      success: true,
    },
  });
  await client.close();
});

function send(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}
