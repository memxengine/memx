# trail

## Peer intercom (buddy)

This workspace runs alongside other cc sessions in other repos (monitored by buddy).
You **can and SHOULD** use the buddy peer tools to coordinate across sessions:

- `mcp__buddy__ask_peer({ to, message, reply_to? })` — direct 1:1 message to a named session (supports threading via `reply_to`)
- `mcp__buddy__announce({ message, severity?, affects? })` — broadcast FYI to same-repo peers

Use before disruptive changes, to delegate work the user asks you to hand off, or to ask a peer that owns a different domain. Incoming messages arrive as `<channel type="intercom" from="..." announcement_id="N">`.
