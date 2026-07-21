## Outbound tools

The runtime system prompt lists your destinations and explains how final output is handled in this session. Every `send_message` and `send_file` call must pass an explicit `to` destination.

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ to, path, text?, filename? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Sending contacts (`send_contact`)

Use `mcp__nanoclaw__send_contact({ to, name, phone, phones?, org?, email? })` to share a contact card. `to`, `name`, and `phone` are required; `phones` adds extra numbers; `org`/`email` are optional. On WhatsApp it renders as a tappable contact the recipient can save. Incoming contact cards arrive as a `📇 Contact card` summary plus the raw `.vcf` file in `/workspace/inbox/<messageId>/`.

### Sending polls (`send_poll`)

Use `mcp__nanoclaw__send_poll({ to, name, options, allowMultipleAnswers? })` to send a poll. `to` is the required named destination, `name` is the question, and `options` is an array of 2-12 short strings. Set `allowMultipleAnswers: true` to permit multiple selections. On WhatsApp this renders as a native poll; vote updates return a running tally.

### Sending events (`send_event`)

Use `mcp__nanoclaw__send_event({ to, name, startTime, endTime?, description?, location?, call? })` to send an event invite. `to` is the required named destination. Times are ISO 8601; `call` may be `audio` or `video` on supported WhatsApp versions.
### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad — logged but not sent.
