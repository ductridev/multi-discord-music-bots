import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Redis, RedisOptions } from "ioredis";
import { JSONStore, type RedisStoreOptions } from "./JSONStore";

/**
 * Minimal in-memory Redis stand-in covering only the commands JSONStore uses.
 * `down` makes set/del reject so the file-fallback + dirty-replay paths can be
 * exercised without a real server.
 */
class FakeRedis extends EventEmitter {
    public store = new Map<string, string>();
    public down = false;
    /** Namespaced keys whose set/del should reject, independent of `down`. */
    public failKeys = new Set<string>();

    constructor(seed?: Record<string, string>) {
        super();
        if (seed) for (const [k, v] of Object.entries(seed)) this.store.set(k, v);
    }

    async connect(): Promise<void> {
        queueMicrotask(() => this.emit("ready"));
    }
    async scan(_cursor: string, _m: string, match: string): Promise<[string, string[]]> {
        const prefix = match.slice(0, -1); // strip trailing "*"
        const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
        return ["0", keys];
    }
    async mget(keys: string[]): Promise<(string | null)[]> {
        return keys.map((k) => this.store.get(k) ?? null);
    }
    async set(key: string, value: string): Promise<string> {
        if (this.down || this.failKeys.has(key)) throw new Error("redis down");
        this.store.set(key, value);
        return "OK";
    }
    async del(key: string): Promise<number> {
        if (this.down || this.failKeys.has(key)) throw new Error("redis down");
        return this.store.delete(key) ? 1 : 0;
    }
    disconnect(): void {}
}

// makeRedisClient runs inside super(), before subclass fields exist, so the
// fake is handed over through a module-level slot.
let nextFake: FakeRedis;
class TestStore extends JSONStore {
    declare public fake: FakeRedis;
    protected makeRedisClient(_url: string, _options: RedisOptions): Redis {
        this.fake = nextFake;
        return nextFake as unknown as Redis;
    }
}

const PREFIX = "test:";
function opts(): RedisStoreOptions {
    return { url: "redis://fake", keyPrefix: PREFIX, ttlSeconds: 100 };
}
function tempFile(seed?: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "jsonstore-"));
    const file = join(dir, "playerData.json");
    if (seed) writeFileSync(file, JSON.stringify(seed), "utf-8");
    return file;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test("first-boot migration seeds an empty Redis from the file and retires it", async () => {
    nextFake = new FakeRedis();
    const file = tempFile({ g1: "v1", g2: "v2" });
    const store = new TestStore(file, opts());
    await store.ensureLoaded();

    assert.equal(store.get("g1"), "v1");
    assert.equal(store.fake.store.get("test:g1"), "v1");
    assert.equal(store.fake.store.get("test:g2"), "v2");
    assert.ok(!existsSync(file), "original file retired");
    assert.ok(existsSync(`${file}.bak`), ".bak written");
    rmSync(`${file}.bak`, { force: true });
});

test("Redis stays authoritative: file never overwrites a key Redis already has", async () => {
    nextFake = new FakeRedis({ "test:g1": "redisVal" });
    const file = tempFile({ g1: "fileVal", g2: "onlyInFile" });
    const store = new TestStore(file, opts());
    await store.ensureLoaded();

    assert.equal(store.get("g1"), "redisVal", "Redis value wins");
    assert.equal(store.get("g2"), "onlyInFile", "file-only key migrated in");
    rmSync(`${file}.bak`, { force: true });
});

test("set persists to Redis and mirror", async () => {
    nextFake = new FakeRedis();
    const store = new TestStore(tempFile(), opts());
    await store.ensureLoaded();

    await store.set("g3", "v3");
    assert.equal(store.get("g3"), "v3");
    assert.equal(store.fake.store.get("test:g3"), "v3");
});

test("set falls back to file and replays to Redis on reconnect (dirty flush)", async () => {
    nextFake = new FakeRedis();
    const store = new TestStore(tempFile(), opts());
    await store.ensureLoaded();

    store.fake.down = true;
    await store.set("g4", "v4"); // resolves via file fallback
    assert.equal(store.get("g4"), "v4", "mirror committed");
    assert.ok(!store.fake.store.has("test:g4"), "not in Redis while down");

    store.fake.down = false;
    store.fake.emit("ready");
    await tick();
    assert.equal(store.fake.store.get("test:g4"), "v4", "replayed on ready");
});

test("delete during outage is replayed as DEL on reconnect", async () => {
    nextFake = new FakeRedis();
    const store = new TestStore(tempFile(), opts());
    await store.ensureLoaded();
    await store.set("g5", "v5");
    assert.equal(store.fake.store.get("test:g5"), "v5");

    store.fake.down = true;
    await store.delete("g5"); // file fallback, Redis still holds it
    assert.equal(store.get("g5"), undefined, "mirror deleted");
    assert.ok(store.fake.store.has("test:g5"), "still in Redis while down");

    store.fake.down = false;
    store.fake.emit("ready");
    await tick();
    assert.ok(!store.fake.store.has("test:g5"), "DEL replayed on ready");
});

test("migration preserves a failed write and the remaining entries for later flush", async () => {
    nextFake = new FakeRedis();
    nextFake.failKeys.add("test:g2"); // second entry fails mid-migration
    const file = tempFile({ g1: "v1", g2: "v2", g3: "v3" });
    const store = new TestStore(file, opts());
    await store.ensureLoaded();

    assert.equal(store.fake.store.get("test:g1"), "v1", "first entry migrated");
    assert.ok(!store.fake.store.has("test:g2"), "failed entry not in Redis");
    assert.ok(!store.fake.store.has("test:g3"), "remaining entry held back");
    assert.equal(store.get("g2"), "v2", "failed entry kept in mirror");
    assert.equal(store.get("g3"), "v3", "remaining entry kept in mirror");
    assert.ok(existsSync(file), "file not retired after a failed migration");

    store.fake.failKeys.clear();
    store.fake.emit("ready");
    await tick();
    assert.equal(store.fake.store.get("test:g2"), "v2", "failed entry replayed on reconnect");
    assert.equal(store.fake.store.get("test:g3"), "v3", "remaining entry replayed on reconnect");
    rmSync(file, { force: true });
    rmSync(`${file}.bak`, { force: true });
});

test("overlapping fallback writes both persist and replay (no clobber)", async () => {
    nextFake = new FakeRedis();
    const file = tempFile();
    const store = new TestStore(file, opts());
    await store.ensureLoaded();

    store.fake.down = true;
    await Promise.all([store.set("a", "1"), store.set("b", "2")]);
    assert.equal(store.get("a"), "1");
    assert.equal(store.get("b"), "2");
    // both diverged keys survive — not just the last writer
    assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { a: "1", b: "2" });

    store.fake.down = false;
    store.fake.emit("ready");
    await tick();
    assert.equal(store.fake.store.get("test:a"), "1");
    assert.equal(store.fake.store.get("test:b"), "2");
    assert.ok(!existsSync(file), "fallback file cleared after re-converge");
});

test("fallback stores only diverged keys, so an expired key isn't resurrected", async () => {
    nextFake = new FakeRedis();
    const file = tempFile();
    const store = new TestStore(file, opts());
    await store.ensureLoaded();

    await store.set("keep", "v"); // lands in Redis, never diverges
    assert.equal(store.fake.store.get("test:keep"), "v");

    store.fake.down = true;
    await store.set("new", "n"); // falls back to file
    assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { new: "n" }, "only the diverged key persisted");

    store.fake.store.delete("test:keep"); // 'keep' expires in Redis during the outage

    store.fake.down = false;
    store.fake.emit("ready");
    await tick();
    assert.equal(store.fake.store.get("test:new"), "n", "diverged key replayed");
    assert.ok(!store.fake.store.has("test:keep"), "expired key not resurrected with a fresh TTL");
});
