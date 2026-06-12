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

const clientOptions: ClientOptions = {
	intents: [Guilds, GuildMessages, MessageContent, GuildVoiceStates, GuildMessageTyping],
	allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
};

export async function shardStart(bot: BotConfig) {
	const client = new Lavamusic(clientOptions, bot);
	await client.start();
};
