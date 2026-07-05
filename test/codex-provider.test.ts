import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction, ToolDefinition } from '@microsoft/agent-host-protocol';
import { AhpServer, FileSystemSessionStore, createInMemoryTransportPair } from '@wyrd-company/ahp-server';
import type { ResumableAgentSessionContext } from '@wyrd-company/ahp-provider-kit';

import {
  createCodexAppServerProvider,
  type CodexAppServerClient,
  type CodexJsonRpcNotification,
  type CodexServerRequestEvent,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('Codex provider maps an AHP turn to CAS thread and turn requests', async () => {
  const codex = new FakeCodexClient();
  const provider = createCodexAppServerProvider({ client: codex, defaultModel: 'gpt-test' });
  const server = new AhpServer({ providers: [provider] });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/codex-session';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'codex',
    workingDirectory: 'file:///workspaces/project-a',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'ahp-turn-1',
    message: userMessage('Summarize the repo'),
  } as StateAction);

  const events = [
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
  ].map(event => {
    assert.equal(event.done, false);
    assert.equal(event.value.type, 'action');
    return event.value.params.action;
  });

  assert.deepEqual(codex.requests.map(request => request.method), [
    'thread/start',
    'turn/start',
  ]);
  assert.equal(codex.requests[0]?.params.cwd, '/workspaces/project-a');
  assert.equal(codex.requests[1]?.params.threadId, 'codex-thread-1');
  assert.deepEqual(codex.requests[1]?.params.input, [
    { type: 'text', text: 'Summarize the repo', text_elements: [] },
  ]);
  assert.equal(events[1]?.type, 'session/responsePart');
  assert.equal((events[1] as { turnId?: string }).turnId, 'ahp-turn-1');
  assert.equal(events[2]?.type, 'session/delta');
  assert.equal((events[2] as { turnId?: string }).turnId, 'ahp-turn-1');
  assert.equal((events[2] as { content?: string }).content, 'Codex says hello');
  assert.equal(events[3]?.type, 'session/usage');
  assert.deepEqual((events[3] as { usage?: unknown }).usage, codexUsageInfo());
  assert.equal(events[4]?.type, 'session/turnComplete');
  assert.equal((events[4] as { turnId?: string }).turnId, 'ahp-turn-1');

  await client.shutdown();
});

test('Codex provider mirrors rollout files to configured AHP session storage after completed turns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-codex-mirror-'));
  const rolloutDir = join(directory, 'codex-home', 'sessions', '2026', '07', '05');
  const rolloutPath = join(rolloutDir, 'rollout-2026-07-05T00-00-00-codex-thread-1.jsonl');
  const mirrorDir = join(directory, 'task', 'sessions', 'codex');

  try {
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(rolloutPath, '{"type":"session_meta"}\n{"type":"turn"}\n', 'utf8');

    const codex = new FakeCodexClient({ rolloutPath });
    const provider = createCodexAppServerProvider({
      client: codex,
      defaultModel: 'gpt-test',
      codexHome: join(directory, 'codex-home'),
      sessionStorage: () => pathToFileURL(mirrorDir).href,
    });
    const server = new AhpServer({ providers: [provider] });
    const client = createClient(server);
    client.connect();
    await client.initialize({ clientId: 'mirror-client', protocolVersions: ['0.3.0'] });

    const sessionUri = 'ahp-session:/codex-mirror';
    await client.request('createSession', {
      channel: sessionUri,
      provider: 'codex',
      workingDirectory: 'file:///workspaces/project-a',
    });
    const { subscription } = await client.subscribe(sessionUri);

    client.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'mirror-turn',
      message: userMessage('Mirror the rollout'),
    } as StateAction);

    const actions = await collectUntilTerminal(subscription);
    assert.equal(actions.at(-1)?.type, 'session/turnComplete');

    const mirroredRolloutPath = join(mirrorDir, basename(rolloutPath));
    assert.equal(existsSync(mirroredRolloutPath), true);
    assert.equal(readFileSync(mirroredRolloutPath, 'utf8'), readFileSync(rolloutPath, 'utf8'));

    const metadata = JSON.parse(readFileSync(join(mirrorDir, 'codex-session.json'), 'utf8')) as {
      threadId?: string;
      model?: string;
      rolloutRelativePath?: string;
      mirroredRolloutFileName?: string;
      mirroredAt?: string;
    };
    assert.equal(metadata.threadId, 'codex-thread-1');
    assert.equal(metadata.model, 'gpt-test');
    assert.equal(metadata.rolloutRelativePath, join('sessions', '2026', '07', '05', basename(rolloutPath)));
    assert.equal(metadata.mirroredRolloutFileName, basename(rolloutPath));
    assert.equal(typeof metadata.mirroredAt, 'string');

    await client.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex provider resumes without restoring when the native rollout exists', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-codex-native-resume-'));
  const codexHome = join(directory, 'codex-home');
  const rolloutRelativePath = join('sessions', '2026', '07', '05', 'rollout-2026-07-05T00-00-00-codex-thread-1.jsonl');
  const rolloutPath = join(codexHome, rolloutRelativePath);
  const mirrorDir = join(directory, 'task', 'sessions', 'codex');
  const codex = new FakeCodexClient({ rolloutPath });

  try {
    mkdirSync(dirname(rolloutPath), { recursive: true });
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(rolloutPath, 'native rollout\n', 'utf8');
    writeFileSync(join(mirrorDir, basename(rolloutPath)), 'mirrored rollout\n', 'utf8');
    writeFileSync(join(mirrorDir, 'codex-session.json'), JSON.stringify({
      threadId: 'codex-thread-1',
      model: 'gpt-test',
      rolloutRelativePath,
      mirroredRolloutFileName: basename(rolloutPath),
    }), 'utf8');

    const provider = createCodexAppServerProvider({
      client: codex,
      defaultModel: 'gpt-test',
      codexHome,
      sessionStorage: () => pathToFileURL(mirrorDir).href,
    });

    await provider.resumeSession(resumeContext({
      threadId: 'codex-thread-1',
      model: 'gpt-test',
      rolloutPath,
      rolloutRelativePath,
      mirroredRolloutFileName: basename(rolloutPath),
    }));

    assert.equal(readFileSync(rolloutPath, 'utf8'), 'native rollout\n');
    assert.deepEqual(codex.requests.map(request => request.method), ['thread/resume']);
    assert.equal(codex.requests[0]?.params.threadId, 'codex-thread-1');
    assert.equal('path' in codex.requests[0]!.params, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex provider restores a missing native rollout from the resolved session storage mirror', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-codex-restore-resume-'));
  const codexHome = join(directory, 'codex-home');
  const rolloutRelativePath = join('sessions', '2026', '07', '05', 'rollout-2026-07-05T00-00-00-codex-thread-1.jsonl');
  const rolloutPath = join(codexHome, rolloutRelativePath);
  const mirrorDir = join(directory, 'task', 'sessions', 'codex');
  const mirrorPath = join(mirrorDir, basename(rolloutPath));
  const codex = new FakeCodexClient({ rolloutPath });

  try {
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(mirrorPath, 'mirrored rollout\n', 'utf8');
    writeFileSync(join(mirrorDir, 'codex-session.json'), JSON.stringify({
      threadId: 'codex-thread-1',
      model: 'gpt-test',
      rolloutRelativePath,
      mirroredRolloutFileName: basename(rolloutPath),
    }), 'utf8');

    const provider = createCodexAppServerProvider({
      client: codex,
      defaultModel: 'gpt-test',
      codexHome,
      sessionStorage: () => pathToFileURL(mirrorDir).href,
    });

    await provider.resumeSession(resumeContext({
      threadId: 'codex-thread-1',
      model: 'gpt-test',
      rolloutPath,
      rolloutRelativePath,
      mirroredRolloutFileName: basename(rolloutPath),
    }));

    assert.equal(readFileSync(rolloutPath, 'utf8'), 'mirrored rollout\n');
    assert.deepEqual(codex.requests.map(request => request.method), ['thread/resume']);
    assert.equal('path' in codex.requests[0]!.params, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex provider restores from the newly resolved storage directory when resume state has an old mirror path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-codex-moved-resume-'));
  const oldRoot = join(directory, 'old-machine');
  const newRoot = join(directory, 'new-machine');
  const oldCodexHome = join(oldRoot, 'codex-home');
  const newCodexHome = join(newRoot, 'codex-home');
  const rolloutRelativePath = join('sessions', '2026', '07', '05', 'rollout-2026-07-05T00-00-00-codex-thread-1.jsonl');
  const oldRolloutPath = join(oldCodexHome, rolloutRelativePath);
  const newRolloutPath = join(newCodexHome, rolloutRelativePath);
  const oldMirrorPath = join(oldRoot, 'task', 'sessions', 'codex', basename(newRolloutPath));
  const newMirrorDir = join(newRoot, 'task', 'sessions', 'codex');
  const codex = new FakeCodexClient({ rolloutPath: newRolloutPath });

  try {
    mkdirSync(newMirrorDir, { recursive: true });
    writeFileSync(join(newMirrorDir, basename(newRolloutPath)), 'moved mirrored rollout\n', 'utf8');
    writeFileSync(join(newMirrorDir, 'codex-session.json'), JSON.stringify({
      threadId: 'codex-thread-1',
      model: 'gpt-test',
      rolloutRelativePath,
      mirroredRolloutFileName: basename(newRolloutPath),
    }), 'utf8');

    const provider = createCodexAppServerProvider({
      client: codex,
      defaultModel: 'gpt-test',
      codexHome: newCodexHome,
      sessionStorage: () => pathToFileURL(newMirrorDir).href,
    });

    await provider.resumeSession(resumeContext({
      threadId: 'codex-thread-1',
      model: 'gpt-test',
      rolloutPath: oldRolloutPath,
      mirroredRolloutPath: oldMirrorPath,
    }));

    assert.equal(readFileSync(newRolloutPath, 'utf8'), 'moved mirrored rollout\n');
    assert.deepEqual(codex.requests.map(request => request.method), ['thread/resume']);
    assert.equal('path' in codex.requests[0]!.params, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex provider attempts resume unchanged when neither native nor mirrored rollout is present', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-codex-missing-resume-'));
  const codexHome = join(directory, 'codex-home');
  const rolloutPath = join(codexHome, 'sessions', '2026', '07', '05', 'rollout-2026-07-05T00-00-00-codex-thread-1.jsonl');
  const mirrorDir = join(directory, 'task', 'sessions', 'codex');
  const codex = new FakeCodexClient({ rolloutPath });

  try {
    mkdirSync(mirrorDir, { recursive: true });
    const warnings = await captureConsoleWarn(async () => {
      const provider = createCodexAppServerProvider({
        client: codex,
        defaultModel: 'gpt-test',
        codexHome,
        sessionStorage: () => pathToFileURL(mirrorDir).href,
      });

      await provider.resumeSession(resumeContext({
        threadId: 'codex-thread-1',
        model: 'gpt-test',
        rolloutPath,
      }));
    });

    assert.deepEqual(codex.requests.map(request => request.method), ['thread/resume']);
    assert.equal(existsSync(rolloutPath), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /no mirrored rollout was found/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex provider leaves the resume path untouched when session storage is unset', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-codex-no-storage-resume-'));
  const codexHome = join(directory, 'codex-home');
  const rolloutPath = join(codexHome, 'sessions', '2026', '07', '05', 'rollout-2026-07-05T00-00-00-codex-thread-1.jsonl');
  const codex = new FakeCodexClient({ rolloutPath });

  try {
    const warnings = await captureConsoleWarn(async () => {
      const provider = createCodexAppServerProvider({
        client: codex,
        defaultModel: 'gpt-test',
        codexHome,
      });

      await provider.resumeSession(resumeContext({
        threadId: 'codex-thread-1',
        model: 'gpt-test',
        rolloutPath,
      }));
    });

    assert.deepEqual(codex.requests.map(request => request.method), ['thread/resume']);
    assert.equal(existsSync(rolloutPath), false);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex provider routes dynamic tool calls through active-client tools', async () => {
  const codex = new FakeCodexClient({
    dynamicToolRequest: {
      threadId: 'codex-thread-1',
      turnId: 'codex-turn-1',
      callId: 'codex-tool-call-1',
      namespace: 'ahp_active_client',
      tool: 'searchWorkspace',
      arguments: {
        sessionUri: 'ahp-session:/forged',
        turnId: 'forged-turn',
        query: 'needle',
      },
    },
  });
  const provider = createCodexAppServerProvider({ client: codex, defaultModel: 'gpt-test' });
  const server = new AhpServer({ providers: [provider] });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'tool-owner', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/codex-active-tools';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'codex',
    activeClient: {
      clientId: 'tool-owner',
      displayName: 'Tool Owner',
      tools: [toolDefinition('searchWorkspace', 'Search Workspace')],
    },
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'ahp-turn-1',
    message: userMessage('Use the search tool'),
  } as StateAction);

  assert.deepEqual(codex.requests[0]?.params.dynamicTools, [{
    namespace: 'ahp_active_client',
    name: 'searchWorkspace',
    description: 'Search Workspace test tool',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    },
  }]);

  const turnStarted = await nextAction(subscription);
  assert.equal(turnStarted.action.type, 'session/turnStarted');

  const toolStart = await nextAction(subscription);
  assert.equal(toolStart.action.type, 'session/toolCallStart');
  assert.equal(toolStart.action.turnId, 'ahp-turn-1');
  assert.equal(toolStart.action.toolCallId, 'codex-tool-call-1');
  assert.equal(toolStart.action.toolName, 'searchWorkspace');
  assert.deepEqual(toolStart.action.contributor, {
    kind: 'client',
    clientId: 'tool-owner',
  });

  const toolReady = await nextAction(subscription);
  assert.equal(toolReady.action.type, 'session/toolCallReady');
  assert.equal(toolReady.action.turnId, 'ahp-turn-1');
  assert.equal(toolReady.action.toolCallId, 'codex-tool-call-1');
  assert.match(String(toolReady.action.toolInput), /forged-turn/);

  client.dispatch(sessionUri, {
    type: 'session/toolCallComplete',
    turnId: 'ahp-turn-1',
    toolCallId: 'codex-tool-call-1',
    result: {
      success: true,
      pastTenseMessage: 'Searched workspace',
      content: [{ type: 'text', text: 'found needle' }],
    },
  } as StateAction);

  const complete = await nextAction(subscription);
  assert.equal(complete.action.type, 'session/toolCallComplete');

  const responsePart = await nextAction(subscription);
  assert.equal(responsePart.action.type, 'session/responsePart');
  const delta = await nextAction(subscription);
  assert.equal(delta.action.type, 'session/delta');
  assert.equal((delta.action as { content?: string }).content, 'Codex says hello');
  const usage = await nextAction(subscription);
  assert.equal(usage.action.type, 'session/usage');
  const turnComplete = await nextAction(subscription);
  assert.equal(turnComplete.action.type, 'session/turnComplete');

  assert.deepEqual(await codex.dynamicToolResponse, {
    success: true,
    contentItems: [{ type: 'inputText', text: 'found needle' }],
  });

  await client.shutdown();
});

test('Codex provider resumes a persisted AHP session with the original CAS thread id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-codex-resume-'));
  const firstCodex = new FakeCodexClient();
  const secondCodex = new FakeCodexClient();
  const sessionUri = 'ahp-session:/codex-resume';

  try {
    const firstServer = new AhpServer({
      providers: [createCodexAppServerProvider({ client: firstCodex, defaultModel: 'gpt-test' })],
      store: new FileSystemSessionStore({ directory }),
    });
    const firstClient = createClient(firstServer);
    firstClient.connect();
    await firstClient.initialize({ clientId: 'codex-client', protocolVersions: ['0.3.0'] });
    await firstClient.request('createSession', {
      channel: sessionUri,
      provider: 'codex',
      workingDirectory: 'file:///workspaces/project-a',
      model: { id: 'gpt-test' },
    });
    await firstClient.shutdown();

    const secondServer = new AhpServer({
      providers: [createCodexAppServerProvider({ client: secondCodex, defaultModel: 'gpt-test' })],
      store: new FileSystemSessionStore({ directory }),
    });
    const secondClient = createClient(secondServer);
    secondClient.connect();

    const reconnect = await secondClient.reconnect({
      clientId: 'codex-client',
      lastSeenServerSeq: 0,
      subscriptions: [sessionUri],
    });
    assert.equal(reconnect.type, 'snapshot');
    assert.deepEqual(secondCodex.requests.map(request => request.method), ['thread/resume']);
    assert.equal(secondCodex.requests[0]?.params.threadId, 'codex-thread-1');
    assert.equal(secondCodex.requests[0]?.params.cwd, '/workspaces/project-a');

    const subscription = secondClient.attachSubscription(sessionUri);
    secondClient.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'resume-turn',
      message: userMessage('Continue after reconnect'),
    } as StateAction);

    const actions = await collectUntilTerminal(subscription);
    assert.deepEqual(secondCodex.requests.map(request => request.method), ['thread/resume', 'turn/start']);
    assert.equal(secondCodex.requests[1]?.params.threadId, 'codex-thread-1');
    assert.equal(actions.at(-1)?.type, 'session/turnComplete');

    await secondClient.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
}

interface FakeCodexClientOptions {
  readonly dynamicToolRequest?: Record<string, unknown>;
  readonly rolloutPath?: string;
}

class FakeCodexClient implements CodexAppServerClient {
  readonly requests: RecordedRequest[] = [];
  readonly dynamicToolResponse: Promise<unknown>;
  private notificationListeners = new Set<(notification: CodexJsonRpcNotification) => void>();
  private serverRequestListeners = new Set<(request: CodexServerRequestEvent) => void>();
  private resolveDynamicToolResponse?: (response: unknown) => void;
  private rejectDynamicToolResponse?: (error: Error) => void;

  constructor(private readonly options: FakeCodexClientOptions = {}) {
    this.dynamicToolResponse = new Promise((resolve, reject) => {
      this.resolveDynamicToolResponse = resolve;
      this.rejectDynamicToolResponse = reject;
    });
  }

  async connect(): Promise<void> {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params: params as Record<string, unknown> });
    if (method === 'thread/start') {
      return { thread: { id: 'codex-thread-1', path: this.options.rolloutPath } } as T;
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: (params as { threadId?: string }).threadId ?? 'codex-thread-1',
          path: this.options.rolloutPath,
        },
      } as T;
    }
    if (method === 'turn/start') {
      queueMicrotask(() => void this.completeTurn());
      return { turn: { id: 'codex-turn-1' } } as T;
    }
    return undefined as T;
  }

  notify(): void {}

  onNotification(listener: (notification: CodexJsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: CodexServerRequestEvent) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  async close(): Promise<void> {}

  private async completeTurn(): Promise<void> {
    if (this.options.dynamicToolRequest) {
      try {
        this.resolveDynamicToolResponse?.(await this.emitServerRequest({
          method: 'item/tool/call',
          params: this.options.dynamicToolRequest,
        }));
      } catch (error) {
        this.rejectDynamicToolResponse?.(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'codex-turn-1',
        itemId: 'item-1',
        delta: 'Codex says hello',
      },
    });
    this.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'codex-turn-1',
        tokenUsage: codexThreadTokenUsage(),
      },
    });
    this.emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread-1',
        turn: { id: 'codex-turn-1' },
      },
    });
  }

  private emitServerRequest(request: { method: string; params?: unknown }): Promise<unknown> {
    let handled = false;
    const response = new Promise<unknown>((resolve, reject) => {
      const event: CodexServerRequestEvent = {
        id: 'server-request-1',
        method: request.method,
        params: request.params,
        respond(result: unknown | Promise<unknown>): void {
          handled = true;
          void Promise.resolve(result).then(resolve, reject);
        },
        reject(error: Error | { readonly code?: number; readonly message: string }): void {
          handled = true;
          reject(error instanceof Error ? error : new Error(error.message));
        },
      };
      for (const listener of this.serverRequestListeners) {
        listener(event);
      }
      if (!handled) {
        reject(new Error(`unhandled server request: ${request.method}`));
      }
    });
    return response;
  }

  private emit(notification: CodexJsonRpcNotification): void {
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }
}

function codexThreadTokenUsage() {
  return {
    total: {
      totalTokens: 45_000,
      inputTokens: 42_000,
      cachedInputTokens: 10_000,
      outputTokens: 3_000,
      reasoningOutputTokens: 750,
    },
    last: {
      totalTokens: 4_500,
      inputTokens: 4_200,
      cachedInputTokens: 1_000,
      outputTokens: 300,
      reasoningOutputTokens: 75,
    },
    modelContextWindow: 200_000,
  };
}

function codexUsageInfo() {
  return {
    inputTokens: 4_200,
    outputTokens: 300,
    model: 'gpt-test',
    cacheReadTokens: 1_000,
    _meta: {
      wyrdContextUsage: {
        totalTokens: 45_000,
        maxContextWindow: 200_000,
        usageRatio: 0.225,
        confidence: 'measured',
        source: 'provider-api',
      },
      codexThreadTokenUsage: codexThreadTokenUsage(),
    },
  };
}

function createClient(server: AhpServer): AhpClient {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));
  return new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
}

function resumeContext(resumeState: Record<string, unknown>): ResumableAgentSessionContext {
  return {
    sessionUri: 'ahp-session:/codex-resume',
    providerId: 'codex',
    workingDirectory: 'file:///workspaces/project-a',
    state: {},
    resumeState,
    activeClientToolSink: {
      async reportInvocation(): Promise<never> {
        throw new Error('unexpected active-client tool invocation');
      },
    },
  } as unknown as ResumableAgentSessionContext;
}

async function captureConsoleWarn(action: () => Promise<void>): Promise<string[]> {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...values: unknown[]) => {
    warnings.push(values.map(String).join(' '));
  };
  try {
    await action();
    return warnings;
  } finally {
    console.warn = originalWarn;
  }
}

function toolDefinition(name: string, title: string): ToolDefinition {
  return {
    name,
    title,
    description: `${title} test tool`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    },
  };
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}

async function nextAction(subscription: AsyncIterator<unknown>): Promise<{ action: StateAction }> {
  const next = await subscription.next();
  assert.equal(next.done, false);
  const value = next.value as { type?: string; params?: { action?: StateAction } };
  assert.equal(value.type, 'action');
  assert.ok(value.params?.action);
  return { action: value.params.action };
}

async function collectUntilTerminal(subscription: AsyncIterator<unknown>): Promise<StateAction[]> {
  const actions: StateAction[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { action } = await nextAction(subscription);
    actions.push(action);
    if (action.type === 'session/turnComplete' || action.type === 'session/error') {
      return actions;
    }
  }
  throw new Error(`timed out waiting for terminal action; saw ${actions.map(action => action.type).join(', ')}`);
}
