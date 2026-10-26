import type { LavalinkNode } from 'lavalink-client';
// Direct imports (not structures/index) keep this module loadable in unit tests.
import Event from '../../structures/Event';
import type Lavamusic from '../../structures/Lavamusic';

/** Lavalink session resume timeout, in seconds (the Lavalink API unit). */
export const SESSION_RESUME_TIMEOUT_S = 15 * 60e3;

export default class Raw extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'raw',
		});

		// On hot reload, connected nodes already received their 'ready' before this handler
		// existed, so pin their live session now.
		for (const node of client.manager.nodeManager.nodes.values()) {
			if (node.connected && node.sessionId) node.options.sessionId = node.sessionId;
		}
	}

	public async run(node: LavalinkNode, payload: { op?: string; sessionId?: string }): Promise<void> {
		if (payload?.op !== 'ready' || !payload.sessionId) return;

		// lavalink-client reconnects send Session-Id from options.sessionId only (set once at
		// boot), never the live session, so every reconnect opened a new Lavalink session and
		// orphaned the previous one. Pin the live id so the next reconnect resumes it.
		node.options.sessionId = payload.sessionId;

		// The node applies the 'ready' payload right after emitting 'raw'; defer so
		// updateSession targets the new session id. Resumable from the start, not after 10 min.
		setImmediate(() => {
			node.updateSession(true, SESSION_RESUME_TIMEOUT_S).catch((error) => {
				this.client.logger.warn(`Node ${node.id} updateSession failed: ${error?.message ?? error}`);
			});
		});
	}
}
