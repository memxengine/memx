<p align="center">
  <img src="docs/assets/trail-logo.svg" alt="trail" width="80" height="80" />
</p>

<h1 align="center">trail</h1>

<p align="center">
  The next-generation knowledge infrastructure engine.<br/>
  Realizing Vannevar Bush's 1945 Memex vision with modern LLMs.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue" alt="FSL-1.1-Apache-2.0" /></a>
  <a href="./docs/PLAN.md"><img src="https://img.shields.io/badge/status-MVP%20in%20progress-orange" alt="Status: MVP in progress" /></a>
</p>

---

## What is trail?

**trail** is a knowledge infrastructure engine that turns your sources into a persistent, compounding wiki (neurons) — maintained by an LLM on your behalf.

Unlike traditional RAG, which fragments your documents and retrieves chunks at query time, trail compiles your knowledge into structured neurons at ingest time. Every new source makes the whole system smarter. Good chat answers feed back into the trail of neurons. Contradictions get flagged. Orphans get linked.

It's what Vannevar Bush dreamed of in 1945, finally made practical by LLMs.

## Use cases

- **Personal knowledge bases** — research, reading, learning
- **Domain expertise platforms** — turn an expert's writings into an AI-powered digital presence
- **Internal knowledge** — Slack threads, meeting notes, wiki pages into one compiled whole
- **Publisher content** — AI-native article platforms
- **CMS modules** — drop-in AI brain for any website

## Status

Phase 1 MVP in progress. See [docs/PLAN.md](./docs/PLAN.md).

**MVP customers:**

- **Sanne Andersen** — healing practice with 25 years of clinical material compiled into a personal Trail.
- **[buddy](https://github.com/webhousecode/buddy)** — adversarial code reviewer for Claude Code sessions. Uses trail as its long-term memory layer: session artifacts (decisions, conventions, bug diagnoses) are distilled by buddy and POSTed to trail as F39 candidates, becoming cross-referenced neurons the next cc session can query via MCP. First real test of trail as agent-harness memory, and the reason F39 exists.

## Installation

### Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.3 — runtime + package script execution
- **[pnpm](https://pnpm.io)** ≥ 9 — monorepo workspace tool
- **macOS** (launchd supervisor) or **Linux** (systemd-user) for supervised mode; manual mode works on any POSIX system
- **API keys** in `.env` for the LLM features you want active (see `.env.example`)

### Clone + install dependencies

```bash
git clone https://github.com/broberg-ai/trail.git
cd trail
pnpm install
```

### Symlink the `trail` CLI (recommended)

```bash
ln -sf "$(pwd)/scripts/trail" ~/.local/bin/trail   # or /usr/local/bin/trail
```

Make sure your PATH includes the target directory. From any directory `trail help` should now print the command list.

### Configure secrets

```bash
cp .env.example .env
$EDITOR .env
```

Minimum keys for full functionality:

- `OPENROUTER_API_KEY` — F149 ingest fallback chain (Flash/GLM/Qwen/Sonnet) + F25 vision fallback
- `OPENAI_API_KEY` — F47 audio transcription via Whisper
- `ANTHROPIC_API_KEY` — optional; if set, vision + ingest prefer the native Anthropic API path
- `TRAIL_SECRETS_MASTER_KEY` — generate with `openssl rand -base64 32`; required for F149's encrypted `tenant_secrets`

The CLI tolerates missing keys: features that need a particular provider gracefully fall back or skip. Run `trail start` and watch the logs to see which subsystems initialise.

### Run database migrations

```bash
bun run packages/db/src/migrate.ts
```

Creates `data/trail.db` if missing and applies all pending migrations. Idempotent — safe to re-run.

### Start trail

```bash
trail start              # foreground processes managed by the script
trail status             # see what's running and which supervisor mode is active
trail logs -f            # follow engine + admin logs
open http://127.0.0.1:58031
```

Without a supervisor installed, `trail start` spawns engine + admin via `nohup` and tracks PIDs in `~/.trail/`. The processes survive shell-detach but **not** macOS sleep/wake or unexpected crashes — for that, install the daemon (next section).

## Installing the auto-restart daemon

For local development that mirrors production stability, install the OS-native supervisor. It adds a KeepAlive loop that auto-restarts trail within ~10 seconds of any exit (crash, manual kill, sleep/wake), and starts the services automatically at user login.

### One-shot install

```bash
trail install-daemon
```

`trail` detects your platform and dispatches to the right installer:

- **macOS** → `scripts/install-launchd.sh` writes `~/Library/LaunchAgents/dk.broberg.trail.{engine,admin}.plist` and `launchctl load`s them
- **Linux** → `scripts/install-systemd.sh` writes `~/.config/systemd/user/trail-{engine,admin}.service`, runs `daemon-reload`, and offers `sudo loginctl enable-linger` so trail survives logout
- **Windows** → not yet supported; the installer prints a pointer to WSL2

The CLI's `start/stop/restart/status` automatically route through the supervisor once it's installed — same UX, but now with auto-restart:

```bash
trail status
# supervisor: launchd (gui/501)
# engine :58021  pid 27632
# admin  :58031  pid 27640

trail restart            # → launchctl kickstart -k (or systemctl --user restart)
```

### Verify auto-restart

```bash
ENGINE_PID=$(launchctl list | awk '/dk\.broberg\.trail\.engine$/{print $1}')
kill "$ENGINE_PID"
sleep 12
trail status             # engine PID should now be different — supervisor respawned it
```

### Remove the daemon

```bash
trail uninstall-daemon
```

Reverts to manual `nohup` mode. State under `~/.trail/` (logs, ingest token, db) is untouched.

### Templates

The plists and unit files are committed under `infra/launchd/` and `infra/systemd/`. They use `__REPO__` and `__HOME__` placeholders that the installer substitutes at install time, so you can clone trail anywhere on disk and `trail install-daemon` does the right thing.

## Architecture

trail is a pnpm + Turbo monorepo:

```
trail/
├── apps/
│   ├── server/    # Hono API (core engine)
│   ├── admin/     # Curator dashboard (Vite+Preact)
│   ├── mcp/       # MCP server for LLM integrations
│   └── widget/    # Embeddable <trail-chat> web component
├── packages/
│   ├── core/      # Ingest, compile, query, lint
│   ├── db/        # Drizzle + SQLite schema
│   ├── storage/   # Local FS + R2 abstraction
│   ├── llm/       # Multi-provider adapter
│   ├── pipelines/ # PDF, vision, web, video
│   └── shared/    # Types + Zod schemas
└── adapters/      # CMS adapters (Phase 2+)
```

## License

**FSL-1.1-Apache-2.0** — Functional Source License, converts to Apache 2.0 after 2 years.

You can use trail freely for your own knowledge bases, research, and internal tools. You cannot offer trail as a competing commercial SaaS. See [LICENSE](./LICENSE) for details.

## Related

- [trailcloud.com](https://trailcloud.com) — managed SaaS (coming soon)
- [trail.wiki](https://trail.wiki) — documentation (coming soon)
- [@webhouse/cms](https://webhouse.app) — CMS with trail adapter (Phase 2)
