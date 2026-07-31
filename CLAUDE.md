# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-instance Discord music bot system. One codebase powers multiple isolated bot instances simultaneously, sharing infrastructure (Lavalink nodes, MongoDB, Fastify API). TypeScript, Discord.js v14, lavalink-client (NOT DisTube), Prisma ORM + MongoDB, Fastify REST API, Next.js dashboard (`dashboard/`).

## Commands

```bash
# Development — ALWAYS build first, see "dist/ gotcha" below
npm run build            # tsc -> dist/
npm run dev              # ts-node src/index.ts (still loads commands/events from dist/)
npm start                # node dist/index.js
npm run dev:dashboard    # Next.js dashboard on :20082
npm run dev:all          # both concurrently

# Database (MongoDB + Prisma)
npm run db:push          # push schema, no migration files
npm run seed             # db:push + seed bots from prisma/bots.json
npx prisma generate      # REQUIRED after any schema.prisma change

# Type check — the real gate this repo relies on
npx tsc --noEmit
```

### Tests

No test runner is installed. Tests are executed by hand, one file at a time.

```bash
# Bot unit checks — plain node:assert, self-executing script
npx ts-node src/utils/BotResolver.spec.ts     # prints "BotResolver: all assertions passed"

# Dashboard E2E (Playwright). Dashboard must ALREADY be running on :20082 —
# webServer is commented out in dashboard/playwright.config.ts
cd dashboard
npx playwright test tests/stats-page.spec.ts
npx playwright test tests/stats-page.spec.ts -g "test name"   # single test
```

`dashboard/tests/stats-page.spec.ts` and `dashboard/playwright/auth.setup.ts` need `DASHBOARD_TEST_TOKEN` in `dashboard/.env`; empty token silently makes the suite meaningless.

New bot-side unit tests should follow `BotResolver.spec.ts`: numbered bare `assert` blocks, no framework, runnable as a script.

### Lint — both `lint` scripts are broken

- Root `npm run lint` fails: no `eslint.config.*` and no `.eslintrc*` exists (ESLint 9 needs flat config). Never existed in git history.
- Dashboard `npm run lint` fails: `next lint` was removed in Next 16. Use `npx eslint .` from `dashboard/` — `dashboard/eslint.config.mjs` is a valid flat config.
- `npm run format` runs, but there is no Prettier config anywhere — it applies bare defaults to the whole tree.
- `biome.json` and `tsup.config.ts` exist but nothing installs or invokes Biome/tsup. Dead config; ignore.

CI (`.github/workflows/deploy.yml`) only does `npm install` → `npx tsc` → SFTP upload of `dist`. No test or lint step.

## Architecture

### The `dist/` gotcha (read this first)

`Lavamusic.loadCommands()` / `loadEvents()` read from `process.cwd()/dist/commands` and `dist/events` and filter `.js` (`src/structures/Lavamusic.ts:165-177`, `:350-379`). This is true even under `npm run dev` (ts-node). **Editing a command or event in `src/` does nothing until you `npm run build`.** A fresh clone that skips the build loads zero commands.

### Boot flow (`src/index.ts`)

1. `restoreSessions()` + `loadBotPreferencesFromDB()` run **before** any bot starts.
2. `prisma.botConfig.findMany({ where: { active: true } })` → `shardStart(bot)` per bot, each wrapped in `.catch()` so one bad login doesn't kill the fleet.
3. `shardStart` (`src/shard.ts:61-92`) builds the `Lavamusic` client. If Discord rejects the `MessageContent` intent it retries **once without it** rather than staying offline; per-bot flag is `BotConfig.messageContentIntent`.
4. `registerBot(this)` is called from inside the client after `login()` succeeds (`src/structures/Lavamusic.ts:148`), not from index.ts.
5. Two independent 10s `setInterval` pollers then start: one launches the Fastify API + `startCleanupScheduler()`, the other starts `PeriodicMessageSystem` + `TemporaryAnnouncementService`. Expect up to 10s lag before the API is up.
6. `HOT_RELOAD_WATCH=true` starts a file watcher.

### Global state (`src/index.ts`)

State: `activeBots`, `guildBotPreferences`, `voiceChannelMap`, `sessionMap`, `updateSession`, `vcLocks`.
Helpers: `getStateManager`, `registerBot`, `addBotToGuild`, `removeBotFromGuild`, `getGuildBotPreferences`, `getBotsForGuild`, `loadBotPreferencesFromDB`, `syncAllBotsWithGuilds`.

For sharded deployments use `getStateManager(client)` instead of the global maps.

### Command dispatch (post slash-command migration)

Slash and @mention paths are extracted into shared helpers; the prefix path is **not**.

- `src/utils/BotResolver.ts` — `buildBotMeta(bots, guild)` reads Discord's cached voice states (cache-only, sync, no DB, so it is safe to call before ack). `resolveBot(...)` is the pure 4-rung ladder: bot in user's VC (preferring one with an active player) → receiver if idle → any idle → `all_busy`.
- `src/utils/CommandGuards.ts` — `runGuards()` returns `{passed, reply?}`; 10 ordered checks (maintenance → channel perms → client perms → command perms/dev → vote → voice → active player → DJ → cooldown → @everyone → busy last). Cooldown is stamped only after every check passes.
- `src/utils/CommandRunner.ts` — `runCommandFor()` runs guards, fires the delegation announcement only after guards pass, executes, then in `finally` records `commandUsage`, writes the audit embed, and calls `resolveUnusedDefer` so a deferred interaction never leaves a stuck "thinking" placeholder.
- `src/events/client/InteractionCreate.ts` — thin orchestrator (~160 lines). **Defers the reply first**, before any DB or vote work: the vote guard has a 5s timeout and `getLanguage` hits Mongo, both past Discord's 3s ack window. Everything after replies via `editReply`.
- `src/events/client/MessageCreate.ts` — @mention and prefix paths, both routed through `buildBotMeta` → `pickReceiver`/`resolveBot` → `runCommandFor`. All three entry points share one guard and audit implementation.

Prefix commands are deprecated but still work; a per-user deprecation notice is throttled to once per 6h via `prefixNoticeSentAt` in MessageCreate.

The prefix path is the one entry point that does **not** delegate: every bot receives the message and runs the same resolution, so the chosen bot handles its own event and the others return. `pickReceiver` (`src/utils/BotResolver.ts`) decides which bot the prefix addressed — a guild prefix names one bot, the global prefix hashes the message id across the fleet.

**Cross-bot delegation**: `Context.delegated(interaction, chosenBot, args)` (`src/structures/Context.ts:69`) swaps `client`/`guild`/`channel`/`member` to the chosen bot's caches and sets `sendMode = 'channel'`. Returns `null` on any cache miss, and the caller then handles locally rather than letting the wrong bot speak. The mention path does the same four-field swap inline (it takes a `Message`, not an interaction). Guards always run against the *chosen* bot. The "will handle this" announcement fires only when the chosen bot isn't the receiver **and** the reason isn't `in_user_vc`.

Determinism matters: all instances see the same event and must independently pick the same bot, which is why selection reads Discord's real voice state rather than any in-memory map.

### Commands & events

Commands in `src/commands/{config,dev,filters,info,music,playlist}/`, each extending `Command` with a single `run(client, ctx, args)` handling both prefix and slash via the `Context` abstraction. Category comes from the directory name.

Events in `src/events/{client,node,player}/`. Dispatch target differs by directory: `player/` → `manager.on`, `node/` → `manager.nodeManager.on`, everything else → `client.on`. Handlers are tracked in `registeredEventHandlers` for hot reload.

### Database (Prisma + MongoDB)

`BotConfig` (1) ↔ (N) `GuildBotConfig` ↔ (1) `Guild`. Each bot gets its own `ServerData` (`src/database/server.ts`) scoped by `botClientId`. Always include `botClientId` in database operations for isolation.

### Session persistence — two separate systems

- `restoreSessions()` (`src/utils/functions/loadSessionsOnStartup.ts`) reads `sessions-map.json` and stores **raw JSON strings** into `sessionMap`. It does not read `playerData-*.json` and does not recreate players.
- Actual player recreation happens in the Lavalink node connect handler (`src/events/node/Connect.ts`), via `playerSaver.getPlayer()` → `manager.createPlayer()`. Writer side is `PlayerSaver` → `playerData-${botConfig.name}.json` (bot name, not clientId).

### API layer (`src/api/`)

Fastify (not Express). `startApiServer(activeBots)` in `src/api/server.ts`, listening on `0.0.0.0`. Routes under `/api/{auth,bots,players,stats,security}` plus `/health`. Socket.io attaches to the raw Fastify HTTP server (`src/api/websocket/DashboardSocket.ts`). Security via `@fastify/helmet`, `@fastify/cors`, `@fastify/jwt`, `@fastify/cookie`, `@fastify/sensible`.

## Critical Patterns

### Voice operation locking

```typescript
await vcLocks.acquire(`guild:${guildId}`, async () => {
  const player = await safeCreatePlayer(client, guildId, voiceId, textId, options);
});
```
`safeCreatePlayer` returns `null` if another bot already holds that voice channel.

### Translation

`T(ctx, 'key.path')` / `ctx.locale(key)`. Locale resolution: `db.getLanguage(guildId)` (in-memory cache → Prisma → `DEFAULT_LOCALE`) → `ctx.guildLocale`.

- **Use `DEFAULT_LOCALE` exported from `src/structures/I18n.ts`, never `env.DEFAULT_LANGUAGE` and never a hardcoded `'Vietnamese'`.** It validates the env value against the `Language` enum and warns at boot on a bad value.
- Locale files are `locales/*.json`, PascalCase English language names (`EnglishUS.json`, `ChineseCN.json`). i18n only loads keys present in the `Language` enum (`src/types.ts`) — `Dutch.json`, `Italian.json`, `Thai.json`, `PortuguesePT.json` exist on disk but are **not** loaded because their enum entries are commented out.
- `i18n.configure` sets `updateFiles: false` deliberately. The default `true` writes missing keys back into `locales/*.json` at runtime and has polluted the repo before.

### Voting (`src/utils/VotingSystem.ts`)

Democratic control when >2 users in voice. Privileged users (requester, DJ, bot summoner) skip voting; others need a majority via interactive buttons.

## Environment (`src/env.ts`, Zod validated)

**Only `NODES` is actually required.** `DATABASE_URL` is declared `.optional()` in the schema despite Prisma needing it — a missing DB URL fails later and less clearly.

Defaults worth knowing: `GLOBAL_PREFIX='b!'`, `DEFAULT_LANGUAGE='Vietnamese'` (not EnglishUS), `SEARCH_ENGINE='youtube'`, `API_PORT='3002'`, `DASHBOARD_URL='http://localhost:3000'` (but the dashboard actually runs on :20082, and docker-compose publishes the API on 3112 — three inconsistent ports).

Undocumented elsewhere: `SKIP_VOTES_GUILDS`, `SKIP_VOTES_USERS`, `GUILD_IDS`, `MINIMUM_DONATION_AMOUNT`.

Read via raw `process.env`, outside the schema: `HOT_RELOAD_WATCH`, `DJS_DEBUG`, `NODE_ENV`, `SESSION_STRICT_IP`, `DOCKER`/`DOCKER_CONTAINER`.

The loop at `env.ts:70-74` is dead code and can never throw.

Bot tokens live in `prisma/bots.json` (gitignored; copy from `prisma/bots.json.example`), seeded via `npm run seed`. Register slash commands globally with the owner-only `!deploy` command.

## Common Pitfalls

- Editing `src/` commands/events without `npm run build` — loaders read `dist/`.
- Forgetting `vcLocks` on voice operations causes race conditions.
- Using `voiceChannelMap`/`sessionMap` in sharded mode gives wrong state — use `getStateManager(client)`.
- Missing `npx prisma generate` after a schema change breaks types.
- Assuming `activeBots[0]`; always use `client` from the command context.
- Prefix is per-guild-per-bot: `client.db.getPrefix(guildId, client.childEnv.clientId)`.
- `patches/lavalink-client+2.9.6.patch` is applied by `postinstall: patch-package`. Bumping `lavalink-client` off 2.9.6 silently drops the patch.

## Other docs

`README.md` (setup, invite permissions, Docker), `implementation-notes.md` (running log of decisions/tradeoffs — keep appending), `Translation.md`, `VOTING_SYSTEM.md`, `SECURITY.md`, `docs/statistics-page-architecture.md`, `docs/temporary-announcement-design.md`, `docs/superpowers/` (slash-migration design, plan, manual test plan). `.github/copilot-instructions.md` covers the same ground in more depth.
