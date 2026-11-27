import { JSONStore } from "./JSONStore";
import { env } from "../env";

/**
 * Last Lavalink session id per node (nodeId -> sessionId) for one bot.
 *
 * Written on every `ready`, so it always holds the live session. Startup sends it
 * as `Session-Id` to resume the paused session. Player records are not a reliable
 * source: idle players keep the id of whatever session they were saved under.
 */
export class NodeSessionStore extends JSONStore {
	constructor(name: string) {
		super(
			`${process.cwd()}/data/nodeSessions-${name}.json`,
			env.REDIS_URL
				? {
					url: env.REDIS_URL,
					keyPrefix: `nodesession:${name}:`,
					ttlSeconds: env.PLAYER_SESSION_TTL,
				}
				: undefined,
		);
	}
}
