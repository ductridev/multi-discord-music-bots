import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteNowPlayingMessage } from "./NowPlayingMessage";

function fakes(opts: { messageId?: string; exists?: boolean; deletable?: boolean } = {}) {
    const deleted: string[] = [];
    const data = new Map<string, unknown>([["messageId", opts.messageId]]);
    const player = {
        textChannelId: "text-1",
        get: (k: string) => data.get(k),
        set: (k: string, v: unknown) => data.set(k, v),
    };
    const channel = {
        messages: {
            fetch: async (id: string) => {
                if (opts.exists === false) throw new Error("Unknown Message");
                return { deletable: opts.deletable ?? true, delete: async () => { deleted.push(id); } };
            },
        },
    };
    const guild = { channels: { cache: new Map([["text-1", channel]]) } };
    return { guild: guild as any, player: player as any, data, deleted };
}

test("deletes the now-playing embed and forgets its id", async () => {
    const { guild, player, data, deleted } = fakes({ messageId: "m1" });
    await deleteNowPlayingMessage(guild, player);
    assert.deepEqual(deleted, ["m1"]);
    assert.equal(data.get("messageId"), undefined);
});

test("an already-deleted message only clears the id", async () => {
    const { guild, player, data, deleted } = fakes({ messageId: "m1", exists: false });
    await deleteNowPlayingMessage(guild, player);
    assert.deepEqual(deleted, []);
    assert.equal(data.get("messageId"), undefined);
});

test("no tracked message is a no-op", async () => {
    const { guild, player, deleted } = fakes();
    await deleteNowPlayingMessage(guild, player);
    assert.deepEqual(deleted, []);
});
