# Implementation Notes

## 2026-06-12 — `lavaconfig` bug fixes

### Bugs reported by user
1. `Đang xử lý yêu cầu của bạn... ⚙️` placeholder text not cleared when embed result is rendered.
2. Result embed rendered with literal `undefined` for `{source}` / `{nodeId}` placeholders (e.g. `Đã cập nhật cấu hình undefined cho node undefined`).
3. `cmd.lavaconfig.messages.updated_config` rendered as raw key — missing translation.

### Root causes
- **Stale defer content**: `ctx.sendDeferMessage(string)` for prefix-command path sends `channel.send("Processing...")`, creating a `Message` with `content` populated. The follow-up `ctx.editMessage({ embeds: [embed] })` does not clear `content` in discord.js v14, so the placeholder text persists above the embed. Slash-command path is unaffected because `interaction.deferReply()` carries no content.
- **Placeholder key mismatch**: 7 locale files (`Vietnamese`, `Russian`, `Polish`, `PortuguesePT`, `SpanishES`, `Turkish`, `Thai`) wrote `{service}` and `{node}` in `config_updated_desc`, but `src/commands/dev/LavaConfig.ts:336` passes params named `{ source, nodeId }`. i18n `__mf` (ICU MessageFormat) renders unmatched placeholders as `undefined`.
- **Missing key**: Same 7 locales never defined `updated_config` (the field label used by `updateAndRespond`). i18n `missingKeyFn` returns the raw key.

### Fixes applied
- `src/commands/dev/LavaConfig.ts` — all 4 `ctx.editMessage` calls now pass `{ content: '', embeds: [embed] }` to wipe the placeholder text on the prefix-command path.
- 7 locale files patched (lavaconfig.messages block):
  - `{service}` → `{source}`, `{node}` → `{nodeId}` in `config_updated_desc`.
  - Added `updated_config` translation.
  - Added `{source}` placeholder to `config_updated_title` and `{nodeId}` to `view_title` so the rendered embed surfaces the same info as English.

### Decisions / trade-offs
- Did **not** touch the other 13 locales — they already had correct placeholders and key set.
- Did **not** add field-presence validation to update handlers (e.g. rejecting `lavaconfig spotify node:main` with no actual config keys). The `removeUndefined` helper in `LavaSrcConfigService` strips empties so the server gets `{}` and the UI still claims success. Left as-is — out of scope for the reported bugs; can be tightened later if it bites.
- Did **not** loosen `preferAnonymousToken` boolean parsing (`'1'`/`'yes'` are still rejected). Out of scope.
- Did **not** add `content: ''` to other dev commands using the same `sendDeferMessage` → `editMessage` pattern (e.g. `YouTubeConfig.ts`). Scope kept to `lavaconfig` per request. Same fix should be applied there if it manifests.

### Verification
- `npx tsc --noEmit` — clean.
- All 7 patched locales parse as valid JSON.

## 2026-06-13 — `youtubeconfig` same-pattern fixes

### Changes
- `src/commands/dev/YouTubeConfig.ts` — all 6 `ctx.editMessage({ embeds: [embed] })` now pass `content: ''` for prefix-command path.
- Same 7 locale files (`Vietnamese`, `Russian`, `Polish`, `PortuguesePT`, `SpanishES`, `Turkish`, `Thai`) patched in `youtubeconfig` block:
  - Added missing `oauth_updated_desc`, `potoken_updated_desc`, `token_refreshed_desc` keys (i18n was rendering raw keys before).
  - Added `{nodeId}` placeholder to `view_title`.
  - Added missing `no_nodes`, `total_nodes` message keys.
  - Added missing field keys used by handler embeds: `token_type`, `expires_in`, `scope`, `access_token_truncated`, `updated`, `not_changed`, `yes`, `no`, `important`, `oauth_warning`, `how_to_generate`, `generator_link`, `note`, `api_note`.
  - Rewrote `*_updated_title` keys to match English emoji-prefixed style.

### Verification
- `npx tsc --noEmit` — clean.
- All 7 patched locales parse as valid JSON.

## 2026-07-31 — Slash command migration design (spec only, no code yet)

Spec: `docs/superpowers/specs/2026-07-31-slash-command-migration-design.md`

### Driver
Discord grants `MessageContent` to zero bots in this fleet; intent is disabled fleet-wide in ~27 days. Prefix commands are the primary interface today and stop working at that point.

### Decisions not in the original request
- **Mention entry point added.** Not asked for, but Discord delivers message content with no privileged intent when the bot is @mentioned, so `@Bot play song` survives the cutoff. Gives prefix users a migration path that isn't "learn slash commands." Uses the same delegation path as slash, since only the mentioned bot receives content.
- **Prefix consensus path deliberately not refactored.** It works and it is deleted in 27 days. Gets only the intent gate and the empty-content early-bail. Accepting ~1 month of duplicated guard logic rather than refactoring a working path under a hard deadline — the duplication resolves by deletion, not by refactor.
- **Handoff notice is public, not ephemeral.** Reversed from the initial plan. Forced by the 3s interaction ack deadline: `deferReply()` must be the first statement (the vote check alone has a 5s timeout, and `getLanguage` is uncached), and a deferred public reply cannot become ephemeral. Deferring ephemerally would hide self-handled replies, including "now playing", from everyone but the invoker. Cost: two messages per delegated command.
- **Explicit `messageContentIntent` flag on `BotConfig`** rather than catching the login error and auto-retrying without the intent. A bot requesting an unheld intent fails login with `Used disallowed intents`; auto-retry would hide a real config problem behind a retry.

### Verified during design (not assumed)
- Commands take `client` as an argument, not `ctx.client`. Only `Ping.ts:99` uses `ctx.client`, and it is not a player command. This is what makes cross-bot delegation cheap rather than a 77-command audit.
- Player-control buttons are attached to messages the chosen bot sends from its own player events (`TrackStart.ts:287`), so its own collector handles them. No cross-bot button routing needed.
- Slash commands are already registered — `Ready.ts:35` auto-deploys on every boot. Zero registration work.
- `is247` is computed into `botMeta` but never used in the selection ladder.

### Corrected a flagged risk
Observation 16977 claims a race in `T()` (`setLocale` then `__mf` non-atomic). **Does not apply.** Both calls are synchronous with no await between them; on a single-threaded event loop the pair cannot interleave. The globally-registered `__` is unused. Still hardening `T()` to pass locale inline so the class of bug can't appear later, but no live defect exists.

### Bugs found in passing, folded into scope
- `MessageCreate` does 3 DB calls (`getSetup`, `getLanguage`, `getAllPrefixes`) before testing the prefix regex. Once content is empty fleet-wide, every message in every guild burns three queries then bails.
- `getLanguage` (`server.ts:92`) has no cache; hits MongoDB on every call, on every message.
- `sendDeferMessage` ignores its content argument for interaction contexts (observation 16971). Must be fixed because the delegated channel-send path relies on that argument.

### 2026-07-31 — Plan authoring notes

Plan: `docs/superpowers/plans/2026-07-31-slash-command-migration.md` (9 tasks)

Deviations from the spec, decided while writing the plan:

- **Dropped `resolveBot(opts.preferPrefix)`.** The spec listed it, but the spec also decided the prefix path keeps its own inline selection code — so the parameter would ship with zero callers. Removing it makes `buildBotMeta` fully synchronous, since `getPrefix` was its only await.
- **Added `resolveBot(receiver)` instead.** Without it, an idle receiving bot would delegate to whichever bot sorts first in `activeBots`, causing pointless handoffs. New ladder rung 2: the receiver, if idle. This is a real behavior improvement over the prefix ladder, not a port of it.
- **`runCommandFor` gained an `onGuardsPassed` callback.** First draft announced the handoff before running guards, so a user with no voice channel would see "Bot2 will handle this" followed by "you're not in a voice channel". The notice now fires only after guards pass. Guard failures and execution errors always answer through the receiver's interaction, since at guard time nothing has been announced.
- **`runGuards` uses `guild.members.me`, not `members.resolve(client.user.id)`.** Member caches are per-client; resolving the chosen bot's id against the receiver's guild cache can miss and produce a spurious `no_send_message` failure. `members.me` on the chosen bot's own guild object is always populated, with a `fetchMe()` fallback.
- **Mention-delegated contexts do not use `Context.delegated()`.** A message-backed context already has `sendMode: 'channel'`, so swapping `client`/`channel`/`guild` is enough. The factory exists only for interaction-backed contexts.
- **Omitted the `command.args && args.length === 0` check from `runGuards`.** Discord validates required slash options before delivery, so it can never fire there. The mention path keeps its own copy since mention args are free-form.
- **`ServerData.languageCache` is `static`.** Each bot builds its own `ServerData`, but guild language is not bot-specific — one shared map avoids N copies of the same value.

Verified before writing, so the plan contains no guesses: `Command`/`Context`/`Lavamusic` are exported from `src/structures/index`; `config.color.blue`, `env.DEFAULT_LANGUAGE`, `env.LOG_COMMANDS_ID` all exist; `locales/EnglishUS.json` is missing `event.message.voice_channel_full` and `.maintenance` that Vietnamese has, which is why the locale patcher falls back per-key rather than copying wholesale.

Known accepted cost: a delegated command produces two messages (receiver's handoff notice, chosen bot's output). Forced by the ack deadline — see spec.
