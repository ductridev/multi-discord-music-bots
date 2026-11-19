import type { Guild, TextChannel } from 'discord.js';
import type { Player } from 'lavalink-client';

/**
 * Deletes the player's now-playing embed and forgets its id. Stripping only the buttons
 * left one dead embed per track, stop and Lavalink reconnect, which read as spam.
 * Callers that await before cleaning up pass the id they captured, so an embed posted
 * for newer playback in the meantime is left alone.
 */
export async function deleteNowPlayingMessage(
	guild: Guild,
	player: Player,
	messageId = player.get<string | undefined>('messageId'),
): Promise<void> {
	if (!messageId || !player.textChannelId) return;
	if (player.get<string | undefined>('messageId') === messageId) player.set('messageId', undefined);

	const channel = guild.channels.cache.get(player.textChannelId) as TextChannel | undefined;
	const message = await channel?.messages.fetch(messageId).catch(() => null);
	if (message?.deletable) await message.delete().catch(() => null);
}
