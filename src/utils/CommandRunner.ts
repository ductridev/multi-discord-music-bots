import { EmbedBuilder, type InteractionReplyOptions, type TextChannel } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_LOCALE, T } from '../structures/I18n';
import { runGuards } from './CommandGuards';
import type Context from '../structures/Context';
import type { Command, Lavamusic } from '../structures/index';

const prisma = new PrismaClient();

export type ReplyFn = (payload: InteractionReplyOptions & { content?: string }) => Promise<void>;

/**
 * A deferred interaction that never receives a reply shows "<Bot> is thinking…"
 * until Discord swaps it for "The application did not respond". That happens
 * whenever the command produces no output through this interaction — most often
 * a delegated command, whose visible output is a channel message from the chosen
 * bot rather than a reply from the receiver.
 *
 * `ack: true` replaces the placeholder with a checkmark, confirming the command
 * was received. `ack: false` deletes the response instead, for the dev-only gate
 * — acknowledging there would both confirm a hidden owner command exists and
 * imply it ran.
 *
 * Safe to call unconditionally: a no-op for message-backed contexts and for any
 * interaction already replied to.
 */
async function resolveUnusedDefer(ctx: Context, ack: boolean): Promise<void> {
	const interaction = ctx.interaction;
	if (!interaction?.deferred || interaction.replied) return;
	await (ack ? interaction.editReply({ content: '✅' }) : interaction.deleteReply()).catch(() => null);
}

/**
 * Runs guards, executes the command, records usage and writes the audit log.
 *
 * `chosen` is the bot that executes. `reply` sends guard failures back through
 * whatever mechanism the entry point owns — editReply for slash, message.reply
 * for mentions. Successful command output goes through `ctx`, not `reply`.
 *
 * `onGuardsPassed` fires only once every guard has passed, immediately before
 * execution. Entry points use it to announce a handoff, so a delegation that
 * fails its checks never gets announced.
 */
export async function runCommandFor(
	chosen: Lavamusic,
	ctx: Context,
	command: Command,
	busy: boolean,
	reply: ReplyFn,
	onGuardsPassed?: () => Promise<void>,
): Promise<void> {
	const locale = ctx.guildLocale ?? DEFAULT_LOCALE;

	const guard = await runGuards(chosen, ctx, command, busy);
	if (!guard.passed) {
		if (guard.reply) await reply(guard.reply).catch(() => null);
		// A silent rejection (the dev-only gate) still owes the interaction a
		// resolution, or the placeholder spins forever. Discard rather than ack,
		// so a non-owner learns nothing about the command.
		else await resolveUnusedDefer(ctx, false);
		return;
	}

	if (onGuardsPassed) await onGuardsPassed().catch(() => null);

	try {
		await command.run(chosen, ctx, ctx.args);
	} catch (error: any) {
		chosen.logger.error(error);
		await reply({
			content: T(locale, 'event.interaction.error', { error: error?.message || 'Unknown error' }),
		}).catch(() => null);
	} finally {
		try {
			await prisma.commandUsage.create({
				data: {
					guildId: ctx.guild.id,
					botId: chosen.childEnv.clientId,
					commandName: command.name,
					userId: ctx.author!.id,
				},
			});
		} catch (error) {
			chosen.logger.error('Failed to track command usage:', error);
		}

		try {
			const logs = chosen.channels.cache.get(chosen.env.LOG_COMMANDS_ID!);
			if (logs) {
				const embed = new EmbedBuilder()
					.setAuthor({
						// Message-backed contexts cover both mentions and prefix commands.
						name: ctx.isInteraction ? 'Slash - Command Logs' : 'Message - Command Logs',
						// A bot with no custom avatar returns null here, and EmbedBuilder
						// rejects null — which would cost the audit log for that bot
						// entirely. undefined just omits the icon.
						iconURL: chosen.user?.avatarURL({ size: 2048 }) ?? undefined,
					})
					.setColor(chosen.config.color.blue)
					.addFields(
						{ name: 'Command', value: `\`${command.name}\``, inline: true },
						{ name: 'User', value: `${ctx.author?.tag} (\`${ctx.author?.id}\`)`, inline: true },
						{ name: 'Guild', value: `${ctx.guild.name} (\`${ctx.guild.id}\`)`, inline: true },
					)
					.setFooter({
						text: 'BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️',
						iconURL:
							'https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg',
					})
					.setTimestamp();

				await (logs as TextChannel).send({ embeds: [embed], flags: 4096 }).catch(() => null);
			}
		} catch (error) {
			// A malformed embed (e.g. a bot with no avatar makes iconURL null,
			// which EmbedBuilder rejects) must not throw inside this finally —
			// that would turn a successful command into a reported failure.
			chosen.logger.error('Failed to send command audit log:', error);
		}

		// Last resort, and deliberately outside the audit-log try so an audit
		// failure cannot skip it: if the command produced no reply of its own,
		// the interaction is still showing a loading placeholder. Ack it.
		await resolveUnusedDefer(ctx, true);
	}
}
