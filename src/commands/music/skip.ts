import { Command, type Context, type Lavamusic } from '../../structures/index';

export default class Skip extends Command {
	constructor(client: Lavamusic) {
		super(client, {
			name: 'skip',
			description: {
				content: 'cmd.skip.description',
				examples: ['skip'],
				usage: 'skip',
			},
			category: 'music',
			aliases: ['s', 'sk'],
			cooldown: 0,
			args: false,
			vote: true,
			player: {
				voice: true,
				dj: true,
				active: true,
				djPerm: null,
			},
			permissions: {
				dev: false,
				client: ['SendMessages', 'ReadMessageHistory', 'ViewChannel', 'EmbedLinks'],
				user: [],
			},
			slashCommand: true,
			options: [],
		});
	}

	public async run(client: Lavamusic, ctx: Context): Promise<any> {
		const player = client.manager.getPlayer(ctx.guild!.id);
		const embed = this.client.embed().setFooter({
			text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
			iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
		})
			.setTimestamp();
		if (!player) return await ctx.sendMessage(ctx.locale('event.message.no_music_playing'));
		const autoplay = player.get<boolean>('autoplay');

		// If no tracks in queue and autoplay is off, stop the player
		if (!autoplay && player.queue.tracks.length === 0) {
			player.stopPlaying(true, false);
			return await ctx.sendMessage({
				embeds: [embed.setColor(this.client.color.red).setDescription(ctx.locale('cmd.stop.messages.stopped'))],
			});
		}
		const currentTrack = player.queue.current?.info;
		player.skip(0, !autoplay);
		if (ctx.isInteraction) {
			return await ctx.sendMessage({
				embeds: [
					embed.setColor(this.client.color.main).setDescription(
						ctx.locale('cmd.skip.messages.skipped', {
							title: currentTrack?.title,
							uri: currentTrack?.uri,
						}),
					),
				],
			});
		}
		ctx.message?.react('👍');
	}
}


