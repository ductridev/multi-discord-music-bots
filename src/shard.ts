// import { ShardingManager } from 'discord.js';
// import type Logger from './structures/Logger';
// import { BotConfig } from '@prisma/client';

// export async function shardStart(logger: Logger, bot: BotConfig) {
// 	const manager = new ShardingManager('./dist/LavaClient.js', {
// 		// respawn: true,
// 		token: bot.token,
// 		totalShards: 'auto',
// 		shardList: 'auto',
// 		shardArgs: [
// 			`--token="${bot.token}"`,
// 			`--id="${bot.id}"`,
// 			`--clientId="${bot.clientId}"`,
// 			`--prefix="${bot.prefix}"`,
// 			`--activity="${bot.activity}"`,
// 			`--activityType="${bot.activityType}"`,
// 			`--status="${bot.status}"`,
// 			`--name="${bot.name}"`,
// 		],
// 	});

// 	manager.on('shardCreate', shard => {
// 		shard.on('ready', () => {
// 			logger.start(`[CLIENT] Shard ${shard.id} connected to Discord's Gateway.`);
// 		});
// 	});

// 	await manager.spawn();

// 	logger.start(`[CLIENT] ${manager.totalShards} shard(s) spawned.`);
// }



import { type ClientOptions, GatewayIntentBits } from 'discord.js';
import Lavamusic from './structures/Lavamusic';
import { BotConfig } from '@prisma/client';

const { MessageContent, GuildVoiceStates, GuildMessages, Guilds, GuildMessageTyping } = GatewayIntentBits;

function clientOptionsFor(bot: BotConfig): ClientOptions {
	const intents = [Guilds, GuildMessages, GuildVoiceStates, GuildMessageTyping];

	// Requesting an intent the application does not hold fails login outright
	// with "Used disallowed intents", so this must be per bot. Mentions still
	// deliver content without it.
	if (bot.messageContentIntent) intents.push(MessageContent);

	return {
		intents,
		allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
	};
}

function isDisallowedIntents(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('Used disallowed intents');
}

export async function shardStart(bot: BotConfig) {
	try {
		const client = new Lavamusic(clientOptionsFor(bot), bot);
		await client.start();
		return;
	} catch (error) {
		if (!(bot.messageContentIntent && isDisallowedIntents(error))) throw error;
	}

	// Discord has revoked MessageContent for this application. Coming up without
	// it beats staying offline: slash commands and @mention commands both work
	// without any privileged intent. Only prefix commands are lost.
	//
	// Deliberately NOT persisted to BotConfig — a write from an error path would
	// turn a transient Discord fault into a permanent silent downgrade. Flip
	// messageContentIntent to false yourself once you have confirmed the
	// revocation is real, and this retry stops happening.
	const client = new Lavamusic(clientOptionsFor({ ...bot, messageContentIntent: false }), bot);
	client.logger.error(
		`${bot.name}: Discord rejected the MessageContent intent. Starting without it — ` +
			'slash and @mention commands will work, prefix commands will not. ' +
			`Set messageContentIntent=false on this bot's BotConfig row to make this permanent.`,
	);
	await client.start();
}
