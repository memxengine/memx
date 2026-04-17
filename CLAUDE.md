# trail

## Peer intercom (buddy)

This workspace runs alongside other cc sessions in other repos (monitored by buddy).

**To reach Christian on his iPhone**: just answer naturally. Your reply
becomes a turn that lands in YOUR session's Chat tab on his phone via the
Stop hook → SSE pipe. No special tool needed. If Christian asks you to
"send X to my mobile", that means: write X as your normal response — he
will see it on the Chat tab for your session.

**To reach another cc session** (cc-to-cc — NOT visible on mobile), use
the buddy peer tools:

- `mcp__buddy__ask_peer({ to, message, reply_to? })` — direct 1:1 message to a named session (supports threading via `reply_to`)
- `mcp__buddy__announce({ message, severity?, affects? })` — broadcast FYI to same-repo peers

Use peer tools before disruptive changes, to delegate work the user asks
you to hand off, or to ask a peer that owns a different domain. Incoming
peer messages arrive as `<channel type="intercom" from="..." announcement_id="N">`
and live ONLY in the receiving cc's context — they are never auto-forwarded
to Christian's phone.
