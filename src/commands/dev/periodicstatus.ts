import { Command, type Context, type Lavamusic } from '../../structures/index';

export default class PeriodicStatus extends Command {
	constructor(client: Lavamusic) {
		super(client, {
			name: 'periodicstatus',
			description: {
				content: 'Check the status of periodic message system (Dev only)',
				examples: ['periodicstatus'],
				usage: 'periodicstatus',
			},
			category: 'dev',
			aliases: ['pstatus', 'pmstatus'],
			cooldown: 3,
			args: false,
			player: {
				voice: false,
				dj: false,
				active: false,
				djPerm: null,
			},
			permissions: {
				dev: true,
				client: ['SendMessages', 'EmbedLinks'],
				user: [],
			},
			slashCommand: true,
			options: [],
		});
	}

	public async run(client: Lavamusic, ctx: Context, _args: string[]): Promise<void> {
		// Import here to avoid circular dependencies
		const { PeriodicMessageSystem } = await import('../../utils/PeriodicMessageSystem');
		const { activeBots } = await import('../..');

		const sessionStatus = PeriodicMessageSystem.getSessionStatus();

		if (sessionStatus.length === 0) {
			await ctx.sendMessage({
				embeds: [
					client
						.embed()
						.setColor(client.color.yellow)
						.setDescription('⚠️ No active periodic message sessions found!')
						.addFields(
							{
								name: '🤔 Why?',
								value:
									'• No players are currently active\n• Sessions haven\'t been initialized yet\n• All players were recently stopped',
							},
							{
								name: '📋 Active Bots',
								value: `${activeBots.length} bot(s) online`,
							},
						),
				],
			});
			return;
		}

		const embed = client
			.embed()
			.setColor(client.color.main)
			.setTitle('🔄 Periodic Message System Status')
			.setDescription(
				`**Active Sessions:** ${sessionStatus.length}\n**Message Interval:** 2 minutes (testing mode)\n**Check Interval:** 1 minute`,
			)
			.setTimestamp();

		for (const session of sessionStatus.slice(0, 10)) {
			// Limit to 10 sessions
			const bot = activeBots.find((b) => b.childEnv.clientId === session.clientId);
			const botName = bot ? bot.user?.username || 'Unknown Bot' : 'Unknown Bot';

			const nextMessageIn = Math.max(0, 2 - session.minutesElapsed); // 2 min interval

			embed.addFields({
				name: `🎵 ${botName}`,
				value: `**Guild ID:** ${session.guildId}\n**Session Started:** ${session.sessionStarted}\n**Last Message:** ${session.lastMessage}\n**Time Elapsed:** ${session.minutesElapsed} min\n**Next Message In:** ~${nextMessageIn} min`,
				inline: false,
			});
		}

		if (sessionStatus.length > 10) {
			embed.setFooter({ text: `Showing 10 of ${sessionStatus.length} sessions` });
		}

		await ctx.sendMessage({ embeds: [embed] });
	}
}
