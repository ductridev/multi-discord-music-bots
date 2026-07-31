import {
	type AutocompleteInteraction,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	CommandInteraction,
	InteractionType,
} from 'discord.js';
import { getBotsForGuild } from '../..';
import { T } from '../../structures/I18n';
import { Context, Event, type Lavamusic } from '../../structures/index';
import { buildBotMeta, resolveBot } from '../../utils/BotResolver';
import { runCommandFor } from '../../utils/CommandRunner';

export default class InteractionCreate extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'interactionCreate',
		});
	}

	public async run(
		interaction: CommandInteraction | AutocompleteInteraction | ButtonInteraction,
	): Promise<any> {
		if (!(interaction.guild && interaction.guildId)) return;

		if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
			const command = this.client.commands.get(interaction.commandName);
			if (!command) return;
			try {
				await command.autocomplete(interaction as AutocompleteInteraction);
			} catch (error) {
				this.client.logger.error(error);
			}
			return;
		}

		if (!(interaction instanceof CommandInteraction && interaction.isChatInputCommand())) return;

		const command = this.client.commands.get(interaction.commandName);
		if (!command) return;

		// Acknowledge before anything that can block. The vote guard has a 5s
		// timeout and getLanguage can hit MongoDB, both past Discord's 3s ack
		// deadline. Everything after this point replies via editReply.
		try {
			await interaction.deferReply();
		} catch (error) {
			this.client.logger.error('Failed to defer slash interaction:', error);
			return;
		}

		// Assigned inside the try below; kept in scope so the catch can still
		// localize its error message if something throws before locale loads.
		let locale = 'Vietnamese';

		try {
			const reply = async (payload: any) => {
				await interaction.editReply(payload);
			};

			const guildId = interaction.guildId;
			locale = await this.client.db.getLanguage(guildId);

			const setup = await this.client.db.getSetup(guildId);
			if (setup && interaction.channelId === setup.textId) {
				await reply({ content: T(locale, 'event.interaction.setup_channel') });
				return;
			}

			const allBots = getBotsForGuild(guildId);
			if (allBots.length === 0) {
				await reply({ content: T(locale, 'event.interaction.no_bots_configured') });
				return;
			}

			const userVCId = interaction.guild.voiceStates.cache.get(interaction.user.id)?.channelId ?? null;

			const { botMeta, vcToBot } = buildBotMeta(allBots, interaction.guild);
			const resolved = resolveBot(vcToBot, botMeta, userVCId, this.client);
			this.client.logger.debug(
				`resolve ${command.name}: ${resolved.reason} -> ${resolved.bot?.childEnv.name ?? 'none'}`,
			);

			// When nothing is free the receiving bot answers, so the guards still
			// run and the user sees permission or voice problems before "all busy".
			let chosen = resolved.bot ?? this.client;
			const busy = !resolved.valid;
			let isSelf = chosen.user!.id === this.client.user!.id;

			const options = (interaction as ChatInputCommandInteraction).options.data as any[];
			let ctx: Context;

			if (isSelf) {
				ctx = new Context(interaction as ChatInputCommandInteraction, options);
			} else {
				const delegatedCtx = Context.delegated(
					interaction as ChatInputCommandInteraction,
					chosen,
					options,
				);
				if (delegatedCtx) {
					ctx = delegatedCtx;
				} else {
					// The chosen bot has not cached this guild or channel, so it
					// cannot honestly own its own messages. Handle it here instead
					// of half-swapping identity and letting the wrong bot speak.
					this.client.logger.warn(
						`Cannot delegate ${command.name} to ${chosen.childEnv.name}: guild or channel not cached. Handling locally.`,
					);
					chosen = this.client;
					isSelf = true;
					ctx = new Context(interaction as ChatInputCommandInteraction, options);
				}
			}

			ctx.setArgs(options);
			ctx.guildLocale = locale;

			// Guard failures and execution errors always answer through the
			// interaction, delegated or not — the receiver is the bot the user
			// actually invoked, and at guard time nothing has been announced yet.
			await runCommandFor(
				chosen,
				ctx,
				command,
				busy,
				reply,
				isSelf
					? undefined
					: async () => {
							// Guards passed, so the handoff is real and worth announcing.
							// The chosen bot posts its own output as a normal channel
							// message; this notice is all the interaction reply carries.
							//
							// It cannot be ephemeral: a deferred public reply cannot become
							// ephemeral, and deferring ephemerally would hide self-handled
							// replies — including now-playing — from everyone but the invoker.
							await reply({
								content: T(locale, 'event.interaction.delegated_to_bot', {
									bot: chosen.user!.username,
								}),
							});
						},
			);
		} catch (error) {
			this.client.logger.error('Slash command handler threw:', error);
			await interaction
				.editReply({ content: T(locale, 'event.interaction.error', { error: 'internal error' }) })
				.catch(() => null);
		}
	}
}
