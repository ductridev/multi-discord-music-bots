import type { LavalinkNode } from 'lavalink-client';
import { Event, type Lavamusic } from '../../structures/index';

export default class NodeError extends Event {
	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'error',
		});
	}

	// Must always be registered. Without an 'error' listener the NodeManager emit throws
	// ERR_UNHANDLED_ERROR inside lavalink-client's socket error handler, which aborts the
	// reconnect (no 'close' event, reconnectionState stuck) and leaves the node dead.
	public async run(node: LavalinkNode, error: Error): Promise<void> {
		this.client.logger.error(`Node ${node.id} error: ${error?.message ?? error}`);
	}
}
