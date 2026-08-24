import { MiniMap } from "lavalink-client";
import { readFileSync } from "node:fs";
import { writeFile, rename, unlink } from "node:fs/promises";
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
    /** Serializes durable file writes so concurrent set/delete can't race the file. */
    private writeChain: Promise<void> = Promise.resolve();

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
            const entries = this.JSONtoEntries(raw).filter(([, v]) => v !== null) as [string, string][];
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

        let entries: [string, string | null][];
        try {
            entries = this.JSONtoEntries(readFileSync(this.filePath, "utf-8"));
        } catch {
            return; // no file (or unreadable/corrupt) — nothing to migrate
        }

        const { ttlSeconds } = this.redisOpts;
        let migrated = 0;
        for (let i = 0; i < entries.length; i++) {
            const [key, value] = entries[i];
            try {
                if (value === null) {
                    // Delete tombstone recorded during an outage — replay the DEL.
                    await this.redis.del(this.redisKey(key));
                    this.data.delete(key);
                    this.dirtyKeys.delete(key);
                    continue;
                }
                if (this.data.has(key)) continue; // Redis already owns this key
                await this.redis.set(this.redisKey(key), value, "EX", ttlSeconds);
                this.data.set(key, value);
                migrated++;
            } catch (error) {
                // Redis went unreachable mid-migration. Preserve the failed record
                // and every still-unprocessed one in the mirror and dirty set so
                // the ready/flushDirty flow republishes them after reconnect; leave
                // the file in place (not retired) as the durable copy until they land.
                this.warnRedisFallback("migrate", error);
                for (let j = i; j < entries.length; j++) {
                    const [k, v] = entries[j];
                    if (v === null) {
                        this.data.delete(k);
                        this.dirtyKeys.add(k);
                    } else if (!this.data.has(k)) {
                        this.data.set(k, v);
                        this.dirtyKeys.add(k);
                    }
                }
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
    private JSONtoEntries(json: string): [string, string | null][] {
        return Object.entries(JSON.parse(json)) as [string, string | null][];
    }

    /** Convert map entries into JSON string */
    private mapToJSON(map: MiniMap<string, string>): string {
        return JSON.stringify(Object.fromEntries(Array.from(map.entries())));
    }

    /**
     * Persist the current diverged (dirty) key set to the fallback file as
     * ordered SET/DEL records: `{ key: value }` for a set, `{ key: null }` as a
     * delete tombstone. Only diverged keys are written — never a full mirror
     * snapshot — so recovery never resurrects an unrelated key that has since
     * expired in Redis with a fresh TTL, and concurrent fallbacks accumulate
     * (write serialized via `enqueueWrite`) instead of clobbering one another.
     */
    private async writeFallbackFile(): Promise<void> {
        const records: Record<string, string | null> = {};
        for (const k of this.dirtyKeys) {
            const v = this.data.get(k);
            records[k] = v === undefined ? null : v;
        }
        await writeFile(this.filePath, JSON.stringify(records), "utf-8");
    }

    /**
     * Serialize durable file writes through a promise chain so concurrent
     * set/delete calls can't tear the file or drop each other's keys. The task
     * reads live mirror/dirty state at execution time, so the last write in a
     * concurrent burst always reflects every committed change.
     */
    private enqueueWrite(task: () => Promise<void>): Promise<void> {
        const run = this.writeChain.then(task, task);
        this.writeChain = run.then(() => {}, () => {});
        return run;
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
        // Reconcile the fallback file with what's still dirty: rewrite the
        // remaining records, or remove the file once everything re-converged, so
        // a later boot never replays a stale tombstone over a recreated key.
        await this.enqueueWrite(() =>
            this.dirtyKeys.size
                ? this.writeFallbackFile()
                : unlink(this.filePath).then(() => {}, () => {}),
        );
    }

    /** Get a stored value by key */
    public get(key: string): string | undefined {
        return this.data.get(key);
    }

    /** Set a value (stringified JSON), update mirror and persist. */
    public async set(key: string, value: string): Promise<void> {
        if (this.redis && this.redisOpts) {
            try {
                await this.redis.set(this.redisKey(key), value, "EX", this.redisOpts.ttlSeconds);
                this.dirtyKeys.delete(key);
                this.data.set(key, value);
                return;
            } catch (error) {
                // Bounded failure: while the socket is down `enableOfflineQueue:
                // false` rejects immediately. Don't lose the write — commit the
                // mirror + dirty set, then persist the whole diverged set to the
                // fallback file so flushDirty re-converges Redis on the next
                // `ready`. Mirror-first here (not persist-first) is deliberate: it
                // is what lets concurrent fallbacks accumulate without clobbering.
                this.warnRedisFallback("set", error);
                this.dirtyKeys.add(key);
                this.data.set(key, value);
                await this.enqueueWrite(() => this.writeFallbackFile());
                return;
            }
        }
        // File-only backend: the mirror is the store. Commit, then serialize a
        // full snapshot of the live mirror so concurrent writes don't race.
        this.data.set(key, value);
        await this.enqueueWrite(() => writeFile(this.filePath, this.mapToJSON(this.data), "utf-8"));
    }

    /** Delete a key: update mirror and persist. */
    public async delete(key: string): Promise<void> {
        if (this.redis && this.redisOpts) {
            try {
                await this.redis.del(this.redisKey(key));
                this.dirtyKeys.delete(key);
                this.data.delete(key);
                return;
            } catch (error) {
                this.warnRedisFallback("del", error);
                this.dirtyKeys.add(key);
                this.data.delete(key);
                await this.enqueueWrite(() => this.writeFallbackFile());
                return;
            }
        }
        this.data.delete(key);
        await this.enqueueWrite(() => writeFile(this.filePath, this.mapToJSON(this.data), "utf-8"));
    }
}
