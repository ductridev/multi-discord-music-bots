import {
	type APIInteractionGuildMember,
	ChatInputCommandInteraction,
	type CommandInteraction,
	type Guild,
	type GuildMember,
	type GuildMemberResolvable,
	type InteractionEditReplyOptions,
	type InteractionReplyOptions,
	Message,
	type MessageCreateOptions,
	type MessageEditOptions,
	type MessagePayload,
	type TextBasedChannel,
	type TextChannel,
	type User,
} from 'discord.js';
import { env } from '../env';
import { T } from './I18n';
import type { Lavamusic } from './index';

export default class Context {
	public ctx: CommandInteraction | Message;
	public interaction: CommandInteraction | null;
	public message: Message | null;
	public id: string;
	public channelId: string;
	public client: Lavamusic;
	public author: User | null;
	public channel: TextBasedChannel;
	public guild: Guild;
	public createdAt: Date;
	public createdTimestamp: number;
	public member: GuildMemberResolvable | GuildMember | APIInteractionGuildMember | null;
	public args: any[];
	public msg: any;
	public guildLocale: string | undefined;
	public sourceType: 'interaction' | 'message';
	private sendMode: 'interaction' | 'channel';

	constructor(ctx: ChatInputCommandInteraction | Message, args: any[]) {
		this.ctx = ctx;
		this.sourceType = ctx instanceof ChatInputCommandInteraction ? 'interaction' : 'message';
		this.sendMode = this.sourceType === 'interaction' ? 'interaction' : 'channel';
		this.interaction = ctx instanceof ChatInputCommandInteraction ? ctx : null;
		this.message = ctx instanceof Message ? ctx : null;
		this.channel = ctx.channel!;
		this.id = ctx.id;
		this.channelId = ctx.channelId;
		this.client = ctx.client as Lavamusic;
		this.author = ctx instanceof Message ? ctx.author : ctx.user;
		this.guild = ctx.guild!;
		this.createdAt = ctx.createdAt;
		this.createdTimestamp = ctx.createdTimestamp;
		this.member = ctx.member;
		this.args = args;
		this.setArgs(args);
		this.setUpLocale();
	}

	/**
	 * Build a Context whose args come from the receiving bot's interaction but
	 * whose output is sent by a different bot as a normal channel message.
	 * The chosen bot then owns every message it posts, so its own collectors,
	 * buttons, name and avatar stay consistent.
	 *
	 * Returns null when the chosen bot has not cached the guild or channel:
	 * without both, its identity cannot be swapped in honestly, and the caller
	 * must handle the command itself rather than let the wrong bot speak.
	 */
	public static delegated(
		interaction: ChatInputCommandInteraction,
		chosenBot: Lavamusic,
		args: any[],
	): Context | null {
		const guild = chosenBot.guilds.cache.get(interaction.guildId!);
		const channel = chosenBot.channels.cache.get(interaction.channelId);
		if (!guild || !channel?.isTextBased()) return null;

		const ctx = new Context(interaction, args);
		ctx.sendMode = 'channel';
		ctx.client = chosenBot;
		ctx.guild = guild;
		ctx.channel = channel as TextBasedChannel;

		return ctx;
	}

	private async setUpLocale(): Promise<void> {
		const defaultLanguage = env.DEFAULT_LANGUAGE || 'Vietnamese';
		this.guildLocale = this.guild ? await this.client.db.getLanguage(this.guild.id) : defaultLanguage;
	}

	/** True when args and options come from an interaction payload. */
	public get isInteraction(): boolean {
		return this.sourceType === 'interaction';
	}

	/** True when replies go through the interaction rather than channel.send(). */
	private get sendsViaInteraction(): boolean {
		return this.sendMode === 'interaction';
	}

	public setArgs(args: any[]): void {
		this.args = this.isInteraction ? args.map((arg: { value: any }) => arg.value) : args;
	}

	public async sendMessage(
		content: string | MessagePayload | MessageCreateOptions | InteractionReplyOptions,
	): Promise<Message> {
		if (this.sendsViaInteraction) {
			if (typeof content === 'string' || isInteractionReplyOptions(content)) {
				if (this.interaction?.replied || this.interaction?.deferred) {
					this.msg = await this.interaction?.followUp(content) as Message;
				} else {
					if (typeof content === 'string') {
						this.msg = await this.interaction?.reply({ content, fetchReply: true }) as Message;
					} else {
						await this.interaction?.reply(content);
						this.msg = await this.interaction?.fetchReply() as Message;
					}
				}
				return this.msg;
			}
		} else if (typeof content === 'string' || isMessagePayload(content)) {
			this.msg = await (this.channel as TextChannel).send(content as any);
			return this.msg;
		}
		return this.msg;
	}

	public async editMessage(
		content: string | MessagePayload | InteractionEditReplyOptions | MessageEditOptions,
	): Promise<Message> {
		if (this.sendsViaInteraction && this.msg) {
			this.msg = await this.interaction?.editReply(content);
			return this.msg;
		}
		if (this.msg) {
			this.msg = await this.msg.edit(content);
			return this.msg;
		}
		return this.msg;
	}

	public async sendDeferMessage(content: string | MessagePayload | MessageCreateOptions): Promise<Message> {
		if (this.sendsViaInteraction) {
			if (!(this.interaction?.deferred || this.interaction?.replied)) {
				await this.interaction?.deferReply();
			}
			this.msg = await this.interaction?.fetchReply() as Message;
			return this.msg;
		}

		this.msg = await (this.channel as TextChannel).send(content as any);
		return this.msg;
	}

	public locale(key: string, ...args: any) {
		if (!this.guildLocale) this.guildLocale = env.DEFAULT_LANGUAGE || 'Vietnamese';
		return T(this.guildLocale, key, ...args);
	}

	public async sendFollowUp(
		content: string | MessagePayload | MessageCreateOptions | InteractionReplyOptions,
	): Promise<void> {
		if (this.sendsViaInteraction) {
			if (typeof content === 'string' || isInteractionReplyOptions(content)) {
				await this.interaction?.followUp(content);
			}
		} else if (typeof content === 'string' || isMessagePayload(content)) {
			this.msg = await (this.channel as TextChannel).send(content as any);
		}
	}

	public get deferred(): boolean | undefined {
		return this.sendsViaInteraction ? this.interaction?.deferred : !!this.msg;
	}

	options = {
		getRole: (name: string, required = true) => {
			return (this.interaction as ChatInputCommandInteraction).options.get(name, required)?.role;
		},
		getMember: (name: string, required = true) => {
			return (this.interaction as ChatInputCommandInteraction).options.get(name, required)?.member;
		},
		get: (name: string, required = true) => {
			return (this.interaction as ChatInputCommandInteraction).options.get(name, required);
		},
		getChannel: (name: string, required = true) => {
			return (this.interaction as ChatInputCommandInteraction).options.get(name, required)?.channel;
		},
		getSubCommand: () => {
			return (this.interaction as ChatInputCommandInteraction).options.data[0].name;
		},
	};
}

function isInteractionReplyOptions(content: any): content is InteractionReplyOptions {
	return content instanceof Object;
}

function isMessagePayload(content: any): content is MessagePayload {
	return content instanceof Object;
}


