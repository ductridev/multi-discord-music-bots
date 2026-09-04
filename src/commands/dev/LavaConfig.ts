import { Command, type Context, type Lavamusic } from '../../structures/index';
import type { DeezerFormat, LavaSrcConfig } from '../../types/lavasrc';

export default class LavaConfig extends Command {
    constructor(client: Lavamusic) {
        super(client, {
            name: 'lavaconfig',
            description: {
                content: 'cmd.lavaconfig.description',
                examples: ['lavaconfig list-nodes', 'lavaconfig spotify node:main clientId:xxx'],
                usage: 'lavaconfig <subcommand> [options]',
            },
            category: 'dev',
            aliases: ['lvc'],
            cooldown: 3,
            args: true,
            player: { voice: false, dj: false, active: false, djPerm: null },
            permissions: {
                dev: true,
                client: ['SendMessages', 'ViewChannel', 'EmbedLinks'],
                user: [],
            },
            slashCommand: true,
            options: [
                {
                    name: 'source',
                    description: 'Source to configure, or an action',
                    type: 3,
                    required: true,
                    choices: [
                        { name: 'spotify', value: 'spotify' },
                        { name: 'applemusic', value: 'applemusic' },
                        { name: 'deezer', value: 'deezer' },
                        { name: 'yandexmusic', value: 'yandexmusic' },
                        { name: 'vkmusic', value: 'vkmusic' },
                        { name: 'qobuz', value: 'qobuz' },
                        { name: 'ytdlp', value: 'ytdlp' },
                        { name: 'view', value: 'view' },
                        { name: 'list-nodes', value: 'list-nodes' },
                    ],
                },
                { name: 'node', description: 'Target Lavalink node id', type: 3, required: false },
                {
                    name: 'config',
                    description: 'key:value pairs, space-separated (e.g. clientId:xxx clientSecret:yyy)',
                    type: 3,
                    required: false,
                },
            ],
        });
    }

    /**
     * Parse key:value arguments from args array
     * Handles quoted values that contain spaces (e.g., node:"BuNgo Node")
     * @param args - Array of arguments in key:value format
     * @returns Object with key-value pairs
     */
    private parseArgs(args: string[]): Record<string, string> {
        const result: Record<string, string> = {};
        
        // Join all args back into a single string to handle quoted values with spaces
        const joined = args.join(' ');
        
        // Regex to match key:value, key:"value with spaces", or key:'value with spaces'
        // Pattern: key followed by colon, then optional whitespace, then either:
        // - quoted string with double quotes (group 2)
        // - quoted string with single quotes (group 3)
        // - unquoted value until space or end (group 4)
        // The \s* allows for cases where parseArgsWithQuotes splits "node:" and "\"value\"" into separate args
        const regex = /(\w+):\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
        
        let match;
        while ((match = regex.exec(joined)) !== null) {
            const key = match[1];
            // Value is in group 2 (double quotes), 3 (single quotes), or 4 (unquoted)
            const value = match[2] ?? match[3] ?? match[4];
            
            if (key && value !== undefined) {
                result[key] = value;
            }
        }
        
        return result;
    }

    public async run(client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
        // Slash options are rebuilt into the prefix-style args array so the
        // existing subcommand + key:value parser runs unchanged.
        if (ctx.isInteraction) {
            const source = ctx.options.getString('source') ?? '';
            const node = ctx.options.getString('node');
            const config = ctx.options.getString('config') ?? '';
            // Keep config as a single arg and quote node: parseArgs joins args
            // back with spaces, so splitting here would collapse whitespace inside
            // quoted values and truncate multi-word node ids before the regex runs.
            args = [
                source,
                ...(node ? [`node:"${node}"`] : []),
                ...(config ? [config] : []),
            ];
        }

        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp();

        if (!client.lavaSrcConfigService) {
            return await ctx.sendMessage({ 
                embeds: [embed.setColor(this.client.color.red).setDescription(ctx.locale('cmd.lavaconfig.errors.service_unavailable'))] 
            });
        }

        if (args.length === 0) {
            return await ctx.sendMessage({ 
                embeds: [
                    embed.setColor(this.client.color.red)
                        .setDescription(ctx.locale('cmd.lavaconfig.errors.missing_subcommand'))
                        .addFields({
                            name: ctx.locale('cmd.lavaconfig.usage.title'),
                            value: ctx.locale('cmd.lavaconfig.usage.value'),
                        })
                ] 
            });
        }

        const subcommand = args[0].toLowerCase();
        const parsedArgs = this.parseArgs(args.slice(1));
        const nodeId = parsedArgs['node'];

        await ctx.sendDeferMessage(ctx.locale('cmd.lavaconfig.messages.processing'));

        try {
            switch (subcommand) {
                case 'spotify':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.lavaconfig.errors.missing_node', { subcommand: 'spotify' }));
                        return;
                    }
                    await this.handleSpotify(client, ctx, nodeId, parsedArgs);
                    break;
                case 'applemusic':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.lavaconfig.errors.missing_node', { subcommand: 'applemusic' }));
                        return;
                    }
                    await this.handleAppleMusic(client, ctx, nodeId, parsedArgs);
                    break;
                case 'deezer':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.lavaconfig.errors.missing_node', { subcommand: 'deezer' }));
                        return;
                    }
                    await this.handleDeezer(client, ctx, nodeId, parsedArgs);
                    break;
                case 'yandexmusic':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.lavaconfig.errors.missing_node', { subcommand: 'yandexmusic' }));
                        return;
                    }
                    await this.handleYandexMusic(client, ctx, nodeId, parsedArgs);
                    break;
                case 'vkmusic':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.lavaconfig.errors.missing_node', { subcommand: 'vkmusic' }));
                        return;
                    }
                    await this.handleVkMusic(client, ctx, nodeId, parsedArgs);
                    break;
                case 'qobuz':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.lavaconfig.errors.missing_node', { subcommand: 'qobuz' }));
                        return;
                    }
                    await this.handleQobuz(client, ctx, nodeId, parsedArgs);
                    break;
                case 'ytdlp':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.lavaconfig.errors.missing_node', { subcommand: 'ytdlp' }));
                        return;
                    }
                    await this.handleYtDlp(client, ctx, nodeId, parsedArgs);
                    break;
                case 'view':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.lavaconfig.errors.missing_node', { subcommand: 'view' }));
                        return;
                    }
                    await this.handleView(client, ctx, nodeId);
                    break;
                case 'list-nodes':
                    await this.handleListNodes(client, ctx);
                    break;
                default:
                    await this.sendError(ctx, ctx.locale('cmd.lavaconfig.errors.unknown_subcommand', { subcommand }));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await this.sendError(ctx, errorMessage);
        }
    }

    private async handleSpotify(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const clientId = parsedArgs['clientId'];
        const clientSecret = parsedArgs['clientSecret'];
        const spDc = parsedArgs['spDc'];
        const preferAnonymousStr = parsedArgs['preferAnonymousToken'];
        const customTokenEndpoint = parsedArgs['customTokenEndpoint'];

        const preferAnonymous = preferAnonymousStr ? preferAnonymousStr.toLowerCase() === 'true' : undefined;

        const config: LavaSrcConfig = {
            spotify: {
                clientId: clientId ?? undefined,
                clientSecret: clientSecret ?? undefined,
                spDc: spDc ?? undefined,
                preferAnonymousToken: preferAnonymous,
                customTokenEndpoint: customTokenEndpoint ?? undefined,
            },
        };

        await this.updateAndRespond(client, ctx, nodeId, config, 'Spotify');
    }

    private async handleAppleMusic(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const mediaApiToken = parsedArgs['mediaAPIToken'];

        const config: LavaSrcConfig = {
            applemusic: {
                mediaAPIToken: mediaApiToken ?? undefined,
            },
        };

        await this.updateAndRespond(client, ctx, nodeId, config, 'Apple Music');
    }

    private async handleDeezer(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const arl = parsedArgs['arl'];
        const formatsStr = parsedArgs['formats'];

        let formats: DeezerFormat[] | undefined;
        if (formatsStr) {
            formats = formatsStr.split(',').map((f: string) => f.trim() as DeezerFormat);
        }

        const config: LavaSrcConfig = {
            deezer: {
                arl: arl ?? undefined,
                formats,
            },
        };

        await this.updateAndRespond(client, ctx, nodeId, config, 'Deezer');
    }

    private async handleYandexMusic(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const accessToken = parsedArgs['accessToken'];

        const config: LavaSrcConfig = {
            yandexMusic: {
                accessToken: accessToken ?? undefined,
            },
        };

        await this.updateAndRespond(client, ctx, nodeId, config, 'Yandex Music');
    }

    private async handleVkMusic(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const userToken = parsedArgs['userToken'];

        const config: LavaSrcConfig = {
            vkMusic: {
                userToken: userToken ?? undefined,
            },
        };

        await this.updateAndRespond(client, ctx, nodeId, config, 'VK Music');
    }

    private async handleQobuz(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const userOauthToken = parsedArgs['userOauthToken'];
        const appId = parsedArgs['appId'];
        const appSecret = parsedArgs['appSecret'];

        const config: LavaSrcConfig = {
            qobuz: {
                userOauthToken: userOauthToken ?? undefined,
                appId: appId ?? undefined,
                appSecret: appSecret ?? undefined,
            },
        };

        await this.updateAndRespond(client, ctx, nodeId, config, 'Qobuz');
    }

    private async handleYtDlp(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const path = parsedArgs['path'];
        const customLoadArgs = parsedArgs['customLoadArgs'];
        const customPlaybackArgs = parsedArgs['customPlaybackArgs'];

        const config: LavaSrcConfig = {
            ytdlp: {
                path: path ?? undefined,
                customLoadArgs: customLoadArgs ? customLoadArgs.split(',').map((a: string) => a.trim()) : undefined,
                customPlaybackArgs: customPlaybackArgs ? customPlaybackArgs.split(',').map((a: string) => a.trim()) : undefined,
            },
        };

        await this.updateAndRespond(client, ctx, nodeId, config, 'yt-dlp');
    }

    private async handleView(client: Lavamusic, ctx: Context, nodeId: string): Promise<void> {
        const config = await client.lavaSrcConfigService!.getConfig(nodeId);
        const configJson = JSON.stringify(config, null, 2);

        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp()
            .setColor(this.client.color.main)
            .setTitle(ctx.locale('cmd.lavaconfig.messages.view_title', { nodeId }))
            .setDescription(`\`\`\`json\n${configJson.length > 4000 ? configJson.substring(0, 4000) + '...' : configJson}\n\`\`\``);

        await ctx.editMessage({ content: '', embeds: [embed] });
    }

    private async handleListNodes(client: Lavamusic, ctx: Context): Promise<void> {
        const nodes = client.lavaSrcConfigService!.getNodesList();

        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp()
            .setColor(this.client.color.main)
            .setTitle(ctx.locale('cmd.lavaconfig.messages.nodes_title'));

        if (nodes.length === 0) {
            embed.setDescription(ctx.locale('cmd.lavaconfig.messages.no_nodes'));
        } else {
            const nodeList = nodes
                .map(node => `**${node.id}** ${node.connected ? '🟢' : '🔴'}`)
                .join('\n');
            embed.setDescription(nodeList)
                .setFooter({ 
                    text: ctx.locale('cmd.lavaconfig.messages.total_nodes', { count: nodes.length }),
                    iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
                });
        }

        await ctx.editMessage({ content: '', embeds: [embed] });
    }

    private async updateAndRespond(
        client: Lavamusic,
        ctx: Context,
        nodeId: string,
        config: LavaSrcConfig,
        sourceName: string
    ): Promise<void> {
        const result = await client.lavaSrcConfigService!.updateConfig(nodeId, config);
        const configJson = JSON.stringify(result, null, 2);

        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp()
            .setColor(this.client.color.main)
            .setTitle(ctx.locale('cmd.lavaconfig.messages.config_updated_title', { source: sourceName }))
            .setDescription(ctx.locale('cmd.lavaconfig.messages.config_updated_desc', { source: sourceName, nodeId }))
            .addFields({
                name: ctx.locale('cmd.lavaconfig.messages.updated_config'),
                value: `\`\`\`json\n${configJson.length > 1000 ? configJson.substring(0, 1000) + '...' : configJson}\n\`\`\``,
            });

        await ctx.editMessage({ content: '', embeds: [embed] });
    }

    private async sendError(ctx: Context, message: string): Promise<void> {
        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp()
            .setColor(this.client.color.red)
            .setDescription(message);

        await ctx.editMessage({ content: '', embeds: [embed] });
    }
}
