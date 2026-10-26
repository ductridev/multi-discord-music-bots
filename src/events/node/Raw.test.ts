import { test } from "node:test";
import assert from "node:assert/strict";
import Raw, { SESSION_RESUME_TIMEOUT_S } from "./Raw";

/** Node stand-in: records updateSession calls and the session id they targeted. */
function fakeNode(opts: { connected?: boolean; sessionId?: string | null; optionsSessionId?: string } = {}) {
    const calls: { resuming: boolean; timeout: number; sessionId: string | null | undefined }[] = [];
    const node = {
        id: "node-a",
        connected: opts.connected ?? true,
        sessionId: opts.sessionId ?? null,
        options: { sessionId: opts.optionsSessionId } as { sessionId?: string },
        async updateSession(resuming: boolean, timeout: number) {
            calls.push({ resuming, timeout, sessionId: node.sessionId });
            return null;
        },
    };
    return { node, calls };
}

function fakeClient(nodes: unknown[] = []) {
    return {
        manager: { nodeManager: { nodes: new Map(nodes.map((n, i) => [String(i), n])) } },
        logger: { warn() {} },
    } as any;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("ready pins the live session id and enables resuming on that session", async () => {
    const { node, calls } = fakeNode({ sessionId: "stale-boot-id", optionsSessionId: "stale-boot-id" });
    const raw = new Raw(fakeClient(), "Raw.js");

    await raw.run(node as any, { op: "ready", sessionId: "live-id" });
    assert.equal(node.options.sessionId, "live-id");
    assert.equal(calls.length, 0, "updateSession must wait until the node applied the ready payload");

    node.sessionId = "live-id"; // what lavalink-client does right after emitting 'raw'
    await tick();
    assert.deepEqual(calls, [{ resuming: true, timeout: SESSION_RESUME_TIMEOUT_S, sessionId: "live-id" }]);
});

test("non-ready payloads are ignored", async () => {
    const { node, calls } = fakeNode({ optionsSessionId: "boot-id" });
    const raw = new Raw(fakeClient(), "Raw.js");

    await raw.run(node as any, { op: "stats" });
    await raw.run(node as any, { op: "ready" });
    await tick();
    assert.equal(node.options.sessionId, "boot-id");
    assert.equal(calls.length, 0);
});

test("loading pins sessions of nodes that are already connected (hot reload)", () => {
    const up = fakeNode({ connected: true, sessionId: "live-up", optionsSessionId: "boot-up" }).node;
    const down = fakeNode({ connected: false, sessionId: "old-down", optionsSessionId: "boot-down" }).node;
    new Raw(fakeClient([up, down]), "Raw.js");

    assert.equal(up.options.sessionId, "live-up");
    assert.equal(down.options.sessionId, "boot-down");
});
