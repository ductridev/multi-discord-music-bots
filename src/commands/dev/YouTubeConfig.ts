import { Command, type Context, type Lavamusic } from '../../structures/index';

export default class YouTubeConfig extends Command {
    constructor(client: Lavamusic) {
        super(client, {
            name: 'youtubeconfig',
            description: {
                content: 'cmd.youtubeconfig.description',
                examples: [
                    'youtubeconfig view node:main',
                    'youtubeconfig oauth node:main refreshToken:xxx skipInitialization:true',
                    'youtubeconfig potoken node:main poToken:xxx visitorData:yyy'
                ],
                usage: 'youtubeconfig <subcommand> [options]',
            },
            category: 'dev',
            aliases: ['ytconfig', 'ytc'],
            cooldown: 3,
            args: true,
            player: { voice: false, dj: false, active: false, djPerm: null },
            permissions: {
                dev: true,
                client: ['SendMessages', 'ViewChannel', 'EmbedLinks'],
                user: [],
            },
            slashCommand: false,
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
        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp();

        if (!client.youTubeConfigService) {
            return await ctx.sendMessage({ 
                embeds: [embed.setColor(this.client.color.red).setDescription(ctx.locale('cmd.youtubeconfig.errors.service_unavailable'))] 
            });
        }

        if (args.length === 0) {
            return await ctx.sendMessage({ 
                embeds: [
                    embed.setColor(this.client.color.red)
                        .setDescription(ctx.locale('cmd.youtubeconfig.errors.missing_subcommand'))
                        .addFields({
                            name: ctx.locale('cmd.youtubeconfig.usage.title'),
                            value: ctx.locale('cmd.youtubeconfig.usage.value'),
                        })
                ] 
            });
        }

        const subcommand = args[0].toLowerCase();
        const parsedArgs = this.parseArgs(args.slice(1));
        const nodeId = parsedArgs['node'];

        await ctx.sendDeferMessage(ctx.locale('cmd.youtubeconfig.messages.processing'));

        try {
            switch (subcommand) {
                case 'oauth':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.youtubeconfig.errors.missing_node', { subcommand: 'oauth' }));
                        return;
                    }
                    await this.handleOAuth(client, ctx, nodeId, parsedArgs);
                    break;
                case 'potoken':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.youtubeconfig.errors.missing_node', { subcommand: 'potoken' }));
                        return;
                    }
                    await this.handlePoToken(client, ctx, nodeId, parsedArgs);
                    break;
                case 'view':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.youtubeconfig.errors.missing_node', { subcommand: 'view' }));
                        return;
                    }
                    await this.handleView(client, ctx, nodeId);
                    break;
                case 'refresh-token':
                    if (!nodeId) {
                        await this.sendError(ctx, ctx.locale('cmd.youtubeconfig.errors.missing_node', { subcommand: 'refresh-token' }));
                        return;
                    }
                    await this.handleRefreshToken(client, ctx, nodeId, parsedArgs);
                    break;
                case 'list-nodes':
                    await this.handleListNodes(client, ctx);
                    break;
                default:
                    await this.sendError(ctx, ctx.locale('cmd.youtubeconfig.errors.unknown_subcommand', { subcommand }));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await this.sendError(ctx, errorMessage);
        }
    }

    private async handleOAuth(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const refreshToken = parsedArgs['refreshToken'];
        const skipInitializationStr = parsedArgs['skipInitialization'];
        const skipInitialization = skipInitializationStr ? skipInitializationStr.toLowerCase() === 'true' : null;

        // Require at least one option
        if (!refreshToken && skipInitialization === null) {
            await this.sendError(ctx, ctx.locale('cmd.youtubeconfig.errors.missing_oauth_option'));
            return;
        }

        await client.youTubeConfigService!.updateConfig(nodeId, {
            refreshToken: refreshToken ?? undefined,
            skipInitialization: skipInitialization ?? undefined,
        });

        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp()
            .setColor(this.client.color.main)
            .setTitle(ctx.locale('cmd.youtubeconfig.messages.oauth_updated_title'))
            .setDescription(ctx.locale('cmd.youtubeconfig.messages.oauth_updated_desc', { nodeId }))
            .addFields(
                { 
                    name: ctx.locale('cmd.youtubeconfig.fields.refresh_token'), 
                    value: refreshToken ? ctx.locale('cmd.youtubeconfig.fields.updated') : ctx.locale('cmd.youtubeconfig.fields.not_changed'), 
                    inline: true 
                },
                { 
                    name: ctx.locale('cmd.youtubeconfig.fields.skip_initialization'), 
                    value: skipInitialization !== null ? (skipInitialization ? ctx.locale('cmd.youtubeconfig.fields.yes') : ctx.locale('cmd.youtubeconfig.fields.no')) : ctx.locale('cmd.youtubeconfig.fields.not_changed'), 
                    inline: true 
                }
            )
            .addFields({
                name: ctx.locale('cmd.youtubeconfig.fields.important'),
                value: ctx.locale('cmd.youtubeconfig.fields.oauth_warning'),
            });

        await ctx.editMessage({ content: '', embeds: [embed] });
    }

    private async handlePoToken(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const poToken = parsedArgs['poToken'];
        const visitorData = parsedArgs['visitorData'];

        // Require at least one option
        if (!poToken && !visitorData) {
            await this.sendError(ctx, ctx.locale('cmd.youtubeconfig.errors.missing_potoken_pair'));
            return;
        }

        // Warn if only one is provided
        if ((poToken && !visitorData) || (!poToken && visitorData)) {
            await this.sendError(ctx, ctx.locale('cmd.youtubeconfig.errors.missing_potoken_pair'));
            return;
        }

        await client.youTubeConfigService!.updateConfig(nodeId, {
            poToken: poToken ?? undefined,
            visitorData: visitorData ?? undefined,
        });

        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp()
            .setColor(this.client.color.main)
            .setTitle(ctx.locale('cmd.youtubeconfig.messages.potoken_updated_title'))
            .setDescription(ctx.locale('cmd.youtubeconfig.messages.potoken_updated_desc', { nodeId }))
            .addFields(
                { 
                    name: ctx.locale('cmd.youtubeconfig.fields.potoken'), 
                    value: poToken ? ctx.locale('cmd.youtubeconfig.fields.updated') : ctx.locale('cmd.youtubeconfig.fields.not_changed'), 
                    inline: true 
                },
                { 
                    name: ctx.locale('cmd.youtubeconfig.fields.visitor_data'), 
                    value: visitorData ? ctx.locale('cmd.youtubeconfig.fields.updated') : ctx.locale('cmd.youtubeconfig.fields.not_changed'), 
                    inline: true 
                }
            )
            .addFields({
                name: ctx.locale('cmd.youtubeconfig.fields.how_to_generate'),
                value: ctx.locale('cmd.youtubeconfig.fields.generator_link'),
            });

        await ctx.editMessage({ content: '', embeds: [embed] });
    }

    private async handleView(client: Lavamusic, ctx: Context, nodeId: string): Promise<void> {
        const config = await client.youTubeConfigService!.getConfig(nodeId);

        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp()
            .setColor(this.client.color.main)
            .setTitle(ctx.locale('cmd.youtubeconfig.messages.view_title', { nodeId }))
            .addFields({
                name: ctx.locale('cmd.youtubeconfig.fields.refresh_token'),
                value: config.refreshToken 
                    ? this.maskToken(config.refreshToken) 
                    : ctx.locale('cmd.youtubeconfig.messages.not_set'),
            })
            .addFields({
                name: ctx.locale('cmd.youtubeconfig.fields.note'),
                value: ctx.locale('cmd.youtubeconfig.fields.api_note'),
            });

        await ctx.editMessage({ content: '', embeds: [embed] });
    }

    private async handleRefreshToken(client: Lavamusic, ctx: Context, nodeId: string, parsedArgs: Record<string, string>): Promise<void> {
        const refreshToken = parsedArgs['refreshToken'];

        if (!refreshToken) {
            await this.sendError(ctx, ctx.locale('cmd.youtubeconfig.errors.missing_refresh_token'));
            return;
        }

        const tokenResponse = await client.youTubeConfigService!.refreshOAuthToken(nodeId, refreshToken);

        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp()
            .setColor(this.client.color.main)
            .setTitle(ctx.locale('cmd.youtubeconfig.messages.token_refreshed_title'))
            .setDescription(ctx.locale('cmd.youtubeconfig.messages.token_refreshed_desc', { nodeId }))
            .addFields(
                { name: ctx.locale('cmd.youtubeconfig.fields.token_type'), value: tokenResponse.token_type, inline: true },
                { name: ctx.locale('cmd.youtubeconfig.fields.expires_in'), value: `${tokenResponse.expires_in}s`, inline: true },
                { name: ctx.locale('cmd.youtubeconfig.fields.scope'), value: tokenResponse.scope || ctx.locale('cmd.youtubeconfig.messages.na'), inline: true }
            )
            .addFields({
                name: ctx.locale('cmd.youtubeconfig.fields.access_token_truncated'),
                value: this.maskToken(tokenResponse.access_token, 50),
            });

        await ctx.editMessage({ content: '', embeds: [embed] });
    }

    private async handleListNodes(client: Lavamusic, ctx: Context): Promise<void> {
        const nodes = client.youTubeConfigService!.getNodesList();

        const embed = this.client.embed()
            .setFooter({
                text: "BuNgo Music Bot 🎵 • Maded by Gúp Bu Ngô with ♥️",
                iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
            })
            .setTimestamp()
            .setColor(this.client.color.main)
            .setTitle(ctx.locale('cmd.youtubeconfig.messages.nodes_title'));

        if (nodes.length === 0) {
            embed.setDescription(ctx.locale('cmd.youtubeconfig.messages.no_nodes'));
        } else {
            const nodeList = nodes
                .map(node => `**${node.id}** - ${node.host} ${node.connected ? '🟢' : '🔴'}`)
                .join('\n');
            embed.setDescription(nodeList)
                .setFooter({ 
                    text: ctx.locale('cmd.youtubeconfig.messages.total_nodes', { count: nodes.length }),
                    iconURL: "https://raw.githubusercontent.com/ductridev/multi-distube-bots/refs/heads/master/assets/img/bot-avatar-1.jpg",
                });
        }

        await ctx.editMessage({ content: '', embeds: [embed] });
    }

    /**
     * Mask a token for display, showing only the first few and last few characters.
     * @param token - The token to mask
     * @param showFirst - Number of characters to show at the start (default: 10)
     * @param showLast - Number of characters to show at the end (default: 4)
     * @returns Masked token string
     */
    private maskToken(token: string, showFirst: number = 10, showLast: number = 4): string {
        if (!token) return 'N/A';
        if (token.length <= showFirst + showLast) {
            return token;
        }
        const first = token.substring(0, showFirst);
        const last = token.substring(token.length - showLast);
        return `${first}...${last}`;
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
