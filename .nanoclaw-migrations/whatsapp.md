# WhatsApp customizations

These behaviors are mandatory. The old implementation is available from the
backup tag and commits shown below, but the behavior must be adapted to the
current `upstream/channels` adapter and current host contracts.

## Native poll and event sending

Source commit: `d57be358`.

- Extend the agent `send_message` content schema/instructions with WhatsApp
  poll and event operations while preserving explicit destination addressing.
- Polls carry a question, option labels, and selectable count and are sent with
  Baileys `sock.sendMessage(jid, { poll: ... })`.
- Events use the Baileys event message shape and its current
  `EventMessageOptions` type.
- Preserve WhatsApp mention parsing and the sent-message cache required by
  later vote decryption.
- Preserve the reliable WA Web version resolver: try the wppconnect version
  tracker with a five-second timeout, fall back to
  `fetchLatestWaWebVersion`, and fail clearly instead of connecting with a
  stale hard-coded version.
- Reassess whether `patches/whatsapp-rust-bridge@0.5.4.patch` is still needed
  with current dependencies; retain only if the package still lacks the
  default export condition.

## Poll vote reception and decryption

Source commits: `2276301e`, `90e04185`, `ec1e847f`.

- Handle poll update messages from `messages.upsert`, not only the disabled or
  unavailable Baileys event path.
- Resolve the original poll creation message from the sent-message cache via
  `getMessage`, aggregate voter selections, and emit a readable poll update to
  the agent.
- Authenticate voters across phone JIDs, device-qualified JIDs, and LIDs.
  Translate LID identities to phone JIDs when possible and reject forged or
  unrelated updates.
- Keep inbound media staging in the same message-processing path; downloaded
  files must pass attachment-name safety checks and enter the session inbox.
- Retain regression tests for decryption, voter identity normalization,
  multi-voter aggregation, deselection, unknown polls, and media staging.

## Approval and ask-question cards as polls

Source commit: `56b8b79d`.

- Render two-to-twelve-option `ask_question`/approval cards as native
  single-select WhatsApp polls.
- Index question polls by sent message ID. Match selected options using SHA-256
  of the option label, invoke `onAction(questionId, value, answerer)`, then
  delete the pending poll state.
- Never forward an approval poll vote to the agent as an ordinary poll tally.
- Fall back to the existing textual slash-command card outside WhatsApp's poll
  option limits.
- Bound pending state and preserve confirmation delivery.

## Contact cards

Source commit: `a3b79d9c`.

- Accept outbound `{ operation: "contact", displayName, vcard }` and send a
  native Baileys contacts payload.
- Parse inbound `contactMessage` and `contactsArrayMessage`; surface formatted
  names and telephone numbers in message text.
- Stage every raw vCard as a safe `.vcf` attachment with MIME type
  `text/vcard`, byte size, and base64 content.
- Retain tests for single/multiple cards, missing names, telephone extraction,
  filename sanitization, and outbound cards.

## Replies and quoted messages

Source commit: `259661b1`.

- Extract `contextInfo` from text, image, video, document, audio, and sticker
  messages. Read `quotedMessage`, `participant`, and `stanzaId`.
- Summarize quoted content as text/caption or a stable type marker such as
  `[image]`, `[video]`, `[voice message]`, `[document: name]`, `[contact]`,
  `[location]`, or `[poll]`.
- Collapse whitespace and truncate quoted text to 300 characters.
- Identify bot-authored quotes using both phone JID and LID; render other
  authors with the best available LID-to-phone/name mapping.
- Attach `{ sender, text, id }` as reply context to the inbound message and
  ensure the current formatter presents it to the agent without allowing XML
  or provenance forgery.
- Retain the full `extractQuotedContext` and `summarizeQuotedMessage` regression
  suite from the source commit, adapted to current types.

## Group mentions and native adapter bug fixes

The baseline fork adapter also contains regression coverage for group bot
mentions and outbound `@<digits>` parsing. Preserve:

- Phone-JID and LID mention detection across text and captions.
- DMs being treated as engaged while unmentioned group messages remain unset.
- `@+number` normalization, deduplication, punctuation handling, and rejection
  of email-like or too-short tokens.
- Current Baileys v7 pairing/version behavior in `setup/whatsapp-auth.ts`.

## Required WhatsApp validation

- Unit tests for all items above.
- Adapter registration test.
- A container/host build with the pinned current Baileys version.
- Controlled smoke tests: receive a reply, image reply, poll vote, approval
  poll vote, contact card, and media attachment; send a poll, event, contact,
  mention, and thread reply.

