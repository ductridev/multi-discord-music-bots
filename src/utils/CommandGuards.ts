import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	Collection,
	type InteractionReplyOptions,
	PermissionFlagsBits,
} from 'discord.js';
import { DEFAULT_LOCALE, T } from '../structures/I18n';
import type Context from '../structures/Context';
import type { Command, Lavamusic } from '../structures/index';

export interface GuardResult {
	passed: boolean;
	reply?: InteractionReplyOptions & { content?: string };
}

const PASS: GuardResult = { passed: true };

function fail(content: string, extra?: Partial<InteractionReplyOptions>): GuardResult {
	return { passed: false, reply: { content, ...extra } };
}

/**
 * Runs every pre-execution check for a delegated or self-handled command.
 *
 * `client` must be the bot that will actually execute the command, not the
 * bot that received the interaction — otherwise permissions are validated
 * against the wrong member.
 *
 * `busy` is checked last on purpose: a user with a missing permission or no
 * voice channel should hear about that before "all bots are busy".
 */
export async function runGuards(
	client: Lavamusic,
	ctx: Context,
	command: Command,
	busy: boolean,
): Promise<GuardResult> {
	const locale = ctx.guildLocale ?? DEFAULT_LOCALE;
	const guild = ctx.guild;
	const userId = ctx.author!.id;
	const isDev = client.env.OWNER_IDS?.includes(userId) ?? false;

	// `guild` comes from the chosen bot's cache, so members.me is the chosen
	// bot's own member and is always populated. Resolving by id against another
	// client's guild cache would miss and produce a spurious failure.
	const clientMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
	if (!clientMember) {
		return fail(T(locale, 'event.interaction.no_send_message'));
	}

	// 1. Maintenance — only blocks player commands, same as the prefix path.
	if (command.player?.voice && client.config.maintenance && !isDev) {
		const embed = client
			.embed()
			.setAuthor({ name: T(locale, 'maintenance.title'), iconURL: client.user?.displayAvatarURL() })
			.setColor(client.color.main)
			.setDescription(T(locale, 'event.interaction.maintenance'))
			.addFields([
				{
					name: T(locale, 'maintenance.status_title'),
					value: `\`\`\`diff\n- ${T(locale, 'maintenance.status_value')}\n\`\`\``,
					inline: true,
				},
				{
					name: T(locale, 'maintenance.affected_title'),
					value: `\`\`\`${T(locale, 'maintenance.affected_value')}\`\`\``,
					inline: true,
				},
			])
			.setFooter({
				text: 'BuNgo Music Bot 🎵 • Made by Gúp Bu Ngô with ♥️',
				iconURL:
					'https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg',
			})
			.setTimestamp();
		return { passed: false, reply: { embeds: [embed] } };
	}

	// 2. Channel-level permissions. Guild-level role permissions are blind to
	// per-channel overwrites, and under delegation the chosen bot may be denied
	// in a channel the receiving bot can see perfectly well.
	const channelPerms = ctx.channel && 'permissionsFor' in ctx.channel
		? ctx.channel.permissionsFor(clientMember)
		: null;
	if (
		channelPerms &&
		!(
			channelPerms.has(PermissionFlagsBits.ViewChannel) &&
			channelPerms.has(PermissionFlagsBits.SendMessages)
		)
	) {
		return fail(T(locale, 'event.interaction.no_send_message'));
	}

	// 3. Channel and client permissions.
	if (
		!(
			clientMember.permissions.has(PermissionFlagsBits.ViewChannel) &&
			clientMember.permissions.has(PermissionFlagsBits.SendMessages) &&
			clientMember.permissions.has(PermissionFlagsBits.EmbedLinks) &&
			clientMember.permissions.has(PermissionFlagsBits.ReadMessageHistory)
		)
	) {
		return fail(T(locale, 'event.interaction.no_send_message'));
	}

	// 3. Command permissions.
	if (command.permissions?.client) {
		const missing = (command.permissions.client as string[]).filter(
			perm => !clientMember.permissions.has(perm as any),
		);
		if (missing.length > 0) {
			return fail(
				T(locale, 'event.interaction.no_permission', {
					permissions: missing.map(perm => `\`${perm}\``).join(', '),
				}),
			);
		}
	}

	const member = guild.members.resolve(userId) ?? (await guild.members.fetch(userId).catch(() => null));
	if (!member) {
		return fail(T(locale, 'event.interaction.no_send_message'));
	}

	if (command.permissions?.user && (command.permissions.user as string[]).length > 0) {
		if (!(isDev || member.permissions.has(command.permissions.user as any))) {
			const required = Array.isArray(command.permissions.user)
				? command.permissions.user
				: [command.permissions.user];
			return fail(
				T(locale, 'event.interaction.no_user_permission', {
					permissions: required.map((perm: any) => `\`${perm}\``).join(', '),
				}),
			);
		}
	}

	if (command.permissions?.dev && client.env.OWNER_IDS && !isDev) {
		return { passed: false };
	}

	// 4. Vote gate.
	if (
		!isDev &&
		command.vote &&
		client.env.TOPGG &&
		!client.env.SKIP_VOTES_GUILDS?.find(id => id === guild.id) &&
		!client.env.SKIP_VOTES_USERS?.find(id => id === userId)
	) {
		const timeout = new Promise<boolean>(resolve => {
			setTimeout(() => {
				client.logger.warn(`Vote check timeout for user ${userId} - defaulting to disallow command`);
				resolve(false);
			}, 5000);
		});

		let voted: boolean;
		try {
			voted = await Promise.race([client.topGG.hasVoted(userId), timeout]);
		} catch {
			voted = false;
		}

		if (!voted) {
			const voteBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setLabel(T(locale, 'event.interaction.vote_button'))
					.setURL(`https://top.gg/bot/${client.env.TOPGG_CLIENT_ID ?? '1385166515099275346'}/vote`)
					.setStyle(ButtonStyle.Link),
			);
			return {
				passed: false,
				reply: { content: T(locale, 'event.interaction.vote_message'), components: [voteBtn] },
			};
		}
	}

	// 5. Voice checks.
	if (command.player?.voice) {
		const voiceChannel = member.voice.channel;
		if (!voiceChannel) {
			return fail(T(locale, 'event.interaction.no_voice_channel', { command: command.name }));
		}

		if (
			voiceChannel.userLimit > 0 &&
			voiceChannel.members.size >= voiceChannel.userLimit &&
			!voiceChannel.members.has(clientMember.id)
		) {
			return fail(
				T(locale, 'event.interaction.voice_channel_full', {
					command: command.name,
					channel: voiceChannel.id,
				}),
			);
		}

		if (!voiceChannel.permissionsFor(client.user!)?.has(PermissionFlagsBits.Connect)) {
			return fail(T(locale, 'event.interaction.no_connect_permission', { command: command.name }));
		}

		if (!voiceChannel.permissionsFor(client.user!)?.has(PermissionFlagsBits.Speak)) {
			return fail(T(locale, 'event.interaction.no_speak_permission', { command: command.name }));
		}

		if (!clientMember.permissions.has(PermissionFlagsBits.Connect)) {
			return fail(T(locale, 'event.interaction.no_connect_permission', { command: command.name }));
		}

		if (!clientMember.permissions.has(PermissionFlagsBits.Speak)) {
			return fail(T(locale, 'event.interaction.no_speak_permission', { command: command.name }));
		}

		if (
			voiceChannel.type === ChannelType.GuildStageVoice &&
			!clientMember.permissions.has(PermissionFlagsBits.RequestToSpeak)
		) {
			return fail(T(locale, 'event.interaction.no_request_to_speak', { command: command.name }));
		}

		// Only meaningful when the resolver picked this bot deliberately. When
		// every bot is busy, `busy` is already true and the message below would
		// be misleading.
		if (
			!busy &&
			clientMember.voice.channel &&
			clientMember.voice.channelId !== voiceChannel.id
		) {
			return fail(
				T(locale, 'event.interaction.different_voice_channel', {
					channel: `<#${clientMember.voice.channelId}>`,
					command: command.name,
				}),
			);
		}
	}

	// 6. Active player.
	if (command.player?.active) {
		const player = client.manager.getPlayer(guild.id);
		if (!player?.queue.current) {
			return fail(T(locale, 'event.interaction.no_music_playing'));
		}
	}

	// 7. DJ role.
	if (command.player?.dj) {
		const dj = await client.db.getDj(guild.id);
		if (dj?.mode) {
			const djRoles = await client.db.getRoles(guild.id);
			if (!djRoles || djRoles.length === 0) {
				return fail(T(locale, 'event.interaction.no_dj_role'));
			}
			const roleIds = djRoles.map(r => r.roleId);
			const hasDJRole = member.roles.cache.some(role => roleIds.includes(role.id));
			if (!(isDev || (hasDJRole && !member.permissions.has(PermissionFlagsBits.ManageGuild)))) {
				return fail(T(locale, 'event.interaction.no_dj_permission'));
			}
		}
	}

	// 8. Cooldown.
	if (!client.cooldown.has(command.name)) {
		client.cooldown.set(command.name, new Collection());
	}
	const timestamps = client.cooldown.get(command.name)!;
	const cooldownAmount = (command.cooldown || 5) * 1000;
	const now = Date.now();

	if (timestamps.has(userId)) {
		const expirationTime = timestamps.get(userId)! + cooldownAmount;
		const timeLeft = (expirationTime - now) / 1000;
		if (now < expirationTime && timeLeft > 0.9) {
			return fail(
				T(locale, 'event.interaction.cooldown', {
					time: timeLeft.toFixed(1),
					command: command.name,
				}),
			);
		}
	}

	// 9. Mention abuse.
	if (ctx.args.some(arg => typeof arg === 'string' && (arg.includes('@everyone') || arg.includes('@here')))) {
		return fail(T(locale, 'event.message.no_mention_everyone'));
	}

	// 10. Busy — last, so the errors above take priority. Only commands that need
	// a bot to join a channel care: `help`, `ping` and the config commands work
	// perfectly well while every bot is playing elsewhere, and refusing them was
	// how the prefix path behaved only for users who happened to be in a voice
	// channel at the time.
	if (busy && command.player?.voice) {
		return fail(T(locale, 'event.interaction.no_free_bots'));
	}

	// Stamp the cooldown only now that the command will actually proceed —
	// a user rejected above (including for "all bots busy") must not burn a
	// cooldown window on a command that never ran.
	timestamps.set(userId, now);
	setTimeout(() => timestamps.delete(userId), cooldownAmount);

	return PASS;
}
