import { BotConfig, type Dj, type Guild, type Playlist, PrismaClient, type Role, type Setup, type Stay } from '@prisma/client';
import { env } from '../env';
import Logger from '../structures/Logger';
import { PlayerJson } from 'lavalink-client';

export default class ServerData {
	private prisma: PrismaClient;
	private childEnv: BotConfig = {} as BotConfig;
	public logger: Logger;
	private static languageCache = new Map<string, string>();
	private static setupCache = new Map<string, Setup | null>();

	constructor(bot: BotConfig) {
		this.prisma = new PrismaClient();
		this.childEnv = bot;
		this.logger = new Logger(bot.name);
	}

	public async connect() {
		await this.prisma.$connect();
		this.logger.info(`[Database] Connected for bot ${this.childEnv.clientId}`);
	}

	public async get(guildId: string): Promise<Guild> {
		return await this.prisma.guild.upsert({
			where: { guildId },
			update: {}, // No update needed
			create: { guildId }, // Create if not exists
		});
	}

	public async getMaintainMode(): Promise<boolean> {
		const config = await this.prisma.globalConfig.findUnique({
			where: { id: "global" },
		});

		// Default to false if not set
		return config?.maintenanceMode ?? false;
	}

	public async updateMaintainMode(mode: boolean): Promise<void> {
		await this.prisma.globalConfig.upsert({
			where: { id: "global" },
			update: { maintenanceMode: mode },
			create: { id: "global", maintenanceMode: mode },
		});
	}

	// Set prefix (now using botClientId instead of botId)
	public async setPrefix(guildId: string, botClientId: string, prefix: string): Promise<void> {
		await this.prisma.guildBotConfig.upsert({
			where: { guildId_botClientId: { guildId, botClientId } },
			update: { prefix },
			create: { guildId, botClientId, prefix },
		});
	}

	// Get prefix (by guildId + botClientId)
	public async getPrefix(guildId: string, botClientId: string): Promise<string> {
		const config = await this.prisma.guildBotConfig.findUnique({
			where: { guildId_botClientId: { guildId, botClientId } },
		});
		return config?.prefix ?? this.childEnv.prefix;
	}

	// Get all prefixes
	public async getAllPrefixes(guildId: string): Promise<string[]> {
		const guildConfigs = await this.prisma.guildBotConfig.findMany({
			where: { guildId },
			select: { prefix: true },
		});

		const defaultConfigs = await this.prisma.botConfig.findMany({
			select: { prefix: true },
		});

		const prefixes = [
			...guildConfigs.map(c => c.prefix),
			...defaultConfigs.map(c => c.prefix),
		]
			.filter(p => !!p) // Remove null/undefined/empty
			.filter((v, i, a) => a.indexOf(v) === i); // Remove duplicates

		return prefixes;
	}

	public async updateLanguage(guildId: string, language: string): Promise<void> {
		await this.prisma.guild.update({
			where: { guildId },
			data: { language },
		});
		ServerData.languageCache.set(guildId, language);
	}

	public async getLanguage(guildId: string): Promise<string> {
		const cached = ServerData.languageCache.get(guildId);
		if (cached !== undefined) return cached;

		const guild = await this.get(guildId);
		const language = guild?.language ?? env.DEFAULT_LANGUAGE;
		ServerData.languageCache.set(guildId, language);
		return language;
	}

	/** Drops every cached guild language. Required after any bulk write that
	 *  bypasses updateLanguage, e.g. a backup restore. */
	public static clearLanguageCache(): void {
		ServerData.languageCache.clear();
	}

	/** Drops every cached setup row. Required after any bulk write that
	 *  bypasses setSetup/deleteSetup, e.g. a backup restore. */
	public static clearSetupCache(): void {
		ServerData.setupCache.clear();
	}

	public async getSetup(guildId: string): Promise<Setup | null> {
		const cached = ServerData.setupCache.get(guildId);
		if (cached !== undefined) return cached;

		const setup = await this.prisma.setup.findUnique({ where: { guildId } });
		ServerData.setupCache.set(guildId, setup);
		return setup;
	}

	public async setSetup(guildId: string, textId: string, messageId: string): Promise<void> {
		const setup = await this.prisma.setup.upsert({
			where: { guildId },
			update: { textId, messageId },
			create: { guildId, textId, messageId },
		});
		ServerData.setupCache.set(guildId, setup);
	}

	public async deleteSetup(guildId: string): Promise<void> {
		await this.prisma.setup.delete({ where: { guildId } });
		ServerData.setupCache.delete(guildId);
	}

	public async set_247(guildId: string, botClientId: string, textId: string, voiceId: string): Promise<void> {
		await this.prisma.stay.upsert({
			where: { guildId_botClientId: { guildId, botClientId } },
			update: { textId, voiceId },
			create: { guildId, botClientId, textId, voiceId },
		});
	}

	public async delete_247(guildId: string, botClientId: string): Promise<void> {
		await this.prisma.stay.delete({
			where: { guildId_botClientId: { guildId, botClientId } },
		});
	}

	public async get_247(botClientId?: string, guildId?: string): Promise<Stay | Stay[] | null> {
		if (guildId && botClientId) {
			// Get specific bot's Stay in a guild
			const stay = await this.prisma.stay.findUnique({
				where: { guildId_botClientId: { guildId, botClientId } },
			});
			return stay ?? null;
		} else if (botClientId) {
			return await this.prisma.stay.findMany({
				where: { botClientId },
			});
		}

		// Return all Stay configs (e.g., for admin stats or bot dashboards)
		return await this.prisma.stay.findMany();
	}

	public async setDj(guildId: string, mode: boolean): Promise<void> {
		await this.prisma.dj.upsert({
			where: { guildId },
			update: { mode },
			create: { guildId, mode },
		});
	}

	public async getDj(guildId: string): Promise<Dj | null> {
		return await this.prisma.dj.findUnique({ where: { guildId } });
	}

	public async getRoles(guildId: string): Promise<Role[]> {
		return await this.prisma.role.findMany({ where: { guildId } });
	}

	public async addRole(guildId: string, roleId: string): Promise<void> {
		await this.prisma.role.create({ data: { guildId, roleId } });
	}

	public async removeRole(guildId: string, roleId: string): Promise<void> {
		await this.prisma.role.deleteMany({ where: { guildId, roleId } });
	}

	public async clearRoles(guildId: string): Promise<void> {
		await this.prisma.role.deleteMany({ where: { guildId } });
	}

	public async getPlaylist(userId: string, name: string): Promise<Playlist | null> {
		return await this.prisma.playlist.findUnique({
			where: { userId_name: { userId, name } },
		});
	}

	public async getUserPlaylists(userId: string): Promise<Playlist[]> {
		return await this.prisma.playlist.findMany({
			where: { userId },
		});
	}

	public async createPlaylist(userId: string, name: string): Promise<void> {
		await this.prisma.playlist.create({ data: { userId, name } });
	}

	// createPlaylist with tracks
	public async createPlaylistWithTracks(userId: string, name: string, tracks: string[]): Promise<void> {
		await this.prisma.playlist.create({
			data: {
				userId,
				name,
				tracks: JSON.stringify(tracks),
			},
		});
	}
	/**
	 * Deletes a playlist from the database
	 *
	 * @param userId The ID of the user that owns the playlist
	 * @param name The name of the playlist to delete
	 */
	public async deletePlaylist(userId: string, name: string): Promise<void> {
		await this.prisma.playlist.delete({
			where: { userId_name: { userId, name } },
		});
	}

	public async deleteSongsFromPlaylist(userId: string, playlistName: string): Promise<void> {
		// Fetch the playlist
		const playlist = await this.getPlaylist(userId, playlistName);

		if (playlist) {
			// Update the playlist and reset the tracks to an empty array
			await this.prisma.playlist.update({
				where: {
					userId_name: {
						userId,
						name: playlistName,
					},
				},
				data: {
					tracks: JSON.stringify([]), // Set tracks to an empty array
				},
			});
		}
	}

	public async addTracksToPlaylist(userId: string, playlistName: string, tracks: string[]) {
		// Serialize the tracks array into a JSON string
		const tracksJson = JSON.stringify(tracks);

		// Check if the playlist already exists for the user
		const playlist = await this.prisma.playlist.findUnique({
			where: {
				userId_name: {
					userId,
					name: playlistName,
				},
			},
		});

		if (playlist) {
			// If the playlist exists, handle existing tracks
			const existingTracks = playlist.tracks ? JSON.parse(playlist.tracks) : []; // Initialize as an empty array if null

			if (Array.isArray(existingTracks)) {
				// Merge new and existing tracks
				const updatedTracks = [...existingTracks, ...tracks];

				// Update the playlist with the new tracks
				await this.prisma.playlist.update({
					where: {
						userId_name: {
							userId,
							name: playlistName,
						},
					},
					data: {
						tracks: JSON.stringify(updatedTracks), // Store the updated tracks as a serialized JSON string
					},
				});
			} else {
				throw new Error('Existing tracks are not in an array format.');
			}
		} else {
			// If no playlist exists, create a new one with the provided tracks
			await this.prisma.playlist.create({
				data: {
					userId,
					name: playlistName,
					tracks: tracksJson, // Store the serialized JSON string
				},
			});
		}
	}

	public async removeSong(userId: string, playlistName: string, encodedSong: string): Promise<void> {
		const playlist = await this.getPlaylist(userId, playlistName);
		if (playlist) {
			const tracks: string[] = JSON.parse(playlist?.tracks!);

			// Find the index of the song to remove
			const songIndex = tracks.indexOf(encodedSong);

			if (songIndex !== -1) {
				// Remove the song from the array
				tracks.splice(songIndex, 1);

				// Update the playlist with the new list of tracks
				await this.prisma.playlist.update({
					where: {
						userId_name: {
							userId,
							name: playlistName,
						},
					},
					data: {
						tracks: JSON.stringify(tracks), // Re-serialize the updated array back to a string
					},
				});
			}
		}
	}

	public async getTracksFromPlaylist(userId: string, playlistName: string) {
		const playlist = await this.prisma.playlist.findUnique({
			where: {
				userId_name: {
					userId,
					name: playlistName,
				},
			},
		});

		if (!playlist) {
			return null;
		}

		// Deserialize the tracks JSON string back into an array
		const tracks = JSON.parse(playlist.tracks!);
		return tracks;
	}

	public async getSavedPlayerData(guildId: string, botClientId: string) {
		return await this.prisma.playerState.findUnique({
			where: { guildId_botClientId: { guildId, botClientId } },
		});
	}

	public async setSavedPlayerData(data: PlayerJson, botClientId: string) {
		const {
			guildId,
			voiceChannelId,
			textChannelId,
			nodeId,
		} = data;

		await this.prisma.playerState.upsert({
			where: { guildId_botClientId: { guildId, botClientId } },
			update: {
				voiceChannelId,
				textChannelId: textChannelId ?? "",
				nodeId: nodeId ?? "",
				selfDeaf: data.options.selfDeaf ?? true,
				selfMute: data.options.selfMute ?? false,
				applyVolumeAsFilter: data.options.applyVolumeAsFilter,
				instaUpdateFiltersFix: data.options.instaUpdateFiltersFix,
				vcRegion: data.options.vcRegion ?? "",
			},
			create: {
				guildId,
				botClientId,
				voiceChannelId,
				textChannelId: textChannelId ?? "",
				nodeId: nodeId ?? "",
				selfDeaf: data.options.selfDeaf ?? true,
				selfMute: data.options.selfMute ?? false,
				applyVolumeAsFilter: data.options.applyVolumeAsFilter,
				instaUpdateFiltersFix: data.options.instaUpdateFiltersFix,
				vcRegion: data.options.vcRegion ?? "",
			},
		});
	}

	public async deleteSavedPlayerData(guildId: string, botClientId: string) {
		await this.prisma.playerState.delete({
			where: { guildId_botClientId: { guildId, botClientId } },
		}).catch(() => null);  // Ignore if not found
	}
}


