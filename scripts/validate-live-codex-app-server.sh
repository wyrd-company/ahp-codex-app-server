#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${CODEX_APP_SERVER_URL:-}" && -z "${CODEX_APP_SERVER_SOCKET:-}" ]]; then
  echo "set CODEX_APP_SERVER_URL or CODEX_APP_SERVER_SOCKET to run live Codex App Server validation" >&2
  exit 0
fi

CODEX_E2E_MODEL="${CODEX_E2E_MODEL:-gpt-5}" node --test --import tsx test/live-codex-app-server.test.ts
