# Slash Command Migration with Cross-Bot Delegation

**Date:** 2026-07-31
**Status:** Approved design, pending implementation plan
**Deadline:** `MessageContent` intent is disabled on all bots in 27 days (~2026-08-27)

## Problem

Discord will not grant the `MessageContent` privileged intent to this fleet's bots. Zero bots are approved, and the intent is disabled fleet-wide in 27 days. Prefix commands (`!play`) are the primary interface today and will stop working entirely at that point.

Slash commands are already registered (`Ready.ts:35` calls `deployCommands()` on every boot) but are short-circuited to a deprecation notice at `InteractionCreate.ts:27`.

The hard part is not enabling slash commands. It is preserving the multi-bot free-bot routing that the prefix path provides.

## Why routing has to change shape

| | Prefix | Slash / Mention |
|---|---|---|
| Who receives the input | every bot instance | only the invoked/mentioned bot |
| Selection model | **consensus** — all instances independently compute the same winner | **delegation** — receiver picks a bot and hands off |
| Survives day 27 | no | yes |

The existing algorithm (`MessageCreate.ts:98-213`) reads Discord's real voice state rather than in-memory maps specifically so that every instance agrees on the winner. With slash commands nobody else is listening, so consensus is unnecessary and delegation is required instead.

## Architecture

### Shared resolver

Extract selection into `src/utils/BotResolver.ts`:

```
buildBotMeta(bots, guild, opts?: { withPrefixes?: boolean }) → BotMeta[]
resolveBot(voiceStates, botMeta, userVCId, opts?: { preferPrefix?: string })
  → { bot, valid, reason }
```

`buildBotMeta` is the impure half: it reads `guild.voiceStates.cache` to determine which bots are in a voice channel, and optionally performs the per-bot `getPrefix` lookups the prefix path needs. `resolveBot` is the pure half — it takes that prepared data and applies the ladder, which is what makes it testable without a Discord connection.

Priority ladder, unchanged from today:

1. Bot already in the user's voice channel
2. Idle bot whose prefix matches (prefix entry point only)
3. Any idle bot
4. None free → `valid: false`

Reads `guild.voiceStates.cache` for real voice state. `preferPrefix` is optional because slash and mention have no prefix to match on.

Note: the current implementation computes `is247` into `botMeta` but never uses it in the ladder. Dropping it, and skipping `getPrefix` for the slash and mention paths that have no prefix to match, makes `buildBotMeta` await-free for those entry points. That is not load-bearing for the ack deadline — the defer-first ordering below handles that — but it removes two database calls per slash command.

### Entry points

| Entry | Model | Lifespan |
|---|---|---|
| Slash `/play` | delegation | permanent |
| Mention `@Bot3 play song` | delegation | permanent |
| Prefix `!play` | consensus (existing code, untouched) | dies day 27 |

**The prefix path is deliberately not refactored.** It works, and it is deleted in 27 days. Rewriting it to share the resolver produces code that gets thrown away next month. It receives only the intent gate and the early-bail guard described below.

### Delegation

When `resolveBot` returns a bot other than the receiver:

1. Receiver edits its deferred reply to a handoff notice: "Bot2 will handle this — it's free and joining your channel."
2. Chosen bot executes `command.run(chosenBot, delegatedCtx, args)`.
3. `delegatedCtx` emits output via `channel.send()` on the **chosen** bot's client.

The chosen bot owns every message it posts, so its buttons, collectors (`Search.ts`), embeds, name, and avatar are all self-consistent. No interaction token crosses a client boundary.

This was verified to be low-risk: commands take `client` as an argument rather than reading `ctx.client`. Only `Ping.ts:99` uses `ctx.client`, and it is not a player command. Player-control buttons are attached to messages the chosen bot sends from its own player events (`TrackStart.ts:287`), so its own collector handles them.

When the chosen bot *is* the receiver — the common case — it replies through the interaction normally with no handoff notice.

### Mention parsing

`MessageCreate.ts:66` currently matches `^<@!?id>( |)$`, anchored to end-of-string, so only a lone mention matches. It becomes a prefix match:

- `@Bot` → help (existing behavior, unchanged)
- `@Bot play song` → strip mention, feed remainder through existing `parseArgsWithQuotes`, resolve, delegate

Discord delivers message content with no privileged intent when the bot is mentioned, so this survives day 27 and gives prefix users a migration path that is not "learn slash commands."

## Context: split two conflated modes

`Context.isInteraction` currently drives two unrelated concerns — how args are parsed and where replies go. Delegation needs them separated:

```
sourceType: 'interaction' | 'message'   // drives setArgs() and options.get()
sendMode:   'interaction' | 'channel'   // drives sendMessage/editMessage/sendDeferMessage
```

A delegated context is `sourceType: 'interaction'` (so `ctx.options.get('song')` still reads the receiver's interaction payload) with `sendMode: 'channel'` (so output goes through the chosen bot).

New factory:

```
Context.delegated(interaction, chosenBot)
  → client/guild/channel swapped to chosenBot's cached objects, sendMode 'channel'
```

Enabling this requires the three send paths (`sendMessage`, `sendDeferMessage`, `sendFollowUp`) to use `this.channel` instead of `this.message?.channel`, which is `null` for interaction-backed contexts. `this.channel` is already populated by the constructor.

`sendDeferMessage` under `sendMode: 'channel'` cannot defer — there is nothing to defer — so it posts its content string immediately. This requires fixing the existing bug where the content argument is ignored for interaction contexts (observation 16971).

## Guard pipeline

`src/utils/CommandGuards.ts` exposes `runGuards(client, ctx, command) → { passed, reply? }`, operating on `Context` rather than on `Message` or `CommandInteraction`.

Order, preserved exactly from the prefix path:

1. maintenance
2. channel and client permissions
3. command permissions (client, user, dev)
4. vote
5. voice (channel present, user limit, connect, speak, stage, different-channel)
6. active player
7. DJ role
8. cooldown
9. `@everyone` / `@here` guard
10. **busy check last** — so users see the useful error before "all bots busy"

**Correctness fix carried in:** the guard must resolve `clientMember` from the **chosen** bot, not the receiver. The previously-commented code did `interaction.guild.members.resolve(this.client.user!)`, which under delegation would validate Bot1's permissions and then send Bot2 to join.

`runGuards` serves slash and mention only. `MessageCreate` keeps its inline copy until day 27, then that branch is deleted and the duplication resolves by deletion rather than by refactor. Carrying a month of duplication is preferable to refactoring a working path under a hard deadline.

DJ-role checks need the invoking user's `GuildMember`. The `GuildMembers` intent was dropped in `c44a32e`, so this is a `guild.members.fetch(userId)` REST call — cached after first use, but a network hop inside the guard path. Voice-state members come free from `GuildVoiceStates`, which is not privileged.

## Interaction ack deadline

Discord requires acknowledgement within 3 seconds. Two things in the current guard path exceed that on their own:

- the vote check has a 5-second timeout (`MessageCreate.ts:289`)
- `getLanguage` has no cache (`server.ts:92` hits MongoDB every call), so even producing a reply's locale is a network hop

**Fix:** `deferReply()` as the literal first statement of the slash handler, before any await. All guard failures and the handoff notice become `editReply`. Ack becomes structurally guaranteed rather than dependent on database latency.

**Consequence:** the handoff notice is public, not ephemeral. A deferred public reply cannot become ephemeral, and deferring ephemerally would make self-handled replies — including "now playing" — visible only to the invoker. So a delegated command produces two messages: the receiver's handoff notice and the chosen bot's output. This is forced by the ack deadline, not chosen. Public is defensible on its own merits, since bystanders learn why a different bot answered.

**Second fix:** cache `getLanguage` in a `Map` on `ServerData`, invalidated in `updateLanguage`. It is called on every message today and is the same lookup the day-27 empty-content path would waste.

## `T()` hardening

Observation 16977 flags a race in `T()`. **Verified not to apply.** `i18n.setLocale(locale)` and `i18n.__mf(...)` are both synchronous with no await between them, so on a single-threaded event loop the pair cannot interleave. Delegation adds concurrent callers but never a suspension point inside the critical section. The globally-registered `__` (from `register: global`, `I18n.ts:15`) is not used anywhere in the codebase.

Still worth removing the dependency on ambient mutable state, because the day an `await` is introduced between those lines the bug becomes real and silent:

```ts
export function T(locale: string, text: string | i18n.TranslateOptions, ...params: any) {
	return i18n.__mf({ phrase: text as string, locale }, ...params);
}
```

## Intent flag

```prisma
model BotConfig {
  messageContentIntent Boolean @default(true)
}
```

`shard.ts:43` builds its intent array from this flag. A bot requesting an intent it does not have fails login outright with `Used disallowed intents`, so this must be per-bot rather than global. Flip it off per bot as approvals lapse.

`GuildMessages` and `GuildVoiceStates` remain unconditional — neither is privileged, and `GuildMessages` is what continues to deliver mention messages.

Requires `npx prisma generate` and `npm run db:push`.

## Early-bail guard

Once `MessageContent` is off, `message.content` is empty on ordinary messages. `MessageCreate` currently performs three database calls — `getSetup` (line 55), `getLanguage` (59), `getAllPrefixes` (62) — *before* testing the prefix regex at line 89. Every message in every guild would burn three queries and bail at line 90.

Add a guard at the top of the handler: if content is empty and the message is not a mention, return immediately. Worth doing independent of this migration.

## Locale keys

`event.interaction.*` already has 20 keys from the previously-commented implementation. Missing and required:

- `voice_channel_full`
- `no_bots_configured`
- `no_free_bots`
- `maintenance`
- `delegated_to_bot` (new)

Five keys across 19 locale files. `retryInDefaultLocale: true` with a `missingKeyFn` that returns the raw key means a missing key falls back to Vietnamese, and if absent there too renders the literal string `event.interaction.delegated_to_bot` to users. Vietnamese and EnglishUS are mandatory; the rest should follow.

`slash_deprecated` is now inverted — it tells users to use prefix, which is about to die. Delete it; prefix replies gain a deprecation notice pointing at slash.

## Testing

`resolveBot` is a pure function over `(voiceStates, botMeta, userVCId)`. The repository has no test framework, so the check is `node:assert`-based and dependency-free, run as `node dist/utils/BotResolver.spec.js`.

Cases:

- bot already in the user's VC wins over an idle bot
- prefix-matched idle bot beats an arbitrary idle bot
- all bots busy in other VCs returns `valid: false`
- empty bot list returns `valid: false` without throwing

This is the component where a regression silently sends the wrong bot to the wrong channel, so it is the component that gets the check.

## Out of scope

- User-facing migration announcements. `docs/temporary-announcement-design.md` and the existing `PeriodicMessageSystem` are the vehicles; tracked as separate work.
- Refactoring the prefix consensus path to share the resolver. Deleted day 27 instead.
- Dashboard changes.
