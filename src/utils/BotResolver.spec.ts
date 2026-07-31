import assert from 'node:assert';
import { resolveBot, type BotMeta } from './BotResolver';
import type { Lavamusic } from '../structures/index';

function fakeBot(id: string): Lavamusic {
	return { user: { id }, childEnv: { clientId: id, name: `bot-${id}` } } as unknown as Lavamusic;
}

function meta(bot: Lavamusic, isInAnyVC: boolean, hasActivePlayer = false): BotMeta {
	return { bot, clientId: bot.user!.id, name: bot.childEnv.name, isInAnyVC, hasActivePlayer };
}

const a = fakeBot('A');
const b = fakeBot('B');
const c = fakeBot('C');

// 1. A bot already sitting in the user's VC wins, even when the receiver is idle.
{
	const vcToBot = new Map([['vc1', ['C']]]);
	const botMeta = [meta(a, false), meta(b, false), meta(c, true)];
	const r = resolveBot(vcToBot, botMeta, 'vc1', a);
	assert.strictEqual(r.bot, c, 'bot in user VC must win');
	assert.strictEqual(r.valid, true);
	assert.strictEqual(r.reason, 'in_user_vc');
}

// 2. No bot in the user's VC, receiver idle -> receiver handles it, no pointless delegation.
{
	const vcToBot = new Map<string, string[]>();
	const botMeta = [meta(a, false), meta(b, false)];
	const r = resolveBot(vcToBot, botMeta, 'vc1', b);
	assert.strictEqual(r.bot, b, 'idle receiver must handle its own command');
	assert.strictEqual(r.reason, 'receiver_idle');
}

// 3. Receiver busy elsewhere -> delegate to another idle bot.
{
	const vcToBot = new Map([['vc9', ['A']]]);
	const botMeta = [meta(a, true), meta(b, false)];
	const r = resolveBot(vcToBot, botMeta, 'vc1', a);
	assert.strictEqual(r.bot, b, 'must delegate to an idle bot');
	assert.strictEqual(r.reason, 'any_idle');
}

// 4. Every bot busy in some other VC -> no bot, invalid.
{
	const vcToBot = new Map([['vc8', ['A']], ['vc9', ['B']]]);
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
	const vcToBot = new Map<string, string[]>();
	const botMeta = [meta(a, false), meta(b, false)];
	const r = resolveBot(vcToBot, botMeta, null, b);
	assert.strictEqual(r.bot, b);
	assert.strictEqual(r.valid, true);
	assert.strictEqual(r.reason, 'receiver_idle');
}

// 7. Two bots occupy the user's VC, only the second has an active player -> resolveBot returns the one with the player.
{
	const vcToBot = new Map([['vc1', ['A', 'B']]]);
	const botMeta = [meta(a, true, false), meta(b, true, true)];
	const r = resolveBot(vcToBot, botMeta, 'vc1', null);
	assert.strictEqual(r.bot, b, 'must prefer occupant with active player');
	assert.strictEqual(r.valid, true);
	assert.strictEqual(r.reason, 'in_user_vc');
}

// 8. Two bots occupy the user's VC, neither has an active player -> returns the first occupant.
{
	const vcToBot = new Map([['vc1', ['B', 'A']]]);
	const botMeta = [meta(a, true, false), meta(b, true, false)];
	const r = resolveBot(vcToBot, botMeta, 'vc1', null);
	assert.strictEqual(r.bot, b, 'must return first occupant when none have player');
	assert.strictEqual(r.valid, true);
	assert.strictEqual(r.reason, 'in_user_vc');
}

console.log('BotResolver: all assertions passed');
