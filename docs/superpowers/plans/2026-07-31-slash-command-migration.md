# Slash Command Migration with Cross-Bot Delegation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make slash commands and `@mention` commands fully functional with cross-bot free-bot delegation, so the fleet keeps working when Discord disables the `MessageContent` intent in ~27 days.

**Architecture:** Slash and mention entry points each receive input on exactly one bot, so bot selection changes from consensus (every instance computes the same winner) to delegation (receiver picks a bot and hands off). A new pure resolver picks the bot; a new `Context` send-mode lets the chosen bot post its own messages; a shared guard pipeline runs the permission/voice/DJ checks the prefix path already performs. The prefix path itself is left alone — it dies in 27 days and is deleted then.

**Tech Stack:** TypeScript (CommonJS, `strict`), discord.js v14, lavalink-client, Prisma + MongoDB, i18n (`__mf`/ICU), `node:assert` for tests.

**Spec:** `docs/superpowers/specs/2026-07-31-slash-command-migration-design.md`

## Global Constraints

- `tsconfig.json` enables `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `strictNullChecks`. Unused parameters must be `_`-prefixed. Every code path in a non-void function must return.
- `outDir` is `./dist`, `include` is `src/**/*`. Commands are loaded from `dist/commands` at runtime, so `npm run build` is required before `npm start` picks up changes.
- Locale files: 19 files in `locales/`. Default locale is Vietnamese (`env.DEFAULT_LANGUAGE || 'Vietnamese'`). `retryInDefaultLocale: true` and `missingKeyFn` returns the raw key, so a key missing everywhere renders as the literal string `event.interaction.foo` to users.
- Every database operation must include `botClientId` for multi-bot isolation.
- Commands receive the bot they should act on as the `client` **argument** of `run(client, ctx, args)`. Never use `ctx.client` in command logic.
- No new npm dependencies. Tests use `node:assert` only.
- Verification command for all TypeScript work: `npx tsc --noEmit`.
- Commit messages: author is the repo owner only. No co-author trailers, no AI attribution.

## File Structure

**Created:**
- `src/utils/BotResolver.ts` — pure bot-selection ladder + voice-state reader. No DB, no awaits.
- `src/utils/BotResolver.spec.ts` — `node:assert` test for the ladder.
- `src/utils/CommandGuards.ts` — `runGuards()`, the permission/voice/DJ/cooldown pipeline over a `Context`.
- `src/utils/CommandRunner.ts` — shared "guard, run, track, log" wrapper used by both the slash and mention entry points.
- `scripts/add-interaction-locale-keys.js` — one-shot locale patcher.

**Modified:**
- `src/structures/I18n.ts:32-35` — `T()` stops mutating ambient locale state.
- `src/database/server.ts:22-28, 85-95` — add a language cache.
- `src/structures/Context.ts` — split `sourceType` from `sendMode`, add `Context.delegated()`.
- `src/events/client/InteractionCreate.ts` — replace the deprecation short-circuit with the real slash path.
- `src/events/client/MessageCreate.ts:48-96` — early-bail guard and mention-prefix parsing.
- `prisma/schema.prisma:23-37` — `messageContentIntent` on `BotConfig`.
- `src/shard.ts:40-50` — per-bot intent array.

**Deviation from spec, deliberate:** the spec's `resolveBot` signature includes `opts.preferPrefix`. Dropped. The prefix path keeps its own inline selection code (spec's own decision), so nothing would ever pass that option — it would ship with zero callers. Removing it also makes `buildBotMeta` fully synchronous, since `getPrefix` was the only await in it. Added instead: `preferBot`, so a receiving bot that is idle handles its own command rather than needlessly delegating to whichever bot sorts first.

---

### Task 1: Language cache and `T()` hardening

Two small independent fixes. `getLanguage` is called on every message and every command reply and hits MongoDB every time; `T()` mutates a shared i18n singleton.

**Files:**
- Modify: `src/database/server.ts:22-28` (add cache field + invalidation), `src/database/server.ts:85-95`
- Modify: `src/structures/I18n.ts:32-35`

**Interfaces:**
- Consumes: nothing
- Produces: `ServerData.getLanguage(guildId: string): Promise<string>` (unchanged signature, now cached); `T(locale: string, text: string, ...params: any): string` (unchanged signature)

- [ ] **Step 1: Add the cache field and invalidation to `ServerData`**

In `src/database/server.ts`, add a static cache field after the existing `logger` declaration (line 9). It is `static` because each bot constructs its own `ServerData`, and guild language is not bot-specific — one shared map avoids N copies of the same value.

```typescript
	private static languageCache = new Map<string, string>();
```

Replace `getLanguage` and `updateLanguage` (lines 85-95) with:

```typescript
	public async updateLanguage(guildId: string, language: string): Promise<void> {
		await this.prisma.guild.update({
			where: { guildId },
			data: { language },
		});
		ServerData.languageCache.set(guildId, language);
	}

	public async getLanguage(guildId: string): Promise<string> {
		const cached = ServerData.languageCache.get(guildId);
		if (cached !== undefined) return cached;

		const guild = await this.get(guildId);
		const language = guild?.language ?? env.DEFAULT_LANGUAGE;
		ServerData.languageCache.set(guildId, language);
		return language;
	}
```

- [ ] **Step 2: Harden `T()`**

Replace `src/structures/I18n.ts:32-35` with:

```typescript
export function T(locale: string, text: string | i18n.TranslateOptions, ...params: any) {
	return i18n.__mf({ phrase: text as string, locale }, ...params);
}
```

This removes the `setLocale` call. Note for the implementer: the previously-flagged race (observation 16977) was **not** a live bug — `setLocale` and `__mf` are both synchronous with no await between them, so they cannot interleave on a single-threaded event loop. This change is preventative, so the bug cannot appear if someone later inserts an await.

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors. If `i18n.__mf` rejects the object-form first argument, the installed `@types/i18n` is older than the runtime; in that case cast: `i18n.__mf({ phrase: text as string, locale } as any, ...params)`.

- [ ] **Step 4: Verify the cache returns a stable value**

Run: `node -e "const i18n=require('i18n');i18n.configure({locales:['EnglishUS','Vietnamese'],defaultLocale:'Vietnamese',directory:process.cwd()+'/locales',objectNotation:true,retryInDefaultLocale:true,mustacheConfig:{tags:['{','}'],disable:false}});console.log(i18n.__mf({phrase:'event.message.no_free_bots',locale:'EnglishUS'}));console.log(i18n.__mf({phrase:'event.message.no_free_bots',locale:'Vietnamese'}));"`

Expected: two different strings, the English one then the Vietnamese one. This proves inline-locale rendering works without `setLocale`.

- [ ] **Step 5: Commit**

```bash
git add src/database/server.ts src/structures/I18n.ts
git commit -m "perf(i18n,db): cache guild language and render translations without ambient locale

getLanguage hit MongoDB on every message and every command reply. T()
mutated a shared i18n singleton; passing locale inline removes the
dependency on ambient state."
```

---

### Task 2: `BotResolver` — the selection ladder

The core of delegation, and the only piece where a regression silently routes the wrong bot to the wrong voice channel. Pure function, so it gets the test.

**Files:**
- Create: `src/utils/BotResolver.ts`
- Test: `src/utils/BotResolver.spec.ts`

**Interfaces:**
- Consumes: `Lavamusic` from `src/structures/index`
- Produces:
  - `interface BotMeta { bot: Lavamusic; clientId: string; name: string; isInAnyVC: boolean; hasActivePlayer: boolean }`
  - `type ResolveReason = 'in_user_vc' | 'receiver_idle' | 'any_idle' | 'all_busy' | 'no_bots'`
  - `interface ResolveResult { bot: Lavamusic | null; valid: boolean; reason: ResolveReason }`
  - `function buildBotMeta(bots: Lavamusic[], guild: Guild): { botMeta: BotMeta[]; vcToBot: Map<string, string[]> }`
  - `function resolveBot(vcToBot: Map<string, string[]>, botMeta: BotMeta[], userVCId: string | null, receiver?: Lavamusic | null): ResolveResult`

**Approved deviation (2026-07-31, during execution).** `vcToBot` maps a channel to an *array* of occupants, and `BotMeta` carries `hasActivePlayer`. Two fleet bots can share a voice channel (24/7 stay mode, a manual join, a restored session); the original single-value map dropped one of them by cache iteration order, so rung 1 could hand the command to an idle co-occupant instead of the bot holding the queue. Rung 1 now prefers the occupant with an active player. `master:src/events/client/MessageCreate.ts:125-131` has the same defect — this supersedes "priority ladder, unchanged from today" on that one point. Invisible to Tasks 6 and 7, which pass `botMeta` and `vcToBot` through opaquely.

- [ ] **Step 1: Write the failing test**

Create `src/utils/BotResolver.spec.ts`. The fake bots only need a `user.id` and `childEnv`, so they are cast — `resolveBot` never touches anything else.

```typescript
import assert from 'node:assert';
import { resolveBot, type BotMeta } from './BotResolver';
import type { Lavamusic } from '../structures/index';

function fakeBot(id: string): Lavamusic {
	return { user: { id }, childEnv: { clientId: id, name: `bot-${id}` } } as unknown as Lavamusic;
}

function meta(bot: Lavamusic, isInAnyVC: boolean): BotMeta {
	return { bot, clientId: bot.user!.id, name: bot.childEnv.name, isInAnyVC };
}

const a = fakeBot('A');
const b = fakeBot('B');
const c = fakeBot('C');

// 1. A bot already sitting in the user's VC wins, even when the receiver is idle.
{
	const vcToBot = new Map([['vc1', 'C']]);
	const botMeta = [meta(a, false), meta(b, false), meta(c, true)];
	const r = resolveBot(vcToBot, botMeta, 'vc1', a);
	assert.strictEqual(r.bot, c, 'bot in user VC must win');
	assert.strictEqual(r.valid, true);
	assert.strictEqual(r.reason, 'in_user_vc');
}

// 2. No bot in the user's VC, receiver idle -> receiver handles it, no pointless delegation.
{
	const vcToBot = new Map<string, string>();
	const botMeta = [meta(a, false), meta(b, false)];
	const r = resolveBot(vcToBot, botMeta, 'vc1', b);
	assert.strictEqual(r.bot, b, 'idle receiver must handle its own command');
	assert.strictEqual(r.reason, 'receiver_idle');
}

// 3. Receiver busy elsewhere -> delegate to another idle bot.
{
	const vcToBot = new Map([['vc9', 'A']]);
	const botMeta = [meta(a, true), meta(b, false)];
	const r = resolveBot(vcToBot, botMeta, 'vc1', a);
	assert.strictEqual(r.bot, b, 'must delegate to an idle bot');
	assert.strictEqual(r.reason, 'any_idle');
}

// 4. Every bot busy in some other VC -> no bot, invalid.
{
	const vcToBot = new Map([['vc8', 'A'], ['vc9', 'B']]);
	const botMeta = [meta(a, true), meta(b, true)];
	const r = resolveBot(vcToBot, botMeta, 'vc1', a);
	assert.strictEqual(r.bot, null);
	assert.strictEqual(r.valid, false);
	assert.strictEqual(r.reason, 'all_busy');
}

// 5. Empty bot list must not throw.
{
	const r = resolveBot(new Map(), [], 'vc1', null);
	assert.strictEqual(r.bot, null);
	assert.strictEqual(r.valid, false);
	assert.strictEqual(r.reason, 'no_bots');
}

// 6. User not in a voice channel still resolves, so non-voice commands work.
{
	const vcToBot = new Map<string, string>();
	const botMeta = [meta(a, false), meta(b, false)];
	const r = resolveBot(vcToBot, botMeta, null, b);
	assert.strictEqual(r.bot, b);
	assert.strictEqual(r.valid, true);
}

console.log('BotResolver: all assertions passed');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc --noEmit`
Expected: FAIL with `Cannot find module './BotResolver'`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/BotResolver.ts`:

```typescript
import type { Guild } from 'discord.js';
import type { Lavamusic } from '../structures/index';

export interface BotMeta {
	bot: Lavamusic;
	clientId: string;
	name: string;
	isInAnyVC: boolean;
}

export type ResolveReason = 'in_user_vc' | 'receiver_idle' | 'any_idle' | 'all_busy' | 'no_bots';

export interface ResolveResult {
	bot: Lavamusic | null;
	valid: boolean;
	reason: ResolveReason;
}

/**
 * Reads Discord's real voice state for the guild and builds the data
 * resolveBot() needs. Synchronous and cache-only: no database calls, so this
 * is safe to run before acknowledging an interaction.
 */
export function buildBotMeta(bots: Lavamusic[], guild: Guild): {
	botMeta: BotMeta[];
	vcToBot: Map<string, string>;
} {
	const botIds = new Set(bots.map(bot => bot.user!.id));
	const vcToBot = new Map<string, string>();
	const activeBotIds = new Set<string>();

	for (const [, voiceState] of guild.voiceStates.cache) {
		const memberId = voiceState.member?.user.id;
		if (voiceState.channelId && memberId && botIds.has(memberId)) {
			vcToBot.set(voiceState.channelId, memberId);
			activeBotIds.add(memberId);
		}
	}

	const botMeta = bots.map(bot => ({
		bot,
		clientId: bot.user!.id,
		name: bot.childEnv.name,
		isInAnyVC: activeBotIds.has(bot.user!.id),
	}));

	return { botMeta, vcToBot };
}

/**
 * Pure selection ladder. Every input is plain data so this is testable
 * without a Discord connection.
 *
 * 1. Bot already in the user's voice channel — continuity beats everything.
 * 2. The receiving bot, if idle — avoids delegating a command the receiver
 *    could have handled itself.
 * 3. Any idle bot — list order, which is stable across instances.
 * 4. Nothing free.
 */
export function resolveBot(
	vcToBot: Map<string, string>,
	botMeta: BotMeta[],
	userVCId: string | null,
	receiver?: Lavamusic | null,
): ResolveResult {
	if (botMeta.length === 0) {
		return { bot: null, valid: false, reason: 'no_bots' };
	}

	if (userVCId) {
		const occupantId = vcToBot.get(userVCId);
		const occupant = botMeta.find(entry => entry.clientId === occupantId);
		if (occupant) {
			return { bot: occupant.bot, valid: true, reason: 'in_user_vc' };
		}
	}

	if (receiver) {
		const receiverMeta = botMeta.find(entry => entry.clientId === receiver.user!.id);
		if (receiverMeta && !receiverMeta.isInAnyVC) {
			return { bot: receiverMeta.bot, valid: true, reason: 'receiver_idle' };
		}
	}

	const idle = botMeta.find(entry => !entry.isInAnyVC);
	if (idle) {
		return { bot: idle.bot, valid: true, reason: 'any_idle' };
	}

	return { bot: null, valid: false, reason: 'all_busy' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsc --noEmit && npm run build && node dist/utils/BotResolver.spec.js
```

Expected: `BotResolver: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add src/utils/BotResolver.ts src/utils/BotResolver.spec.ts
git commit -m "feat(resolver): add pure bot-selection ladder for delegated commands

Slash and mention commands reach only one bot, so selection becomes
delegation rather than consensus. Ladder prefers a bot already in the
user's VC, then the receiving bot if idle, then any idle bot."
```

---

### Task 3: `Context` dual-mode plus `Context.delegated()`

`isInteraction` currently drives both arg parsing and reply routing. Delegation needs a context that parses interaction options but sends through a different bot's channel.

**Files:**
- Modify: `src/structures/Context.ts`

**Interfaces:**
- Consumes: `Lavamusic`
- Produces:
  - `Context.sourceType: 'interaction' | 'message'`
  - `static Context.delegated(interaction: ChatInputCommandInteraction, chosenBot: Lavamusic, args: any[]): Context`
  - existing `sendMessage`, `editMessage`, `sendDeferMessage`, `sendFollowUp`, `deferred`, `options`, `locale` all unchanged in signature

- [ ] **Step 1: Add the two mode fields**

In `src/structures/Context.ts`, add to the property declarations (after `guildLocale`, line 37):

```typescript
	public sourceType: 'interaction' | 'message';
	private sendMode: 'interaction' | 'channel';
```

In the constructor, after `this.ctx = ctx;` (line 40), add:

```typescript
		this.sourceType = ctx instanceof ChatInputCommandInteraction ? 'interaction' : 'message';
		this.sendMode = this.sourceType === 'interaction' ? 'interaction' : 'channel';
```

- [ ] **Step 2: Split the two getters**

Replace the `isInteraction` getter (lines 62-64) with:

```typescript
	/** True when args and options come from an interaction payload. */
	public get isInteraction(): boolean {
		return this.sourceType === 'interaction';
	}

	/** True when replies go through the interaction rather than channel.send(). */
	private get sendsViaInteraction(): boolean {
		return this.sendMode === 'interaction';
	}
```

`setArgs` and `options` keep using `isInteraction`, which is correct — a delegated context still reads interaction options.

- [ ] **Step 3: Route the send paths through `sendMode` and off `this.message`**

Replace `sendMessage` (lines 70-96) with the version below. Two changes: the mode check, and `this.channel` instead of `this.message?.channel` — the latter is `null` for any interaction-backed context, which is exactly what a delegated context is.

```typescript
	public async sendMessage(
		content: string | MessagePayload | MessageCreateOptions | InteractionReplyOptions,
	): Promise<Message> {
		if (this.sendsViaInteraction) {
			if (typeof content === 'string' || isInteractionReplyOptions(content)) {
				if (this.interaction?.replied || this.interaction?.deferred) {
					this.msg = await this.interaction?.followUp(content) as Message;
				} else {
					if (typeof content === 'string') {
						this.msg = await this.interaction?.reply({ content, fetchReply: true }) as Message;
					} else {
						await this.interaction?.reply(content);
						this.msg = await this.interaction?.fetchReply() as Message;
					}
				}
				return this.msg;
			}
		} else if (typeof content === 'string' || isMessagePayload(content)) {
			this.msg = await (this.channel as TextChannel).send(content as any);
			return this.msg;
		}
		return this.msg;
	}
```

Replace `editMessage` (lines 98-110) with:

```typescript
	public async editMessage(
		content: string | MessagePayload | InteractionEditReplyOptions | MessageEditOptions,
	): Promise<Message> {
		if (this.sendsViaInteraction && this.msg) {
			this.msg = await this.interaction?.editReply(content);
			return this.msg;
		}
		if (this.msg) {
			this.msg = await this.msg.edit(content);
			return this.msg;
		}
		return this.msg;
	}
```

Replace `sendDeferMessage` (lines 112-121) with the version below. This also fixes observation 16971 — the old code discarded `content` on the interaction path, and the delegated channel path depends on that argument being honoured.

```typescript
	public async sendDeferMessage(content: string | MessagePayload | MessageCreateOptions): Promise<Message> {
		if (this.sendsViaInteraction) {
			if (!(this.interaction?.deferred || this.interaction?.replied)) {
				await this.interaction?.deferReply();
			}
			this.msg = await this.interaction?.fetchReply() as Message;
			return this.msg;
		}

		this.msg = await (this.channel as TextChannel).send(content as any);
		return this.msg;
	}
```

Replace `sendFollowUp` (lines 128-138) with:

```typescript
	public async sendFollowUp(
		content: string | MessagePayload | MessageCreateOptions | InteractionReplyOptions,
	): Promise<void> {
		if (this.sendsViaInteraction) {
			if (typeof content === 'string' || isInteractionReplyOptions(content)) {
				await this.interaction?.followUp(content);
			}
		} else if (typeof content === 'string' || isMessagePayload(content)) {
			this.msg = await (this.channel as TextChannel).send(content as any);
		}
	}
```

Replace the `deferred` getter (lines 140-142) with:

```typescript
	public get deferred(): boolean | undefined {
		return this.sendsViaInteraction ? this.interaction?.deferred : !!this.msg;
	}
```

- [ ] **Step 4: Add the delegated factory**

Add this static method immediately after the constructor. It resolves the guild and channel from the **chosen** bot's caches, because objects from the receiver's cache carry the receiver's identity and permissions.

```typescript
	/**
	 * Build a Context whose args come from the receiving bot's interaction but
	 * whose output is sent by a different bot as a normal channel message.
	 * The chosen bot then owns every message it posts, so its own collectors,
	 * buttons, name and avatar stay consistent.
	 */
	public static delegated(
		interaction: ChatInputCommandInteraction,
		chosenBot: Lavamusic,
		args: any[],
	): Context | null {
		// Both must come from the CHOSEN bot's caches — objects from the
		// receiver's cache are bound to the receiver's client, so sending
		// through them makes the wrong bot speak. If either is missing we
		// cannot build an honest delegated context: return null and let the
		// caller handle the command itself rather than half-swapping identity.
		const guild = chosenBot.guilds.cache.get(interaction.guildId!);
		const channel = chosenBot.channels.cache.get(interaction.channelId);
		if (!guild || !channel?.isTextBased()) return null;

		const ctx = new Context(interaction, args);
		ctx.sendMode = 'channel';
		ctx.client = chosenBot;
		ctx.guild = guild;
		ctx.channel = channel as TextBasedChannel;

		return ctx;
	}
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors. `sendMode` is `private` but assignable inside `static delegated` because TypeScript scopes `private` to the class, not the instance.

- [ ] **Step 6: Commit**

```bash
git add src/structures/Context.ts
git commit -m "feat(context): separate arg source from reply destination

Adds Context.delegated(), which reads options from the receiving bot's
interaction but sends output through the chosen bot's channel. Also
fixes sendDeferMessage discarding its content argument."
```

---

### Task 4: Interaction locale keys

`event.interaction.*` has 20 keys already. Five are missing. Doing this by hand across 19 files invites typos, so it is scripted.

**Files:**
- Create: `scripts/add-interaction-locale-keys.js`
- Modify: all 19 files in `locales/`

**Interfaces:**
- Consumes: nothing
- Produces: `event.interaction.voice_channel_full`, `.no_bots_configured`, `.no_free_bots`, `.maintenance`, `.delegated_to_bot` in every locale file

- [ ] **Step 1: Write the patch script**

Create `scripts/add-interaction-locale-keys.js`. It copies from `event.message` where an equivalent already exists in that same file, falls back to Vietnamese, then to English, and never overwrites a key that is already present.

**Formatting is load-bearing.** The existing locale files are **tab**-indented with **no trailing newline**. `JSON.stringify(json, null, '\t')` with no appended newline round-trips them byte-identically — verified against `locales/Vietnamese.json`. Writing 2-space indent instead reformats all ~16k lines across 19 files, producing a 1.7 MB diff for ~95 added lines and making review impossible.

```javascript
const fs = require('node:fs');
const path = require('node:path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');

// Keys to add to event.interaction. `from` names an event.message key to copy
// within the same file when present; `vi`/`en` are the fallbacks.
const KEYS = [
	{ key: 'voice_channel_full', from: 'voice_channel_full' },
	{ key: 'no_bots_configured', from: 'no_bots_configured' },
	{ key: 'no_free_bots', from: 'no_free_bots' },
	{ key: 'maintenance', from: 'maintenance' },
	{
		key: 'delegated_to_bot',
		from: null,
		vi: '**{bot}** sẽ xử lý lệnh này — bot đó đang rảnh và sắp vào kênh của bạn 🎶',
		en: '**{bot}** will handle this — it is free and joining your channel 🎶',
	},
];

const FALLBACK_VI = {
	voice_channel_full: 'Kênh <#{channel}> đầy rồi! Sang kênh khác hoặc tăng giới hạn thành viên 😅',
	no_bots_configured: 'Chưa có bot nhạc nào trong server! Mời bot vào trước nhé 🎵',
	no_free_bots: 'Không có bot nào rảnh! Thêm bot khác vào server xem 🤖',
	maintenance: 'Bot đang bảo trì! Quay lại sau nhé 🔧',
};

const FALLBACK_EN = {
	voice_channel_full: 'Channel <#{channel}> is full! Try another channel or raise the user limit 😅',
	no_bots_configured: 'No music bots here yet! Invite a bot first 🎵',
	no_free_bots: 'No bots available right now! Consider adding more bots to the server 🤖',
	maintenance: 'The bot is under maintenance! Check back soon 🔧',
};

let changed = 0;

for (const file of fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'))) {
	const full = path.join(LOCALES_DIR, file);
	const raw = fs.readFileSync(full, 'utf8');
	const json = JSON.parse(raw);

	json.event = json.event || {};
	json.event.interaction = json.event.interaction || {};
	const message = json.event.message || {};
	const isVietnamese = file === 'Vietnamese.json';

	const added = [];
	for (const spec of KEYS) {
		if (json.event.interaction[spec.key] !== undefined) continue;

		let value;
		if (spec.from && typeof message[spec.from] === 'string') {
			value = message[spec.from];
		} else if (isVietnamese) {
			value = spec.vi || FALLBACK_VI[spec.key];
		} else {
			value = spec.en || FALLBACK_EN[spec.key];
		}

		if (!value) throw new Error(`No value available for ${spec.key} in ${file}`);
		json.event.interaction[spec.key] = value;
		added.push(spec.key);
	}

	if (added.length > 0) {
		// Reuse whatever indentation this file already uses, and append no
		// trailing newline — these files do not end with one. The first indented
		// line of a JSON object is one unit deep, so its leading whitespace is
		// the unit. 16 of the 19 files round-trip byte-identically this way.
		const indentMatch = raw.match(/\n([ \t]+)/);
		const indent = indentMatch ? indentMatch[1] : '\t';
		fs.writeFileSync(full, JSON.stringify(json, null, indent), 'utf8');
		changed++;
		console.log(`${file}: added ${added.join(', ')}`);
	} else {
		console.log(`${file}: nothing to add`);
	}
}

console.log(`\nPatched ${changed} file(s).`);
```

- [ ] **Step 2: Check the current state before patching**

Run: `node -e "const l=require('./locales/Vietnamese.json');console.log(Object.keys(l.event.interaction).length)"`
Expected: `20`

- [ ] **Step 3: Run the patcher**

Run: `node scripts/add-interaction-locale-keys.js`
Expected: 19 lines, each naming the keys added, then `Patched 19 file(s).`

- [ ] **Step 4: Verify every file has all five keys and still parses**

```bash
node -e "
const fs=require('fs');
const need=['voice_channel_full','no_bots_configured','no_free_bots','maintenance','delegated_to_bot'];
let bad=0;
for (const f of fs.readdirSync('./locales').filter(f=>f.endsWith('.json'))) {
  const l=JSON.parse(fs.readFileSync('./locales/'+f,'utf8'));
  const missing=need.filter(k=>typeof l.event.interaction[k]!=='string');
  if (missing.length) { console.log('FAIL',f,missing.join(',')); bad++; }
}
console.log(bad===0?'all 19 locales OK':'FAILURES: '+bad);
"
```

Expected: `all 19 locales OK`

- [ ] **Step 5: Confirm `{bot}` renders**

Run: `node -e "const i18n=require('i18n');i18n.configure({locales:['Vietnamese'],defaultLocale:'Vietnamese',directory:process.cwd()+'/locales',objectNotation:true,retryInDefaultLocale:true,mustacheConfig:{tags:['{','}'],disable:false}});console.log(i18n.__mf({phrase:'event.interaction.delegated_to_bot',locale:'Vietnamese'},{bot:'TestBot'}))"`

Expected: the Vietnamese sentence with `**TestBot**` substituted, no literal `{bot}`.

- [ ] **Step 6: Commit**

```bash
git add scripts/add-interaction-locale-keys.js locales/
git commit -m "i18n: add missing event.interaction keys across all 19 locales

Slash commands need voice_channel_full, no_bots_configured,
no_free_bots and maintenance, plus a new delegated_to_bot notice."
```

---

### Task 5: `CommandGuards` — the shared check pipeline

Carries over the prefix path's checks, but operates on a `Context` and validates the **chosen** bot rather than the receiver.

**Ordering is not a literal replay of the prefix path**, and the difference is deliberate. `MessageCreate.ts` runs its maintenance check late — nested inside `command.player.voice` and after the permission and vote gates. Here maintenance comes first, so a user learns the bot is down before being asked to vote. The `command.player?.voice` scoping is preserved, so *which* commands maintenance blocks is unchanged. The property genuinely preserved from the prefix path is the one that matters: the busy check runs last, after every specific error.

**Files:**
- Create: `src/utils/CommandGuards.ts`

**Interfaces:**
- Consumes: `Context`, `Command`, `Lavamusic`, `BotResolver` types
- Produces: `interface GuardResult { passed: boolean; reply?: InteractionReplyOptions & { content?: string } }`, `async function runGuards(client: Lavamusic, ctx: Context, command: Command, busy: boolean): Promise<GuardResult>`

- [ ] **Step 1: Write the guard module**

Create `src/utils/CommandGuards.ts`. `client` is the **chosen** bot throughout. The busy check is last so users see permission and voice errors first, matching the prefix path.

Check 2 is a **channel-level** permission test (`ViewChannel` and `SendMessages` via `channel.permissionsFor(clientMember)`), separate from the guild-level test that follows it. `MessageCreate.ts:225-226` has the channel-level `ViewChannel` check and an earlier draft of this plan dropped it. It matters more here than in the prefix path: a prefix command was necessarily received in a channel the bot could see, whereas a delegated command sends through the *chosen* bot into a channel only the *receiver* was known to have access to. When `permissionsFor` returns null the check does not fail — an indeterminate result must not block DM-context or uncached-channel cases.

```typescript
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	Collection,
	type GuildMember,
	type InteractionReplyOptions,
	PermissionFlagsBits,
} from 'discord.js';
import { T } from '../structures/I18n';
import type Context from '../structures/Context';
import type { Command, Lavamusic } from '../structures/index';

export interface GuardResult {
	passed: boolean;
	reply?: InteractionReplyOptions & { content?: string };
}

const PASS: GuardResult = { passed: true };

function fail(content: string, extra?: Partial<InteractionReplyOptions>): GuardResult {
	return { passed: false, reply: { content, ...extra } };
}

/**
 * Runs every pre-execution check for a delegated or self-handled command.
 *
 * `client` must be the bot that will actually execute the command, not the
 * bot that received the interaction — otherwise permissions are validated
 * against the wrong member.
 *
 * `busy` is checked last on purpose: a user with a missing permission or no
 * voice channel should hear about that before "all bots are busy".
 */
export async function runGuards(
	client: Lavamusic,
	ctx: Context,
	command: Command,
	busy: boolean,
): Promise<GuardResult> {
	const locale = ctx.guildLocale ?? client.env.DEFAULT_LANGUAGE ?? 'Vietnamese';
	const guild = ctx.guild;
	const userId = ctx.author!.id;
	const isDev = client.env.OWNER_IDS?.includes(userId) ?? false;

	// `guild` comes from the chosen bot's cache, so members.me is the chosen
	// bot's own member and is always populated. Resolving by id against another
	// client's guild cache would miss and produce a spurious failure.
	const clientMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
	if (!clientMember) {
		return fail(T(locale, 'event.interaction.no_send_message'));
	}

	// 1. Maintenance — only blocks player commands, same as the prefix path.
	if (command.player?.voice && client.config.maintenance && !isDev) {
		const embed = client
			.embed()
			.setAuthor({ name: T(locale, 'maintenance.title'), iconURL: client.user?.displayAvatarURL() })
			.setColor(client.color.main)
			.setDescription(T(locale, 'event.interaction.maintenance'))
			.addFields([
				{
					name: T(locale, 'maintenance.status_title'),
					value: `\`\`\`diff\n- ${T(locale, 'maintenance.status_value')}\n\`\`\``,
					inline: true,
				},
				{
					name: T(locale, 'maintenance.affected_title'),
					value: `\`\`\`${T(locale, 'maintenance.affected_value')}\`\`\``,
					inline: true,
				},
			])
			.setTimestamp();
		return { passed: false, reply: { embeds: [embed] } };
	}

	// 2. Channel and client permissions.
	if (
		!(
			clientMember.permissions.has(PermissionFlagsBits.ViewChannel) &&
			clientMember.permissions.has(PermissionFlagsBits.SendMessages) &&
			clientMember.permissions.has(PermissionFlagsBits.EmbedLinks) &&
			clientMember.permissions.has(PermissionFlagsBits.ReadMessageHistory)
		)
	) {
		return fail(T(locale, 'event.interaction.no_send_message'));
	}

	// 3. Command permissions.
	if (command.permissions?.client) {
		const missing = (command.permissions.client as string[]).filter(
			perm => !clientMember.permissions.has(perm as any),
		);
		if (missing.length > 0) {
			return fail(
				T(locale, 'event.interaction.no_permission', {
					permissions: missing.map(perm => `\`${perm}\``).join(', '),
				}),
			);
		}
	}

	const member = guild.members.resolve(userId) ?? (await guild.members.fetch(userId).catch(() => null));
	if (!member) {
		return fail(T(locale, 'event.interaction.no_send_message'));
	}

	if (command.permissions?.user && (command.permissions.user as string[]).length > 0) {
		if (!(isDev || member.permissions.has(command.permissions.user as any))) {
			const required = Array.isArray(command.permissions.user)
				? command.permissions.user
				: [command.permissions.user];
			return fail(
				T(locale, 'event.interaction.no_user_permission', {
					permissions: required.map((perm: any) => `\`${perm}\``).join(', '),
				}),
			);
		}
	}

	if (command.permissions?.dev && client.env.OWNER_IDS && !isDev) {
		return { passed: false };
	}

	// 4. Vote gate.
	if (
		!isDev &&
		command.vote &&
		client.env.TOPGG &&
		!client.env.SKIP_VOTES_GUILDS?.find(id => id === guild.id) &&
		!client.env.SKIP_VOTES_USERS?.find(id => id === userId)
	) {
		const timeout = new Promise<boolean>(resolve => {
			setTimeout(() => {
				client.logger.warn(`Vote check timeout for user ${userId} - defaulting to disallow command`);
				resolve(false);
			}, 5000);
		});

		let voted: boolean;
		try {
			voted = await Promise.race([client.topGG.hasVoted(userId), timeout]);
		} catch {
			voted = false;
		}

		if (!voted) {
			const voteBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setLabel(T(locale, 'event.interaction.vote_button'))
					.setURL(`https://top.gg/bot/${client.env.TOPGG_CLIENT_ID ?? '1385166515099275346'}/vote`)
					.setStyle(ButtonStyle.Link),
			);
			return {
				passed: false,
				reply: { content: T(locale, 'event.interaction.vote_message'), components: [voteBtn] },
			};
		}
	}

	// 5. Voice checks.
	if (command.player?.voice) {
		const voiceChannel = member.voice.channel;
		if (!voiceChannel) {
			return fail(T(locale, 'event.interaction.no_voice_channel', { command: command.name }));
		}

		if (
			voiceChannel.userLimit > 0 &&
			voiceChannel.members.size >= voiceChannel.userLimit &&
			!voiceChannel.members.has(clientMember.id)
		) {
			return fail(
				T(locale, 'event.interaction.voice_channel_full', {
					command: command.name,
					channel: voiceChannel.id,
				}),
			);
		}

		if (!voiceChannel.permissionsFor(client.user!)?.has(PermissionFlagsBits.Connect)) {
			return fail(T(locale, 'event.interaction.no_connect_permission', { command: command.name }));
		}

		if (!voiceChannel.permissionsFor(client.user!)?.has(PermissionFlagsBits.Speak)) {
			return fail(T(locale, 'event.interaction.no_speak_permission', { command: command.name }));
		}

		if (!clientMember.permissions.has(PermissionFlagsBits.Connect)) {
			return fail(T(locale, 'event.interaction.no_connect_permission', { command: command.name }));
		}

		if (!clientMember.permissions.has(PermissionFlagsBits.Speak)) {
			return fail(T(locale, 'event.interaction.no_speak_permission', { command: command.name }));
		}

		if (
			voiceChannel.type === ChannelType.GuildStageVoice &&
			!clientMember.permissions.has(PermissionFlagsBits.RequestToSpeak)
		) {
			return fail(T(locale, 'event.interaction.no_request_to_speak', { command: command.name }));
		}

		// Only meaningful when the resolver picked this bot deliberately. When
		// every bot is busy, `busy` is already true and the message below would
		// be misleading.
		if (
			!busy &&
			clientMember.voice.channel &&
			clientMember.voice.channelId !== voiceChannel.id
		) {
			return fail(
				T(locale, 'event.interaction.different_voice_channel', {
					channel: `<#${clientMember.voice.channelId}>`,
					command: command.name,
				}),
			);
		}
	}

	// 6. Active player.
	if (command.player?.active) {
		const player = client.manager.getPlayer(guild.id);
		if (!player?.queue.current) {
			return fail(T(locale, 'event.interaction.no_music_playing'));
		}
	}

	// 7. DJ role.
	if (command.player?.dj) {
		const dj = await client.db.getDj(guild.id);
		if (dj?.mode) {
			const djRoles = await client.db.getRoles(guild.id);
			if (!djRoles || djRoles.length === 0) {
				return fail(T(locale, 'event.interaction.no_dj_role'));
			}
			const roleIds = djRoles.map(r => r.roleId);
			const hasDJRole = member.roles.cache.some(role => roleIds.includes(role.id));
			if (!(isDev || (hasDJRole && !member.permissions.has(PermissionFlagsBits.ManageGuild)))) {
				return fail(T(locale, 'event.interaction.no_dj_permission'));
			}
		}
	}

	// 8. Cooldown.
	if (!client.cooldown.has(command.name)) {
		client.cooldown.set(command.name, new Collection());
	}
	const timestamps = client.cooldown.get(command.name)!;
	const cooldownAmount = (command.cooldown || 5) * 1000;
	const now = Date.now();

	if (timestamps.has(userId)) {
		const expirationTime = timestamps.get(userId)! + cooldownAmount;
		const timeLeft = (expirationTime - now) / 1000;
		if (now < expirationTime && timeLeft > 0.9) {
			return fail(
				T(locale, 'event.interaction.cooldown', {
					time: timeLeft.toFixed(1),
					command: command.name,
				}),
			);
		}
	}
	timestamps.set(userId, now);
	setTimeout(() => timestamps.delete(userId), cooldownAmount);

	// 9. Mention abuse.
	if (ctx.args.some(arg => typeof arg === 'string' && (arg.includes('@everyone') || arg.includes('@here')))) {
		return fail(T(locale, 'event.message.no_mention_everyone'));
	}

	// 10. Busy — last, so the errors above take priority.
	if (busy) {
		return fail(T(locale, 'event.interaction.no_free_bots'));
	}

	return PASS;
}
```

Note on the arg check: the prefix path also enforces `command.args && args.length === 0`. That check is intentionally absent here — Discord validates required slash options before the interaction is ever delivered, so it can never fire. The mention path in Task 7 keeps the prefix path's own version of it.

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors. `Command`, `Context` and `Lavamusic` are all exported from `src/structures/index` (verified), and `config.color.blue`, `env.DEFAULT_LANGUAGE` and `env.LOG_COMMANDS_ID` all exist.

- [ ] **Step 3: Commit**

```bash
git add src/utils/CommandGuards.ts
git commit -m "feat(guards): extract command pre-checks into a Context-based pipeline

Validates the chosen bot rather than the receiving bot, which matters
once commands are delegated across bots. Busy check runs last so
permission and voice errors surface first."
```

---

### Task 6: Slash command path

Replaces the deprecation short-circuit with resolve-and-delegate. This is the task that makes the fleet survive day 27.

**Files:**
- Create: `src/utils/CommandRunner.ts`
- Modify: `src/events/client/InteractionCreate.ts` (replace lines 18-434 of `run`, keep the autocomplete branch)

**Interfaces:**
- Consumes: `resolveBot`, `buildBotMeta`, `BotMeta` (Task 2); `Context.delegated` (Task 3); `runGuards` (Task 5); `getBotsForGuild` from `src/index`
- Produces: `async function runCommandFor(chosen: Lavamusic, ctx: Context, command: Command, busy: boolean, reply: ReplyFn, onGuardsPassed?: () => Promise<void>): Promise<void>`; `type ReplyFn = (payload: InteractionReplyOptions & { content?: string }) => Promise<void>`

- [ ] **Step 1: Write the shared runner**

Create `src/utils/CommandRunner.ts`. Both the slash and mention paths need identical guard-run-track-log behaviour but reply through different mechanisms, so the reply mechanism is injected.

```typescript
import { EmbedBuilder, type InteractionReplyOptions, type TextChannel } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { T } from '../structures/I18n';
import { runGuards } from './CommandGuards';
import type Context from '../structures/Context';
import type { Command, Lavamusic } from '../structures/index';

const prisma = new PrismaClient();

export type ReplyFn = (payload: InteractionReplyOptions & { content?: string }) => Promise<void>;

/**
 * Runs guards, executes the command, records usage and writes the audit log.
 *
 * `chosen` is the bot that executes. `reply` sends guard failures back through
 * whatever mechanism the entry point owns — editReply for slash, message.reply
 * for mentions. Successful command output goes through `ctx`, not `reply`.
 *
 * `onGuardsPassed` fires only once every guard has passed, immediately before
 * execution. Entry points use it to announce a handoff, so a delegation that
 * fails its checks never gets announced.
 */
export async function runCommandFor(
	chosen: Lavamusic,
	ctx: Context,
	command: Command,
	busy: boolean,
	reply: ReplyFn,
	onGuardsPassed?: () => Promise<void>,
): Promise<void> {
	const locale = ctx.guildLocale ?? 'Vietnamese';

	const guard = await runGuards(chosen, ctx, command, busy);
	if (!guard.passed) {
		if (guard.reply) await reply(guard.reply).catch(() => null);
		return;
	}

	if (onGuardsPassed) await onGuardsPassed().catch(() => null);

	try {
		await command.run(chosen, ctx, ctx.args);
	} catch (error: any) {
		chosen.logger.error(error);
		await reply({
			content: T(locale, 'event.interaction.error', { error: error?.message || 'Unknown error' }),
		}).catch(() => null);
	} finally {
		try {
			await prisma.commandUsage.create({
				data: {
					guildId: ctx.guild.id,
					botId: chosen.childEnv.clientId,
					commandName: command.name,
					userId: ctx.author!.id,
				},
			});
		} catch (error) {
			chosen.logger.error('Failed to track command usage:', error);
		}

		const logs = chosen.channels.cache.get(chosen.env.LOG_COMMANDS_ID!);
		if (logs) {
			const embed = new EmbedBuilder()
				.setAuthor({
					name: ctx.isInteraction ? 'Slash - Command Logs' : 'Mention - Command Logs',
					iconURL: chosen.user?.avatarURL({ size: 2048 })!,
				})
				.setColor(chosen.config.color.blue)
				.addFields(
					{ name: 'Command', value: `\`${command.name}\``, inline: true },
					{ name: 'User', value: `${ctx.author?.tag} (\`${ctx.author?.id}\`)`, inline: true },
					{ name: 'Guild', value: `${ctx.guild.name} (\`${ctx.guild.id}\`)`, inline: true },
				)
				.setFooter({
					text: 'BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️',
					iconURL:
						'https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg',
				})
				.setTimestamp();

			await (logs as TextChannel).send({ embeds: [embed], flags: 4096 }).catch(() => null);
		}
	}
}
```

- [ ] **Step 2: Replace the slash branch in `InteractionCreate`**

Rewrite `src/events/client/InteractionCreate.ts` entirely. Every commented-out block from the old file is superseded — delete it rather than reviving it.

`deferReply()` is the **first await in the handler**. This is not stylistic: the vote guard alone has a 5-second timeout, well past Discord's 3-second acknowledgement deadline, and `getLanguage` may still hit the database on a cold cache. Deferring first makes the ack independent of everything that follows.

```typescript
import {
	type AutocompleteInteraction,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	CommandInteraction,
	InteractionType,
} from 'discord.js';
import { getBotsForGuild } from '../..';
import { T } from '../../structures/I18n';
import { Context, Event, type Lavamusic } from '../../structures/index';
import { buildBotMeta, resolveBot } from '../../utils/BotResolver';
import { runCommandFor } from '../../utils/CommandRunner';

export default class InteractionCreate extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'interactionCreate',
		});
	}

	public async run(
		interaction: CommandInteraction | AutocompleteInteraction | ButtonInteraction,
	): Promise<any> {
		if (!(interaction.guild && interaction.guildId)) return;

		if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
			const command = this.client.commands.get(interaction.commandName);
			if (!command) return;
			try {
				await command.autocomplete(interaction as AutocompleteInteraction);
			} catch (error) {
				this.client.logger.error(error);
			}
			return;
		}

		if (!(interaction instanceof CommandInteraction && interaction.isChatInputCommand())) return;

		const command = this.client.commands.get(interaction.commandName);
		if (!command) return;

		// Acknowledge before anything that can block. The vote guard has a 5s
		// timeout and getLanguage can hit MongoDB, both past Discord's 3s ack
		// deadline. Everything after this point replies via editReply.
		try {
			await interaction.deferReply();
		} catch (error) {
			this.client.logger.error('Failed to defer slash interaction:', error);
			return;
		}

		const reply = async (payload: any) => {
			await interaction.editReply(payload);
		};

		const guildId = interaction.guildId;
		const locale = await this.client.db.getLanguage(guildId);

		const setup = await this.client.db.getSetup(guildId);
		if (setup && interaction.channelId === setup.textId) {
			await reply({ content: T(locale, 'event.interaction.setup_channel') });
			return;
		}

		const allBots = getBotsForGuild(guildId);
		if (allBots.length === 0) {
			await reply({ content: T(locale, 'event.interaction.no_bots_configured') });
			return;
		}

		const member = interaction.guild.members.resolve(interaction.user.id);
		const userVCId = member?.voice?.channelId ?? null;

		const { botMeta, vcToBot } = buildBotMeta(allBots, interaction.guild);
		const resolved = resolveBot(vcToBot, botMeta, userVCId, this.client);

		// When nothing is free the receiving bot answers, so the guards still
		// run and the user sees permission or voice problems before "all busy".
		let chosen = resolved.bot ?? this.client;
		const busy = !resolved.valid;
		let isSelf = chosen.user!.id === this.client.user!.id;

		const options = (interaction as ChatInputCommandInteraction).options.data as any[];
		let ctx: Context;

		if (isSelf) {
			ctx = new Context(interaction as ChatInputCommandInteraction, options);
		} else {
			const delegatedCtx = Context.delegated(
				interaction as ChatInputCommandInteraction,
				chosen,
				options,
			);
			if (delegatedCtx) {
				ctx = delegatedCtx;
			} else {
				// The chosen bot has not cached this guild or channel, so it
				// cannot honestly own its own messages. Handle it here instead
				// of half-swapping identity and letting the wrong bot speak.
				this.client.logger.warn(
					`Cannot delegate ${command.name} to ${chosen.childEnv.name}: guild or channel not cached. Handling locally.`,
				);
				chosen = this.client;
				isSelf = true;
				ctx = new Context(interaction as ChatInputCommandInteraction, options);
			}
		}

		ctx.setArgs(options);
		ctx.guildLocale = locale;

		// Guard failures and execution errors always answer through the
		// interaction, delegated or not — the receiver is the bot the user
		// actually invoked, and at guard time nothing has been announced yet.
		await runCommandFor(
			chosen,
			ctx,
			command,
			busy,
			reply,
			isSelf
				? undefined
				: async () => {
						// Guards passed, so the handoff is real and worth announcing.
						// The chosen bot posts its own output as a normal channel
						// message; this notice is all the interaction reply carries.
						//
						// It cannot be ephemeral: a deferred public reply cannot become
						// ephemeral, and deferring ephemerally would hide self-handled
						// replies — including now-playing — from everyone but the invoker.
						await reply({
							content: T(locale, 'event.interaction.delegated_to_bot', {
								bot: chosen.user!.username,
							}),
						});
					},
		);
	}
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors. `interaction.isChatInputCommand()` requires discord.js v14, which is what this project uses.

- [ ] **Step 4: Build and confirm no runtime import cycle**

Run: `npm run build && node -e "require('./dist/utils/CommandRunner.js');require('./dist/utils/BotResolver.js');console.log('modules load')"`
Expected: `modules load`. `CommandRunner` importing `PrismaClient` at module scope mirrors what `MessageCreate` already does, so this is consistent with the existing pattern.

- [ ] **Step 5: Manual verification against a live guild**

This path cannot be unit-tested without a Discord connection, so verify by hand with at least two bots in one guild:

1. Start the fleet: `npm start`
2. With no bot in any voice channel, join a VC and run `/play` on Bot1. Expected: Bot1 handles it directly, no handoff notice. This confirms `receiver_idle`.
3. Leave Bot1 playing. Have a second user in a **different** VC run `/play` on Bot1. Expected: Bot1's reply is the handoff notice naming Bot2, and Bot2 posts the now-playing message under its own name. This confirms delegation.
4. Run `/play` on Bot1 from the VC Bot1 is already in. Expected: Bot1 handles it and queues the track. This confirms `in_user_vc`.
5. With every bot busy in other VCs, run `/play`. Expected: the `no_free_bots` message, and only after any voice or permission problem would have been reported.
6. Run `/ping`. Expected: works with no voice channel involved.

- [ ] **Step 6: Commit**

```bash
git add src/utils/CommandRunner.ts src/events/client/InteractionCreate.ts
git commit -m "feat(slash): enable slash commands with cross-bot delegation

Replaces the deprecation short-circuit. The receiving bot resolves a
free bot and either handles the command itself or posts a handoff
notice while the chosen bot executes and replies in-channel.

deferReply is the first await so acknowledgement cannot miss Discord's
3s deadline behind the 5s vote timeout or a cold language cache."
```

---

### Task 7: Mention entry point and the empty-content bail

`@Bot play song` delivers content with no privileged intent, so this is the path that keeps prefix-style usage alive past day 27.

**Files:**
- Modify: `src/events/client/MessageCreate.ts:48-96`

**Interfaces:**
- Consumes: `buildBotMeta`, `resolveBot` (Task 2); `runCommandFor` (Task 6); existing `parseArgsWithQuotes`
- Produces: no new exports

- [ ] **Step 1: Add the early bail and mention-command parsing**

In `src/events/client/MessageCreate.ts`, replace the block from `if (message.author.bot) return;` (line 49) through `if (!command) return;` (line 96) with the code below.

Two behaviour changes. First, the early bail: once `MessageContent` is disabled, `message.content` is empty for ordinary messages, and the current code performs three database calls (`getSetup`, `getLanguage`, `getAllPrefixes`) before the prefix regex at line 89 ever runs — every message in every guild, for nothing. Second, the mention regex loses its `$` anchor so `@Bot play song` is treated as a command.

```typescript
		if (message.author.bot) return;
		if (!(message.guild && message.guildId)) return;

		const mentionPrefix = new RegExp(`^<@!?${this.client.user?.id}>\\s*`);
		const mentionMatch = message.content.match(mentionPrefix);

		// Once MessageContent is disabled, content is empty on everything except
		// mentions and DMs. Bail before spending any database calls.
		if (!(message.content.trim() || mentionMatch)) return;

		const guildId = message.guildId;
		const userVCId = message.member?.voice?.channelId ?? null;

		const setup = await this.client.db.getSetup(guildId);
		if (setup && setup.textId === message.channelId) {
			return this.client.emit('setupSystem', message);
		}
		const locale = await this.client.db.getLanguage(guildId);
		const botClientId = this.client.childEnv.id;

		if (mentionMatch) {
			const rest = message.content.slice(mentionMatch[0].length).trim();

			// Bare mention keeps the old behaviour: show help.
			if (!rest) {
				const helpCommand = this.client.commands.get('help');
				if (helpCommand) {
					const helpCtx = new Context(message, []);
					helpCtx.guildLocale = locale;
					await helpCommand.run(this.client, helpCtx, []);
					return;
				}
				await message.reply({
					content: T(locale, 'event.message.prefix_mention', {
						prefix: await this.client.db.getPrefix(guildId, botClientId),
					}),
				});
				return;
			}

			// `@Bot play song` — only this bot received content, so resolve and
			// delegate exactly as the slash path does.
			const mentionArgs = parseArgsWithQuotes(rest);
			const mentionCmdName = mentionArgs.shift()?.toLowerCase();
			if (!mentionCmdName) return;

			const mentionCommand =
				this.client.commands.get(mentionCmdName) ||
				this.client.commands.get(this.client.aliases.get(mentionCmdName) as string);
			if (!mentionCommand) return;

			const mentionBots = getBotsForGuild(guildId);
			if (mentionBots.length === 0) {
				await message.reply({ content: T(locale, 'event.message.no_bots_configured') });
				return;
			}

			if (mentionCommand.args && mentionArgs.length === 0) {
				const embed = this.client
					.embed()
					.setColor(this.client.color.red)
					.setTitle(T(locale, 'event.message.missing_arguments'))
					.setDescription(
						T(locale, 'event.message.missing_arguments_description', {
							command: mentionCommand.name,
							examples: mentionCommand.description.examples
								? mentionCommand.description.examples.join('\n')
								: 'None',
						}),
					);
				await message.reply({ embeds: [embed] });
				return;
			}

			const { botMeta, vcToBot } = buildBotMeta(mentionBots, message.guild);
			const resolved = resolveBot(vcToBot, botMeta, userVCId, this.client);
			const chosen = resolved.bot ?? this.client;
			const isSelf = chosen.user!.id === this.client.user!.id;

			const mentionCtx = new Context(message, mentionArgs);
			mentionCtx.setArgs(mentionArgs);
			mentionCtx.guildLocale = locale;

			// Swap the context onto the chosen bot's caches before guards run —
			// runGuards resolves the chosen bot's own member from ctx.guild, and
			// member caches are per-client.
			if (!isSelf) {
				const chosenChannel = chosen.channels.cache.get(message.channelId);
				if (chosenChannel?.isTextBased()) {
					mentionCtx.client = chosen;
					mentionCtx.channel = chosenChannel;
					const chosenGuild = chosen.guilds.cache.get(guildId);
					if (chosenGuild) mentionCtx.guild = chosenGuild;
				}
			}

			await runCommandFor(
				chosen,
				mentionCtx,
				mentionCommand,
				!resolved.valid,
				async payload => {
					await message.reply(payload as any).catch(() => null);
				},
				isSelf
					? undefined
					: async () => {
							await message.reply({
								content: T(locale, 'event.interaction.delegated_to_bot', {
									bot: chosen.user!.username,
								}),
							});
						},
			);
			return;
		}

		const allPrefixes = await this.client.db.getAllPrefixes(guildId);
		allPrefixes.push(env.GLOBAL_PREFIX);

		const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const prefixPatterns = allPrefixes.map(p => `(${escapeRegex(p)})`);
		const combinedPrefixRegex = new RegExp(`^(${prefixPatterns.join('|')})\\s*`);

		const match = message.content.toLocaleLowerCase().match(combinedPrefixRegex);
		if (!match) return;
		const [matchedPrefix] = match;
		const args = parseArgsWithQuotes(message.content.slice(matchedPrefix.length).trim());
		const cmd = args.shift()?.toLowerCase();
		if (!cmd) return;
		const command = this.client.commands.get(cmd) || this.client.commands.get(this.client.aliases.get(cmd) as string);
		if (!command) return;
```

Note: a mention-delegated context is `sourceType: 'message'`, so `sendMode` is already `'channel'` — swapping `client`, `channel` and `guild` is sufficient. `Context.delegated()` is only needed for interaction-backed contexts.

- [ ] **Step 2: Add the new imports**

At the top of `src/events/client/MessageCreate.ts`, extend the existing import of `getBotsForGuild` from `'../..'` (line 16) and add:

```typescript
import { buildBotMeta, resolveBot } from '../../utils/BotResolver';
import { runCommandFor } from '../../utils/CommandRunner';
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors. `botClientId` is still used by the bare-mention branch, so `noUnusedLocals` is satisfied. If `Stay` or `PrismaClient` become unused as a result of any edits, remove those imports.

- [ ] **Step 4: Verify the prefix path still works**

Run: `npm run build && npm start`

Then in a test guild:

1. `!play <song>` — expected: works exactly as before, consensus selection unchanged.
2. `@Bot1` alone — expected: help embed.
3. `@Bot1 play <song>` with Bot1 idle — expected: Bot1 plays, no handoff notice.
4. `@Bot1 play <song>` with Bot1 busy in another VC and Bot2 idle — expected: Bot1 posts the handoff notice, Bot2 plays.
5. Send an ordinary chat message — expected: nothing happens, and no `getSetup`/`getAllPrefixes` query fires. Confirm by watching the bot log at debug level, or temporarily add a log line to `getAllPrefixes`.

- [ ] **Step 5: Commit**

```bash
git add src/events/client/MessageCreate.ts
git commit -m "feat(mention): accept commands via @mention with delegation

Discord delivers message content without a privileged intent when the
bot is mentioned, so @Bot play song survives the MessageContent
shutdown. Also bails before three database calls on messages with no
usable content, which is every message once the intent is gone."
```

---

### Task 8: Per-bot `messageContentIntent` flag

A bot that requests an intent it does not hold fails login with `Used disallowed intents`. When the intent is revoked the fleet must be able to drop it per bot.

**Files:**
- Modify: `prisma/schema.prisma:23-37`
- Modify: `src/shard.ts:40-50`

**Interfaces:**
- Consumes: `BotConfig` from `@prisma/client`
- Produces: `BotConfig.messageContentIntent: boolean`

- [ ] **Step 1: Add the schema field**

In `prisma/schema.prisma`, add to `model BotConfig` after the `active` field (line 32):

```prisma
  messageContentIntent Boolean @default(true)
```

- [ ] **Step 2: Regenerate the client and push the schema**

```bash
npx prisma generate && npm run db:push
```

Expected: `Generated Prisma Client` then a successful push. MongoDB has no migration files, so existing documents pick up the `true` default on read.

- [ ] **Step 3: Build the intent array per bot**

Replace `src/shard.ts:40-50` with:

```typescript
const { MessageContent, GuildVoiceStates, GuildMessages, Guilds, GuildMessageTyping } = GatewayIntentBits;

function clientOptionsFor(bot: BotConfig): ClientOptions {
	const intents = [Guilds, GuildMessages, GuildVoiceStates, GuildMessageTyping];

	// Requesting an intent the application does not hold fails login outright
	// with "Used disallowed intents", so this must be per bot. Mentions still
	// deliver content without it.
	if (bot.messageContentIntent) intents.push(MessageContent);

	return {
		intents,
		allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
	};
}

export async function shardStart(bot: BotConfig) {
	const client = new Lavamusic(clientOptionsFor(bot), bot);
	await client.start();
}
```

The module-level `clientOptions` const is removed — it was shared across every bot, which cannot express a per-bot intent set.

- [ ] **Step 4: Verify types compile and the flag reads**

```bash
npx tsc --noEmit && node -e "
const {PrismaClient}=require('@prisma/client');
new PrismaClient().botConfig.findMany({select:{name:true,messageContentIntent:true}}).then(r=>{console.log(r);process.exit(0)});
"
```

Expected: every bot listed with `messageContentIntent: true`.

- [ ] **Step 5: Verify a bot boots with the intent disabled**

Pick one bot and turn the flag off, start the fleet, confirm it connects, then turn it back on:

```bash
node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.botConfig.findFirst().then(b=>p.botConfig.update({where:{id:b.id},data:{messageContentIntent:false}}).then(()=>{console.log('disabled for',b.name);process.exit(0)}));
"
npm run build && npm start
```

Expected: the bot logs in normally. Slash commands and `@Bot play` work; `!play` does nothing for that bot. Then restore:

```bash
node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.botConfig.findFirst().then(b=>p.botConfig.update({where:{id:b.id},data:{messageContentIntent:true}}).then(()=>{console.log('restored',b.name);process.exit(0)}));
"
```

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma src/shard.ts
git commit -m "feat(intents): make MessageContent a per-bot flag

Requesting an unheld privileged intent fails login with 'Used
disallowed intents', so the fleet needs to drop it per bot as
approvals lapse. GuildMessages stays unconditional — it is what
delivers mention content."
```

---

### Task 9: Invert the deprecation notice

`event.interaction.slash_deprecated` currently tells users to go and use prefix commands, which is the opposite of what should happen now.

**Files:**
- Create: `scripts/invert-deprecation-notice.js`
- Modify: all 19 files in `locales/`
- Modify: `src/events/client/MessageCreate.ts` (prefix success path)

**Interfaces:**
- Consumes: `Context` (already imported in `MessageCreate`)
- Produces: `event.message.prefix_deprecated` in every locale; `event.interaction.slash_deprecated` removed

- [ ] **Step 1: Write the locale script**

Create `scripts/invert-deprecation-notice.js`:

```javascript
const fs = require('node:fs');
const path = require('node:path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');

const VI =
	'⚠️ Lệnh prefix sắp ngừng hoạt động vì Discord thu hồi quyền đọc tin nhắn. Dùng lệnh gạch chéo `/{command}` hoặc nhắc tên bot: `@{bot} {command}` nhé!';
const EN =
	'⚠️ Prefix commands are going away — Discord is revoking message access. Use the slash command `/{command}` or mention the bot: `@{bot} {command}`';

let changed = 0;

for (const file of fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'))) {
	const full = path.join(LOCALES_DIR, file);
	const raw = fs.readFileSync(full, 'utf8');
	const json = JSON.parse(raw);

	json.event = json.event || {};
	json.event.message = json.event.message || {};
	json.event.interaction = json.event.interaction || {};

	let touched = false;

	if (json.event.interaction.slash_deprecated !== undefined) {
		delete json.event.interaction.slash_deprecated;
		touched = true;
	}

	if (json.event.message.prefix_deprecated === undefined) {
		json.event.message.prefix_deprecated = file === 'Vietnamese.json' ? VI : EN;
		touched = true;
	}

	if (touched) {
		// Reuse whatever indentation this file already uses, and append no
		// trailing newline — these files do not end with one. The first indented
		// line of a JSON object is one unit deep, so its leading whitespace is
		// the unit. 16 of the 19 files round-trip byte-identically this way.
		const indentMatch = raw.match(/\n([ \t]+)/);
		const indent = indentMatch ? indentMatch[1] : '\t';
		fs.writeFileSync(full, JSON.stringify(json, null, indent), 'utf8');
		changed++;
		console.log(`${file}: updated`);
	} else {
		console.log(`${file}: nothing to do`);
	}
}

console.log(`\nUpdated ${changed} file(s).`);
```

- [ ] **Step 2: Run it and verify**

```bash
node scripts/invert-deprecation-notice.js
node -e "
const fs=require('fs');
let bad=0;
for (const f of fs.readdirSync('./locales').filter(f=>f.endsWith('.json'))) {
  const l=JSON.parse(fs.readFileSync('./locales/'+f,'utf8'));
  if (l.event.interaction.slash_deprecated!==undefined) { console.log('FAIL still present',f); bad++; }
  if (typeof l.event.message.prefix_deprecated!=='string') { console.log('FAIL missing',f); bad++; }
}
console.log(bad===0?'all 19 locales OK':'FAILURES: '+bad);
"
```

Expected: `all 19 locales OK`

- [ ] **Step 3: Attach the notice to successful prefix commands**

In `src/events/client/MessageCreate.ts`, inside the `finally` block of the existing prefix `try/catch` (currently around line 507), add the notice as a follow-up message. It goes in `finally` so it fires whether or not the command threw, and it is `.catch`-guarded so a failed notice never masks a successful command.

```typescript
			await message.channel
				.send({
					content: T(locale, 'event.message.prefix_deprecated', {
						command: command.name,
						bot: this.client.user!.username,
					}),
				})
				.catch(() => null);
```

Note for the implementer: this posts on every prefix command, which is deliberately noisy — the point is that users notice before the cutoff. If it proves too noisy in practice, gate it to roughly one message per guild per hour with a `Map<string, number>` keyed by guild id; do not silently drop it.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run build
```

Then run `!ping` in a test guild. Expected: the normal ping reply, followed by the deprecation notice naming `/ping` and `@Bot ping`.

- [ ] **Step 5: Commit**

```bash
git add scripts/invert-deprecation-notice.js locales/ src/events/client/MessageCreate.ts
git commit -m "feat(migration): warn on prefix use instead of on slash use

slash_deprecated pointed users at prefix commands, which stop working
when MessageContent is revoked. Replaced with prefix_deprecated,
pointing at slash commands and mentions."
```

---

## Verification Checklist

Run after every task is complete:

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — no new errors
- [ ] `npm run build && node dist/utils/BotResolver.spec.js` — `BotResolver: all assertions passed`
- [ ] All 19 locales parse and contain the five new `event.interaction` keys plus `event.message.prefix_deprecated`, with no `event.interaction.slash_deprecated`
- [ ] `/play` with the receiving bot idle: handled directly, no handoff notice
- [ ] `/play` with the receiving bot busy elsewhere and another bot idle: handoff notice from the receiver, playback and now-playing from the chosen bot
- [ ] `/play` from the VC the receiving bot already occupies: queued by that bot
- [ ] `/play` with every bot busy: `no_free_bots`, and only after any voice or permission error would have been reported
- [ ] `/play` while **not** in a voice channel, with the receiving bot busy: the reply is the no-voice-channel error only — no handoff notice is posted for a delegation that never happens
- [ ] `/ping` works with the user in no voice channel
- [ ] `@Bot` alone: help embed
- [ ] `@Bot play <song>`: same three delegation outcomes as `/play`
- [ ] `!play <song>`: unchanged behaviour, plus the deprecation notice
- [ ] One bot with `messageContentIntent: false` logs in successfully; its slash and mention paths work, its prefix path is inert
- [ ] Ordinary chat messages trigger no database queries

## Day-27 Follow-Up (not part of this plan)

Once `MessageContent` is revoked fleet-wide, delete the prefix branch of `MessageCreate.ts` along with its inline guard copy, `getAllPrefixes`, and the `prefix_deprecated` notice. The guard duplication this plan deliberately accepts resolves at that point by deletion. Track separately.
