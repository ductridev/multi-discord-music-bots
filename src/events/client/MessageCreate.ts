import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	Collection,
	EmbedBuilder,
	type GuildMember,
	type Message,
	PermissionFlagsBits,
	type TextChannel,
} from 'discord.js';
import { T } from '../../structures/I18n';
import { Context, Event, type Lavamusic } from '../../structures/index';
import { env } from '../../env';
import { getBotsForGuild } from '../..';
import { Stay, PrismaClient } from '@prisma/client';
import { buildBotMeta, resolveBot } from '../../utils/BotResolver';
import { runCommandFor } from '../../utils/CommandRunner';

const prisma = new PrismaClient();

/**
 * Parse a string into args, respecting quoted strings (both double and single quotes)
 * This ensures that values like node:"BuNgo Node" are kept as a single arg
 * @param input - The string to parse
 * @returns Array of args with quoted values preserved
 * @example
 * parseArgsWithQuotes('spotify node:"BuNgo Node" other:value')
 * // Returns: ["spotify", "node:\"BuNgo Node\"", "other:value"]
 */
function parseArgsWithQuotes(input: string): string[] {
	const args: string[] = [];
	// Match either: non-space/quote chars, or double-quoted strings, or single-quoted strings
	const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
	let match;
	while ((match = regex.exec(input)) !== null) {
		args.push(match[0]);
	}
	return args;
}

export default class MessageCreate extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'messageCreate',
		});
	}

	public async run(message: Message): Promise<any> {
		if (message.author.bot) return;
		if (!(message.guild && message.guildId)) return;

		const mentionPrefix = new RegExp(`^<@!?${this.client.user?.id}>\\s*`);
		const mentionMatch = message.content.match(mentionPrefix);

		const guildId = message.guildId;
		const userVCId = message.member?.voice?.channelId ?? null;

		// getSetup is cache-backed (ServerData.setupCache), so this runs ahead
		// of the empty-content bail below without reintroducing a per-message
		// database call. A setup-channel message must be consumed regardless
		// of content — SetupSystem.run always ends in message.delete(), and
		// that channel's whole purpose is staying clean of stray posts.
		const setup = await this.client.db.getSetup(guildId);
		if (setup && setup.textId === message.channelId) {
			return this.client.emit('setupSystem', message);
		}

		// Once MessageContent is disabled, content is empty on everything except
		// mentions and DMs. Bail before spending any database calls.
		if (!(message.content.trim() || mentionMatch)) return;

		const locale = await this.client.db.getLanguage(guildId);
		const botClientId = this.client.childEnv.id;

		if (mentionMatch) {
			const rest = message.content.slice(mentionMatch[0].length).trim();

			// Bare mention keeps the old behaviour: show help.
			if (!rest) {
				const helpCommand = this.client.commands.get('help');
				if (helpCommand) {
					const helpCtx = new Context(message, []);
					helpCtx.guildLocale = locale;
					await helpCommand.run(this.client, helpCtx, []);
					return;
				}
				await message.reply({
					content: T(locale, 'event.message.prefix_mention', {
						prefix: await this.client.db.getPrefix(guildId, botClientId),
					}),
				});
				return;
			}

			// `@Bot play song` — only this bot received content, so resolve and
			// delegate exactly as the slash path does.
			const mentionArgs = parseArgsWithQuotes(rest);
			const mentionCmdName = mentionArgs.shift()?.toLowerCase();
			if (!mentionCmdName) return;

			const mentionCommand =
				this.client.commands.get(mentionCmdName) ||
				this.client.commands.get(this.client.aliases.get(mentionCmdName) as string);
			if (!mentionCommand) return;

			const mentionBots = getBotsForGuild(guildId);
			if (mentionBots.length === 0) {
				await message.reply({ content: T(locale, 'event.message.no_bots_configured') });
				return;
			}

			if (mentionCommand.args && mentionArgs.length === 0) {
				const embed = this.client
					.embed()
					.setColor(this.client.color.red)
					.setTitle(T(locale, 'event.message.missing_arguments'))
					.setDescription(
						T(locale, 'event.message.missing_arguments_description', {
							command: mentionCommand.name,
							examples: mentionCommand.description.examples
								? mentionCommand.description.examples.join('\n')
								: 'None',
						}),
					);
				await message.reply({ embeds: [embed] });
				return;
			}

			const { botMeta, vcToBot } = buildBotMeta(mentionBots, message.guild);
			const resolved = resolveBot(vcToBot, botMeta, userVCId, this.client);
			let chosen = resolved.bot ?? this.client;
			let isSelf = chosen.user!.id === this.client.user!.id;

			const mentionCtx = new Context(message, mentionArgs);
			mentionCtx.setArgs(mentionArgs);
			mentionCtx.guildLocale = locale;

			if (!isSelf) {
				const chosenChannel = chosen.channels.cache.get(message.channelId);
				const chosenGuild = chosen.guilds.cache.get(guildId);
				if (chosenChannel?.isTextBased() && chosenGuild) {
					// Swap all three together, before runGuards — it resolves the
					// chosen bot's own member from ctx.guild and member caches are
					// per-client.
					mentionCtx.client = chosen;
					mentionCtx.channel = chosenChannel;
					mentionCtx.guild = chosenGuild;
				} else {
					// The chosen bot cannot honestly own its own messages here, so
					// handle it locally rather than validating one bot and running
					// another. Mirrors the slash path's null-delegation fallback.
					this.client.logger.warn(
						`Cannot delegate ${mentionCommand.name} to ${chosen.childEnv.name}: guild or channel not cached. Handling locally.`,
					);
					chosen = this.client;
					isSelf = true;
				}
			}

			await runCommandFor(
				chosen,
				mentionCtx,
				mentionCommand,
				!resolved.valid,
				async payload => {
					await message.reply(payload as any).catch(() => null);
				},
				isSelf
					? undefined
					: async () => {
							await message.reply({
								content: T(locale, 'event.interaction.delegated_to_bot', {
									bot: chosen.user!.username,
								}),
							});
						},
			);
			return;
		}

		const allPrefixes = await this.client.db.getAllPrefixes(guildId);
		allPrefixes.push(env.GLOBAL_PREFIX);

		const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const prefixPatterns = allPrefixes.map(p => `(${escapeRegex(p)})`);
		const combinedPrefixRegex = new RegExp(`^(${prefixPatterns.join('|')})\\s*`);

		const match = message.content.toLocaleLowerCase().match(combinedPrefixRegex);
		if (!match) return;
		const [matchedPrefix] = match;
		const args = parseArgsWithQuotes(message.content.slice(matchedPrefix.length).trim());
		const cmd = args.shift()?.toLowerCase();
		if (!cmd) return;
		const command = this.client.commands.get(cmd) || this.client.commands.get(this.client.aliases.get(cmd) as string);
		if (!command) return;

		const allBots = getBotsForGuild(guildId);

		// Check if no bots are configured for this guild
		if (allBots.length === 0) {
			// Only one bot should reply to avoid spam
			if (this.client.childEnv.id === this.client.childEnv.id) {
				await message.reply({
					content: T(locale, 'event.message.no_bots_configured')
				});
			}
			return;
		}

		// Early return: If this bot is not configured for this guild, skip processing
		if (!allBots.some(bot => bot.user?.id === this.client.user?.id)) {
			return;
		}

		let chosenBot: typeof this.client | null = null;
		let valid = true;

		// CRITICAL FIX: Use a shared state across ALL bot instances
		// We need to check ACTUAL voice state from Discord, not from local memory
		// because each bot instance might have different in-memory state
		const voiceStates = message.guild!.voiceStates.cache;
		const botClientIds = allBots.map(b => b.user!.id);

		// Build REAL voice channel mapping from Discord's actual state
		const realGuildMap = new Map<string, string>();
		const realActiveClientIds = new Set<string>();

		for (const [, voiceState] of voiceStates) {
			if (voiceState.channelId && botClientIds.includes(voiceState.member!.user.id)) {
				realGuildMap.set(voiceState.channelId, voiceState.member!.user.id);
				realActiveClientIds.add(voiceState.member!.user.id);
			}
		}

		const botMeta = await Promise.all(
			allBots.map(async bot => {
				const [prefix, is247] = await Promise.all([
					bot.db.getPrefix(guildId, bot.childEnv.clientId),
					bot.db.get_247(bot.childEnv.clientId, guildId)
				]);
				return {
					bot,
					clientId: bot.childEnv.clientId,
					name: bot.childEnv.name,
					prefix,
					is247: is247 as Stay,
					isInAnyVC: realActiveClientIds.has(bot.user!.id) // Use REAL state
				};
			})
		);

		// Deterministic bot selection (same result across all bot instances)
		if (userVCId) {
			const botInSameVC = realGuildMap.get(userVCId);

			// Priority 1: Bot already in user's VC
			const sameVCBot = botMeta.find(entry => botInSameVC === entry.bot.user!.id);
			if (sameVCBot) {
				chosenBot = sameVCBot.bot;
				valid = true;
			}
			// Priority 2: Bot with matching prefix that is idle
			else {
				const matchingFreeBot = botMeta.find(entry =>
					entry.prefix === matchedPrefix.trim() && !entry.isInAnyVC
				);
				if (matchingFreeBot) {
					chosenBot = matchingFreeBot.bot;
					valid = true;
				}
				// Priority 3: Any idle bot (deterministic: use first idle bot found)
				else {
					const idleBot = botMeta.find(entry => !entry.isInAnyVC);
					if (idleBot) {
						chosenBot = idleBot.bot;
						valid = true;
					}
					// No bot available - all bots are busy in other VCs
					else {
						// Pick a bot for responding (first one or based on prefix)
						if (matchedPrefix.trim() === env.GLOBAL_PREFIX) {
							const botIndex = parseInt(message.id.slice(-4), 16) % allBots.length;
							chosenBot = allBots[botIndex];
						} else {
							chosenBot = allBots[0];
						}
						valid = false; // Mark as invalid so it shows "no free bots" message
					}
				}
			}
		} else {
			// User not in voice channel - select bot based on prefix match or distribution
			// First try to match the prefix
			const matchingPrefixBot = botMeta.find(entry => entry.prefix === matchedPrefix.trim());
			if (matchingPrefixBot) {
				chosenBot = matchingPrefixBot.bot;
			}
			// Otherwise, use round-robin or first bot that matches
			// If using global prefix, distribute commands across all available bots
			else if (matchedPrefix.trim() === env.GLOBAL_PREFIX) {
				// Simple distribution: use hash of message ID to pick a bot
				const botIndex = parseInt(message.id.slice(-4), 16) % allBots.length;
				chosenBot = allBots[botIndex];
			}
			// Fallback to first available bot
			else {
				chosenBot = allBots[0];
			}
		}

		// Only the chosen bot should continue processing
		if (!chosenBot || this.client.user!.id !== chosenBot.user!.id) return;

		// Don't check if bot is free yet - we need to validate voice channel first
		// to show proper error messages

		const ctx = new Context(message, args);
		ctx.setArgs(args);
		ctx.guildLocale = locale;

		const clientMember = message.guild!.members.resolve(this.client.user!)!;
		const isDev = this.client.env.OWNER_IDS?.includes(message.author.id);

		if (!(message.inGuild() && message.channel.permissionsFor(clientMember)?.has(PermissionFlagsBits.ViewChannel)))
			return;

		if (
			!(
				clientMember.permissions.has(PermissionFlagsBits.ViewChannel) &&
				clientMember.permissions.has(PermissionFlagsBits.SendMessages) &&
				clientMember.permissions.has(PermissionFlagsBits.EmbedLinks) &&
				clientMember.permissions.has(PermissionFlagsBits.ReadMessageHistory)
			)
		) {
			return await message.author
				.send({
					content: T(locale, 'event.message.no_send_message'),
				})
				.catch(() => {
					null;
				});
		}

		if (command.permissions) {
			if (command.permissions?.client) {
				const missingClientPermissions = command.permissions.client.filter(
					(perm: any) => !clientMember.permissions.has(perm),
				);

				if (missingClientPermissions.length > 0) {
					return await message.reply({
						content: T(locale, 'event.message.no_permission', {
							permissions: missingClientPermissions.map((perm: string) => `\`${perm}\``).join(', '),
						}),
					});
				}
			}

			if (command.permissions?.user) {
				if (!(isDev || (message.member as GuildMember).permissions.has(command.permissions.user))) {
					const missingUserPermissions = Array.isArray(command.permissions.user)
						? command.permissions.user
						: [command.permissions.user];

					return await message.reply({
						content: T(locale, 'event.message.no_user_permission', {
							permissions: missingUserPermissions.map((perm: string) => `\`${perm}\``).join(', '),
						}),
					});
				}
			}

			if (command.permissions?.dev && this.client.env.OWNER_IDS) {
				if (!isDev) return;
			}
		}

		if (!isDev && command.vote
			&& this.client.env.TOPGG
			&& !this.client.env.SKIP_VOTES_GUILDS!.find(id => id === message.guildId)
			&& !this.client.env.SKIP_VOTES_USERS!.find(id => id === message.author.id)
		) {
			// Add timeout to prevent hanging on slow/unresponsive Top.gg API
			const voteCheckTimeout = new Promise<boolean>((resolve) => {
				setTimeout(() => {
					this.client.logger.warn(`Vote check timeout for user ${message.author.id} - defaulting to disallow command`);
					resolve(false); // Default to disallowing command if API is slow
				}, 5000); // 5 second timeout
			});

			let voted: boolean;
			try {
				voted = await Promise.race([
					this.client.topGG.hasVoted(message.author.id),
					voteCheckTimeout
				]);
			} catch (error) {
				voted = false; // Default to disallowing command on error
			}

			if (!voted) {
				const voteBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setLabel(T(locale, 'event.message.vote_button'))
						.setURL(`https://top.gg/bot/${this.client.env.TOPGG_CLIENT_ID ?? '1385166515099275346'}/vote`)
						.setStyle(ButtonStyle.Link),
				);

				return await message.reply({
					content: T(locale, 'event.message.vote_message'),
					components: [voteBtn],
				});
			}
		}

		if (command.player) {
			if (command.player.voice) {
				if (this.client.config.maintenance && !isDev) {
					const embed = this.client.embed()
						.setAuthor({
							name: T(locale, 'maintenance.title'),
							iconURL: this.client.user?.displayAvatarURL(),
						})
						.setColor(this.client.color.main)
						.setDescription(T(locale, 'event.message.maintenance') || 'The bot is currently under maintenance. Some commands may not work properly.')
						.addFields([
							{
								name: T(locale, 'maintenance.status_title'), // 🔒 Status
								value: `\`\`\`diff\n- ${T(locale, 'maintenance.status_value')}\n\`\`\``, // - MAINTENANCE ENABLED
								inline: true,
							},
							{
								name: T(locale, 'maintenance.affected_title'), // 🕒 Affected Features
								value: `\`\`\`${T(locale, 'maintenance.affected_value')}\`\`\``, // All music playback and queue commands are temporarily disabled.
								inline: true,
							},
						])
						.setFooter({
							text: 'BuNgo Music Bot 🎵 • Made by Gúp Bu Ngô with ♥️',
							iconURL: 'https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg',
						})
						.setTimestamp();

					return await message.reply({ embeds: [embed] });
				}

				const voiceChannel = (message.member as GuildMember).voice.channel;
				const botMember = message.guild?.members.me;
				if (!voiceChannel) {
					return await message.reply({
						content: T(locale, 'event.message.no_voice_channel', { command: command.name }),
					});
				}

				if (voiceChannel.userLimit > 0 && voiceChannel.members.size >= voiceChannel.userLimit && !voiceChannel.members.has(botMember?.id ?? '')) {
					return await message.reply({
						content: T(locale, 'event.message.voice_channel_full', { command: command.name, channel: voiceChannel.id }),
					});
				}

				if (!voiceChannel.permissionsFor(this.client.user!)?.has(PermissionFlagsBits.Connect)) {
					return await message.reply({
						content: T(locale, 'event.message.no_connect_permission', { command: command.name }),
					});
				}

				if (!voiceChannel.permissionsFor(this.client.user!)?.has(PermissionFlagsBits.Speak)) {
					return await message.reply({
						content: T(locale, 'event.message.no_speak_permission', { command: command.name }),
					});
				}

				if (!clientMember.permissions.has(PermissionFlagsBits.Connect)) {
					return await message.reply({
						content: T(locale, 'event.message.no_connect_permission', { command: command.name }),
					});
				}

				if (!clientMember.permissions.has(PermissionFlagsBits.Speak)) {
					return await message.reply({
						content: T(locale, 'event.message.no_speak_permission', { command: command.name }),
					});
				}

				if (
					(message.member as GuildMember).voice.channel?.type === ChannelType.GuildStageVoice &&
					!clientMember.permissions.has(PermissionFlagsBits.RequestToSpeak)
				) {
					return await message.reply({
						content: T(locale, 'event.message.no_request_to_speak', { command: command.name }),
					});
				}

				// Only check if bot is in different channel if THIS bot is actually in a voice channel
				// AND the bot selection was valid (meaning this bot was intended to be used)
				if (
					clientMember.voice.channel &&
					clientMember.voice.channelId !== (message.member as GuildMember).voice.channelId &&
					valid
				) {
					return await message.reply({
						content: T(locale, 'event.message.different_voice_channel', {
							channel: `<#${clientMember.voice.channelId}>`,
							command: command.name,
						}),
					});
				}
			}

			if (command.player.active) {
				const queue = this.client.manager.getPlayer(message.guildId);
				if (!queue?.queue.current) {
					return await message.reply({
						content: T(locale, 'event.message.no_music_playing'),
					});
				}
			}

			if (command.player.dj) {
				const dj = await this.client.db.getDj(message.guildId);
				if (dj?.mode) {
					const djRole = await this.client.db.getRoles(message.guildId);
					if (!djRole) {
						return await message.reply({
							content: T(locale, 'event.message.no_dj_role'),
						});
					}

					const hasDJRole = (message.member as GuildMember).roles.cache.some(role =>
						djRole.map(r => r.roleId).includes(role.id),
					);
					if (
						!(isDev || (hasDJRole && !(message.member as GuildMember).permissions.has(PermissionFlagsBits.ManageGuild)))
					) {
						return await message.reply({
							content: T(locale, 'event.message.no_dj_permission'),
						});
					}
				}
			}
		}

		if (command.args && args.length === 0) {
			const embed = this.client
				.embed()
				.setColor(this.client.color.red)
				.setTitle(T(locale, 'event.message.missing_arguments'))
				.setDescription(
					T(locale, 'event.message.missing_arguments_description', {
						command: command.name,
						examples: command.description.examples ? command.description.examples.join('\n') : 'None',
					}),
				)
				.setFooter({
					text: T(locale, 'event.message.syntax_footer'),
					iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg"
				});
			await message.reply({ embeds: [embed] });
			return;
		}

		if (!this.client.cooldown.has(cmd)) {
			this.client.cooldown.set(cmd, new Collection());
		}
		const now = Date.now();
		const timestamps = this.client.cooldown.get(cmd)!;
		const cooldownAmount = (command.cooldown || 5) * 1000;

		if (timestamps.has(message.author.id)) {
			const expirationTime = timestamps.get(message.author.id)! + cooldownAmount;
			const timeLeft = (expirationTime - now) / 1000;
			if (now < expirationTime && timeLeft > 0.9) {
				return await message.reply({
					content: T(locale, 'event.message.cooldown', { time: timeLeft.toFixed(1), command: cmd }),
				});
			}
			timestamps.set(message.author.id, now);
			setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);
		} else {
			timestamps.set(message.author.id, now);
			setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);
		}

		if (args.includes('@everyone') || args.includes('@here')) {
			return await message.reply({
				content: T(locale, 'event.message.no_mention_everyone'),
			});
		}

		// NOW check if bot is free (after all permission/voice checks)
		// This ensures users get proper error messages about missing permissions or voice channel first
		if (!valid) {
			await message.reply({
				content: T(locale, 'event.message.no_free_bots'),
			});
			return;
		}

		try {
			return await command.run(this.client, ctx, ctx.args);
		} catch (error: any) {
			this.client.logger.error(error);
			await message.reply({
				content: T(locale, 'event.message.error', { error: error.message || 'Unknown error' }),
			});
		} finally {
			// Track command usage for statistics
			try {
				await prisma.commandUsage.create({
					data: {
						guildId: message.guildId!,
						botId: this.client.childEnv.clientId,
						commandName: command.name,
						userId: message.author.id,
					},
				});
			} catch (error) {
				// Silently fail - don't interrupt command execution
				this.client.logger.error('Failed to track command usage:', error);
			}

			const logs = this.client.channels.cache.get(this.client.env.LOG_COMMANDS_ID!);
			if (logs) {
				const embed = new EmbedBuilder()
					.setAuthor({
						name: 'Prefix - Command Logs',
						iconURL: this.client.user?.avatarURL({ size: 2048 })!,
					})
					.setColor(this.client.config.color.green)
					.addFields(
						{ name: 'Command', value: `\`${command.name}\``, inline: true },
						{ name: 'User', value: `${message.author.tag} (\`${message.author.id}\`)`, inline: true },
						{ name: 'Guild', value: `${message.guild.name} (\`${message.guild.id}\`)`, inline: true },
					)
					.setFooter({
						text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
						iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
					})
					.setTimestamp();

				await (logs as TextChannel).send({ embeds: [embed], flags: 4096 });
			}
		}
	}
}


