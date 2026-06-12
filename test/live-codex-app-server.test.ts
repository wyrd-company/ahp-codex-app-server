import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction } from '@microsoft/agent-host-protocol';
import { AhpServer, createInMemoryTransportPair } from '@wyrd-company/ahp-server';

import { createCodexAppServerProvider } from '../src/index.js';

test('creates an AHP session backed by a live Codex App Server', {
  skip: process.env.CODEX_APP_SERVER_URL || process.env.CODEX_APP_SERVER_SOCKET
    ? false
    : 'set CODEX_APP_SERVER_URL or CODEX_APP_SERVER_SOCKET to run live CAS validation',
}, async () => {
  const server = new AhpServer({
    providers: [
      createCodexAppServerProvider({
        webSocketUrl: process.env.CODEX_APP_SERVER_URL,
        socketPath: process.env.CODEX_APP_SERVER_SOCKET,
        defaultModel: process.env.CODEX_E2E_MODEL ?? 'gpt-5',
      }),
    ],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const serverRun = server.accept(serverTransport);

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 10_000 });
  let sessionUri: string | undefined;
  try {
    client.connect();
    await client.initialize({
      clientId: 'live-cas-client',
      protocolVersions: ['0.3.0'],
      initialSubscriptions: ['ahp-root://'],
    });

    sessionUri = `ahp-session:/live-cas-${Date.now()}`;
    await client.request('createSession', {
      channel: sessionUri,
      provider: 'codex',
      workingDirectory: `file://${process.cwd()}`,
    });
    const { result } = await client.subscribe(sessionUri);
    assert.equal(result.snapshot?.resource, sessionUri);

    if (!process.env.CODEX_LIVE_TURN_PROMPT) {
      return;
    }

    const { subscription } = await client.subscribe(sessionUri);
    client.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'live-cas-turn',
      message: userMessage(process.env.CODEX_LIVE_TURN_PROMPT),
    } as StateAction);

    const seen = new Set<string>();
    const actions: StateAction[] = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !seen.has('session/turnComplete') && !seen.has('session/error')) {
      const next = await Promise.race([
        subscription.next(),
        new Promise<IteratorResult<never>>(resolve => setTimeout(
          () => resolve({ done: true, value: undefined as never }),
          1_000,
        )),
      ]);
      if (next.done) {
        continue;
      }
      if (next.value.type === 'action') {
        actions.push(next.value.params.action);
        seen.add(next.value.params.action.type);
      }
    }
    assert.ok(
      seen.has('session/delta') || seen.has('session/turnComplete'),
      `expected live CAS turn output, saw: ${JSON.stringify(actions)}`,
    );
  } finally {
    if (sessionUri) {
      try {
        await client.request('disposeSession', { channel: sessionUri });
      } catch {
        // The session may not have been created if initialization failed.
      }
    }
    await client.shutdown();
    await serverRun;
  }
});

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}
