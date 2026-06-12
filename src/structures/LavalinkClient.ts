import { LavalinkManager, type LavalinkNodeOptions, type SearchPlatform, type SearchResult } from 'lavalink-client';
import { autoPlayFunction, requesterTransformer } from '../utils/functions/player';
import type Lavamusic from './Lavamusic';

export default class LavalinkClient extends LavalinkManager {
	public client: Lavamusic;
	constructor(client: Lavamusic) {
		super({
			nodes: (client.env.NODES as LavalinkNodeOptions[]).map(node => {
				node.sessionId = client.playerSaver!.getAllLastNodeSessions().get(node.id!);
				return node;
			}),
			sendToShard: async (guildId, payload) => (await client.guilds.fetch(guildId)).shard.send(payload),
			queueOptions: {
				maxPreviousTracks: 1000,
			},
			playerOptions: {
				defaultSearchPlatform: client.env.SEARCH_ENGINE,
				onDisconnect: {
					autoReconnect: true,
					destroyPlayer: false,
				},
				requesterTransformer: (requester) => requesterTransformer(requester, client),
				onEmptyQueue: {
					autoPlayFunction,
				},
			},
			advancedOptions: {
				enableDebugEvents: true, // enable the DEBUG EVENT LISTENER
			}
		});
		this.client = client;
	}
	/**
	 * Searches for a song and returns the tracks.
	 * @param query The query to search for.
	 * @param user The user who requested the search.
	 * @param source The source to search in. Defaults to youtube.
	 * @returns An array of tracks that match the query.
	 */
	public async search(query: string, user: unknown, source?: SearchPlatform): Promise<SearchResult> {
		const nodes = this.nodeManager.leastUsedNodes();
		const node = nodes[Math.floor(Math.random() * nodes.length)];
		const result = await node.search({ query, source }, user, false);
		return result;
	}
}


