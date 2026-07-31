import type { Message } from 'discord.js';
import { T } from '../../structures/I18n';
import { type Command, Context, Event, type Lavamusic } from '../../structures/index';
import { env } from '../../env';
import { activeBots, getBotsForGuild } from '../..';
import { buildBotMeta, pickReceiver, resolveBot } from '../../utils/BotResolver';
import { runCommandFor } from '../../utils/CommandRunner';

/**
 * Last time each user was told prefix commands are going away, keyed
 * `guildId:userId`.
 *
 * The notice doubles the message volume of every prefix command, which on a busy
 * guild is real channel rate-limit pressure. Keyed per user rather than per
 * guild because the notice exists to retrain each individual — a guild-wide
 * throttle would let one person's command suppress everyone else's only warning.
 *
 * Unbounded by design: one small entry per user who still uses prefix commands,
 * on a code path that is deleted when the intent revocation completes.
 */
const prefixNoticeSentAt = new Map<string, number>();
const PREFIX_NOTICE_INTERVAL = 6 * 60 * 60 * 1000;

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

	/**
	 * Shared by the mention and prefix paths. Deliberately not folded into
	 * runGuards: a slash command's required options are enforced by Discord
	 * before the interaction ever arrives, and `ctx.args` there is an options
	 * array rather than words, so the same check would reject valid slash calls.
	 */
	private missingArgsEmbed(command: Command, locale: string) {
		return this.client
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
				iconURL:
					'https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg',
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
				await message.reply({ embeds: [this.missingArgsEmbed(mentionCommand, locale)] });
				return;
			}

			const { botMeta, vcToBot } = buildBotMeta(mentionBots, message.guild);
			const resolved = resolveBot(vcToBot, botMeta, userVCId, this.client);
			this.client.logger.debug(
				`resolve @mention ${mentionCommand.name}: ${resolved.reason} -> ${resolved.bot?.childEnv.name ?? 'none'}`,
			);
			let chosen = resolved.bot ?? this.client;
			let isSelf = chosen.user!.id === this.client.user!.id;

			const mentionCtx = new Context(message, mentionArgs);
			mentionCtx.setArgs(mentionArgs);
			mentionCtx.guildLocale = locale;

			if (!isSelf) {
				const chosenChannel = chosen.channels.cache.get(message.channelId);
				const chosenGuild = chosen.guilds.cache.get(guildId);
				// Commands read ctx.member directly, so it must come from the chosen
				// bot's cache too — otherwise guards validate one view of the user's
				// voice state while execution reads another. resolve() does not
				// fetch, so a member cache miss disqualifies the delegation just
				// like a missing guild or channel.
				const chosenMember = chosenGuild?.members.resolve(message.author.id);
				if (chosenChannel?.isTextBased() && chosenGuild && chosenMember) {
					// Swap all four together, before runGuards — it resolves the
					// chosen bot's own member from ctx.guild and member caches are
					// per-client.
					mentionCtx.client = chosen;
					mentionCtx.channel = chosenChannel;
					mentionCtx.guild = chosenGuild;
					mentionCtx.member = chosenMember;
				} else {
					// The chosen bot cannot honestly own its own messages here, so
					// handle it locally rather than validating one bot and running
					// another. Mirrors the slash path's null-delegation fallback.
					this.client.logger.warn(
						`Cannot delegate ${mentionCommand.name} to ${chosen.childEnv.name}: guild, channel or member not cached. Handling locally.`,
					);
					chosen = this.client;
					isSelf = true;
				}
			}

			// Announce a handoff only when a bot is about to JOIN the channel. A bot
			// already sitting in the user's channel is visibly there and its own
			// reply follows, so a preamble explains nothing.
			const announceHandoff = !isSelf && resolved.reason !== 'in_user_vc';

			await runCommandFor(
				chosen,
				mentionCtx,
				mentionCommand,
				!resolved.valid,
				async payload => {
					await message.reply(payload as any).catch(() => null);
				},
				announceHandoff
					? async () => {
							await message.reply({
								content: T(locale, 'event.interaction.delegated_to_bot', {
									bot: chosen.user!.username,
								}),
							});
						}
					: undefined,
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
		if (allBots.length === 0) {
			// Every instance reaches this line for the same message, so the reply
			// has to be pinned to one of them or the guild gets one copy per bot.
			if (activeBots[0]?.user?.id === this.client.user?.id) {
				await message.reply({ content: T(locale, 'event.message.no_bots_configured') });
			}
			return;
		}

		// This bot isn't serving this guild, so it has no say in the selection.
		if (!allBots.some(bot => bot.user?.id === this.client.user?.id)) return;

		// The bot the user addressed. A guild-specific prefix names exactly one
		// bot; the global prefix names none, so those spread across the fleet by
		// message id — every instance derives the same index from the same message.
		const prefixes = await Promise.all(allBots.map(bot => bot.db.getPrefix(guildId, bot.childEnv.clientId)));
		const receiver = pickReceiver(allBots, prefixes, matchedPrefix.trim(), env.GLOBAL_PREFIX, message.id);

		const { botMeta, vcToBot } = buildBotMeta(allBots, message.guild);
		const resolved = resolveBot(vcToBot, botMeta, userVCId, receiver);
		this.client.logger.debug(
			`resolve prefix ${command.name}: ${resolved.reason} -> ${resolved.bot?.childEnv.name ?? 'none'}`,
		);

		// When nothing is free the addressed bot still answers, so the guards run
		// and the user hears about a permission or voice problem before "all busy".
		const chosen = resolved.bot ?? receiver;

		// No identity swap here, unlike the slash and mention paths: every bot
		// receives this message and runs the same resolution, so the chosen bot
		// handles its own event and the rest drop out on this line.
		if (chosen.user!.id !== this.client.user!.id) return;

		if (command.args && args.length === 0) {
			await message.reply({ embeds: [this.missingArgsEmbed(command, locale)] });
			return;
		}

		const ctx = new Context(message, args);
		ctx.setArgs(args);
		ctx.guildLocale = locale;

		await runCommandFor(
			chosen,
			ctx,
			command,
			!resolved.valid,
			async payload => {
				await message.reply(payload as any).catch(() => null);
			},
			// Warn that prefix commands are deprecated, at most once per user per
			// PREFIX_NOTICE_INTERVAL. Hung off onGuardsPassed so a rejected command
			// still doesn't produce a notice, matching the old placement in a
			// finally that guard failures returned before ever reaching.
			async () => {
				const noticeKey = `${guildId}:${message.author.id}`;
				const now = Date.now();
				if (now - (prefixNoticeSentAt.get(noticeKey) ?? 0) <= PREFIX_NOTICE_INTERVAL) return;
				if (!message.channel.isSendable()) return;
				prefixNoticeSentAt.set(noticeKey, now);
				await message.channel
					.send({
						content: T(locale, 'event.message.prefix_deprecated', {
							command: command.name,
							bot: this.client.user!.username,
						}),
					})
					.catch(() => null);
			},
		);
	}
}
