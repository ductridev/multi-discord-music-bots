import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	ComponentType,
	EmbedBuilder,
	type Message,
} from 'discord.js';
import type { Player, LyricsResult } from 'lavalink-client';
import type Lavamusic from '../structures/Lavamusic';
import AsyncLock from '../structures/AsyncLock.js';
import { DEFAULT_LOCALE, T } from '../structures/I18n.js';

/**
 * Discord rate limit scope types
 */
type RateLimitScope = 'global' | 'user' | 'shared' | 'unknown';

/**
 * Parsed rate limit information from Discord API error
 */
interface RateLimitInfo {
	scope: RateLimitScope;
	retryAfterMs: number;
	isGlobal: boolean;
	limit?: number;
	remaining?: number;
	resetAfter?: number;
	bucket?: string;
}

/**
 * Represents a single line of synchronized lyrics
 */
export interface SyncedLyricsLine {
	timestamp: number;  // milliseconds
	duration: number;   // milliseconds
	line: string;
}

/**
 * Represents an active live lyrics session
 */
export interface LiveLyricsSession {
	guildId: string;
	textChannelId: string;
	messageId: string | null;
	intervalId: NodeJS.Timeout | null;
	lyrics: SyncedLyricsLine[];
	currentLineIndex: number;
	lastUpdateTime: number;
	trackTitle: string;
	trackAuthor: string;
	trackDuration: number;
	trackUri: string;
	artworkUrl: string | undefined;
	isPaused: boolean;
	pausedAt?: number;
	retryCount: number;
	collector: unknown | null; // Button collector reference for cleanup
	backoffUntil: number; // Timestamp when backoff period ends
	locale: string; // Guild locale for i18n
	rateLimitBucket: string | null;    // X-RateLimit-Bucket for this session's channel
	lastRateLimitScope: RateLimitScope; // Last rate limit scope encountered
}

/**
 * Configuration options for the live lyrics service
 */
interface LiveLyricsConfig {
	visibleLines: number;        // lines to show in karaoke display
	maxRetries: number;          // max retries on rate limit
	backoffMultiplier: number;   // exponential backoff multiplier
}

/**
 * Rate limiting constants for Discord API
 */
const MIN_UPDATE_INTERVAL = 200;              // Minimum 200ms between updates (safety floor)
const MAX_UPDATE_INTERVAL = 5000;             // Maximum 5 seconds (for UX when many sessions)
const GLOBAL_RATE_LIMIT = 50;                 // Discord's global rate limit: 50 requests/second
const SAFETY_BUFFER_PERCENTAGE = 0.35;        // 35% buffer for other bot operations
const MAX_LYRICS_REQUESTS_PER_SEC = GLOBAL_RATE_LIMIT * (1 - SAFETY_BUFFER_PERCENTAGE); // ~32.5 req/sec
const BURST_THRESHOLD = 5;                    // Sessions added in 5-second window triggers burst protection
const BURST_MULTIPLIER = 1.5;                 // Multiply interval by 1.5 during burst

const DEFAULT_CONFIG: LiveLyricsConfig = {
	visibleLines: 3,         // 3 lines display
	maxRetries: 3,           // max 3 retries
	backoffMultiplier: 1.5,  // 1.5x backoff
};

/**
 * Service for managing live synchronized lyrics sessions
 * Handles fetching, displaying, and updating lyrics in real-time
 */
export class LiveLyricsService {
	private client: Lavamusic;
	private sessions: Map<string, LiveLyricsSession> = new Map();
	private config: LiveLyricsConfig;
	private updateLock: AsyncLock = new AsyncLock();
	private globalIntervalId: NodeJS.Timeout | null = null;
	private recentSessionChanges: number[] = [];  // Timestamps of recent session additions

	constructor(client: Lavamusic, config: Partial<LiveLyricsConfig> = {}) {
		this.client = client;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Calculate dynamic update interval based on active session count
	 * Formula: interval = (1000 * sessionCount) / MAX_LYRICS_REQUESTS_PER_SEC
	 * This ensures we stay safely within Discord's rate limit with buffer for other operations
	 */
	private calculateDynamicInterval(): number {
		const sessionCount = this.sessions.size;
		if (sessionCount === 0) {
			return MIN_UPDATE_INTERVAL;
		}

		// Calculate base interval to stay within our allocated rate limit
		// If we have N sessions, each can update at most MAX_LYRICS_REQUESTS_PER_SEC / N times per second
		const baseInterval = (1000 * sessionCount) / MAX_LYRICS_REQUESTS_PER_SEC;

		// Apply burst protection if many sessions were added recently
		const isBurst = this.detectBurst();
		const interval = isBurst ? baseInterval * BURST_MULTIPLIER : baseInterval;

		// Clamp to min/max bounds
		return Math.min(Math.max(interval, MIN_UPDATE_INTERVAL), MAX_UPDATE_INTERVAL);
	}

	/**
	 * Detect if we're in a burst scenario (many sessions added recently)
	 */
	private detectBurst(): boolean {
		const now = Date.now();
		const fiveSecondsAgo = now - 5000;

		// Clean old entries
		this.recentSessionChanges = this.recentSessionChanges.filter(t => t > fiveSecondsAgo);

		// Check if threshold exceeded
		return this.recentSessionChanges.length >= BURST_THRESHOLD;
	}

	/**
	 * Record a session change for burst detection
	 */
	private recordSessionChange(): void {
		this.recentSessionChanges.push(Date.now());
	}

	/**
	 * Start the global update loop that iterates through all active sessions
	 */
	private startGlobalUpdateLoop(): void {
		// Don't start if already running
		if (this.globalIntervalId !== null) {
			return;
		}

		const interval = this.calculateDynamicInterval();
		this.globalIntervalId = setInterval(async () => {
			await this.updateAllSessions();
		}, interval);
	}

	/**
	 * Stop the global update loop
	 */
	private stopGlobalUpdateLoop(): void {
		if (this.globalIntervalId !== null) {
			clearInterval(this.globalIntervalId);
			this.globalIntervalId = null;
		}
	}

	/**
	 * Restart the global update loop with a new interval
	 * Called when sessions are added/removed
	 */
	private restartGlobalUpdateLoop(): void {
		this.stopGlobalUpdateLoop();
		if (this.sessions.size > 0) {
			this.startGlobalUpdateLoop();
		}
	}

	/**
	 * Update all active sessions
	 */
	private async updateAllSessions(): Promise<void> {
		const guildIds = Array.from(this.sessions.keys());
		for (const guildId of guildIds) {
			await this.updateDisplay(guildId);
		}
	}

	/**
	 * Get the guild's locale
	 */
	private async getGuildLocale(guildId: string): Promise<string> {
		try {
			const locale = await this.client.db.getLanguage(guildId);
			return locale || DEFAULT_LOCALE;
		} catch {
			return DEFAULT_LOCALE;
		}
	}

	/**
	 * Translate a key using the session's locale
	 */
	private t(session: LiveLyricsSession, key: string, ...args: any): string {
		return T(session.locale, key, ...args);
	}

	/**
	 * Check if a session exists for a guild
	 */
	public hasSession(guildId: string): boolean {
		return this.sessions.has(guildId);
	}

	/**
	 * Get a session for a guild
	 */
	public getSession(guildId: string): LiveLyricsSession | undefined {
		return this.sessions.get(guildId);
	}

	/**
	 * Start a new live lyrics session
	 */
	public async startSession(
		player: Player,
		textChannelId: string,
		lyricsResult: LyricsResult,
	): Promise<Message | null> {
		const guildId = player.guildId;

		// Stop any existing session
		if (this.sessions.has(guildId)) {
			await this.stopSession(guildId);
		}

		// Validate lyrics are synced (check for lines array with timestamps)
		if (!lyricsResult || !lyricsResult.lines?.length) {
			return null;
		}

		const track = player.queue.current;
		if (!track) return null;

		// Convert lyrics to our format, handling null duration
		const lyrics: SyncedLyricsLine[] = lyricsResult.lines
			.filter((line) => line.timestamp !== null && line.timestamp !== undefined)
			.map((line) => ({
				timestamp: line.timestamp ?? 0,
				duration: line.duration ?? 0,
				line: line.line,
			}));

		// If no synced lines, return null
		if (lyrics.length === 0) {
			return null;
		}

		// Sort lyrics by timestamp
		lyrics.sort((a, b) => a.timestamp - b.timestamp);

		// Get guild locale
		const locale = await this.getGuildLocale(guildId);

		// Create session
		const session: LiveLyricsSession = {
			guildId,
			textChannelId,
			messageId: null,
			intervalId: null,
			lyrics,
			currentLineIndex: -1,
			lastUpdateTime: 0,
			trackTitle: track.info.title,
			trackAuthor: track.info.author,
			trackDuration: track.info.duration,
			trackUri: track.info.uri,
			artworkUrl: track.info.artworkUrl ?? undefined,
			isPaused: false,
			retryCount: 0,
			collector: null,
			backoffUntil: 0,
			locale,
			rateLimitBucket: null,
			lastRateLimitScope: 'unknown',
		};

		this.sessions.set(guildId, session);

		// Record for burst detection
		this.recordSessionChange();

		// Create initial message
		const message = await this.createInitialMessage(session, player);
		if (message) {
			session.messageId = message.id;
			this.setupButtonCollector(session, message);
			// Start or restart the global update loop when adding a session
			this.restartGlobalUpdateLoop();
		}

		return message;
	}

	/**
	 * Stop a live lyrics session and delete the message
	 */
	public async stopSession(guildId: string): Promise<void> {
		const session = this.sessions.get(guildId);
		if (!session) return;

		// Stop button collector if exists
		if (session.collector && typeof session.collector === 'object' && 'stop' in session.collector) {
			(session.collector as { stop: () => void }).stop();
			session.collector = null;
		}

		// Delete session from map BEFORE any async operations
		this.sessions.delete(guildId);

		// Restart global update loop with new interval (or stop if no sessions)
		this.restartGlobalUpdateLoop();

		// Delete the message
		if (session.messageId) {
			try {
				const channel = this.client.channels.cache.get(session.textChannelId);
				if (channel?.isTextBased()) {
					const message = await channel.messages.fetch(session.messageId).catch(() => null);
					if (message && message.deletable) {
						await message.delete().catch(() => null);
					}
				}
			} catch (error) {
				this.client.logger.error('Failed to delete lyrics message:', error);
			}
		}
	}

	/**
	 * Stop all active lyrics sessions (used for hot reload)
	 */
	public async stopAllSessions(): Promise<void> {
		const guildIds = [...this.sessions.keys()];
		for (const guildId of guildIds) {
			await this.stopSession(guildId);
		}
	}

	/**
	 * Handle track end event
	 */
	public handleTrackEnd(guildId: string): void {
		if (this.sessions.has(guildId)) {
			this.stopSession(guildId);
		}
	}

	/**
	 * Handle player destroy event
	 */
	public handlePlayerDestroy(guildId: string): void {
		if (this.sessions.has(guildId)) {
			this.stopSession(guildId);
		}
	}

	/**
	 * Handle track pause event
	 */
	public handleTrackPause(guildId: string): void {
		const session = this.sessions.get(guildId);
		if (session) {
			session.isPaused = true;
			session.pausedAt = Date.now();
		}
	}

	/**
	 * Handle track resume event
	 */
	public handleTrackResume(guildId: string): void {
		const session = this.sessions.get(guildId);
		if (session) {
			session.isPaused = false;
			session.pausedAt = undefined;
		}
	}

	/**
	 * Handle seek event - update current line index
	 */
	public handleSeek(guildId: string, newPosition: number): void {
		const session = this.sessions.get(guildId);
		if (session) {
			session.currentLineIndex = this.getCurrentLineIndex(session, newPosition);
		}
	}

	/**
	 * Manual refresh triggered by user
	 */
	public async manualRefresh(guildId: string, interaction: ButtonInteraction): Promise<void> {
		const session = this.sessions.get(guildId);
		if (!session) return;

		const player = this.client.manager.getPlayer(guildId);
		if (!player) {
			await this.stopSession(guildId);
			return;
		}

		// Force update regardless of line change
		session.currentLineIndex = this.getCurrentLineIndex(session, player.position);
		session.retryCount = 0;

		try {
			await interaction.update({
				embeds: [this.createLyricsEmbed(session, player)],
				components: [this.createButtonRow(session)],
			});
			session.lastUpdateTime = Date.now();
		} catch (error) {
			this.client.logger.error('Failed to refresh lyrics:', error);
		}
	}

	/**
	 * Create initial message for the session
	 */
	private async createInitialMessage(session: LiveLyricsSession, player: Player): Promise<Message | null> {
		try {
			const channel = this.client.channels.cache.get(session.textChannelId);
			if (!channel?.isSendable()) return null;

			session.currentLineIndex = this.getCurrentLineIndex(session, player.position);

			const message = await channel.send({
				embeds: [this.createLyricsEmbed(session, player)],
				components: [this.createButtonRow(session)],
			});

			return message;
		} catch (error) {
			this.client.logger.error('Failed to create live lyrics message:', error);
			this.sessions.delete(session.guildId);
			return null;
		}
	}

	/**
	 * Update the lyrics display
	 */
	private async updateDisplay(guildId: string): Promise<void> {
		// Check if session still exists at the start
		const session = this.sessions.get(guildId);
		if (!session || !session.messageId) return;

		// Check if in backoff period
		if (session.backoffUntil > Date.now()) {
			return;
		}

		// Don't update if paused
		if (session.isPaused) return;

		const player = this.client.manager.getPlayer(guildId);
		if (!player) {
			await this.stopSession(guildId);
			return;
		}

		// Check if track changed
		const currentTrack = player.queue.current;
		if (!currentTrack || currentTrack.info.uri !== session.trackUri) {
			await this.stopSession(guildId);
			return;
		}

		const newIndex = this.getCurrentLineIndex(session, player.position);

		// Only update if line changed (smart update)
		if (newIndex === session.currentLineIndex) return;

		session.currentLineIndex = newIndex;
		session.retryCount = 0;

		// Use lock to prevent concurrent updates
		await this.updateLock.acquire(guildId, async () => {
			await this.editMessageSafe(session, player);
		});
	}

	/**
	 * Safely edit message with rate limit handling
	 */
	private async editMessageSafe(session: LiveLyricsSession, player: Player): Promise<void> {
		if (!session.messageId) return;

		try {
			const channel = this.client.channels.cache.get(session.textChannelId);
			if (!channel?.isTextBased()) return;

			const message = await channel.messages.fetch(session.messageId).catch(() => null);
			if (!message || !message.editable) {
				await this.stopSession(session.guildId);
				return;
			}

			await message.edit({
				embeds: [this.createLyricsEmbed(session, player)],
				components: [this.createButtonRow(session)],
			});

			session.lastUpdateTime = Date.now();

			// Log rate limit headers if present (for monitoring)
			const headers = (message as any).editResponse?.headers;
			if (headers) {
				const remaining = headers.get?.('X-RateLimit-Remaining') ?? headers['X-RateLimit-Remaining'];
				if (remaining && parseInt(remaining) < 5) {
					this.client.logger.warn(
						`[RATE LIMIT WARNING] Guild ${session.guildId} has only ${remaining} requests remaining in bucket`
					);
				}
			}
		} catch (error: any) {
			await this.handleUpdateError(session, error);
		}
	}

	/**
	 * Parse rate limit information from Discord API error
	 */
	private parseRateLimitError(error: any): RateLimitInfo {
		const scope: RateLimitScope = error.scope ?? 
			(error.global ? 'global' : 
			(error.headers?.get('X-RateLimit-Scope') as RateLimitScope) ?? 'unknown');
		
		const retryAfterMs = (error.retryAfter ?? error.retry_after ?? 0) * 1000;
		
		return {
			scope,
			retryAfterMs,
			isGlobal: scope === 'global' || error.global === true,
			limit: error.limit ?? parseInt(error.headers?.get('X-RateLimit-Limit') ?? '0'),
			remaining: error.remaining ?? parseInt(error.headers?.get('X-RateLimit-Remaining') ?? '0'),
			resetAfter: error.resetAfter ?? parseFloat(error.headers?.get('X-RateLimit-Reset-After') ?? '0'),
			bucket: error.bucket ?? error.headers?.get('X-RateLimit-Bucket') ?? undefined,
		};
	}

	/**
	 * Handle update errors with appropriate response based on rate limit type
	 */
	private async handleUpdateError(session: LiveLyricsSession, error: any): Promise<void> {
		session.retryCount++;

		if (session.retryCount >= this.config.maxRetries) {
			await this.stopSession(session.guildId);
			return;
		}

		// Check if it's a rate limit error
		if (error.code === 429 || error.status === 429) {
			const rateLimitInfo = this.parseRateLimitError(error);
			session.lastRateLimitScope = rateLimitInfo.scope;

			// Store bucket if provided
			if (rateLimitInfo.bucket) {
				session.rateLimitBucket = rateLimitInfo.bucket;
			}

			const currentInterval = this.calculateDynamicInterval();
			const backoffTime = Math.max(
				rateLimitInfo.retryAfterMs,
				currentInterval * Math.pow(this.config.backoffMultiplier, session.retryCount)
			);

			switch (rateLimitInfo.scope) {
				case 'global':
					// Global rate limit - pause ALL sessions
					this.client.logger.error(
						`[GLOBAL RATE LIMIT] Hit global rate limit! Backing off all sessions for ${backoffTime}ms`
					);
					for (const [, s] of this.sessions) {
						s.backoffUntil = Math.max(s.backoffUntil, Date.now() + backoffTime);
						s.lastRateLimitScope = 'global';
					}
					break;

				case 'user':
					// Per-route rate limit - pause only this session
					this.client.logger.warn(
						`[PER-ROUTE RATE LIMIT] Guild ${session.guildId} hit per-route limit. ` +
						`Bucket: ${rateLimitInfo.bucket ?? 'unknown'}, Backing off for ${backoffTime}ms`
					);
					session.backoffUntil = Date.now() + backoffTime;
					break;

				case 'shared':
					// Resource-specific rate limit - pause only this session
					// Note: Shared limits don't count towards invalid request limits
					this.client.logger.warn(
						`[SHARED RATE LIMIT] Guild ${session.guildId} hit resource-specific limit. ` +
						`This may be caused by other bots/users in the channel. Backing off for ${backoffTime}ms`
					);
					session.backoffUntil = Date.now() + backoffTime;
					break;

				default:
					// Unknown scope - treat conservatively as per-route
					this.client.logger.warn(
						`[UNKNOWN RATE LIMIT] Guild ${session.guildId} hit rate limit with unknown scope. ` +
						`Backing off for ${backoffTime}ms`
					);
					session.backoffUntil = Date.now() + backoffTime;
			}
		} else {
			this.client.logger.error('Error updating lyrics:', error);
		}
	}

	/**
	 * Find the current line index based on playback position
	 * Returns the last line where line.timestamp <= currentPosition
	 * This means we're looking for the line that STARTED most recently
	 */
	private getCurrentLineIndex(session: LiveLyricsSession, position: number): number {
		const { lyrics } = session;

		// Find the last line where timestamp <= position
		// Iterate backwards to find the most recent line that has started
		for (let i = lyrics.length - 1; i >= 0; i--) {
			if (lyrics[i].timestamp <= position) {
				return i;
			}
		}

		return -1; // Before first lyric line
	}

	/**
	 * Format lyrics for karaoke display
	 */
	private formatKaraokeDisplay(session: LiveLyricsSession, currentIndex: number): string {
		const lines: string[] = [];
		const { lyrics } = session;
		const visibleLines = this.config.visibleLines;

		// Calculate visible range (center current line)
		const halfVisible = Math.floor(visibleLines / 2);
		let start = Math.max(0, currentIndex - halfVisible);
		const end = Math.min(lyrics.length - 1, start + visibleLines - 1);

		// Adjust start if we're near the end
		start = Math.max(0, Math.min(start, end - visibleLines + 1));

		for (let i = start; i <= end; i++) {
			const lyricLine = lyrics[i];

			if (!lyricLine || !lyricLine.line.trim()) {
				// Instrumental break or empty line
				if (i === currentIndex) {
					lines.push('**🎵 ♪ ♫ ♪ 🎵**');
				} else {
					lines.push('♪');
				}
			} else if (i === currentIndex) {
				// Current line - highlight with bold and emoji
				lines.push(`**🎵 ${lyricLine.line} 🎵**`);
			} else if (i < currentIndex) {
				// Past lines - italicized
				lines.push(`*${lyricLine.line}*`);
			} else {
				// Future lines - normal
				lines.push(lyricLine.line);
			}
		}

		return lines.join('\n') || this.t(session, 'LIVE_LYRICS.NO_LYRICS_AVAILABLE');
	}

	/**
	 * Create the lyrics embed
	 */
	private createLyricsEmbed(session: LiveLyricsSession, player: Player): EmbedBuilder {
		const displayText = this.formatKaraokeDisplay(session, session.currentLineIndex);
		const position = player.position;
		const progress = this.formatProgress(position, session.trackDuration);
		const updateIntervalSeconds = this.calculateDynamicInterval() / 1000;

		return this.client.embed()
			.setAuthor({
				name: this.t(session, 'LIVE_LYRICS.TITLE', { track: session.trackTitle }),
				iconURL: session.artworkUrl,
			})
			.setColor(this.client.color.main)
			.setDescription(displayText)
			.setThumbnail(session.artworkUrl || null)
			.addFields({
				name: this.t(session, 'LIVE_LYRICS.PROGRESS'),
				value: `${progress} • ${this.t(session, 'LIVE_LYRICS.UPDATE_INTERVAL', { seconds: updateIntervalSeconds })}`,
				inline: false,
			})
			.setFooter({
				text: `BuNgo Music Bot 🎵 • ${this.t(session, 'LIVE_LYRICS.CLICK_REFRESH')}`,
				iconURL: this.client.user?.displayAvatarURL({ extension: 'png' }),
			})
			.setTimestamp();
	}

	/**
	 * Create button row for controls
	 */
	private createButtonRow(session: LiveLyricsSession): ActionRowBuilder<ButtonBuilder> {
		const refreshButton = new ButtonBuilder()
			.setCustomId('live-refresh')
			.setLabel(this.t(session, 'LIVE_LYRICS.REFRESH_BUTTON'))
			.setEmoji('🔄')
			.setStyle(ButtonStyle.Secondary);

		const stopButton = new ButtonBuilder()
			.setCustomId('live-stop')
			.setLabel(this.t(session, 'LIVE_LYRICS.STOP_BUTTON'))
			.setEmoji('⏹️')
			.setStyle(ButtonStyle.Danger);

		return new ActionRowBuilder<ButtonBuilder>().addComponents(refreshButton, stopButton);
	}

	/**
	 * Setup button collector for a session
	 */
	private setupButtonCollector(session: LiveLyricsSession, message: Message): void {
		const collector = message.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: 3600000, // 1 hour max
		});

		// Store collector reference for cleanup
		session.collector = collector;

		collector.on('collect', async (interaction: ButtonInteraction) => {
			if (interaction.customId === 'live-refresh') {
				await this.manualRefresh(session.guildId, interaction);
			} else if (interaction.customId === 'live-stop') {
				// Stop collector first to prevent further events
				collector.stop();
				// Defer update to acknowledge the interaction without changing the message
				await interaction.deferUpdate().catch(() => null);
				// Stop session (will delete the message)
				await this.stopSession(session.guildId);
			}
		});

		collector.on('end', async (_collected, reason) => {
			if (reason !== 'user') {
				await this.stopSession(session.guildId);
			}
		});
	}

	/**
	 * Format progress time display
	 */
	private formatProgress(current: number, total: number): string {
		const formatTime = (ms: number): string => {
			const seconds = Math.floor(ms / 1000);
			const minutes = Math.floor(seconds / 60);
			const remainingSeconds = seconds % 60;
			return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
		};

		return `${formatTime(current)} / ${formatTime(total)}`;
	}
}

export default LiveLyricsService;
