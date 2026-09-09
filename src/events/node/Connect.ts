import type { LavalinkNode, LavalinkPlayer, LavalinkTrack, PlayerJson } from 'lavalink-client';
import { Event, type Lavamusic } from '../../structures/index';
import { sendLog } from '../../utils/BotLog';
import { sessionMap, updateSession, voiceChannelMap } from '../..';
import { TextBasedChannel, VoiceBasedChannel } from 'discord.js';

export default class Connect extends Event {
	// Track resume per node to avoid cross-node interference
	private resumedNodes = new Set<string>();
	// Track guilds already reconnected by 247 logic so fallback skips them
	private reconnected247Guilds = new Set<string>();

	constructor(client: Lavamusic, file: string) {
		super(client, file, {
			name: 'connect',
		});

		this.resume();
	}

	public async run(node: LavalinkNode): Promise<void> {
		this.client.logger.success(`Node ${node.id} is ready!`);

		const interval = setInterval(async () => {
			await node.updateSession(true, 15 * 60e3); // 15 minutes
		}, 10 * 60e3);

		updateSession.set(`${node.id}-${this.client.childEnv.clientId}`, interval);

		// Lavalink-only restart: the bot stayed up, so its players are still in memory
		// but stranded on the now-dead session. Recover them immediately on the fresh
		// session (deterministic check against fetchAllPlayers — no 7s fallback wait).
		// No-op on first boot / full bot restart (no in-memory players yet).
		await this.reestablishGhostPlayers(node);

		let data = await this.client.db.get_247(this.client.childEnv.clientId);
		if (!data) {
			sendLog(this.client, `Node ${node.id} is ready!`, 'success');
			this.scheduleResumeFallback(node);
			return;
		}

		if (!Array.isArray(data)) {
			data = [data];
		}

		// Wait for all 247 reconnections to complete before scheduling fallback
		const reconnectPromises: Promise<void>[] = [];

		for (const main of data as { guildId: string; textId: string; botClientId: string; voiceId: string }[]) {
			if (this.client.childEnv.clientId !== main.botClientId) continue;

			reconnectPromises.push((async () => {
				const guild = this.client.guilds.cache.get(main.guildId);
				if (!guild) return;

				const channel = guild.channels.cache.get(main.textId) as TextBasedChannel | undefined;
				const vc = guild.channels.cache.get(main.voiceId) as VoiceBasedChannel | undefined;

				if (channel && vc) {
					try {
						const player = this.client.manager.createPlayer({
							guildId: guild.id,
							voiceChannelId: vc.id,
							textChannelId: channel.id,
							selfDeaf: true,
							selfMute: false,
							customData: {
								botClientId: main.botClientId
							}
						});
						if (!player.connected) await player.connect();
						player.set('autoplay', true);

						// Restore queue from playerData if available (don't let empty 247 player overwrite saved state).
						// Skip when a track is already playing: the "resumed" handler adopted the live Lavalink
						// session, so re-restoring here would duplicate the queue and restart the track from 0.
						const savedData = this.client.playerSaver?.getPlayer(guild.id);
						if (savedData && !player.queue.current && !player.playing &&
							(savedData.queue?.current || (savedData.queue?.tracks?.length ?? 0) > 0)) {
							this.client.logger.info(`[247 RESTORE] Restoring queue for guild ${guild.id} from saved playerData`);
							player.setRepeatMode(savedData.repeatMode);
							if (savedData.data?.['autoplay'] === 'true') player.set('autoplay', true);
							if (savedData.data?.['summonUserId']) player.set('summonUserId', savedData.data['summonUserId']);
							if (savedData.data?.['messageId']) player.set('messageId', savedData.data['messageId']);
							if (savedData.filters) player.filterManager.data = savedData.filters;

							this.restoreQueueState(player, null, savedData);

							if (!player.paused && player.queue.current) {
								await player.play({ clientTrack: player.queue.current, position: savedData.lastPosition ?? 0 });
							}
						}

						// Save player session
						if (!sessionMap.has(player.guildId)) sessionMap.set(player.guildId, new Map());
						sessionMap.get(player.guildId)!.set(player.voiceChannelId!, player);

						// Mark this guild as handled by 247 so fallback skips it
						this.reconnected247Guilds.add(guild.id);
					} catch (error) {
						this.client.logger.error(`Failed to create queue for guild ${guild.id}: ${error}`);
						try {
							await this.client.db.delete_247(guild.id, this.client.childEnv.clientId);
							this.client.logger.info(`Disabled 247 mode for guild ${guild.id} due to connection failure`);
						} catch (dbError) {
							this.client.logger.error(`Failed to disable 247 mode for guild ${guild.id}:`, dbError);
						}
					}
				} else {
					this.client.logger.warn(
						`Missing channels for guild ${guild.id}. Text channel: ${main.textId}, Voice channel: ${main.voiceId}`,
					);
					try {
						await this.client.db.delete_247(guild.id, this.client.childEnv.clientId);
						this.client.logger.info(`Cleaned up invalid 247 mode data for guild ${guild.id}`);
					} catch (error) {
						this.client.logger.error(`Failed to clean up 247 mode data for guild ${guild.id}:`, error);
					}
				}
			})());
		}

		// Wait for 247 reconnections, then schedule fallback
		await Promise.allSettled(reconnectPromises);

		sendLog(this.client, `Node ${node.id} is ready!`, 'success');

		this.scheduleResumeFallback(node);
	}

	private scheduleResumeFallback(node: LavalinkNode): void {
		setTimeout(async () => {
			if (!this.resumedNodes.has(node.id!)) {
				this.client.logger.warn(`[RESUME FALLBACK] Resume event did not fire for node ${node.id}, handling manually.`);
				await this.handleResumeFallback(node);
			}
		}, 7000);
	}

	private async resume(): Promise<void> {
		this.client.manager.nodeManager.on("resumed", async (node, _payload, fetchedPlayers) => {
			this.resumedNodes.add(node.id);
			this.client.logger.info(`Node ${node.id} is resuming players`);

			// Ensure player data is fully loaded before resuming
			await this.client.playerSaver?.ensureLoaded();

			// create players:
			for (const fetchedPlayer of (fetchedPlayers as LavalinkPlayer[])) {
				// fetchedPlayer is the live data from lavalink
				const savedPlayerData = this.client.playerSaver?.getPlayer(fetchedPlayer.guildId);
				const is247 = await this.client.db.get_247(this.client.childEnv.clientId, fetchedPlayer.guildId);
				if (!savedPlayerData) continue;

				// if lavalink says the bot got disconnected, we can skip the resuming, or force reconnect whatever you want!, here we choose to not do anything and thus delete the saved player data
				if (!fetchedPlayer.state.connected && !this.client.channels.cache.has(savedPlayerData.voiceChannelId) && !is247) {
					this.client.logger.info(`Node ${node.id} is skipping resuming player, because it already disconnected`);
					await this.client.playerSaver?.delPlayer(fetchedPlayer.guildId);
					continue;
				}

				// now you can create the player based on the live and saved data
				const player = this.client.manager.createPlayer({
					guildId: fetchedPlayer.guildId,
					voiceChannelId: savedPlayerData.voiceChannelId,
					textChannelId: savedPlayerData.textChannelId,
					node: node.id,
					// you need to update the volume of the player by the volume of lavalink which might got decremented by the volume decrementer
					volume: this.client.manager.options.playerOptions?.volumeDecrementer
						? Math.round(fetchedPlayer.volume / this.client.manager.options.playerOptions.volumeDecrementer)
						: fetchedPlayer.volume,
					// all of the following options can either be saved too, or you can use pre-defined defaults
					selfDeaf: true,
					selfMute: false,
					applyVolumeAsFilter: savedPlayerData.options.applyVolumeAsFilter,
					instaUpdateFiltersFix: savedPlayerData.options.instaUpdateFiltersFix,
					vcRegion: savedPlayerData.options.vcRegion,
				});

				// normally just player.voice is enough, but if you restart the entire bot, you need to create a new connection, thus call player.connect();
				await player.connect();

				player.setRepeatMode(savedPlayerData.repeatMode);
				player.set('autoplay', savedPlayerData.data?.['autoplay'] === 'true' ? true : false);
				player.set('summonUserId', savedPlayerData.data?.['summonUserId']);
				// Restore the now-playing embed reference so TrackEnd/QueueEnd can clean it
				// up instead of leaving an orphaned message and posting a duplicate.
				if (savedPlayerData.data?.['messageId']) player.set('messageId', savedPlayerData.data['messageId']);

				// Initialize maps if they don't exist
				if (!sessionMap.has(player.guildId)) sessionMap.set(player.guildId, new Map());
				if (!voiceChannelMap.has(player.guildId)) voiceChannelMap.set(player.guildId, new Map());

				sessionMap.get(player.guildId)!.set(player.voiceChannelId!, player);
				voiceChannelMap.get(player.guildId)!.set(player.voiceChannelId!, this.client.childEnv.clientId);

				player.filterManager.data = fetchedPlayer.filters; // override the filters data

				// Restore the queue from the persistent queue store (current + tracks +
				// previous + requesters). Falls back to reconstructing from playerData /
				// live Lavalink state if the store is empty or unreadable.
				await this.client.manager.queueStore.ensureLoaded();
				try {
					await player.queue.utils.sync(true, false);
				} catch {
					this.restoreQueueState(player, fetchedPlayer, savedPlayerData);
				}
				// The live Lavalink track is the source of truth for what is actually
				// streaming; align current so position adoption below is correct.
				if (fetchedPlayer.track) {
					player.queue.current = this.client.manager.utils.buildTrack(fetchedPlayer.track, player.queue.current?.requester ?? this.client.user);
				}

				// you can also override the ping of the player, or wait about 30s till it's done automatically
				player.ping.lavalink = fetchedPlayer.state.ping;
				player.paused = fetchedPlayer.paused;

				if (fetchedPlayer.track) {
					// Lavalink is still streaming this track (bot-only restart): adopt its live
					// position. Calling play() here would replace the track and restart from 0.
					player.lastPosition = fetchedPlayer.state.position;
					player.lastPositionChange = Date.now();
					this.client.logger.info(`Node ${node.id} adopted live playback for guild ${fetchedPlayer.guildId} at ${fetchedPlayer.state.position}ms`);
				} else if (!player.paused && player.queue.current) {
					// Nothing playing on Lavalink but we have a restored queue — start it.
					await player.play({ clientTrack: player.queue.current, position: savedPlayerData.lastPosition ?? 0 });
					this.client.logger.info(`Node ${node.id} restarted playback for guild ${fetchedPlayer.guildId}`);
				}
			}

			this.client.logger.info(`Node ${node.id} has resumed all players`);
		})
	}

	/**
	 * Restore player.queue.current and player.queue.tracks from persisted data.
	 * The in-memory queue store is empty after a restart, so this is the reliable
	 * source. Prefers the live Lavalink track for the current entry (so position
	 * adoption matches what is actually streaming), falling back to saved data.
	 */
	private restoreQueueState(player: any, fetchedPlayer: LavalinkPlayer | null, savedPlayerData: PlayerJson): void {
		const utils = this.client.manager.utils;
		const fallbackRequester = this.client.user;

		const savedCurrent = savedPlayerData.queue?.current;
		if (fetchedPlayer?.track) {
			player.queue.current = utils.buildTrack(fetchedPlayer.track, (savedCurrent as any)?.requester ?? fallbackRequester);
		} else if (savedCurrent) {
			player.queue.current = utils.buildTrack(savedCurrent as unknown as LavalinkTrack, (savedCurrent as any).requester ?? fallbackRequester);
		}

		const savedTracks = savedPlayerData.queue?.tracks ?? [];
		if (savedTracks.length > 0) {
			player.queue.tracks.splice(
				0,
				player.queue.tracks.length,
				...savedTracks.map((track) => utils.buildTrack(track as unknown as LavalinkTrack, (track as any).requester ?? fallbackRequester)),
			);
		}

		const savedPrevious = savedPlayerData.queue?.previous ?? [];
		if (savedPrevious.length > 0) {
			player.queue.previous.splice(
				0,
				player.queue.previous.length,
				...savedPrevious.map((track) => utils.buildTrack(track as unknown as LavalinkTrack, (track as any).requester ?? fallbackRequester)),
			);
		}
	}

	/** Poll until the node has a sessionId from its `ready` handshake (REST calls need it). */
	private async waitForSession(node: LavalinkNode, timeoutMs = 5000): Promise<boolean> {
		const start = Date.now();
		while (!node.sessionId && Date.now() - start < timeoutMs) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return !!node.sessionId;
	}

	/**
	 * Recover players when Lavalink itself restarted while the bot process stayed up.
	 *
	 * Lavalink comes back with a fresh, empty session, so it sends `ready` with
	 * `resumed=false` and the "resumed" event never fires. The bot's Player objects
	 * still live in memory, but on Lavalink's side the session, player and voice
	 * connection are gone — they are "ghosts": position free-runs on the wall clock,
	 * no audio, and skip/stop hang because Lavalink has nothing to act on.
	 *
	 * Re-send the cached Discord voice data (still valid across a quick restart, since
	 * Discord holds the bot's voice slot) plus the current track and position to the
	 * new session in one updatePlayer, so Lavalink reconnects to voice and resumes
	 * without dropping the bot from the channel.
	 */
	private async reestablishGhostPlayers(node: LavalinkNode): Promise<void> {
		// Only relevant when the bot already holds players in memory (Lavalink-only
		// restart). On first boot / full bot restart there are none yet.
		const mine = [...this.client.manager.players.values()].filter(p => p.node?.id === node.id);
		if (mine.length === 0) return;

		// Ask the fresh session what it actually has. If it returns our players, it
		// genuinely resumed and they are live — not ghosts. Any in-memory player the
		// session does NOT know about was stranded by a Lavalink restart.
		if (!(await this.waitForSession(node))) return;
		let liveGuilds: Set<string>;
		try {
			const live = await node.fetchAllPlayers();
			liveGuilds = new Set((live as LavalinkPlayer[]).map(p => p.guildId));
		} catch (error) {
			this.client.logger.warn(`[LAVALINK RESUME] Could not fetch live players on node ${node.id}, skipping ghost recovery:`, error);
			return;
		}

		for (const player of mine) {
			if (liveGuilds.has(player.guildId)) continue;
			const current = player.queue.current;
			if (!current?.encoded) continue;

			const guildId = player.guildId;
			try {
				const duration = current.info?.duration ?? 0;
				const position = current.info?.isStream || duration <= 0
					? 0
					: Math.min(Math.max(player.position, 0), duration);

				const v = player.voice;
				const hasVoice = !!(v?.token && v?.endpoint && v?.sessionId);
				if (!hasVoice) {
					// No cached voice server data — force Discord to re-issue it so the
					// lavalink-client voice handler can forward it to the new session.
					if (!player.connected) await player.connect();
				}

				await player.play({
					clientTrack: current,
					position,
					paused: player.paused,
					...(hasVoice ? { voice: { token: v.token!, endpoint: v.endpoint!, sessionId: v.sessionId! } } : {}),
				});

				this.client.logger.info(
					`[LAVALINK RESUME] Re-established ghost player for guild ${guildId} at ${position}ms on node ${node.id} (voice=${hasVoice ? 'cached' : 'renegotiated'})`,
				);
			} catch (error) {
				this.client.logger.error(`[LAVALINK RESUME] Failed to re-establish player for guild ${guildId}:`, error);
			}
		}
	}

	private async handleResumeFallback(node: LavalinkNode): Promise<void> {
		// Fallback logic if "resumed" event never fired (e.g. Lavalink also restarted)
		this.client.logger.info(`[RESUME FALLBACK] Node ${node.id} - restoring from saved playerData`);

		// Ensure player data is fully loaded before fallback resume
		await this.client.playerSaver?.ensureLoaded();

		// Use playerData (per-bot file) as the primary source — it's more reliable than sessionMap
		// sessionMap entries may have been overwritten by 247 reconnection with empty players
		const playerDataMap = this.client.playerSaver?.data;
		if (!playerDataMap || playerDataMap.size === 0) {
			this.client.logger.info(`[RESUME FALLBACK] No saved player data found for ${this.client.childEnv.name}`);
			return;
		}

		let restoredCount = 0;
		let skippedCount = 0;

		for (const [guildId, rawData] of playerDataMap.entries()) {
			try {
				// Skip guilds already reconnected by 247 logic
				if (this.reconnected247Guilds.has(guildId)) {
					this.client.logger.info(`[RESUME FALLBACK] Skipping guild ${guildId} - already handled by 247 reconnection`);
					skippedCount++;
					continue;
				}

				let playerData: PlayerJson;
				try {
					playerData = JSON.parse(rawData) as PlayerJson;
				} catch {
					this.client.logger.warn(`[RESUME FALLBACK] Failed to parse player data for guild ${guildId}, skipping`);
					continue;
				}

				// Skip if this player data doesn't belong to this bot
				if (playerData.options?.customData?.botClientId &&
					playerData.options.customData.botClientId !== this.client.childEnv.clientId) {
					continue;
				}

				// Skip if essential channel info is missing
				if (!playerData.voiceChannelId || !playerData.textChannelId) {
					this.client.logger.warn(`[RESUME FALLBACK] Missing channel info for guild ${guildId}, skipping`);
					continue;
				}

				// Check if voice channel is accessible
				const voiceChannel = this.client.channels.cache.get(playerData.voiceChannelId) as VoiceBasedChannel | undefined;
				if (!voiceChannel) {
					// Channel not in cache - check if it's a 247 guild before skipping
					const is247 = await this.client.db.get_247(this.client.childEnv.clientId, guildId);
					if (!is247) {
						this.client.logger.info(`[RESUME FALLBACK] Voice channel ${playerData.voiceChannelId} not accessible for guild ${guildId}, skipping`);
						await this.client.playerSaver?.delPlayer(guildId);
						continue;
					}
					// For 247 guilds, try to fetch the channel
					try {
						await this.client.channels.fetch(playerData.voiceChannelId);
					} catch {
						this.client.logger.warn(`[RESUME FALLBACK] Could not fetch voice channel ${playerData.voiceChannelId} for 247 guild ${guildId}`);
						continue;
					}
				}

				// Check if bot is already connected (another player may already exist)
				const existingPlayer = this.client.manager.getPlayer(guildId);
				if (existingPlayer) {
					this.client.logger.info(`[RESUME FALLBACK] Player already exists for guild ${guildId}, skipping`);
					skippedCount++;
					continue;
				}

				// Create and restore the player
				const player = this.client.manager.createPlayer({
					guildId: guildId,
					voiceChannelId: playerData.voiceChannelId,
					textChannelId: playerData.textChannelId,
					node: node.id,
					volume: this.client.manager.options.playerOptions?.volumeDecrementer
						? Math.round(playerData.volume / this.client.manager.options.playerOptions.volumeDecrementer)
						: playerData.volume,
					selfDeaf: true,
					selfMute: false,
					applyVolumeAsFilter: playerData.options?.applyVolumeAsFilter,
					instaUpdateFiltersFix: playerData.options?.instaUpdateFiltersFix,
					vcRegion: playerData.options?.vcRegion,
				});

				await player.connect();

				player.setRepeatMode(playerData.repeatMode);
				player.set('autoplay', playerData.data?.['autoplay'] === 'true' ? true : false);
				player.set('summonUserId', playerData.data?.['summonUserId']);
				// Restore the now-playing embed reference so cleanup works and no duplicate is posted.
				if (playerData.data?.['messageId']) player.set('messageId', playerData.data['messageId']);

				// Initialize maps
				if (!sessionMap.has(player.guildId)) sessionMap.set(player.guildId, new Map());
				if (!voiceChannelMap.has(player.guildId)) voiceChannelMap.set(player.guildId, new Map());

				sessionMap.get(player.guildId)!.set(player.voiceChannelId!, player);
				voiceChannelMap.get(player.guildId)!.set(player.voiceChannelId!, this.client.childEnv.clientId);

				// Restore filters
				if (playerData.filters) player.filterManager.data = playerData.filters;

				// Lavalink also restarted here (resumed never fired), so nothing is streaming.
				// Restore the queue from the persistent store, falling back to playerData.
				await this.client.manager.queueStore.ensureLoaded();
				try {
					await player.queue.utils.sync(true, false);
				} catch {
					this.restoreQueueState(player, null, playerData);
				}

				player.ping.lavalink = playerData.ping?.lavalink ?? 0;
				player.paused = playerData.paused;

				if (!player.paused && player.queue.current) {
					await player.play({ clientTrack: player.queue.current, position: playerData.lastPosition ?? 0 });
					this.client.logger.info(`[RESUME FALLBACK] Resumed playback for guild ${guildId} (${player.queue.tracks.length} tracks queued)`);
				}

				restoredCount++;
			} catch (error) {
				this.client.logger.error(`[RESUME FALLBACK] Failed to restore player for guild ${guildId}:`, error);
			}
		}

		this.client.logger.info(`[RESUME FALLBACK] Node ${node.id} - restored ${restoredCount} players, skipped ${skippedCount}`);
	}
}


