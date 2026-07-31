/**
 * Database Backup Service
 * Automated database backups with rotation
 */

import { PrismaClient } from "@prisma/client";
import Logger from "../structures/Logger.js";
import ServerData from "../database/server.js";
import { writeFile, readdir, unlink, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface BackupConfig {
	enabled: boolean;
	interval: number; // ms between backups
	retention: number; // number of backups to keep
	path: string; // backup directory
	includePlayerData: boolean;
}

export class DatabaseBackupService {
	private logger: Logger;
	private prisma: PrismaClient;
	private backupInterval: NodeJS.Timeout | null = null;

	private config: BackupConfig = {
		enabled: true,
		interval: 86400000, // 24 hours
		retention: 7, // keep 7 backups
		path: "./backups",
		includePlayerData: true,
	};

	constructor(config?: Partial<BackupConfig>) {
		this.logger = new Logger("DatabaseBackup");
		this.prisma = new PrismaClient();
		if (config) {
			this.config = { ...this.config, ...config };
		}
	}

	/**
	 * Start automated backups
	 */
	public async start(): Promise<void> {
		if (!this.config.enabled) {
			this.logger.info("[Database Backup] Backups are disabled");
			return;
		}

		this.logger.info(
			`[Database Backup] Starting automated backups (interval: ${this.config.interval / 1000 / 60}min)`,
		);

		// Ensure backup directory exists
		await this.ensureBackupDirectory();

		// Perform initial backup
		await this.performBackup();

		// Schedule recurring backups
		this.backupInterval = setInterval(() => {
			this.performBackup();
		}, this.config.interval);
	}

	/**
	 * Stop automated backups
	 */
	public stop(): void {
		if (this.backupInterval) {
			clearInterval(this.backupInterval);
			this.backupInterval = null;
			this.logger.info("[Database Backup] Stopped automated backups");
		}
	}

	/**
	 * Perform a database backup
	 */
	public async performBackup(): Promise<string> {
		try {
			this.logger.info("[Database Backup] Starting backup...");

			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const backupFile = join(this.config.path, `backup-${timestamp}.json`);

			// Collect all data
			const backupData: any = {
				timestamp: new Date().toISOString(),
				version: "1.0",
				data: {
					botConfigs: await this.prisma.botConfig.findMany(),
					guilds: await this.prisma.guild.findMany(),
					guildBotConfigs: await this.prisma.guildBotConfig.findMany(),
					guildBotPreferences: await this.prisma.guildBotPreferences.findMany(),
					setup: await this.prisma.setup.findMany(),
					dj: await this.prisma.dj.findMany(),
					stay: await this.prisma.stay.findMany(),
					playlists: await this.prisma.playlist.findMany(),
					dashboardUsers: await this.prisma.dashboardUser.findMany(),
					dashboardSessions: await this.prisma.dashboardSession.findMany(),
					auditLogs: await this.prisma.auditLog.findMany(),
					botStats: await this.prisma.botStats.findMany(),
					playerHistory: await this.prisma.playerHistory.findMany(),
					globalConfig: await this.prisma.globalConfig.findMany(),
				},
			};

			// If including player data, add it
			if (this.config.includePlayerData) {
				try {
					backupData.data.playerStates = await this.prisma.playerState.findMany();
				} catch (error) {
					this.logger.warn(
						`[Database Backup] Could not include player states: ${error}`,
					);
				}
			}

			// Write to file
			await writeFile(backupFile, JSON.stringify(backupData, null, 2), "utf-8");

			this.logger.info(`[Database Backup] Backup created: ${backupFile}`);

			// Clean up old backups
			await this.cleanupOldBackups();

			return backupFile;
		} catch (error) {
			this.logger.error(`[Database Backup] Backup failed: ${error}`);
			throw error;
		}
	}

	/**
	 * Restore from a backup file
	 */
	public async restoreBackup(backupFile: string): Promise<void> {
		try {
			this.logger.info(`[Database Backup] Restoring from ${backupFile}...`);

			// Read backup file
			const backupContent = await readFile(backupFile, "utf-8");
			const backupData = JSON.parse(backupContent);

			// Verify backup format
			if (!backupData.data) {
				throw new Error("Invalid backup file format");
			}

			// Clear existing data (in transaction)
			await this.prisma.$transaction(async (tx) => {
				// Delete in reverse order to respect foreign keys
				await tx.playerHistory.deleteMany();
				await tx.botStats.deleteMany();
				await tx.auditLog.deleteMany();
				await tx.dashboardSession.deleteMany();
				await tx.dashboardUser.deleteMany();
				await tx.playlist.deleteMany();
				await tx.stay.deleteMany();
				await tx.dj.deleteMany();
				await tx.setup.deleteMany();
				await tx.guildBotPreferences.deleteMany();
				await tx.guildBotConfig.deleteMany();
				await tx.guild.deleteMany();
				await tx.botConfig.deleteMany();
				await tx.globalConfig.deleteMany();

				// Restore data
				if (backupData.data.globalConfig?.length) {
					await tx.globalConfig.createMany({
						data: backupData.data.globalConfig,
					});
				}
				if (backupData.data.botConfigs?.length) {
					await tx.botConfig.createMany({ data: backupData.data.botConfigs });
				}
				if (backupData.data.guilds?.length) {
					await tx.guild.createMany({ data: backupData.data.guilds });
				}
				if (backupData.data.guildBotConfigs?.length) {
					await tx.guildBotConfig.createMany({
						data: backupData.data.guildBotConfigs,
					});
				}
				if (backupData.data.guildBotPreferences?.length) {
					await tx.guildBotPreferences.createMany({
						data: backupData.data.guildBotPreferences,
					});
				}
				if (backupData.data.setup?.length) {
					await tx.setup.createMany({ data: backupData.data.setup });
				}
				if (backupData.data.dj?.length) {
					await tx.dj.createMany({ data: backupData.data.dj });
				}
				if (backupData.data.stay?.length) {
					await tx.stay.createMany({ data: backupData.data.stay });
				}
				if (backupData.data.playlists?.length) {
					await tx.playlist.createMany({ data: backupData.data.playlists });
				}
				if (backupData.data.dashboardUsers?.length) {
					await tx.dashboardUser.createMany({
						data: backupData.data.dashboardUsers,
					});
				}
				if (backupData.data.dashboardSessions?.length) {
					await tx.dashboardSession.createMany({
						data: backupData.data.dashboardSessions,
					});
				}
				if (backupData.data.auditLogs?.length) {
					await tx.auditLog.createMany({ data: backupData.data.auditLogs });
				}
				if (backupData.data.botStats?.length) {
					await tx.botStats.createMany({ data: backupData.data.botStats });
				}
				if (backupData.data.playerHistory?.length) {
					await tx.playerHistory.createMany({
						data: backupData.data.playerHistory,
					});
				}
				if (backupData.data.playerStates?.length) {
					await tx.playerState.createMany({
						data: backupData.data.playerStates,
					});
				}
			});

			ServerData.clearLanguageCache();
			ServerData.clearSetupCache();

			this.logger.info(
				`[Database Backup] Successfully restored from ${backupFile}`,
			);
		} catch (error) {
			this.logger.error(`[Database Backup] Restore failed: ${error}`);
			throw error;
		}
	}

	/**
	 * List available backups
	 */
	public async listBackups(): Promise<string[]> {
		try {
			const files = await readdir(this.config.path);
			return files
				.filter((f) => f.startsWith("backup-") && f.endsWith(".json"))
				.sort()
				.reverse(); // Most recent first
		} catch (error) {
			this.logger.error(`[Database Backup] Error listing backups: ${error}`);
			return [];
		}
	}

	/**
	 * Clean up old backups
	 */
	private async cleanupOldBackups(): Promise<void> {
		try {
			const backups = await this.listBackups();

			if (backups.length > this.config.retention) {
				const toDelete = backups.slice(this.config.retention);

				for (const backup of toDelete) {
					const backupPath = join(this.config.path, backup);
					await unlink(backupPath);
					this.logger.info(`[Database Backup] Deleted old backup: ${backup}`);
				}
			}
		} catch (error) {
			this.logger.error(`[Database Backup] Error cleaning up backups: ${error}`);
		}
	}

	/**
	 * Ensure backup directory exists
	 */
	private async ensureBackupDirectory(): Promise<void> {
		if (!existsSync(this.config.path)) {
			await mkdir(this.config.path, { recursive: true });
			this.logger.info(
				`[Database Backup] Created backup directory: ${this.config.path}`,
			);
		}
	}

	/**
	 * Update configuration
	 */
	public updateConfig(config: Partial<BackupConfig>): void {
		this.config = { ...this.config, ...config };
		this.logger.info("[Database Backup] Configuration updated");

		// Restart if interval changed
		if (config.interval && this.backupInterval) {
			this.stop();
			this.start();
		}
	}
}
