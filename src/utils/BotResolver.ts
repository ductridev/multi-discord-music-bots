import type { Guild } from 'discord.js';
import type { Lavamusic } from '../structures/index';

export interface BotMeta {
	bot: Lavamusic;
	clientId: string;
	name: string;
	isInAnyVC: boolean;
	hasActivePlayer: boolean;
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
	vcToBot: Map<string, string[]>;
} {
	const botIds = new Set(bots.map(bot => bot.user!.id));
	const vcToBot = new Map<string, string[]>();
	const activeBotIds = new Set<string>();

	for (const [, voiceState] of guild.voiceStates.cache) {
		const memberId = voiceState.member?.user.id;
		if (voiceState.channelId && memberId && botIds.has(memberId)) {
			const occupants = vcToBot.get(voiceState.channelId) ?? [];
			occupants.push(memberId);
			vcToBot.set(voiceState.channelId, occupants);
			activeBotIds.add(memberId);
		}
	}

	const botMeta = bots.map(bot => {
		const player = bot.manager.getPlayer(guild.id);
		return {
			bot,
			clientId: bot.user!.id,
			name: bot.childEnv.name,
			isInAnyVC: activeBotIds.has(bot.user!.id),
			hasActivePlayer: Boolean(player?.queue.current),
		};
	});

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
	vcToBot: Map<string, string[]>,
	botMeta: BotMeta[],
	userVCId: string | null,
	receiver?: Lavamusic | null,
): ResolveResult {
	if (botMeta.length === 0) {
		return { bot: null, valid: false, reason: 'no_bots' };
	}

	if (userVCId) {
		const occupantIds = vcToBot.get(userVCId) ?? [];
		const occupants = occupantIds
			.map(id => botMeta.find(entry => entry.clientId === id))
			.filter((entry): entry is BotMeta => entry !== undefined);
		// Two bots can share a channel. The one holding the queue is the one
		// the user means, so prefer it over an idle co-occupant.
		const chosen = occupants.find(entry => entry.hasActivePlayer) ?? occupants[0];
		if (chosen) {
			return { bot: chosen.bot, valid: true, reason: 'in_user_vc' };
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
