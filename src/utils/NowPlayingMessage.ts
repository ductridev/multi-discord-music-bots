import type { Guild, TextChannel } from 'discord.js';
import type { Player } from 'lavalink-client';

/**
 * Deletes the player's now-playing embed and forgets its id. Stripping only the buttons
 * left one dead embed per track, stop and Lavalink reconnect, which read as spam.
 */
export async function deleteNowPlayingMessage(guild: Guild, player: Player): Promise<void> {
	const messageId = player.get<string | undefined>('messageId');
	if (!messageId || !player.textChannelId) return;
	player.set('messageId', undefined);

	const channel = guild.channels.cache.get(player.textChannelId) as TextChannel | undefined;
	const message = await channel?.messages.fetch(messageId).catch(() => null);
	if (message?.deletable) await message.delete().catch(() => null);
}
