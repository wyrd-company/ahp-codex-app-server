# AHP Codex App Server Provider

TypeScript provider adapter that lets an AHP server run Codex App Server sessions.

Package target: `@wyrd-company/ahp-codex-app-server`.

This package is intentionally separate from `@wyrd-company/ahp-server` so consumers explicitly opt into the Codex runtime dependency and wire the provider into their server process.

## Behavior

- Creates one Codex App Server thread per AHP session.
- Connects to Codex App Server over either a Unix socket or WebSocket.
- Uses the AHP session working directory as the Codex thread `cwd`.
- Sends each AHP user turn with `turn/start`.
- Maps streamed Codex assistant deltas to AHP markdown response parts and deltas.
- Maps Codex turn completion to `session/turnComplete`.
- Cancels turns with `turn/interrupt`.
- Closes the Codex connection when the AHP session is disposed.

## Active-Client Tools

The provider maps AHP active-client tools to Codex dynamic tools.

- Tools present at session creation are sent in `thread/start.dynamicTools`.
- Codex currently treats dynamic tools as model-visible at thread creation. The adapter keeps the latest AHP active-client tool set for invocation routing, but tool visibility updates after thread creation depend on Codex App Server support.
- Codex invokes a dynamic tool through a JSON-RPC server request. The adapter routes that request through `ActiveClientToolSink.reportInvocation(...)`.
- AHP owns session URI, turn id, tool call id, tool name, and active-client identity. Tool input is passed through as display/input data only.
- Only the active client that owns the tool call can complete it through normal AHP `session/toolCallComplete`.

## Session Resume

The provider implements `ResumableAgentProvider`. When `ahp-server` reloads a
persisted AHP session, the adapter reconnects to Codex App Server and calls
`thread/resume` with the stored CAS `thread.id`. The thread id is stored through
the provider-owned resume-state hook exposed by `ahp-server`; it is not read
from client-supplied tool input or AHP session config.

## Usage

```ts
import { AhpServer } from '@wyrd-company/ahp-server';
import { createCodexAppServerProvider } from '@wyrd-company/ahp-codex-app-server';

const server = new AhpServer({
  providers: [
    createCodexAppServerProvider({
      socketPath: process.env.CODEX_APP_SERVER_SOCKET,
      webSocketUrl: process.env.CODEX_APP_SERVER_URL,
      defaultModel: process.env.CODEX_E2E_MODEL ?? 'gpt-5',
    }),
  ],
});
```

## Development

```bash
npm install
npm run verify
```

Live validation requires a running Codex App Server:

```bash
CODEX_APP_SERVER_SOCKET=/path/to/codex.sock npm run test:live
```

Set `CODEX_LIVE_TURN_PROMPT` to exercise a real model turn during live validation.
