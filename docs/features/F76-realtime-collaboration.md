# F76 — Real-Time Collaboration (CRDT)

> Real-time multi-curator editing on the same wiki page via CRDT. Yjs most likely. Phase 3 scope — compile-at-ingest model means live editing is less critical than for traditional wikis.

## Problem

Når to curatorer editorer samme Neuron samtidigt, overskriver den sidste den første's ændringer. For store teams (Business/Enterprise tier) er dette en reel frustration — især når man arbejder på samme emne fra forskellige vinkler.

## Solution

Yjs CRDT integreres i Neuron editoren (F91). Hver editor connection deler et Yjs document der syncer ændringer i real-time via WebSocket. Konflikter resolves automatisk af CRDT — ingen "overskrevet" fejl.

Compile-at-ingest modellen betyder at live editing er mindre kritisk end i traditionelle wikis (LLM'en compiles alligevel), men for curator Korrektioner og noter er real-time sync værdifuldt.

## Technical Design

### 1. Yjs Document per Neuron

```typescript
// packages/core/src/collab/yjs-doc.ts

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

export function createCollabDoc(neuronId: string, wsUrl: string): {
  doc: Y.Doc;
  provider: WebsocketProvider;
  text: Y.Text;
} {
  const doc = new Y.Doc();
  const text = doc.getText('content');

  const provider = new WebsocketProvider(wsUrl, neuronId, doc, {
    connect: true,
  });

  return { doc, provider, text };
}
```

### 2. WebSocket Relay Server

```typescript
// apps/server/src/services/collab-relay.ts

import { WebSocketServer } from 'ws';
import { setupWSConnection } from 'y-websocket/bin/utils.js';

export function startCollabRelay(port: number = 4444): void {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (conn, req) => {
    const docName = req.url?.split('/').pop();
    if (!docName) return;

    // Auth check via token in query params
    const token = req.url?.split('token=')[1]?.split('&')[0];
    if (!validateToken(token)) {
      conn.close(4001, 'Unauthorized');
      return;
    }

    setupWSConnection(conn, req, { docName });
  });

  console.log(`[collab] relay started on port ${port}`);
}
```

### 3. Editor Integration

```typescript
// apps/admin/src/components/collab-editor.tsx

import { useEffect, useRef } from 'preact/hooks';
import { createCollabDoc } from '@trail/core';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin } from 'y-prosemirror';

export function CollabEditor({ neuronId, wsUrl }: { neuronId: string; wsUrl: string }) {
  const editorRef = useRef(null);

  useEffect(() => {
    const { doc, provider, text } = createCollabDoc(neuronId, wsUrl);

    // Initialize ProseMirror with Yjs plugins
    const view = new EditorView(editorRef.current, {
      state: EditorState.create({
        schema,
        plugins: [
          ySyncPlugin(text),
          yCursorPlugin(provider.awareness),
          yUndoPlugin(),
        ],
      }),
    });

    // Load initial content from server
    fetch(`/api/v1/documents/${neuronId}/content`)
      .then(r => r.json())
      .then(data => {
        if (data.content && text.length === 0) {
          doc.transact(() => {
            text.insert(0, data.content);
          });
        }
      });

    return () => {
      view.destroy();
      provider.destroy();
      doc.destroy();
    };
  }, [neuronId, wsUrl]);

  return h('div', { ref: editorRef, class: 'collab-editor' });
}
```

### 4. Awareness (Cursor Presence)

```typescript
// apps/admin/src/components/collab-cursors.tsx

// Show other users' cursors in real-time
const provider.awareness.on('change', () => {
  const states = Array.from(provider.awareness.getStates().values());
  states.forEach((state) => {
    if (state.user) {
      // Render cursor at position
      renderCursor(state.user, state.cursor);
    }
  });
});
```

## Impact Analysis

### Files created (new)
- `packages/core/src/collab/yjs-doc.ts` — Yjs document factory
- `apps/server/src/services/collab-relay.ts` — WebSocket relay
- `apps/admin/src/components/collab-editor.tsx` — collaborative editor
- `apps/admin/src/components/collab-cursors.tsx` — cursor presence

### Files modified
- `apps/server/src/app.ts` — start collab relay on boot
- `apps/admin/src/components/neuron-editor.tsx` — optional collab mode

### Downstream dependents for modified files

All modifications are additive.

### Blast radius
- WebSocket relay is a separate server — adds operational complexity
- Yjs adds ~30KB to editor bundle
- Awareness/cursor data is ephemeral — no persistence needed
- Compile-at-ingest means CRDT only matters for curator edits, not LLM compiles

### Breaking changes
None. Collab is opt-in per editor session.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Integration: Two browser tabs editing same neuron → changes sync in real-time
- [ ] Integration: Cursors visible for other editors
- [ ] Integration: Disconnect/reconnect → state syncs correctly
- [ ] Load test: 10 concurrent editors on same neuron
- [ ] Regression: Single-user editor unchanged

## Implementation Steps

1. Add yjs, y-websocket, y-prosemirror dependencies
2. Create Yjs document factory
3. Create WebSocket relay server
4. Create collaborative editor component
5. Add cursor presence UI
6. Integration test: multi-user editing
7. Load test with concurrent editors

## Dependencies

- F91 (Neuron Editor) — collab extends the editor
- F16 (Wiki Events) — collab edits still generate events

## Effort Estimate

**Medium** — 3-4 days

- Day 1: Yjs setup + WebSocket relay
- Day 2: Editor integration + sync plugins
- Day 3: Cursor presence + awareness
- Day 4: Testing + polish
