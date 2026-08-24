import { MiniMap } from "lavalink-client";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import IORedis, { type Redis } from "ioredis";

export interface RedisStoreOptions {
    /** Redis connection URL. When provided, persistence uses per-key Redis writes. */
    url: string;
    /** Key namespace, e.g. `playerdata:BotName:`. Each entry is stored at `${keyPrefix}${key}`. */
    keyPrefix: string;
    /** TTL in seconds applied to every write; stale entries self-prune. */
    ttlSeconds: number;
}

/**
 * Key/value store with an in-memory mirror (`data`) plus durable persistence.
 *
 * Two persistence backends:
 *  - Redis (when RedisStoreOptions are passed): each key is a separate Redis
 *    entry with a TTL. Writes are O(1) and never rewrite the whole set, and
 *    stale entries expire on their own. This is the scalable prod path.
 *  - File (default): the entire map is serialized to one JSON file on every
 *    write. Fine for dev, but O(N) per write — do not use with many guilds.
 *
 * Reads always hit the in-memory `data` mirror, so all existing synchronous
 * callers keep working unchanged regardless of backend.
 */
export class JSONStore {
    public data: MiniMap<string, string>;
    public filePath: string;
    private loadPromise: Promise<void>;
    private redis: Redis | null = null;
    private redisOpts: RedisStoreOptions | null = null;

    constructor(filePath?: string, redisOpts?: RedisStoreOptions) {
        this.filePath = filePath ?? `${process.cwd()}/queueData.json`;
        this.data = new MiniMap<string, string>();
        this.redisOpts = redisOpts ?? null;
        this.loadPromise = this.initLoadData();
    }

    /** Ensure data is loaded before accessing */
    public async ensureLoaded(): Promise<void> {
        await this.loadPromise;
    }

    private redisKey(key: string): string {
        return `${this.redisOpts!.keyPrefix}${key}`;
    }

    /** Load existing data into the in-memory mirror (Redis SCAN or JSON file). */
    private async initLoadData(): Promise<void> {
        if (this.redisOpts) {
            try {
                await this.initRedis();
                return;
            } catch (error) {
                console.warn(
                    `[JSONStore] Redis init failed for prefix ${this.redisOpts.keyPrefix}, falling back to file store:`,
                    error instanceof Error ? error.message : String(error),
                );
                this.redis = null;
                this.redisOpts = null;
                // fall through to file load
            }
        }

        try {
            const raw = readFileSync(this.filePath, "utf-8");
            const entries = this.JSONtoEntries(raw);
            this.data = new MiniMap<string, string>(entries);
            console.log(`[JSONStore] Loaded ${entries.length} entries from ${this.filePath}`);
        } catch (error) {
            // If file missing or corrupted, create it
            console.warn(`[JSONStore] Failed to load ${this.filePath}, creating new store:`, error instanceof Error ? error.message : String(error));
            await writeFile(this.filePath, this.mapToJSON(this.data), "utf-8");
        }
    }

    /** Connect to Redis and hydrate the in-memory mirror from all namespaced keys. */
    private async initRedis(): Promise<void> {
        const { url, keyPrefix } = this.redisOpts!;
        this.redis = new IORedis(url, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            lazyConnect: true,
            retryStrategy: (times) => Math.min(times * 50, 2000),
        });
        this.redis.on("error", (err) => console.error("[JSONStore][Redis] Error:", err));
        await this.redis.connect();

        const match = `${keyPrefix}*`;
        let cursor = "0";
        let loaded = 0;
        do {
            const [next, keys] = await this.redis.scan(cursor, "MATCH", match, "COUNT", 500);
            cursor = next;
            if (keys.length) {
                const values = await this.redis.mget(keys);
                for (let i = 0; i < keys.length; i++) {
                    const value = values[i];
                    if (value == null) continue;
                    this.data.set(keys[i].slice(keyPrefix.length), value);
                    loaded++;
                }
            }
        } while (cursor !== "0");

        console.log(`[JSONStore][Redis] Loaded ${loaded} entries for prefix ${keyPrefix}`);
    }

    /** Convert JSON string to entries array */
    private JSONtoEntries(json: string): [string, string][] {
        return Object.entries(JSON.parse(json));
    }

    /** Convert map entries into JSON string */
    private mapToJSON(map: MiniMap<string, string>): string {
        return JSON.stringify(Object.fromEntries(Array.from(map.entries())));
    }

    /** Persist the whole map / a single key depending on backend. */
    private async persistSet(key: string): Promise<void> {
        if (this.redis && this.redisOpts) {
            await this.redis.set(this.redisKey(key), this.data.get(key)!, "EX", this.redisOpts.ttlSeconds);
        } else {
            await writeFile(this.filePath, this.mapToJSON(this.data), "utf-8");
        }
    }

    private async persistDelete(key: string): Promise<void> {
        if (this.redis && this.redisOpts) {
            await this.redis.del(this.redisKey(key));
        } else {
            await writeFile(this.filePath, this.mapToJSON(this.data), "utf-8");
        }
    }

    /** Get a stored value by key */
    public get(key: string): string | undefined {
        return this.data.get(key);
    }

    /** Set a value (stringified JSON), update mirror and persist. */
    public async set(key: string, value: string): Promise<void> {
        this.data.set(key, value);
        await this.persistSet(key);
    }

    /** Delete a key, update mirror and persist. */
    public async delete(key: string): Promise<void> {
        this.data.delete(key);
        await this.persistDelete(key);
    }
}
