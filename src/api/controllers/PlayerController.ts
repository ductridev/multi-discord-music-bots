import { activeBots } from '../../index';
import Logger from '../../structures/Logger';
import { T } from '../../structures/I18n';
import type { PlayerControlDTO } from '../types';

const logger = new Logger('PlayerController');

export class PlayerController {
	// Get all active players
	static async getAllPlayers() {
		try {
			const players: any[] = [];

			for (const bot of activeBots) {
				if (!bot.manager) continue;

				for (const [guildId, player] of bot.manager.players) {
				const guild = bot.guilds.cache.get(guildId);
				if (!guild) continue;

				const voiceChannel = guild.channels.cache.get(player.voiceChannelId || '');
				const textChannel = guild.channels.cache.get(player.textChannelId || '');

				players.push({
					guildId,
					guildName: guild.name,
					clientId: bot.childEnv.clientId,
					botName: bot.childEnv.name || bot.user?.username || 'Unknown Bot',
					voiceChannel: {
						id: player.voiceChannelId || '',
						name: voiceChannel?.name || 'Unknown Channel',
					},
					textChannel: {
						id: player.textChannelId || '',
						name: textChannel?.name || 'Unknown Channel',
					},
					currentTrack: player.queue.current ? {
						title: player.queue.current.info.title,
						author: player.queue.current.info.author,
						duration: player.queue.current.info.duration,
						position: player.position,
						uri: player.queue.current.info.uri,
						thumbnail: player.queue.current.info.artworkUrl,
						requestedBy: {
							id: (player.queue.current.requester as any)?.id || '',
							username: (player.queue.current.requester as any)?.username || 'Unknown',
							avatar: (player.queue.current.requester as any)?.avatar,
						},
					} : undefined,
					queue: player.queue.tracks.map(track => ({
						title: track.info.title,
						author: track.info.author,
						duration: track.info.duration,
						uri: track.info.uri,
						thumbnail: track.info.artworkUrl,
						requestedBy: {
							id: (track.requester as any)?.id || '',
							username: (track.requester as any)?.username || 'Unknown',
							avatar: (track.requester as any)?.avatar,
						},
					})),
					volume: player.volume,
					isPaused: player.paused,
					isLooping: player.repeatMode !== 'off',
					isAutoplay: false,
					filters: [],
				});
				}
			}

			return { success: true, data: players };
		} catch (error) {
			logger.error('Failed to get all players:', error);
			return { success: false, error: 'Failed to fetch players' };
		}
	}

	// Get player for specific guild
	static async getPlayer(guildId: string) {
		try {
			// Find which bot is serving this guild
			let targetBot = null;
			let player = null;

			for (const bot of activeBots) {
				if (!bot.manager) continue;
				const guildPlayer = bot.manager.getPlayer(guildId);
				if (guildPlayer) {
					targetBot = bot;
					player = guildPlayer;
					break;
				}
			}

			if (!player || !targetBot) {
				return { success: false, error: 'No active player in this guild' };
			}

			const guild = targetBot.guilds.cache.get(guildId);

			return {
				success: true,
				data: {
					guildId,
					guildName: guild?.name,
					clientId: targetBot.childEnv.clientId,
					botName: targetBot.childEnv.name || targetBot.user?.username || 'Unknown Bot',
					voiceChannel: player.voiceChannelId,
					textChannel: player.textChannelId,
					currentTrack: player.queue.current ? {
						title: player.queue.current.info.title,
						author: player.queue.current.info.author,
						duration: player.queue.current.info.duration,
						uri: player.queue.current.info.uri,
						artworkUrl: player.queue.current.info.artworkUrl,
						requester: player.queue.current.requester,
					} : null,
					queue: player.queue.tracks.map(track => ({
						title: track.info.title,
						author: track.info.author,
						duration: track.info.duration,
						uri: track.info.uri,
						artworkUrl: track.info.artworkUrl,
						requester: track.requester,
					})),
					volume: player.volume,
					paused: player.paused,
					position: player.position,
					repeatMode: player.repeatMode,
				},
			};
		} catch (error) {
			logger.error(`Failed to get player for guild ${guildId}:`, error);
			return { success: false, error: 'Failed to fetch player' };
		}
	}

	// Control player
	static async controlPlayer(guildId: string, control: PlayerControlDTO) {
		try {
			// Find the bot managing this guild
			let targetBot = null;
			let player = null;

			for (const bot of activeBots) {
				if (!bot.manager) continue;
				const guildPlayer = bot.manager.getPlayer(guildId);
				if (guildPlayer) {
					targetBot = bot;
					player = guildPlayer;
					break;
				}
			}

			if (!player || !targetBot) {
				return { success: false, error: 'No active player in this guild' };
			}

			switch (control.action) {
				case 'pause':
					if (player.paused) {
						player.resume();
					} else {
						player.pause();
					}
					logger.info(`Player ${player.paused ? 'paused' : 'resumed'} in guild ${guildId}`);
					break;

				case 'skip':
					await player.skip();
					logger.info(`Skipped track in guild ${guildId}`);
					break;

				case 'stop': {
					// Mirror the embed STOP button (SetupButtons.ts): stop playback and
					// clear the queue but stay in the voice channel. destroy() would leave.
					// Capture the now-playing message before clearing messageId so we can
					// refresh it to the stopped state (QueueEnd skips it once messageId is null).
					const messageId = player.get('messageId') as string | undefined;
					const textChannelId = player.textChannelId;

					player.set('messageId', undefined);
					player.stopPlaying(true, false);

					if (messageId && textChannelId) {
						try {
							const locale = await targetBot.db.getLanguage(guildId);
							const channel = targetBot.channels.cache.get(textChannelId);
							const message = channel?.isTextBased?.()
								? await channel.messages.fetch(messageId).catch(() => null)
								: null;
							if (message?.editable) {
								const embed = targetBot
									.embed()
									.setColor(targetBot.color.main)
									.setAuthor({
										name: targetBot.user?.username ?? 'Music',
										iconURL: targetBot.user?.displayAvatarURL({ extension: 'png' }),
									})
									.setDescription(T(locale, 'event.setupButton.nothing_playing'))
									.setImage(targetBot.config.links.img)
									.setFooter({
										text:
											T(locale, 'event.setupButton.stopped_footer', { displayName: 'Dashboard' }) +
											' • BuNgo Music Bot 🎵 • Made by Gúp Bu Ngô with ♥️',
										iconURL: targetBot.user?.displayAvatarURL({ extension: 'png' }),
									});
								await message.edit({ embeds: [embed] });
							}
						} catch (err) {
							logger.error(`Failed to update setup message after stop in guild ${guildId}:`, err);
						}
					}

					logger.info(`Stopped player in guild ${guildId}`);
					break;
				}

				case 'volume':
					if (control.volume !== undefined) {
						player.setVolume(control.volume);
						logger.info(`Set volume to ${control.volume} in guild ${guildId}`);
					}
					break;

				case 'seek':
					if (control.position !== undefined) {
						player.seek(control.position);
						logger.info(`Seeked to ${control.position}ms in guild ${guildId}`);
					}
					break;

				default:
					return { success: false, error: 'Invalid action' };
			}

			return { success: true, message: `Action ${control.action} executed successfully` };
		} catch (error) {
			logger.error(`Failed to control player in guild ${guildId}:`, error);
			return { success: false, error: 'Failed to control player' };
		}
	}
}
