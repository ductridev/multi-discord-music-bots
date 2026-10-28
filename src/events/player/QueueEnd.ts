import type { TextChannel } from 'discord.js';
import type { Player, Track, TrackStartEvent } from 'lavalink-client';
import { Event, type Lavamusic } from '../../structures/index';
import { updateSetup } from '../../utils/SetupSystem';
import { T } from '../../structures/I18n';
import { PeriodicMessageSystem } from '../../utils/PeriodicMessageSystem';

export default class QueueEnd extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'queueEnd',
		});
	}

	public async run(player: Player, _track: Track | null, _payload: TrackStartEvent): Promise<void> {
		const guild = this.client.guilds.cache.get(player.guildId);
		if (!guild) return;

		// End periodic message session when queue ends
		PeriodicMessageSystem.endSession(player.guildId, this.client.childEnv.clientId);

		// Clear all vote data
		const voteActions = ['skip', 'stop', 'pause', 'resume', 'volume', 'seek', 'shuffle', 'skipto', 'clearqueue', 'leave'];
		for (const action of voteActions) {
			player.set(`${action}Votes`, new Set<string>());
			player.set(`${action}VoteMessageId`, undefined);
			player.set(`${action}VoteChannelId`, undefined);
		}
		player.set('keepVotes', new Set<string>());

		// Save player queue
		await player.queue.utils.save();

		// Persist the now-idle player state. playerUpdate only fires while a track
		// streams, so without this the last-playing snapshot (old queue.current)
		// stays frozen in playerData/Redis and a restart resurrects a track the
		// user already stopped. Writing the idle snapshot keeps the store mirroring
		// live state; the entry is reaped by TTL, not deleted here.
		await this.client.playerSaver!.set(player.guildId, JSON.stringify(player.toJSON()));

		const locale = await this.client.db.getLanguage(player.guildId);
		await updateSetup(this.client, guild, locale);

		if (player.voiceChannelId) {
			// await this.client.utils.setVoiceStatus(this.client, player.voiceChannelId, "");
		}

		// Stop paths clear messageId before stopping, so a missing message must not skip
		// the idle-disconnect timer below.
		const messageId = player.get<string | undefined>('messageId');
		const textChannel = messageId ? (guild.channels.cache.get(player.textChannelId!) as TextChannel | undefined) : undefined;
		const message = textChannel ? await textChannel.messages.fetch(messageId!).catch(() => null) : null;
		if (message?.editable) {
			await message.edit({ components: [] }).catch(() => {
				null;
			});
		}

		const is247 = await this.client.db.get_247(this.client.childEnv.clientId, player.guildId);

		if (player.queue.tracks.length <= 0) {
			if (!this.client.timeoutListenersMap.has(player.guildId) && !this.client.timeoutSongsMap.has(player.guildId) && !is247) {
				const channel = this.client.channels.cache.get(player.textChannelId!);
				const locale = await this.client.db.getLanguage(player.guildId);
				const embed = this.client.embed().setFooter({
					text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
					iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
				})
					.setTimestamp();
				const time = 5;

				if (channel && channel.isTextBased()) {
					await (channel as TextChannel).send({
						embeds: [embed.setColor(this.client.color.main).setDescription(T(locale, 'will_leave.no_songs', { time: time }))],
					});
				}
				const timeout = setTimeout(async () => {
					if (!player?.voiceChannelId) return;

					const channel = this.client.channels.cache.get(player.textChannelId!);
					const locale = await this.client.db.getLanguage(player.guildId);
					const embed = this.client.embed()
						.setFooter({
							text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
							iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
						})
						.setTimestamp();

					if (channel && channel.isTextBased()) {
						await (channel as TextChannel).send({
							embeds: [embed.setColor(this.client.color.red).setDescription(T(locale, 'event.voice_state_update.left_due_to_timeout_no_songs', { channelId: player.voiceChannelId }))],
						});
					}

					player.destroy();
				}, time * 60_000);
				this.client.timeoutSongsMap.set(player.guildId, timeout);
			}
		}
	}
}


