import { mock, test } from "node:test";
import assert from "node:assert/strict";
import Raw, { patchNodeHeartbeat, SESSION_RESUME_TIMEOUT_S, STATS_WATCHDOG_MS } from "./Raw";

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

/** Node stand-in with lavalink-client's close() on the prototype, like the real class. */
function heartbeatNode() {
    const protoCloses: { code: number; reason?: string }[] = [];
    const socket = { terminated: 0, terminate() { this.terminated++; } };
    class FakeNode {
        nodeType = "Lavalink";
        socket: typeof socket | null = socket;
        isAlive = true;
        pingTimeout: ReturnType<typeof setTimeout> | null = null;
        resetAckTimeouts(_heartbeat = true, ping = true) {
            if (ping && this.pingTimeout) clearTimeout(this.pingTimeout);
            if (ping) this.pingTimeout = null;
        }
        close(code: number, reason?: string) {
            protoCloses.push({ code, reason });
            return Promise.resolve();
        }
    }
    const node = new FakeNode();
    patchNodeHeartbeat(node as any);
    return { node: node as any, socket, protoCloses };
}

test("ping timeout terminates the socket instead of detaching it", async () => {
    const { node, socket, protoCloses } = heartbeatNode();
    await node.close(500, "Node-Heartbeat-Timeout");
    assert.equal(socket.terminated, 1);
    assert.equal(node.isAlive, false);
    assert.deepEqual(protoCloses, []);
});

test("socket close events still run lavalink-client's close", async () => {
    const { node, socket, protoCloses } = heartbeatNode();
    await node.close(1006, undefined);
    assert.equal(socket.terminated, 0);
    assert.deepEqual(protoCloses, [{ code: 1006, reason: undefined }]);
});

test("stats watchdog tolerates late stats and terminates only after STATS_WATCHDOG_MS", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const { node, socket } = heartbeatNode();
        node.heartBeat();
        mock.timers.tick(65e3 + 5e3); // old lavalink-client limit plus a 5s hiccup
        assert.equal(socket.terminated, 0);
        node.heartBeat(); // the late stats arrives and re-arms the watchdog
        mock.timers.tick(STATS_WATCHDOG_MS - 1);
        assert.equal(socket.terminated, 0);
        mock.timers.tick(1);
        assert.equal(socket.terminated, 1);
    } finally {
        mock.timers.reset();
    }
});

test("hot reload replaces the overrides instead of stacking them", async () => {
    const { node, socket } = heartbeatNode();
    patchNodeHeartbeat(node);
    await node.close(500, "Node-Heartbeat-Timeout");
    assert.equal(socket.terminated, 1);
});

test("loading re-arms a stats watchdog armed before the hot reload", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const { node, socket } = heartbeatNode();
        Object.assign(node, { connected: true, sessionId: "live", options: { enablePingOnStatsCheck: true } });
        node.pingTimeout = setTimeout(() => socket.terminate(), 65e3); // lavalink-client's own watchdog
        new Raw(fakeClient([node]), "Raw.js");
        mock.timers.tick(65e3 + 5e3);
        assert.equal(socket.terminated, 0);
    } finally {
        mock.timers.reset();
    }
});

test("loading arms no watchdog when enablePingOnStatsCheck is off", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const { node, socket } = heartbeatNode();
        Object.assign(node, { connected: true, sessionId: "live", options: { enablePingOnStatsCheck: false } });
        new Raw(fakeClient([node]), "Raw.js");
        mock.timers.tick(STATS_WATCHDOG_MS + 1);
        assert.equal(socket.terminated, 0);
    } finally {
        mock.timers.reset();
    }
});
