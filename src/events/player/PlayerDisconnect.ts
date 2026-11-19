import type { TextChannel } from 'discord.js';
import type { Player } from 'lavalink-client';
import { Event, type Lavamusic } from '../../structures/index';
import { deleteNowPlayingMessage } from '../../utils/NowPlayingMessage';
import { updateSetup } from '../../utils/SetupSystem';

export default class PlayerDisconnect extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'playerDisconnect',
		});
	}

	public async run(player: Player, _voiceChannelId: string): Promise<void> {
		const guild = this.client.guilds.cache.get(player.guildId);
		if (!guild) return;
		const locale = await this.client.db.getLanguage(player.guildId);
		await updateSetup(this.client, guild, locale);

		// Disable 247 mode when bot disconnects from voice channel
		const is247 = await this.client.db.get_247(this.client.childEnv.clientId, player.guildId);
		if (is247) {
			try {
				await this.client.db.delete_247(player.guildId, this.client.childEnv.clientId);
				this.client.logger.info(`Disabled 247 mode for guild ${player.guildId} due to player disconnect`);
				
				// Notify in text channel if available
				const textChannel = guild.channels.cache.get(player.textChannelId!) as TextChannel;
				if (textChannel && textChannel.isTextBased()) {
					const embed = this.client.embed()
						.setColor(this.client.color.yellow)
						.setDescription('🔌 247 mode has been disabled due to voice channel disconnect.')
						.setFooter({
							text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
							iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
						})
						.setTimestamp();
					
					await textChannel.send({ embeds: [embed] }).catch(() => null);
				}
			} catch (error) {
				this.client.logger.error('Error disabling 247 mode on player disconnect:', error);
			}
		}

		if (player.voiceChannelId) {
			// await this.client.utils.setVoiceStatus(this.client, player.voiceChannelId, "");
		}

		await deleteNowPlayingMessage(guild, player);
	}
}


