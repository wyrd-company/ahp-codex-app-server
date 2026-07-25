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
- Mirrors Codex rollout files into configured AHP provider session storage after completed turns.
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

## Provider Session Storage

Codex App Server still owns its native storage under `CODEX_HOME/sessions`.
When `sessionStorage` is configured, this adapter mirrors the current Codex
rollout file into the resolved AHP provider session-storage directory after
each completed turn and writes `codex-session.json` metadata beside it.

Use a static storage URI for normal provider-kit session segmentation, or a
function when the host needs to route each AHP session to a task-specific
folder.

```ts
createCodexAppServerProvider({
  socketPath: process.env.CODEX_APP_SERVER_SOCKET,
  defaultModel: 'gpt-5',
  sessionStorage: context => context.config?.values.taskCodexSessionUri as string | undefined,
});
```

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

## Releasing

[Intentional](https://github.com/wyrd-company/intentional) is the version and
release-intent authority for this repository. `.intentional/config.yml` defines
the single `ahp-codex-app-server` release unit, `package.json` is a projection of that state,
and Git tags are the released-version record. Do not hand-edit the version in
`package.json`.

Continuous integration runs `intentional check` on every pull request and on
`main`. It validates only; it never releases.

### Record a change

Author an intent alongside the implementation it describes:

```bash
intentional add --release-unit ahp-codex-app-server:minor --message "Add a user-visible capability."
```

Use `major`, `minor`, or `patch` for the compatibility impact of the change.
While the package is below `1.0.0`, the configured `compatibility` mapping
shifts each bump down one position: a `major` intent moves the minor number and
both `minor` and `patch` intents move the patch number. Commit the generated
file in `.intentional/intents/` with the code change.

### Cut a release

Releasing is a deliberate, human-authorized action. Nothing below happens
automatically.

```bash
intentional status
intentional check
intentional plan > release-plan.json
intentional apply --dry-run
intentional apply

git add -A
git commit -m "chore: release"
```

`apply` writes the new version into `package.json`, updates `CHANGELOG.md`, and
consumes the included intents.

`main` accepts changes only through a pull request, so open one for the release
commit and merge it. Then tag the merged commit on `main`:

```bash
git switch main && git pull
intentional tag --plan release-plan.json
```

`tag` creates the annotated release record using the plain `N.N.N` tag name that
the CD workflow expects. Pushing that tag starts publication and is the point of
no return:

```bash
git push origin <version>
```

`.github/workflows/cd.yml` reacts to the tag: it verifies the tag matches
`package.json`, builds, publishes to npmjs and GitHub Packages, and creates the
GitHub release. Delete `release-plan.json` once the release is tagged; it is
working material, not repository state.
