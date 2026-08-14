import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type ChannelSelectMenuInteraction,
	GuildMember,
	type MentionableSelectMenuInteraction,
	PermissionFlagsBits,
	MessageFlags,
	type RoleSelectMenuInteraction,
	type StringSelectMenuInteraction,
	type TextChannel,
	type UserSelectMenuInteraction,
	Message,
	ComponentType,
} from 'discord.js';
import type { Player, Track, TrackStartEvent } from 'lavalink-client';
import { T } from '../../structures/I18n';
import { Event, type Lavamusic } from '../../structures/index';
import type { Requester } from '../../types';
import { trackStart } from '../../utils/SetupSystem';
import { VoiceStateHelper } from '../../utils/VoiceStateHelper';
import { dashboardSocket } from '../../api/websocket/DashboardSocket';
import { PrismaClient } from '@prisma/client';
import { PeriodicMessageSystem } from '../../utils/PeriodicMessageSystem';
import { isTrackLoopReplay } from '../../utils/TrackLoop';

const prisma = new PrismaClient();

export default class TrackStart extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'trackStart',
		});
	}

	public async run(player: Player, track: Track | null, _payload: TrackStartEvent): Promise<void> {
		const guild = this.client.guilds.cache.get(player.guildId);
		if (!player.options.customData) player.options.customData = {};
		player.options.customData.botClientId = this.client.childEnv.clientId

		// Save player session across shards
		await VoiceStateHelper.saveSession(
			this.client,
			player.guildId,
			player.voiceChannelId!,
			player
		);

		// Cancel timeout
		const timeout = this.client.timeoutSongsMap.get(player.guildId);
		if (timeout) {
			clearTimeout(timeout);
			this.client.timeoutSongsMap.delete(player.guildId);
		}
		if (!guild) return;
		if (!player.textChannelId) return;
		if (!track) return;

		// Emit WebSocket event for dashboard
		dashboardSocket.emitPlayerStart({
			guildId: player.guildId,
			clientId: this.client.childEnv.clientId,
			track: {
				title: track.info.title,
				author: track.info.author,
				duration: track.info.duration,
				uri: track.info.uri,
			},
			requestedBy: (track.requester as Requester).username,
		});

		// Detect source from track URL
		const detectSourceFromUrl = (url: string): string => {
			if (url.includes('youtube.com') || url.includes('youtu.be')) {
				return 'youtube';
			}
			if (url.includes('spotify.com')) {
				return 'spotify';
			}
			if (url.includes('soundcloud.com')) {
				return 'soundcloud';
			}
			return 'youtube'; // Default to youtube
		};

		// Maximum safe duration value for database (max 32-bit signed integer in milliseconds)
		// This is approximately 24 days in milliseconds - more than enough for any real track
		const MAX_SAFE_DURATION_MS = 2147483647;

		// Cap duration to safe value to prevent overflow for livestreams/unknown duration tracks
		const safeDurationMs = (duration: number): number => {
			if (!duration || duration <= 0) return 0;
			if (duration > MAX_SAFE_DURATION_MS) return MAX_SAFE_DURATION_MS;
			return Math.floor(duration);
		};

		// Get listener count from voice channel
		const getListenerCount = (): number => {
			const voiceChannel = guild?.channels.cache.get(player.voiceChannelId!);
			if (voiceChannel && 'members' in voiceChannel) {
				const members = voiceChannel.members as Map<string, { user: { bot: boolean } }>;
				return [...members.values()].filter((m) => !m.user.bot).length;
			}
			return 0;
		};

		const listenerCount = getListenerCount();
		const startedAt = new Date();
		const source = detectSourceFromUrl(track.info.uri || '');

		// Generate unique trackPlayId for upsert: guildId-botId-trackUrl-timestamp
		const trackPlayId = `${player.guildId}-${this.client.childEnv.clientId}-${encodeURIComponent(track.info.uri || 'unknown')}-${startedAt.getTime()}`;

		// Record to player history and track play
		try {
			// Record to PlayerHistory (legacy)
			const playerHistoryPromise = prisma.playerHistory.create({
				data: {
					guildId: player.guildId,
					clientId: this.client.childEnv.clientId,
					trackUrl: track.info.uri,
					trackTitle: track.info.title,
					author: (track.requester as Requester).username,
					authorId: (track.requester as Requester).id,
					duration: safeDurationMs(track.info.duration),
				},
			});

			// Record to TrackPlay using create (new statistics)
			const trackPlayPromise = prisma.trackPlay.create({
				data: {
					trackPlayId,
					guildId: player.guildId,
					botId: this.client.childEnv.clientId,
					trackName: track.info.title,
					trackUrl: track.info.uri,
					source,
					duration: Math.floor(safeDurationMs(track.info.duration) / 1000), // Convert ms to seconds
					playedBy: (track.requester as Requester).id,
					startedAt,
					listenerCount,
				},
			});

			const [, trackPlayRecord] = await Promise.all([playerHistoryPromise, trackPlayPromise]);

			// Store the record id in player customData for later update in TrackEnd
			player.options.customData = {
				...player.options.customData,
				currentTrackPlayDbId: trackPlayRecord.id,
			};
		} catch (error) {
			this.client.logger.error('Failed to record player history:', error);
		}

		const channel = guild.channels.cache.get(player.textChannelId) as TextChannel;
		if (!channel) return;

		// Save player queue
		await player.queue.utils.save();

		this.client.utils.updateStatus(this.client, guild.id);

		const locale = await this.client.db.getLanguage(guild.id);

		// Mark session start for periodic message system
		PeriodicMessageSystem.startSession(guild.id, this.client.childEnv.clientId);

		// if (player.voiceChannelId) {
		// 	await this.client.utils.setVoiceStatus(this.client, player.voiceChannelId, `🎵 ${track.info.title}`);
		// }

		const embed = this.client
			.embed()
			.setAuthor({
				name: T(locale, 'player.trackStart.now_playing'),
				iconURL:
					this.client.config.icons[track.info.sourceName] ?? this.client.user?.displayAvatarURL({ extension: 'png' }),
			})
			.setColor(this.client.color.main)
			.setDescription(`**[${track.info.title}](${track.info.uri})**`)
			.setFooter({
				text: T(locale, 'player.trackStart.requested_by', {
					user: (track.requester as Requester).username,
				}) + " • BuNgo Music Bot 🎵 • Made by Gúp Bu Ngô with ♥️",
				iconURL: (track.requester as Requester).avatarURL,
			})
			.setThumbnail(track.info.artworkUrl)
			.addFields(
				{
					name: T(locale, 'player.trackStart.duration'),
					value: track.info.isStream ? 'LIVE' : this.client.utils.formatTime(track.info.duration),
					inline: true,
				},
				{
					name: T(locale, 'player.trackStart.author'),
					value: track.info.author,
					inline: true,
				},
			)
			.setTimestamp();

		const setup = await this.client.db.getSetup(guild.id);

		if (setup && setup.textId) {
			const textChannel = guild.channels.cache.get(setup.textId) as TextChannel;
			if (textChannel) {
				await trackStart(setup.messageId, textChannel, player, track, this.client, locale);
			}
		} else {
			const previousMessageId = player.get<string | undefined>('messageId');
			const previousMessageTrack = player.get<string | undefined>('messageTrack');

			// Track loop replaying the same track: message already exists, reuse it.
			// A skip while looping advances the queue, so the track differs and needs
			// a fresh message.
			if (previousMessageId && isTrackLoopReplay(player.repeatMode, track.encoded, previousMessageTrack)) {
				return;
			}

			// For queue loop or normal mode: remove buttons from old message and create new one
			if (previousMessageId) {
				try {
					const previousMessage = await channel.messages.fetch(previousMessageId).catch(() => null);
					if (previousMessage) {
						// Remove buttons from the old message instead of deleting it
						await previousMessage.edit({ components: [] }).catch(() => null);
					}
				} catch (error) {
					// Message might already be deleted or not found, continue
				}
			}

			const message = await channel.send({
				embeds: [embed],
				components: [createButtonRow(player, this.client)],
				flags: 4096
			});

			player.set('messageId', message.id);
			player.set('messageTrack', track.encoded);
			createCollector(message, player, track, embed, this.client, locale);
		}
	}
}

function createButtonRow(player: Player, client: Lavamusic): ActionRowBuilder<ButtonBuilder> {
	const previousButton = new ButtonBuilder()

		.setCustomId('previous')
		.setEmoji(client.emoji.previous)
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(!player.queue.previous);

	const resumeButton = new ButtonBuilder()
		.setCustomId('resume')
		.setEmoji(player.paused ? client.emoji.resume : client.emoji.pause)
		.setStyle(player.paused ? ButtonStyle.Success : ButtonStyle.Secondary);

	const stopButton = new ButtonBuilder().setCustomId('stop').setEmoji(client.emoji.stop).setStyle(ButtonStyle.Danger);

	const skipButton = new ButtonBuilder()
		.setCustomId('skip')
		.setEmoji(client.emoji.skip)
		.setStyle(ButtonStyle.Secondary);

	const loopButton = new ButtonBuilder()
		.setCustomId('loop')
		.setEmoji(player.repeatMode === 'track' ? client.emoji.loop.track : client.emoji.loop.none)
		.setStyle(player.repeatMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary);

	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		resumeButton,
		previousButton,
		stopButton,
		skipButton,
		loopButton,
	);
}

function createCollector(
	message: Message<true>,
	player: Player,
	_track: Track,
	embed: any,
	client: Lavamusic,
	locale: string,
): void {
	const collector = message.createMessageComponentCollector({
		filter: async (b: ButtonInteraction) => {
			if (!b.isButton()) return false;
			if (b.member instanceof GuildMember) {
				const isSameVoiceChannel = b.guild?.members.me?.voice.channelId === b.member.voice.channelId;
				if (isSameVoiceChannel) return true;
			}
			await b.reply({
				content: T(locale, 'player.trackStart.not_connected_to_voice_channel', {
					channel: b.guild?.members.me?.voice.channelId ?? 'None',
				}),
				flags: MessageFlags.Ephemeral,
			});
			return false;
		},
		componentType: ComponentType.Button,
	});

	collector.on('collect', async (interaction: ButtonInteraction<'cached'>) => {
		if (!(await checkDj(client, interaction))) {
			await interaction.reply({
				content: T(locale, 'player.trackStart.need_dj_role'),
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const editMessage = async (text: string): Promise<void> => {
			if (message && message.editable) {
				await message.edit({
					embeds: [
						embed.setFooter({
							text: text + " • BuNgo Music Bot 🎵 • Made by Gúp Bu Ngô with ♥️",
							iconURL: interaction.user.avatarURL({}),
						}),
					],
					components: [createButtonRow(player, client)],
				});
			}
		};
		switch (interaction.customId) {
			case 'previous':
				if (player.queue.previous) {
					await interaction.deferUpdate();
					const previousTrack = player.queue.previous[0];
					player.play({
						track: previousTrack,
					});
					await editMessage(
						T(locale, 'player.trackStart.previous_by', {
							user: interaction.user.tag,
						}),
					);
				} else {
					await interaction.reply({
						content: T(locale, 'player.trackStart.no_previous_song'),
						flags: MessageFlags.Ephemeral,
					});
				}
				break;
			case 'resume':
				if (player.paused) {
					player.resume();
					await interaction.deferUpdate();
					await editMessage(
						T(locale, 'player.trackStart.resumed_by', {
							user: interaction.user.tag,
						}),
					);
				} else {
					player.pause();
					await interaction.deferUpdate();
					await editMessage(
						T(locale, 'player.trackStart.paused_by', {
							user: interaction.user.tag,
						}),
					);
				}
				break;
			case 'stop': {
				// Clear the messageId before stopping to ensure new messages are created for future tracks
				player.set('messageId', undefined);
				player.stopPlaying(true, false);
				await interaction.deferUpdate();

				// Remove all buttons from the message
				if (message && message.editable) {
					await message.edit({
						embeds: [
							embed.setFooter({
								text: T(locale, 'cmd.stop.messages.stopped') + " • BuNgo Music Bot 🎵 • Made by Gúp Bu Ngô with ♥️",
								iconURL: interaction.user.avatarURL({}),
							}),
						],
						components: [], // Remove all buttons
					});
				}
				break;
			}
			case 'skip': {
				const autoplay = player.get<boolean>('autoplay');
				if (!autoplay && player.queue.tracks.length === 0) {
					// Clear the messageId before stopping to ensure new messages are created for future tracks
					player.set('messageId', undefined);
					player.stopPlaying(true, false);
					await editMessage(T(locale, 'cmd.stop.messages.stopped'));
					break;
				}

				await interaction.deferUpdate();
				player.skip(0, !autoplay);
				await editMessage(
					T(locale, 'player.trackStart.skipped_by', {
						user: interaction.user.tag,
					}),
				);
				break;
			}
			case 'loop': {
				await interaction.deferUpdate();
				switch (player.repeatMode) {
					case 'off': {
						player.setRepeatMode('track');
						await editMessage(
							T(locale, 'player.trackStart.looping_by', {
								user: interaction.user.tag,
							}),
						);
						break;
					}
					case 'track': {
						player.setRepeatMode('queue');
						await editMessage(
							T(locale, 'player.trackStart.looping_queue_by', {
								user: interaction.user.tag,
							}),
						);
						break;
					}
					case 'queue': {
						player.setRepeatMode('off');
						await editMessage(
							T(locale, 'player.trackStart.looping_off_by', {
								user: interaction.user.tag,
							}),
						);
						break;
					}
				}
				break;
			}
		}
	});
}

export async function checkDj(
	client: Lavamusic,
	interaction:
		| ButtonInteraction<'cached'>
		| StringSelectMenuInteraction<'cached'>
		| UserSelectMenuInteraction<'cached'>
		| RoleSelectMenuInteraction<'cached'>
		| MentionableSelectMenuInteraction<'cached'>
		| ChannelSelectMenuInteraction<'cached'>,
): Promise<boolean> {
	const dj = await client.db.getDj(interaction.guildId);
	if (dj?.mode) {
		const djRole = await client.db.getRoles(interaction.guildId);
		if (!djRole) return false;
		const hasDjRole = interaction.member.roles.cache.some(role => djRole.map(r => r.roleId).includes(role.id));
		if (!(hasDjRole || interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))) {
			return false;
		}
	}
	return true;
}


