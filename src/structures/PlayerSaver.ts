import { PlayerJson } from "lavalink-client";
import { JSONStore } from "./JSONStore";
import { env } from "../env";

export class PlayerSaver extends JSONStore {
    constructor(name: string) {
        super(
            `${process.cwd()}/playerData-${name}.json`,
            env.REDIS_URL
                ? {
                    url: env.REDIS_URL,
                    keyPrefix: `playerdata:${name}:`,
                    ttlSeconds: env.PLAYER_SESSION_TTL,
                }
                : undefined,
        );
    }

    /**
     * Ensure player data is loaded from disk before accessing
     */
    public async ensureLoaded(): Promise<void> {
        await super.ensureLoaded();
    }

    /**
     * Retrieve last saved session IDs: nodeId → nodeSessionId.
     */
    public getAllLastNodeSessions(): Map<string, string> {
        try {
            const datas = Array.from(this.data.values());
            const sessionIds = new Map<string, string>();

            for (const theData of datas) {
                const json = JSON.parse(theData) as PlayerJson;
                if (json.nodeSessionId && json.nodeId) {
                    sessionIds.set(json.nodeId, json.nodeSessionId);
                }
            }

            return sessionIds;
        } catch {
            return new Map<string, string>();
        }
    }

    /**
     * Get saved player data for a guild.
     * @param guildId - ID of the guild
     */
    public getPlayer(guildId: string): PlayerJson | null {
        const data = this.get(guildId);
        return data ? (JSON.parse(data) as PlayerJson) : null;
    }

    /**
     * Delete saved player data for a guild.
     * @param guildId - ID of the guild
     */
    public async delPlayer(guildId: string): Promise<void> {
        await this.delete(guildId);
    }
}
