import { MiniMap } from "lavalink-client";
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import IORedis, { type Redis, type RedisOptions } from "ioredis";

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
    /**
     * Keys whose last Redis write failed (bounded op timeout / disconnect) and
     * thus diverged from the mirror. Replayed from the mirror on the next
     * `ready` event so Redis re-converges after an outage. `mirror.has(key)`
     * decides SET vs DEL, so it stays correct for both set and delete.
     */
    private dirtyKeys = new Set<string>();
    private flushing = false;

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
                // Tear down the half-open client so it doesn't keep retrying in
                // the background (retryStrategy would otherwise reconnect forever).
                this.redis?.disconnect();
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
        this.redis = this.makeRedisClient(url, {
            // Bound every command: reject after a few retries / a timeout, and
            // don't buffer commands while disconnected, so a set/del settles
            // within a fixed window instead of hanging indefinitely.
            maxRetriesPerRequest: 3,
            commandTimeout: 5_000,
            connectTimeout: 10_000,
            enableOfflineQueue: false,
            enableReadyCheck: false,
            lazyConnect: true,
            retryStrategy: (times) => Math.min(times * 50, 2000),
        });
        this.redis.on("error", (err) => console.error("[JSONStore][Redis] Error:", err));
        // On (re)connect, push any keys that diverged during an outage back to
        // Redis. Fires on first connect too (dirty set empty then — no-op).
        this.redis.on("ready", () => void this.flushDirty());
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

        await this.migrateFileIntoRedis();
    }

    /** Overridable seam for the Redis client (kept small so tests can inject a fake). */
    protected makeRedisClient(url: string, options: RedisOptions): Redis {
        return new IORedis(url, options);
    }

    /**
     * Seed the legacy/fallback JSON file into Redis for keys Redis doesn't
     * already have, then retire the file. Runs once per Redis boot and covers
     * two cases with one mechanism:
     *  - First switch to a Redis backend: Redis is empty, so every file entry
     *    is migrated in.
     *  - Recovery after an outage: writes that fell back to the file while Redis
     *    was down are pushed in.
     *
     * Redis stays authoritative — a key already present in the mirror (loaded
     * from Redis) is never overwritten by the file. Retiring the file to `.bak`
     * afterwards prevents an expired-then-stale key from being resurrected on
     * every subsequent boot; a future outage recreates the file fresh.
     */
    private async migrateFileIntoRedis(): Promise<void> {
        if (!this.redis || !this.redisOpts) return;

        let entries: [string, string][];
        try {
            entries = this.JSONtoEntries(readFileSync(this.filePath, "utf-8"));
        } catch {
            return; // no file (or unreadable/corrupt) — nothing to migrate
        }

        const { ttlSeconds } = this.redisOpts;
        let migrated = 0;
        for (const [key, value] of entries) {
            if (this.data.has(key)) continue; // Redis already owns this key
            try {
                await this.redis.set(this.redisKey(key), value, "EX", ttlSeconds);
                this.data.set(key, value);
                migrated++;
            } catch (error) {
                // Redis went unreachable mid-migration: leave the file in place
                // (not retired) so the remaining keys retry on the next boot.
                this.warnRedisFallback("migrate", error);
                return;
            }
        }

        try {
            await rename(this.filePath, `${this.filePath}.bak`);
        } catch (error) {
            console.warn(
                `[JSONStore][Redis] Migrated ${migrated} entries but could not retire ${this.filePath}:`,
                error instanceof Error ? error.message : String(error),
            );
            return;
        }
        if (migrated) console.log(`[JSONStore][Redis] Migrated ${migrated} file entries into Redis`);
    }

    /** Convert JSON string to entries array */
    private JSONtoEntries(json: string): [string, string][] {
        return Object.entries(JSON.parse(json));
    }

    /** Convert map entries into JSON string */
    private mapToJSON(map: MiniMap<string, string>): string {
        return JSON.stringify(Object.fromEntries(Array.from(map.entries())));
    }

    /**
     * Persist a single key/value depending on backend. Persists the proposed
     * value directly (Redis) or a snapshot of the map with the value applied
     * (file), so the durable store commits before the in-memory mirror does.
     */
    private async persistSet(key: string, value: string): Promise<void> {
        if (this.redis && this.redisOpts) {
            try {
                await this.redis.set(this.redisKey(key), value, "EX", this.redisOpts.ttlSeconds);
                this.dirtyKeys.delete(key);
                return;
            } catch (error) {
                // Bounded failure: while the socket is down `enableOfflineQueue:
                // false` rejects immediately (no timeout wait); `commandTimeout`
                // only bounds a connected-but-slow server. Don't lose the write —
                // persist to file this once and mark the key dirty so flushDirty
                // re-converges Redis on the next `ready`. `redis` is left intact.
                this.warnRedisFallback("set", error);
                this.dirtyKeys.add(key);
            }
        }
        const snapshot = new MiniMap<string, string>(Array.from(this.data.entries()));
        snapshot.set(key, value);
        await writeFile(this.filePath, this.mapToJSON(snapshot), "utf-8");
    }

    private async persistDelete(key: string): Promise<void> {
        if (this.redis && this.redisOpts) {
            try {
                await this.redis.del(this.redisKey(key));
                this.dirtyKeys.delete(key);
                return;
            } catch (error) {
                this.warnRedisFallback("del", error);
                this.dirtyKeys.add(key);
            }
        }
        const snapshot = new MiniMap<string, string>(Array.from(this.data.entries()));
        snapshot.delete(key);
        await writeFile(this.filePath, this.mapToJSON(snapshot), "utf-8");
    }

    private warnRedisFallback(op: string, error: unknown): void {
        console.warn(
            `[JSONStore][Redis] ${op} failed, writing to file store this once:`,
            error instanceof Error ? error.message : String(error),
        );
    }

    /**
     * Replay keys that diverged during an outage back to Redis, driven by the
     * mirror: present => SET (with TTL), absent => DEL. Runs on `ready`. Keys
     * that fail again stay dirty and retry on the next `ready`; a concurrent
     * normal write may re-add a key, which the next pass picks up.
     */
    private async flushDirty(): Promise<void> {
        if (this.flushing || !this.redis || !this.redisOpts) return;
        if (this.dirtyKeys.size === 0) return;
        this.flushing = true;
        try {
            const { ttlSeconds } = this.redisOpts;
            for (const key of Array.from(this.dirtyKeys)) {
                try {
                    const value = this.data.get(key);
                    if (value === undefined) {
                        await this.redis.del(this.redisKey(key));
                    } else {
                        await this.redis.set(this.redisKey(key), value, "EX", ttlSeconds);
                    }
                    this.dirtyKeys.delete(key);
                } catch (error) {
                    // Still unreachable — keep the key dirty, stop this pass.
                    this.warnRedisFallback("flush", error);
                    break;
                }
            }
        } finally {
            this.flushing = false;
        }
    }

    /** Get a stored value by key */
    public get(key: string): string | undefined {
        return this.data.get(key);
    }

    /** Set a value (stringified JSON), update mirror and persist. */
    public async set(key: string, value: string): Promise<void> {
        // Persist first; only commit to the mirror once durable, so a failed
        // write can't leave the mirror ahead of the store.
        await this.persistSet(key, value);
        this.data.set(key, value);
    }

    /** Delete a key: persist first, then update the mirror. */
    public async delete(key: string): Promise<void> {
        await this.persistDelete(key);
        this.data.delete(key);
    }
}
