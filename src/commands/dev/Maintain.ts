import { Command, type Context, type Lavamusic } from '../../structures/index';
import { EmbedBuilder } from 'discord.js';

export default class Maintain extends Command {
    constructor(client: Lavamusic) {
        super(client, {
            name: 'maintain',
            description: {
                content: 'Toggle global maintenance mode.',
                examples: ['maintain on', 'maintain off'],
                usage: 'maintain <on|off>',
            },
            category: 'dev',
            aliases: ['maintenance'],
            cooldown: 3,
            args: true,
            player: {
                voice: false,
                dj: false,
                active: false,
                djPerm: null,
            },
            permissions: {
                dev: true,
                client: ['SendMessages', 'ReadMessageHistory', 'ViewChannel', 'EmbedLinks'],
                user: [],
            },
            slashCommand: true,
            options: [
                {
                    name: 'state',
                    description: 'Turn maintenance mode on or off',
                    type: 3,
                    required: true,
                    choices: [
                        { name: 'on', value: 'on' },
                        { name: 'off', value: 'off' },
                    ],
                },
            ],
        });
    }

    public async run(client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
        const subCommand = args[0]?.toLowerCase();

        if (!['on', 'off', 'true', 'false', 'enable', 'disable'].includes(subCommand)) {
            return ctx.sendMessage('❌ Please specify `on` or `off`.');
        }

        const enable = ['on', 'true', 'enable'].includes(subCommand);

        // 1. Update global DB
        await client.db.updateMaintainMode(enable);

        // 2. Update local config
        client.config.maintenance = enable;

        // 3. Broadcast to all shards if applicable
        if (client.shard) {
            await client.shard.broadcastEval(
                (c, { enable }) => {
                    // Cast client to your extended client type
                    const typedClient = c as unknown as typeof client;
                    if (typedClient.config) typedClient.config.maintenance = enable;
                },
                { context: { enable } }
            );
        }

        // 4. Confirm to user
        const embed = new EmbedBuilder()
            .setColor(enable ? this.client.color.red : this.client.color.green)
            .setTitle(
                enable
                    ? ctx.locale('maintenance.enabled_title')
                    : ctx.locale('maintenance.disabled_title')
            )
            .setDescription(
                enable
                    ? ctx.locale('maintenance.enabled_desc')
                    : ctx.locale('maintenance.disabled_desc')
            )
            .setFooter({
                text: ctx.locale('maintenance.requested_by', { author: ctx.author?.tag }),
                iconURL: ctx.author?.displayAvatarURL() || undefined,
            })
            .setTimestamp();

        await ctx.sendMessage({ embeds: [embed] });
    }
}