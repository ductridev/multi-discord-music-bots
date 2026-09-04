import { AutoPoster } from 'topgg-autoposter';
import { Event, type Lavamusic } from '../../structures/index';
import { dashboardSocket } from '../../api/websocket/DashboardSocket';

export default class Ready extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'clientReady',
		});
	}

	public async run(): Promise<void> {
		this.client.logger.success(`${this.client.user?.tag} is ready!`);

		this.client.user?.setPresence({
			activities: [
				{
					name: this.client.childEnv.activity ?? 'Tui tên Bô',
					type: this.client.childEnv.activityType as any,
				},
			],
			status: this.client.childEnv.status as any,
		});

		// Emit WebSocket event for dashboard
		dashboardSocket.emitBotStatus({
			clientId: this.client.childEnv.clientId,
			status: 'online',
			guilds: this.client.guilds.cache.size,
			players: this.client.manager?.players.size || 0,
		});

		// Sync slash commands on every boot: non-dev commands globally, dev-only
		// commands to the configured dev guild(s).
		try {
			await this.client.deployCommands();
			await this.client.deployDevCommands();
			this.client.logger.info('Slash commands synced successfully!');
		} catch (error) {
			this.client.logger.error('Failed to sync slash commands:', error);
		}

		if (this.client.env.TOPGG) {
			// Only start auto poster if the client ID matches
			if (this.client.application?.id === this.client.env.TOPGG_CLIENT_ID) {
				const autoPoster = AutoPoster(this.client.env.TOPGG, this.client);
				setInterval(() => {
					autoPoster.on('posted', _stats => {
						null;
					});
				}, 24 * 60 * 60e3); // 24 hours in milliseconds
			} else {
				this.client.logger.warn('Top.gg client ID does not match application ID. Skipping auto poster.');
			}
		} else {
			this.client.logger.warn('Top.gg token not found. Skipping auto poster.');
		}
		await this.client.manager.init({ ...this.client.user!, shards: 'auto' });

		// Handle 247 mode reconnection
		await this.handle247Reconnection();
	}

	private async handle247Reconnection(): Promise<void> {
		try {
			const stay247Data = await this.client.db.get_247(this.client.childEnv.clientId);
			if (!stay247Data) return;

			const dataArray = Array.isArray(stay247Data) ? stay247Data : [stay247Data];

			for (const data of dataArray) {
				try {
					const guild = this.client.guilds.cache.get(data.guildId);
					if (!guild) {
						// Guild not found, remove 247 mode
						await this.client.db.delete_247(data.guildId, this.client.childEnv.clientId);
						continue;
					}

					const voiceChannel = guild.channels.cache.get(data.voiceId);
					const textChannel = guild.channels.cache.get(data.textId);

					if (!voiceChannel || !textChannel) {
						// Channels not found, remove 247 mode
						await this.client.db.delete_247(data.guildId, this.client.childEnv.clientId);
						this.client.logger.info(`Removed invalid 247 mode data for guild ${data.guildId} - channels not found`);
						continue;
					}

					// Check if bot is already connected to this voice channel
					const botVoiceState = guild.members.cache.get(this.client.user!.id)?.voice;
					if (botVoiceState?.channelId === data.voiceId) {
						this.client.logger.info(`Already connected to 247 voice channel in guild ${data.guildId}`);
						continue;
					}

					// Check if there's already a player for this guild
					let player = this.client.manager.getPlayer(data.guildId);
					if (!player) {
						// No player exists, this will be handled by node connect event
						this.client.logger.info(`247 mode enabled for guild ${data.guildId}, waiting for node connection to create player`);
						continue;
					}

					// Player exists but not connected to the right channel
					if (player.voiceChannelId !== data.voiceId) {
						try {
							player.options.voiceChannelId = data.voiceId;
							await player.connect();
							this.client.logger.info(`Reconnected 247 mode player to voice channel ${data.voiceId} in guild ${data.guildId}`);
						} catch (error) {
							this.client.logger.error(`Failed to reconnect 247 mode player in guild ${data.guildId}:`, error);
							// If connection fails, disable 247 mode
							await this.client.db.delete_247(data.guildId, this.client.childEnv.clientId);
						}
					}
				} catch (error) {
					this.client.logger.error(`Error handling 247 reconnection for guild ${data.guildId}:`, error);
					try {
						await this.client.db.delete_247(data.guildId, this.client.childEnv.clientId);
					} catch (dbError) {
						this.client.logger.error(`Failed to cleanup 247 mode for guild ${data.guildId}:`, dbError);
					}
				}
			}
		} catch (error) {
			this.client.logger.error('Error in 247 mode reconnection handler:', error);
		}
	}
}


