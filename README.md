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
