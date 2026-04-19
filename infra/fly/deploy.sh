#!/usr/bin/env bash
# Deploy trail-engine to Fly.io Stockholm.
#
# Usage: infra/fly/deploy.sh [--first-time]
#
# --first-time provisions the app + volume + secrets. Re-runnable without
# the flag for subsequent deploys (just builds + rolls out).

set -euo pipefail

APP="trail-engine"
REGION="arn"
VOLUME_NAME="trail_data"
VOLUME_SIZE_GB=10

cd "$(dirname "$0")/../.."

if ! command -v fly >/dev/null 2>&1; then
  echo "error: flyctl not installed — https://fly.io/docs/hands-on/install-flyctl/"
  exit 1
fi

if [[ "${1:-}" == "--first-time" ]]; then
  echo "==> provisioning app ${APP} in ${REGION}"
  fly apps create "${APP}" --org broberg-ai || echo "  (app already exists, continuing)"

  echo "==> provisioning volume ${VOLUME_NAME}"
  fly volumes create "${VOLUME_NAME}" --region "${REGION}" --size "${VOLUME_SIZE_GB}" --app "${APP}" || echo "  (volume already exists, continuing)"

  echo "==> checking required secrets"
  # List the secrets expected before a healthy run. `fly secrets list` is
  # a non-destructive introspection — the caller sets them manually so we
  # never risk echoing sensitive values into shell history.
  required=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ANTHROPIC_API_KEY SESSION_SECRET)
  missing=()
  existing=$(fly secrets list --app "${APP}" --json 2>/dev/null | grep -o '"Name":"[^"]*"' | cut -d'"' -f4 || true)
  for s in "${required[@]}"; do
    if ! grep -qx "$s" <<<"${existing}"; then
      missing+=("$s")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo
    echo "  missing secrets: ${missing[*]}"
    echo "  set with:"
    for s in "${missing[@]}"; do
      echo "    fly secrets set ${s}=<value> --app ${APP}"
    done
    echo
    echo "  re-run without --first-time once all four are set."
    exit 1
  fi
fi

echo "==> deploying"
fly deploy -c infra/fly/fly.toml --app "${APP}"

echo "==> waiting for health to settle"
for i in {1..12}; do
  if curl -fsS "https://${APP}.fly.dev/api/health" >/dev/null 2>&1; then
    echo "  healthy"
    break
  fi
  sleep 5
done

echo "==> done"
