import util from 'node:util';
import { activeBots } from '../..';
import { Command, type Context, type Lavamusic } from '../../structures/index';

export default class Reconnect extends Command {
    constructor(client: Lavamusic) {
        super(client, {
            name: 'reconnect',
            description: {
                content: 'Reconnect to disconnected nodes',
                examples: ['reconnect'],
                usage: 'reconnect',
            },
            category: 'dev',
            aliases: ['rc', 'rconnect'],
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
                client: ['SendMessages', 'ReadMessageHistory', 'ViewChannel', 'EmbedLinks'],
                user: [],
            },
            slashCommand: true,
            options: [
                { name: 'nodes', description: 'Node IDs to reconnect (space-separated, optional)', type: 3, required: false },
            ],
        });
    }

    public async run(_client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
        // Get target node IDs if provided, else reconnect all disconnected nodes
        const targetNodeIds = args.length
            ? args.map((arg) => arg.trim().replace(/^["']|["']$/g, '').replaceAll('_', ' '))
            : null;

        const reconnectResults: Record<string, string[]> = {};

        for (const bot of activeBots) {
            const botName = bot.user?.username ?? bot.childEnv.name ?? 'Unknown';

            for (const node of bot.manager.nodeManager.nodes.values()) {
                if (targetNodeIds && !targetNodeIds.includes(node.id)) continue;

                const key = `Node "${node.id}"`;
                if (!reconnectResults[key]) reconnectResults[key] = [];

                if (node.connected) {
                    reconnectResults[key].push(`${botName}: Already connected.`);
                    continue;
                }
                try {
                    const sessionId = bot.playerSaver!.getAllLastNodeSessions().get(node.id!);
                    node.connect(sessionId);
                    reconnectResults[key].push(`${botName}: Reconnected successfully.`);
                } catch (error) {
                    reconnectResults[key].push(`${botName}: Failed - ${util.inspect(error)}`);
                }
            }
        }

        if (Object.keys(reconnectResults).length === 0) {
            return ctx.sendMessage({
                content: targetNodeIds
                    ? `Node(s) not found: ${targetNodeIds.join(', ')}`
                    : 'All nodes are currently connected. No nodes to reconnect.',
            });
        }

        const resultMessages = Object.entries(reconnectResults)
            .map(([nodeId, results]) => `**${nodeId}:**\n${results.map(r => `  • ${r}`).join('\n')}`)
            .join('\n\n');

        return ctx.sendMessage({
            content: `**Reconnect Results:**\n\n${resultMessages}`,
        });
    }
}


