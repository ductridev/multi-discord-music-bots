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

### 2026-07-31 — Execution: all 9 tasks (branch `feat/slash-command-migration`)

22 commits off `e289dc6`. Type-check, build and the `BotResolver` spec pass. **Nothing has run against a live Discord connection and no `BotConfig` row was mutated** — see `docs/superpowers/2026-07-31-slash-migration-manual-test-plan.md`.

Executed subagent-driven: one implementer per task, a spec+quality review after each, and a whole-branch review at the end. Every task except 8 and 9 needed one fix round. Consolidated report of deviations, per the standing "fix everything, report at the end" instruction:

**Plan deviations (2 approved by you, rest adjudicated by me)**

- **`vcToBot` maps a channel to an array, `BotMeta` gains `hasActivePlayer`** *(you approved)*. Two fleet bots can share a voice channel; the single-value map dropped one by cache iteration order, so rung 1 could hand a command to an idle co-occupant instead of the bot holding the queue. `master:MessageCreate.ts:125-131` has the same defect. Supersedes "priority ladder, unchanged from today".
- **`Context.delegated` returns `Context | null`** *(you approved)*. It previously set `client` unconditionally but swapped `guild`/`channel` behind `if` guards, so a cache miss produced a half-swapped context — chosen bot plays, receiver posts, silently. Both delegation paths now fall back to handling the command locally.
- **Dropped `resolveBot(opts.preferPrefix)`, added `receiver`.** The spec listed `preferPrefix`, but the spec also kept the prefix path's own inline selection, so it would have shipped with zero callers. `receiver` fixes a real gap the spec missed: without it an idle receiving bot delegates to whichever bot sorts first, causing handoffs for no reason.
- **`runCommandFor` gained `onGuardsPassed`.** My first draft announced the handoff before running guards, so a user with no voice channel saw "Bot2 will handle this" then "you're not in a voice channel".
- **Guard order is not the prefix path's order.** My plan's prose claimed it was. `MessageCreate` runs maintenance late, nested inside `command.player.voice` and after the vote gate; here it runs first. The `player?.voice` scoping is preserved. The property that is preserved is the one that matters: busy last.
- **Added a channel-level `ViewChannel`/`SendMessages` guard.** My plan dropped the channel-level check `MessageCreate.ts:225` has. It matters more under delegation: a prefix command was necessarily received in a channel the bot could see, but a delegated command sends through the *chosen* bot into a channel only the *receiver* was known to reach.
- **The setup-channel check stays above the early bail, and `getSetup` is now cached.** I claimed there was "no net regression" from bailing first. That was wrong — the old code emitted `setupSystem` for any setup-channel message regardless of content, and `SetupSystem.run` always ends in `message.delete()`, so attachment-only posts were consumed. Caching `getSetup` (including the `null` result) keeps the query the bail was meant to remove.

**Corrections to my own plan**

- The plan claimed `sendDeferMessage` "discarded its content argument". False: the channel path already used it, and the interaction path discards it inherently because `deferReply()` takes no content. Only the `deferred || replied` guard was a real change. Commit `86cf0f7`'s message carries the wrong claim; not rewriting history.
- The plan called a 2-space locale reformat "expected and acceptable". It produced a 1.7 MB diff — 16,479 insertions for ~95 added lines. Locale files are mostly tab-indented with no trailing newline, but Thai is 2-space and Italian/Russian are internally inconsistent, so the scripts now detect each file's own indent. 16 of 19 round-trip byte-identically; the other three normalize, content verified semantically unchanged across all 19.
- The plan's Global Constraints list `npm run lint` as a verification command. No eslint config exists anywhere in this repo's history, so it cannot run.

**A rejected review finding worth recording.** The whole-branch reviewer reported, as Critical, that slash commands never register at all — `PortuguesePT` and a stray `vi.json` poisoning `name_localizations` with an `undefined` key. Disproven twice: `i18n.getLocales()` returns exactly the 15 `Language`-enum keys, all valid discord.js locales, and `descriptionLocalization` (the only function that would double-map key→value→key) is defined but never called. The investigation did surface a real adjacent bug though — `Lavamusic.ts` called `T(Locale.Vietnamese, ...)`, passing the value `'vi'` instead of the key `'Vietnamese'`, and since i18n defaults `updateFiles: true` it had auto-created that stray `locales/vi.json`. Three call sites fixed, file deleted.

**Critical fallout from defer-first that reached outside the task.** Deferring before anything else was my design decision, and it broke two things elsewhere:
- `Context.sendMessage` took its `followUp` branch whenever the interaction was deferred — now always — so the deferred reply was never edited and every one of 239 call sites left a stuck "thinking" placeholder.
- `Utils.paginate` branched on `ctx.isInteraction` (source type) rather than send mode, so a delegated context called `reply()` on an already-deferred interaction. `/queue`, `/lavalink` and `/guildlist` failed every time they delegated.

Both now route through `Context`, which also gives the chosen bot ownership of its own collectors.

**Incidental bugs found and fixed while in the area:** `restoreBackup` and the `Setup` bulk-restore path bypassed the new caches (fixed with explicit invalidation); the audit-log `EmbedBuilder` sat unguarded inside a `finally`, so a bot with no avatar turned a successful command into a failure; the cooldown was stamped before the busy check, rate-limiting commands that never ran; a throw after the defer escaped to the global `unhandledRejection` handler and left the interaction spinning forever.

**Ledger with every adjudication and deferred minor:** `.superpowers/sdd/2026-07-31-slash-command-migration/progress.md`. Kept rather than deleted, since manual testing has not happened yet.

---

## CodeRabbit review round on PR #1 (2026-07-31)

16 inline findings. Five were real code defects, two I rejected with evidence, the rest were the plan and spec documents having drifted from what actually shipped during the fix waves.

**Real code defects fixed**

- **`buildBotMeta` read the occupant id from `voiceState.member?.user.id`.** That depends on the per-client `GuildMember` cache, and `GuildMembers` was dropped from the intent list back in June. A cache miss made an occupied bot look idle, so the resolver could hand a second command to a bot already playing. Now reads `voiceState.id`, which is the user id straight off Discord's voice-state payload and never depends on a member cache. This was the most consequential finding in the set — it silently degrades the routing the whole feature exists to provide.
- **The rejected client was left alive before the intent-fallback client logged in.** `shardStart` created a client, `start()` rejected on `Used disallowed intents`, and the reference went out of scope still holding its REST agent, its sweeper intervals and whatever the `Lavamusic` constructor registered — while a second client logged in on the same token. Hoisted the reference and `destroy()`d it first.
- **A member cache miss during delegation fell back to the receiver's member.** Both `Context.delegated` and the mention path did `resolve(...) ?? ctx.member`, which is exactly the mismatch the member swap exists to prevent: guards would validate the receiver's view of the user's voice state while the chosen bot executed. A miss now cancels the delegation, matching how a missing guild or channel is already treated. CodeRabbit only flagged the mention path; the slash path had the identical bug.
- **The audit-log embed still forced `iconURL` non-null.** The surrounding `try` (added in an earlier round) stops this from failing the command, but an avatarless bot still lost its audit log entirely. `?? undefined` omits the icon instead.

**Findings rejected, with reasons**

- *"Check gateway close code `4014` before relying on the error text."* There is no close code to check. `@discordjs/ws@1.2.3` (`dist/index.js:1149-1153`) handles `GatewayCloseCodes.DisallowedIntents` by emitting `new Error("Used disallowed intents")` — a bare `Error` with no `code` property and no `4014` anywhere on it. A `code === 4014` branch would be dead code that reads as a safety net.
- *"Drop the English fallback values so `retryInDefaultLocale` resolves the configured default."* The configured default is **Vietnamese**. Removing the English fallback from `French.json` would show French users Vietnamese, not English — strictly worse. The real problem CodeRabbit was circling is that the values were untranslated at all, so I translated them: `delegated_to_bot`, `prefix_deprecated`, `voice_channel_full` and `maintenance` across all 17 non-English/Vietnamese locales, 62 changed values, placeholders verified intact and each string round-tripped through `T()`. Files that already carried a real translation were left untouched by matching on the exact English fallback string.

**Deleted `scripts/add-interaction-locale-keys.js` and `scripts/invert-deprecation-notice.js`.** Both were spent one-shot migrations. Worse than dead: re-running either would now overwrite the translations above with English again.

**Document drift — the bulk of the findings.** Findings against the plan's cooldown ordering, post-defer error boundary, `voiceStates.cache` lookup, setup-channel ordering and audit-log guarding were all reporting code the plan document *proposed*, not code that shipped — each had already been fixed in a review round without the plan being updated. Those snippets are now synchronized with the shipped files. Two exceptions where I annotated instead of rewriting: the `BotResolver` Step 1/2 blocks keep the pre-deviation single-occupant shape with an explicit banner naming the shipped file as authoritative, because they are the record of what was planned before the multi-occupant deviation was approved mid-execution.

**Setup-channel gap promoted to a release blocker** with a named owner and the 2026-08-27 deadline, and the recommended fix named (drop the slash rejection in `InteractionCreate.ts` unconditionally — gating it on `messageContentIntent` becomes dead code the moment the revocation lands). It still does not block merging this branch, because it is the intent loss meeting a pre-existing feature rather than a regression here. It does block calling the migration complete.

**Three manual tests could never have passed as written.** Tests 1, 5, 6 and 10 in the test plan all set up "all bots idle" and then expected delegation. Rung 2 of the ladder hands the command straight back to an idle receiver, so those tests would have resolved `receiver_idle`, the invoked bot would have done the work, and the test would have looked like a pass while exercising none of the delegation code. Each now parks the receiving bot in another voice channel and asserts on the `any_idle` debug line. This was a genuine error in my own test plan, and it was the finding most likely to have produced false confidence.

**Three nitpicks I initially missed.** CodeRabbit collapses low-severity findings inside the review *body*, not the inline-comment endpoint. I pulled `/pulls/1/comments` and reported on 16 findings without ever reading the 15 KB review body, so three were silently skipped. All three were fair:

- **`let locale = 'Vietnamese'` ignored the configured default.** `env.DEFAULT_LANGUAGE || 'Vietnamese'` is the established idiom at five existing sites including `CommandGuards.ts:41`; `InteractionCreate.ts` and `CommandRunner.ts` were the outliers. Reached through `client.env` rather than adding an `env` import, matching `CommandGuards`.
- **`buildBotMeta` had no test coverage at all** — the eight existing cases only exercised `resolveBot` with hand-built metadata, which is exactly why the `voiceState.member` bug survived to review. Five cases added: occupant grouping, humans excluded, `hasActivePlayer` from `queue.current` rather than presence, a null `channelId` not counting as occupancy, and an end-to-end case where the queue holder wins rung 1 while being both uncached and listed second. Case 10 was verified to fail against the old `voiceState.member?.user.id` line (`undefined` instead of `['A']`) before being kept, so it is a real regression guard and not a test written to pass.
- **The prefix deprecation notice fired on every prefix command**, doubling message volume and channel rate-limit pressure for the whole migration window. Throttled to once per six hours, keyed `guildId:userId` rather than by guild as suggested — the notice exists to retrain each individual, and a guild-wide throttle would let one person's command suppress everyone else's only warning. The map is unbounded by design: one small entry per prefix user, on a code path deleted when the revocation completes.

**Latent bug found while checking the locale default, deliberately not fixed.** `I18n.ts:11` reads `typeof defaultLanguage === 'string' ? defaultLanguage : 'Vietnamese'`, but `defaultLanguage` is the default export of `src/config.ts`, which is an object of colors and emoji — never a string. So i18n's `defaultLocale` is hardcoded to Vietnamese in practice and `env.DEFAULT_LANGUAGE` never reaches `retryInDefaultLocale`. This is the mechanism behind the rejected "drop the English fallbacks" finding: those fallbacks are load-bearing precisely because the retry locale is always Vietnamese. Fixing it would change the fallback language for any deployment that sets `DEFAULT_LANGUAGE`, and `env.ts` types it as a bare `z.string()` with no validation against the `Language` enum, so an unrecognized value would break i18n rather than degrade. Out of scope for this migration; worth its own change.

## The I18n default-locale bug, fixed (2026-07-31)

Flagged in the previous round and deferred; fixed on request. Three things had to move together.

**The bug.** `I18n.ts` read `typeof defaultLanguage === 'string' ? defaultLanguage : 'Vietnamese'` where `defaultLanguage` was the default export of `src/config.ts` — an object of colours and emoji, never a string. The ternary was always false, so i18n's `defaultLocale` was hardcoded to Vietnamese and `DEFAULT_LANGUAGE` never reached it. **This was live, not theoretical: this deployment's `.env` sets `DEFAULT_LANGUAGE=EnglishUS`**, so every missing-key lookup in every locale has been retrying into Vietnamese.

**One validated constant instead of six copies.** `env.DEFAULT_LANGUAGE || 'Vietnamese'` was pasted at six call sites, so fixing i18n alone would have left them able to disagree with it. `I18n.ts` now exports `DEFAULT_LOCALE`, validated once against the `Language` enum, and all six sites use it: `Context.locale`, `CommandGuards`, `CommandRunner`, `InteractionCreate`, `LiveLyricsService` (both branches) and `ServerData.getLanguage`. `Language.ts`'s local `defaultLanguage` too.

Validation degrades rather than throws. `env.ts` types `DEFAULT_LANGUAGE` as a bare `z.string()`, and i18n only loads the locales the `Language` enum names — 15 of the 19 locale files, since Dutch, Italian, PortuguesePT and Thai are commented out. A `.env` typo should not take the fleet offline at boot, so an unrecognised value logs a warning naming the fix and falls back to Vietnamese. Verified: `DEFAULT_LANGUAGE=Klingon` and `=Thai` both warn and fall back; `=EnglishUS` is honoured.

**The regression this fix would have shipped on its own.** 16 of the 19 locale files have no `maintenance.*` namespace at all — only ChineseCN, ChineseTW, Dutch and Vietnamese do. Under the old broken default those 16 retried into Vietnamese and rendered Vietnamese text in an otherwise-English embed: ugly, but words. With the default correctly resolving to EnglishUS, they would have retried into EnglishUS, which *also* lacks the namespace, fallen through to `missingKeyFn` and rendered the literal string `maintenance.title` to users. Strictly worse.

So `maintenance.*` was added to `EnglishUS.json` — all 16 keys the code actually references, placeholders `{author}` and `{count}/{total}` preserved. Adding it to the default locale fixes every locale at once through the retry, for 16 strings instead of 256. The other 15 now show English there, which is the same fallback posture as the rest of this branch and better than the Vietnamese they showed before. Verified: Norwegian and Turkish resolve English maintenance text, ChineseCN keeps its own.

**`updateFiles: false`.** i18n defaults it to true, which makes a missing key write itself into `locales/*.json` at runtime and a `T()` call with an unknown locale mint a whole new file. That is what created the stray `locales/vi.json` found earlier in this branch — and it bit again during this round: a single `T('Norwegian', 'event.interaction.nonexistent_key_xyz')` probe silently added that key to both `Norwegian.json` and `EnglishUS.json` on disk. Both were reverted, and the setting now closes the class. `missingKeyFn` already handles missing keys without touching disk.

## CLAUDE.md rewritten against the actual code (2026-07-31)

`/init` on a repo that already had a `CLAUDE.md`. Audited every claim in it rather than appending to it; enough was wrong that a rewrite was the smaller change.

**Corrections, not additions.** Four claims were false or half-true and were actively misleading:

- *"Required: `DATABASE_URL`, `NODES`."* Only `NODES` is required. `DATABASE_URL` is `.optional()` in `env.ts:38` despite Prisma needing it.
- *"`restoreSessions()` recreates players from `playerData-*.json`."* It reads `sessions-map.json` and stores raw strings; player recreation happens in `src/events/node/Connect.ts`. These are two unrelated systems that the old doc merged into one.
- The global-state list omitted `vcLocks` and `updateSession` — while the same document's "Critical Patterns" section used `vcLocks`.
- `registerBot` was attributed to `index.ts`; it is called from inside the client after login (`Lavamusic.ts:148`).

**The `dist/` gotcha promoted to the top.** `loadCommands`/`loadEvents` read `process.cwd()/dist`, including under `npm run dev`. Editing a command in `src/` and running `npm run dev` does nothing. This was in no doc anywhere and is the single most likely way to waste an hour here, so it leads the Architecture section rather than sitting in Pitfalls.

**Broken tooling documented as broken.** The old doc listed `npm run lint` as a normal workflow command. It exits 2 — there is no `eslint.config.*` and never was in git history. Dashboard `npm run lint` also fails, because `next lint` was removed in Next 16. Writing "use `npx eslint .` from `dashboard/`, root has no config" is more useful than a command that fails, and stops the next session from trying to fix its own environment. Same for `biome.json` and `tsup.config.ts`: present, uninstalled, uninvoked — labelled dead so nobody edits them expecting effect.

**Tests exist now and had no entry.** `src/utils/BotResolver.spec.ts` is a self-executing `node:assert` script with no runner and no npm script. Documented with the exact invocation plus the convention to follow, since "no test framework" would otherwise keep being rediscovered and a runner keeps getting proposed.

**Left out deliberately.** `.github/copilot-instructions.md` covers the same architecture at ~700 lines. CLAUDE.md is read on every session, so it stays scannable and points at the long version rather than duplicating it. Per-model tables, the full endpoint list and the service inventory are all discoverable and were cut.

**Flagged, not fixed.** The prefix half of `MessageCreate.ts` (lines ~213-692) is a second implementation of routing, guards and audit logging that the slash and mention paths no longer share. A guard changed only in `CommandGuards.ts` will silently not apply to prefix commands. Documented as a pitfall; the real fix is to route the prefix path through `runCommandFor` or to finish deleting it.

## Prefix path routed through the shared helpers (2026-07-31)

The flagged duplicate: `MessageCreate.ts` lines 213-692 were a second implementation of routing, guards, audit logging and usage tracking that the slash and mention paths had already moved into `BotResolver`/`CommandGuards`/`CommandRunner`. A guard changed in one place silently did not apply to prefix commands. 545 lines out of `MessageCreate.ts`, 475 deletions net across the change.

**No delegation on the prefix path, deliberately.** The slash and mention paths delegate by swapping four fields of `Context` onto the chosen bot's caches, because only the receiving bot got the event. Prefix is different: every bot receives the message and runs the same resolution, so the chosen bot can handle its own event and the rest return on one line. Adding a delegation limb would have meant a third copy of the identity-swap logic on a code path scheduled for deletion when the MessageContent intent is revoked. The gate stays on the *chosen* bot rather than moving to the receiver, which also preserves exactly who answers today.

**`pickReceiver` extracted rather than inlined.** The old selection ladder mixed "which bot did the user address" (prefix match, global-prefix hash) with "which bot is free" (VC occupancy, idle). `resolveBot` already owned the second half, so only the first needed a home. It went into `BotResolver.ts` as a generic pure function specifically so it could be tested: every instance must derive the same receiver from the same message or one command gets answered twice, and that property was previously untested. Tests 14-17 cover named prefix, hash distribution and its cross-instance stability, an unknown prefix, and duplicate prefixes.

**The busy gate now only applies to voice commands** (`CommandGuards.ts` check 10). This is a behaviour change to the slash path too, and it is the one place the unification could not be purely mechanical. Old prefix code only set `valid = false` inside the `userVCId` branch, so a user *not* in a voice channel never saw "all bots are busy"; `resolveBot` returns `all_busy` regardless. Routing the prefix path through the shared guard unchanged would have made `!help` fail whenever every bot happened to be playing elsewhere. Gating on `command.player?.voice` fixes that for both paths at once: busy only matters when a bot has to join something. Commands with `player.active` are unaffected — check 6 runs first and reports "nothing playing", which is the accurate message.

**Smaller things settled along the way.**

- The missing-arguments embed is a local `missingArgsEmbed` helper shared by the mention and prefix paths. It stayed out of `runGuards` on purpose: Discord enforces required options before a slash interaction is ever dispatched, and `ctx.args` there is an options array, so the same check would reject valid slash calls.
- The deprecation notice moved from a `finally` to `onGuardsPassed`. Same condition — the old `finally` sat inside a block that guard failures returned before reaching — but it now prints before the command's output rather than after.
- `if (this.client.childEnv.id === this.client.childEnv.id)` guarding the "no bots configured" reply was always true, so every instance replied. Now pinned to `activeBots[0]`.
- Audit log author is `Message - Command Logs` rather than `Mention - Command Logs`, since message-backed contexts now cover both.
- The prefix path emits `event.interaction.*` locale keys instead of `event.message.*`. Checked the pairs it now uses in `EnglishUS.json`: identical or near-identical wording, nothing slash-specific, so no user-visible change. The `event.message.*` equivalents are now unused but left in place.

Verified: `npx tsc --noEmit` clean, `npx ts-node src/utils/BotResolver.spec.ts` passes 17 blocks. Not exercised against a live Discord connection — the manual test plan in `docs/superpowers/` still applies, and the prefix path's real risk is cross-instance agreement, which only shows up with the fleet running.
