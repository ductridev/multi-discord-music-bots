import type { QueueStoreManager, StoredQueue } from "lavalink-client";
import { JSONStore } from "./JSONStore";
import { env } from "../env";

/**
 * Persistent queue store for lavalink-client.
 *
 * The library's DefaultQueueStore is a pure in-memory MiniMap, so it is empty
 * after a process restart and `player.queue.utils.sync()` throws "No data found
 * to sync" — losing the current track, upcoming tracks, previous history, and
 * per-track requesters on every restart.
 *
 * This store persists each guild's queue through {@link JSONStore}, which uses
 * the same file (+ optional Redis) backend as {@link PlayerSaver}. It is scoped
 * per bot (name in the file path / Redis key prefix) so instances stay isolated
 * in the multi-bot deployment.
 *
 * Values are stored as raw JSON strings: `get` MUST return them unparsed (the
 * library calls `parse` itself), `set` accepts either a StoredQueue or an
 * already-stringified value.
 */
export class QueueStore implements QueueStoreManager {
	private store: JSONStore;

	constructor(name: string) {
		this.store = new JSONStore(
			`${process.cwd()}/queueData-${name}.json`,
			env.REDIS_URL
				? {
					url: env.REDIS_URL,
					keyPrefix: `queuedata:${name}:`,
					ttlSeconds: env.PLAYER_SESSION_TTL,
				}
				: undefined,
		);
	}

	/** Wait for the in-memory mirror to hydrate from disk/Redis before first sync. */
	public ensureLoaded(): Promise<void> {
		return this.store.ensureLoaded();
	}

	public get(guildId: string): string | undefined {
		return this.store.get(guildId);
	}

	public async set(guildId: string, value: StoredQueue | string): Promise<void> {
		await this.store.set(guildId, typeof value === "string" ? value : JSON.stringify(value));
	}

	public async delete(guildId: string): Promise<void> {
		await this.store.delete(guildId);
	}

	public stringify(value: StoredQueue | string): string {
		return typeof value === "string" ? value : JSON.stringify(value);
	}

	public parse(value: StoredQueue | string): Partial<StoredQueue> {
		return typeof value === "string" ? JSON.parse(value) : value;
	}
}
