import assert from 'node:assert';
import type { Guild } from 'discord.js';
import { buildBotMeta, pickReceiver, resolveBot, type BotMeta } from './BotResolver';
import type { Lavamusic } from '../structures/index';

function fakeBot(id: string, currentTrack: unknown = null): Lavamusic {
	return {
		user: { id },
		childEnv: { clientId: id, name: `bot-${id}` },
		manager: { getPlayer: () => (currentTrack ? { queue: { current: currentTrack } } : null) },
	} as unknown as Lavamusic;
}

/**
 * Fake guild for buildBotMeta. Each state is `[userId, channelId, memberCached]`.
 *
 * `memberCached: false` produces a voice state with no `member` — the shape that
 * exposed the bug fixed in `buildBotMeta`. That is not a contrived case: the
 * fleet dropped the `GuildMembers` intent, so member caches are routinely cold.
 */
function fakeGuild(states: Array<[string, string | null, boolean]>): Guild {
	const cache = new Map(
		states.map(([userId, channelId, memberCached]) => [
			userId,
			{ id: userId, channelId, member: memberCached ? { user: { id: userId } } : undefined },
		]),
	);
	return { id: 'guild1', voiceStates: { cache } } as unknown as Guild;
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

// --- buildBotMeta: the half that reads Discord state ---

// 9. Two bots share a channel; humans in it are ignored, idle bots stay idle.
{
	const guild = fakeGuild([
		['A', 'vc1', true],
		['B', 'vc1', true],
		['human', 'vc1', true],
	]);
	const { botMeta, vcToBot } = buildBotMeta([a, b, c], guild);
	assert.strictEqual(vcToBot.size, 1, 'only channels containing fleet bots are mapped');
	assert.deepStrictEqual(vcToBot.get('vc1'), ['A', 'B'], 'both occupants recorded, human excluded');
	assert.strictEqual(botMeta.find(m => m.clientId === 'A')!.isInAnyVC, true);
	assert.strictEqual(botMeta.find(m => m.clientId === 'C')!.isInAnyVC, false);
}

// 10. An occupant with no cached member is still an occupant. This is the
//     regression guard: reading the id from voiceState.member instead of
//     voiceState.id made a busy bot look idle and invited a second command.
{
	const guild = fakeGuild([['A', 'vc1', false]]);
	const { botMeta, vcToBot } = buildBotMeta([a, b], guild);
	assert.deepStrictEqual(vcToBot.get('vc1'), ['A'], 'occupant must be found without a cached member');
	assert.strictEqual(botMeta.find(m => m.clientId === 'A')!.isInAnyVC, true, 'uncached member must not read as idle');
	assert.strictEqual(botMeta.find(m => m.clientId === 'B')!.isInAnyVC, false);
}

// 11. hasActivePlayer comes from the player's current track, not mere presence.
{
	const playing = fakeBot('P', { title: 'song' });
	const idle = fakeBot('I');
	const guild = fakeGuild([
		['P', 'vc1', true],
		['I', 'vc1', true],
	]);
	const { botMeta } = buildBotMeta([playing, idle], guild);
	assert.strictEqual(botMeta.find(m => m.clientId === 'P')!.hasActivePlayer, true);
	assert.strictEqual(botMeta.find(m => m.clientId === 'I')!.hasActivePlayer, false, 'present but empty queue is not active');
}

// 12. A voice state with no channelId is not an occupancy.
{
	const guild = fakeGuild([['A', null, true]]);
	const { botMeta, vcToBot } = buildBotMeta([a], guild);
	assert.strictEqual(vcToBot.size, 0);
	assert.strictEqual(botMeta[0].isInAnyVC, false);
}

// 13. Both halves together: the queue holder wins rung 1 even when it is the
//     occupant whose member is not cached and it is listed second.
{
	const playing = fakeBot('P', { title: 'song' });
	const idle = fakeBot('I');
	const guild = fakeGuild([
		['I', 'vc1', true],
		['P', 'vc1', false],
	]);
	const { botMeta, vcToBot } = buildBotMeta([idle, playing], guild);
	const r = resolveBot(vcToBot, botMeta, 'vc1', null);
	assert.strictEqual(r.bot, playing, 'queue holder must win with no cached member');
	assert.strictEqual(r.reason, 'in_user_vc');
}

// 14. A guild prefix names its own bot, whatever the message id or list order.
{
	const bots = ['A', 'B', 'C'];
	const prefixes = ['a!', 'b!', 'c!'];
	assert.strictEqual(pickReceiver(bots, prefixes, 'b!', '!', '123456789012345678'), 'B');
	assert.strictEqual(pickReceiver(bots, prefixes, 'c!', '!', '999999999999990000'), 'C');
}

// 15. The global prefix spreads across the fleet by message id, and does so
//     identically on every instance — two bots picking different receivers for
//     one message is how a command gets answered twice.
{
	const bots = ['A', 'B', 'C'];
	const prefixes = ['a!', 'b!', 'c!'];
	// 0x0003 % 3 === 0, 0x0004 % 3 === 1, 0x0005 % 3 === 2.
	assert.strictEqual(pickReceiver(bots, prefixes, '!', '!', '111111111111110003'), 'A');
	assert.strictEqual(pickReceiver(bots, prefixes, '!', '!', '111111111111110004'), 'B');
	assert.strictEqual(pickReceiver(bots, prefixes, '!', '!', '111111111111110005'), 'C');
	assert.strictEqual(
		pickReceiver(bots, prefixes, '!', '!', '111111111111110004'),
		pickReceiver(bots, prefixes, '!', '!', '111111111111110004'),
		'same message must resolve to the same receiver on every instance',
	);
}

// 16. A prefix that belongs to a bot no longer serving this guild is neither a
//     name nor the global prefix. Falling back to the first bot keeps a reply
//     coming instead of dropping the command.
{
	assert.strictEqual(pickReceiver(['A', 'B'], ['a!', 'b!'], 'z!', '!', '111111111111110004'), 'A');
}

// 17. A duplicate prefix resolves to the first holder — two bots must not both
//     consider themselves addressed.
{
	assert.strictEqual(pickReceiver(['A', 'B'], ['x!', 'x!'], 'x!', '!', '111111111111110004'), 'A');
}

console.log('BotResolver: all assertions passed');
