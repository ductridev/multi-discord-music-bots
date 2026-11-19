import type { LavalinkNode } from 'lavalink-client';
// Direct imports (not structures/index) keep this module loadable in unit tests.
import Event from '../../structures/Event';
import type Lavamusic from '../../structures/Lavamusic';

/** Lavalink session resume timeout, in seconds (the Lavalink API unit). */
export const SESSION_RESUME_TIMEOUT_S = 15 * 60e3;

/**
 * Lavalink sends stats every 60s and lavalink-client terminates the socket if none arrives
 * within 65s, so a 5s hiccup on the Cloudflare path dropped live sessions (prod closes cluster
 * at 5-9s past the minute). Allow three missed stats; the 30s ping still catches dead sockets.
 */
export const STATS_WATCHDOG_MS = 185e3;

type HeartbeatNode = {
	nodeType?: string;
	socket: { terminate(): void } | null;
	isAlive: boolean;
	pingTimeout: ReturnType<typeof setTimeout> | null;
	resetAckTimeouts(heartbeat?: boolean, ping?: boolean): void;
};

/**
 * Instance-level overrides so the fix applies on hot reload without restarting the bot
 * (node_modules cannot be reloaded). Reassigned from the prototype each time, so repeated
 * reloads never stack wrappers. Same method shapes in lavalink-client 2.9.6 through 2.11.2.
 */
export function patchNodeHeartbeat(node: LavalinkNode): void {
	const target = node as unknown as Record<string, unknown>;
	const protoClose = Object.getPrototypeOf(node).close as (code: number, reason?: string) => unknown;

	target.heartBeat = function (this: HeartbeatNode) {
		if (this.nodeType !== 'Lavalink') return;
		this.resetAckTimeouts(false, true);
		this.pingTimeout = setTimeout(() => {
			this.pingTimeout = null;
			if (!this.socket) return;
			this.isAlive = false;
			this.socket.terminate();
		}, STATS_WATCHDOG_MS);
	};

	target.close = function (this: HeartbeatNode, code: number, reason?: string) {
		// The ping timeout calls close(500), which only detaches listeners and nulls the
		// socket, leaving it open while a new one connects. Terminate it; the socket's own
		// 'close' event then runs the normal close/reconnect path.
		if (reason === 'Node-Heartbeat-Timeout' && this.socket) {
			this.isAlive = false;
			this.socket.terminate();
			return Promise.resolve();
		}
		return protoClose.call(this, code, reason);
	};
}

export default class Raw extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'raw',
		});

		for (const node of client.manager.nodeManager.nodes.values()) {
			patchNodeHeartbeat(node);
			// Replace a 65s stats watchdog armed before this reload with the patched one.
			if (node.connected) (node as unknown as { heartBeat(): void }).heartBeat();
			// On hot reload, connected nodes already received their 'ready' before this handler
			// existed, so pin their live session now.
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
