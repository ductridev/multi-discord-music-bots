import fs from "node:fs";
import path from "node:path";
import { Api } from "@top-gg/sdk";
import {
  ApplicationCommandType,
  Client,
  ClientOptions,
  Collection,
  EmbedBuilder,
  Events,
  Interaction,
  PermissionsBitField,
  REST,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  Routes,
} from "discord.js";
import config from "../config";
import ServerData from "../database/server";
import { env } from "../env";
import loadPlugins from "../plugin/index";
import { Utils } from "../utils/Utils";
import { T, i18n, initI18n, localization } from "./I18n";
import LavalinkClient from "./LavalinkClient";
import Logger from "./Logger";
import type { Command } from "./index";
import { registerBot } from "..";
import { BotConfig } from "@prisma/client";
import { PlayerSaver } from "./PlayerSaver";
import { ShardStateManager } from "./ShardStateManager";
import { LavaSrcConfigService } from "../services/LavaSrcConfigService.js";
import { YouTubeConfigService } from "../services/YouTubeConfigService.js";
import { LiveLyricsService } from "../services/LiveLyricsService.js";
import { PeriodicMessageSystem } from "../utils/PeriodicMessageSystem";
import { TemporaryAnnouncementService } from "../services/TemporaryAnnouncementService";
import { TranslationService } from "../services/TranslationService";
import { stopCleanupScheduler } from "../services/DatabaseCleanup";

export default class Lavamusic extends Client {
  public commands: Collection<string, any> = new Collection();
  public aliases: Collection<string, any> = new Collection();
  public db = new ServerData({} as BotConfig);
  public cooldown: Collection<string, any> = new Collection();
  public config = config;
  public readonly emoji = config.emoji;
  public readonly color = config.color;
  public body: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
  public topGG!: Api;
  public utils = Utils;
  public env: typeof env = env;
  public childEnv: BotConfig = {} as BotConfig;
  public manager!: LavalinkClient;
  public rest = new REST().setToken("");
  public playerSaver: PlayerSaver | null = null;
  public timeoutListenersMap: Map<string, NodeJS.Timeout> = new Map();
  public timeoutSongsMap: Map<string, NodeJS.Timeout> = new Map();
  public logger: Logger;
  public shardStateManager: ShardStateManager | null = null;
  public isShuttingDown: boolean = false;
  public lavaSrcConfigService: LavaSrcConfigService | null = null;
  public youTubeConfigService: YouTubeConfigService | null = null;
  public liveLyricsService: LiveLyricsService | null = null;
  private registeredEventHandlers: Array<{
    name: string;
    handler: (...args: any[]) => void;
    type: 'client' | 'player' | 'node';
  }> = [];
  constructor(clientOptions: ClientOptions, bot: BotConfig) {
    super(clientOptions);
    this.logger = new Logger(bot.name);
    this.childEnv = bot;
  }
  public embed(): EmbedBuilder {
    return new EmbedBuilder();
  }

  public async start(): Promise<void> {
    initI18n(this.logger);
    this.playerSaver = new PlayerSaver(this.childEnv.name);
    // CRITICAL: Ensure player data is loaded from disk before bot uses it
    await this.playerSaver.ensureLoaded();
    this.logger.info(`Player session data loaded for ${this.childEnv.name}`);
    
    this.db = new ServerData(this.childEnv);
    await this.db.connect();
    config.maintenance = await this.db.getMaintainMode();
    
    // Initialize ShardStateManager for cross-shard communication
    this.shardStateManager = new ShardStateManager(this);
    this.logger.info("ShardStateManager initialized");
    
    if (this.env.TOPGG) {
      this.topGG = new Api(this.env.TOPGG);
    } else {
      this.logger.warn("Top.gg token not found!");
    }
    this.rest = new REST().setToken(this.childEnv.token ?? "");
    this.manager = new LavalinkClient(this);
    this.lavaSrcConfigService = new LavaSrcConfigService(this.manager);
    this.youTubeConfigService = new YouTubeConfigService(this.manager);
    const nm = this.manager.nodeManager;
    nm.on("connect",      n => console.log("[NM] connect", n.id));
    nm.on("disconnect",   (n,p) => console.log("[NM] disconnect", n.id, p));
    nm.on("reconnectinprogress", n => console.log("[NM] pending", n.id, n.reconnectionState));
    nm.on("reconnecting", n => console.log("[NM] reconnecting", n.id, "att=", n.reconnectionAttemptCount));
    nm.on("error",        (n,e) => console.log("[NM] error", n.id, e?.message));
    nm.on("destroy",      (n,r) => console.log("[NM] destroy", n.id, r));
    this.manager.on("debug", (ev,p) =>
        p?.functionLayer?.includes("LavalinkNode") && console.log("[DBG]", ev, p.state, p.message));
    this.liveLyricsService = new LiveLyricsService(this);
    await this.loadCommands();
    this.logger.info("Successfully loaded commands!");
    await this.validate247Stays();
    await this.loadEvents();
    this.logger.info("Successfully loaded events!");
    loadPlugins(this);

    this.on('debug', m => this.logger.info(`[DJS] ${m}`));
    this.on('error', e => this.logger.error(`[DJS-ERR]`, e));
    this.on('shardError', e => this.logger.error(`[SHARD-ERR]`, e));
    this.on('shardDisconnect', (e, id) =>
      this.logger.warn(`[SHARD-DISC] shard=${id} code=${e.code} reason=${e.reason}`)
    );
    this.on('shardReady', id => this.logger.success(`[SHARD-READY] shard=${id}`));
    this.on('shardReconnecting', id => this.logger.warn(`[SHARD-RECONNECT] shard=${id}`));
    this.on('shardResume', (id, replayed) =>
      this.logger.info(`[SHARD-RESUME] shard=${id} replayed=${replayed}`)
    );

    try {
      this.logger.info(`Logging in as ${this.childEnv.name}...`);
      await this.login(this.childEnv.token);
      this.logger.success(`Login OK for ${this.childEnv.name}`);
    } catch (e) {
      this.logger.error(`Login FAILED for ${this.childEnv.name}:`, e);
      throw e;
    }
    registerBot(this);

    this.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (interaction.isButton() && interaction.guildId) {
        const setup = await this.db.getSetup(interaction.guildId);
        if (
          setup &&
          interaction.channelId === setup.textId &&
          interaction.message.id === setup.messageId
        ) {
          this.emit("setupButtons", interaction);
        }
      }
    });
  }

  public async loadCommands(): Promise<void> {
    const commandsPath = fs.readdirSync(
      path.join(process.cwd(), "dist", "commands")
    );

    for (const dir of commandsPath) {
      const commandFiles = fs
        .readdirSync(path.join(process.cwd(), "dist", "commands", dir))
        .filter((file) => file.endsWith(".js"));

      for (const file of commandFiles) {
        const cmdModule = require(
          path.join(process.cwd(), "dist", "commands", dir, file)
        );
        const command: Command = new cmdModule.default(this, file);
        command.category = dir;

        this.commands.set(command.name, command);
        command.aliases.forEach((alias: string) => {
          this.aliases.set(alias, command.name as any);
        });

        if (command.slashCommand) {
          const data: RESTPostAPIChatInputApplicationCommandsJSONBody = {
            name: command.name,
            description: T('Vietnamese', command.description.content),
            type: ApplicationCommandType.ChatInput,
            options: command.options || [],
            default_member_permissions:
              Array.isArray(command.permissions.user) &&
                command.permissions.user.length > 0
                ? PermissionsBitField.resolve(
                  command.permissions.user as any
                ).toString()
                : null,
            name_localizations: null,
            description_localizations: null,
          };

          const localizations: { name: any[]; description: string[] }[] = [];
          i18n.getLocales().map((locale: any) => {
            localizations.push(
              localization(locale, command.name, command.description.content)
            );
          });

          for (const localization of localizations) {
            const [language, name] = localization.name;
            const [language2, description] = localization.description;
            data.name_localizations = {
              ...data.name_localizations,
              [language]: name,
            };
            data.description_localizations = {
              ...data.description_localizations,
              [language2]: description,
            };
          }

          if (command.options.length > 0) {
            command.options.map((option) => {
              const optionsLocalizations: {
                name: any[];
                description: string[];
              }[] = [];
              i18n.getLocales().map((locale: any) => {
                optionsLocalizations.push(
                  localization(locale, option.name, option.description)
                );
              });

              for (const localization of optionsLocalizations) {
                const [language, name] = localization.name;
                const [language2, description] = localization.description;
                option.name_localizations = {
                  ...option.name_localizations,
                  [language]: name,
                };
                option.description_localizations = {
                  ...option.description_localizations,
                  [language2]: description,
                };
              }
              option.description = T('Vietnamese', option.description);
            });

            data.options?.map((option) => {
              if ("options" in option && option.options!.length > 0) {
                option.options?.map((subOption) => {
                  const subOptionsLocalizations: {
                    name: any[];
                    description: string[];
                  }[] = [];
                  i18n.getLocales().map((locale: any) => {
                    subOptionsLocalizations.push(
                      localization(
                        locale,
                        subOption.name,
                        subOption.description
                      )
                    );
                  });

                  for (const localization of subOptionsLocalizations) {
                    const [language, name] = localization.name;
                    const [language2, description] = localization.description;
                    subOption.name_localizations = {
                      ...subOption.name_localizations,
                      [language]: name,
                    };
                    subOption.description_localizations = {
                      ...subOption.description_localizations,
                      [language2]: description,
                    };
                  }
                  subOption.description = T(
                    'Vietnamese',
                    subOption.description
                  );
                });
              }
            });
          }
          this.body.push(data);
        }
      }
    }
  }

  private async validate247Stays(): Promise<void> {
    const stay = await this.db.get_247(this.childEnv.clientId);
    if (!Array.isArray(stay)) return;

    await Promise.all(
      stay.map(async (s) => {
        try {
          const guild = await this.guilds.fetch(s.guildId).catch(() => null);
          if (!guild) {
            await this.db.delete_247(s.guildId, this.childEnv.clientId);
            return;
          }

          const channel = await guild.channels.fetch(s.voiceId).catch(() => null);
          if (!channel) {
            await this.db.delete_247(s.guildId, this.childEnv.clientId);
          }
        } catch (error) {
          await this.db.delete_247(s.guildId, this.childEnv.clientId);
        }
      })
    );
  }

  public async deployCommands(guildId?: string): Promise<void> {
    if (!this.application?.id) {
      this.logger.error("Bot is not ready yet—application ID is missing.");
      return;
    }

    const applicationId = this.application.id;
    const route = guildId
      ? Routes.applicationGuildCommands(applicationId, guildId)
      : Routes.applicationCommands(applicationId);

    try {
      // Fetch existing commands to preserve Entry Point commands
      const existingCommands = await this.rest.get(route) as any[];
      const entryPointCommands = existingCommands.filter((cmd: any) => 
        cmd.integration_types?.includes(1) || cmd.contexts?.includes(1)
      );
      
      // Merge our commands with existing Entry Point commands
      const commandsToUpdate = [
        ...this.body,
        ...entryPointCommands.filter((epc: any) => 
          !this.body.some((cmd: any) => cmd.name === epc.name)
        )
      ];
      
      await this.rest.put(route, { body: commandsToUpdate });
      this.logger.info("Successfully deployed slash commands!");
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async loadEvents(): Promise<void> {
    const eventsPath = fs.readdirSync(
      path.join(process.cwd(), "dist", "events")
    );

    for (const dir of eventsPath) {
      const eventFiles = fs
        .readdirSync(path.join(process.cwd(), "dist", "events", dir))
        .filter((file) => file.endsWith(".js"));

      for (const file of eventFiles) {
        const eventModule = require(
          path.join(process.cwd(), "dist", "events", dir, file)
        );
        const event = new eventModule.default(this, file);
        const handler = (...args: any) => event.run(...args);
        const type = dir === "player" ? "player" as const : dir === "node" ? "node" as const : "client" as const;

        if (dir === "player") {
          this.manager.on(event.name, handler);
        } else if (dir === "node") {
          this.manager.nodeManager.on(event.name, handler);
        } else {
          this.on(event.name, handler);
        }

        this.registeredEventHandlers.push({ name: event.name, handler, type });
      }
    }
  }

  private clearRequireCache(dir: string): void {
    const resolved = path.resolve(dir).replace(/\\/g, '/');
    for (const key of Object.keys(require.cache)) {
      if (key.replace(/\\/g, '/').startsWith(resolved)) {
        delete require.cache[key];
      }
    }
  }

  public async reloadCommands(): Promise<{ success: boolean; loaded: number; errors: string[] }> {
    const errors: string[] = [];
    const oldCommands = new Collection(this.commands);
    const oldAliases = new Collection(this.aliases);
    const oldBody = [...this.body];

    try {
      this.clearRequireCache(path.join(process.cwd(), 'dist', 'commands'));
      this.commands.clear();
      this.aliases.clear();
      this.body = [];
      await this.loadCommands();
      this.logger.info(`Hot reloaded ${this.commands.size} commands`);
      return { success: true, loaded: this.commands.size, errors };
    } catch (error: any) {
      this.commands = oldCommands;
      this.aliases = oldAliases;
      this.body = oldBody;
      errors.push(error.message);
      this.logger.error('Failed to reload commands:', error);
      return { success: false, loaded: 0, errors };
    }
  }

  public async reloadEvents(): Promise<{ success: boolean; loaded: number; errors: string[] }> {
    const errors: string[] = [];
    const eventsDir = path.join(process.cwd(), 'dist', 'events');

    // Pre-validate: try loading all event files before removing anything
    try {
      this.clearRequireCache(eventsDir);
      const dirs = fs.readdirSync(eventsDir);
      for (const dir of dirs) {
        const files = fs.readdirSync(path.join(eventsDir, dir)).filter(f => f.endsWith('.js'));
        for (const file of files) {
          require(path.join(eventsDir, dir, file));
        }
      }
    } catch (error: any) {
      errors.push(`Pre-validation failed: ${error.message}`);
      this.logger.error('Event reload pre-validation failed:', error);
      return { success: false, loaded: 0, errors };
    }

    try {
      // Remove all tracked event handlers
      for (const entry of this.registeredEventHandlers) {
        if (entry.type === 'player') {
          (this.manager as any).removeListener(entry.name, entry.handler);
        } else if (entry.type === 'node') {
          (this.manager.nodeManager as any).removeListener(entry.name, entry.handler);
        } else {
          this.removeListener(entry.name, entry.handler);
        }
      }
      this.registeredEventHandlers = [];

      // Clear cache again and re-load
      this.clearRequireCache(eventsDir);
      await this.loadEvents();
      this.logger.info(`Hot reloaded ${this.registeredEventHandlers.length} events`);
      return { success: true, loaded: this.registeredEventHandlers.length, errors };
    } catch (error: any) {
      errors.push(error.message);
      this.logger.error('CRITICAL: Event reload failed. Bot may be in degraded state.', error);
      return { success: false, loaded: 0, errors };
    }
  }

  public async reloadPlugins(): Promise<{ success: boolean; loaded: number; errors: string[] }> {
    const errors: string[] = [];
    const pluginsDir = path.join(process.cwd(), 'dist', 'plugin', 'plugins');

    try {
      // Shutdown existing plugins
      if (fs.existsSync(pluginsDir)) {
        const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
        for (const file of files) {
          const pluginPath = path.join(pluginsDir, file);
          try {
            const cached = require.cache[require.resolve(pluginPath)];
            if (cached) {
              const plugin = cached.exports.default;
              if (plugin?.shutdown) {
                plugin.shutdown(this);
                this.logger.info(`Shutdown plugin: ${plugin.name}`);
              }
            }
          } catch (e: any) {
            errors.push(`Shutdown error for ${file}: ${e.message}`);
          }
        }
      }

      // Clear cache and re-load
      this.clearRequireCache(path.join(process.cwd(), 'dist', 'plugin'));
      await loadPlugins(this);
      this.logger.info('Hot reloaded plugins');
      return { success: true, loaded: 1, errors };
    } catch (error: any) {
      errors.push(error.message);
      this.logger.error('Failed to reload plugins:', error);
      return { success: false, loaded: 0, errors };
    }
  }

  public async reloadServices(): Promise<{ success: boolean; reloaded: string[]; errors: string[] }> {
    const errors: string[] = [];
    const reloaded: string[] = [];

    // 1. Stop PeriodicMessageSystem
    try {
      PeriodicMessageSystem.stopPeriodicCheck();
      reloaded.push('PeriodicMessageSystem (stopped)');
    } catch (e: any) {
      errors.push(`PeriodicMessageSystem stop: ${e.message}`);
    }

    // 2. Stop TemporaryAnnouncementService
    try {
      TemporaryAnnouncementService.stopIntervalCheck();
      reloaded.push('TemporaryAnnouncementService (stopped)');
    } catch (e: any) {
      errors.push(`TemporaryAnnouncementService stop: ${e.message}`);
    }

    // 3. Stop DatabaseCleanup cron jobs
    try {
      stopCleanupScheduler();
      reloaded.push('DatabaseCleanup (stopped)');
    } catch (e: any) {
      errors.push(`DatabaseCleanup stop: ${e.message}`);
    }

    // 4. Reset TranslationService singleton
    try {
      TranslationService.resetInstance();
      reloaded.push('TranslationService (reset)');
    } catch (e: any) {
      errors.push(`TranslationService reset: ${e.message}`);
    }

    // 5. Stop LiveLyricsService sessions
    try {
      if (this.liveLyricsService) {
        await this.liveLyricsService.stopAllSessions();
        reloaded.push('LiveLyricsService (sessions stopped)');
      }
    } catch (e: any) {
      errors.push(`LiveLyricsService stop: ${e.message}`);
    }

    // 6. Clear require cache for services and utils that hold state
    this.clearRequireCache(path.join(process.cwd(), 'dist', 'services'));
    this.clearRequireCache(path.join(process.cwd(), 'dist', 'utils', 'PeriodicMessageSystem.js'));

    // 7. Re-instantiate per-bot services
    try {
      const { LavaSrcConfigService: FreshLavaSrc } = require('../services/LavaSrcConfigService.js');
      this.lavaSrcConfigService = new FreshLavaSrc(this.manager);

      const { YouTubeConfigService: FreshYouTube } = require('../services/YouTubeConfigService.js');
      this.youTubeConfigService = new FreshYouTube(this.manager);

      const { LiveLyricsService: FreshLyrics } = require('../services/LiveLyricsService.js');
      this.liveLyricsService = new FreshLyrics(this);

      reloaded.push('LavaSrcConfigService', 'YouTubeConfigService', 'LiveLyricsService');
    } catch (e: any) {
      errors.push(`Service re-instantiation: ${e.message}`);
    }

    // 8. Restart global services
    try {
      const { PeriodicMessageSystem: FreshPeriodic } = require('../utils/PeriodicMessageSystem');
      FreshPeriodic.startPeriodicCheck();
      reloaded.push('PeriodicMessageSystem (restarted)');
    } catch (e: any) {
      errors.push(`PeriodicMessageSystem restart: ${e.message}`);
    }

    try {
      const { TemporaryAnnouncementService: FreshTempAnnounce } = require('../services/TemporaryAnnouncementService');
      FreshTempAnnounce.startIntervalCheck();
      reloaded.push('TemporaryAnnouncementService (restarted)');
    } catch (e: any) {
      errors.push(`TemporaryAnnouncementService restart: ${e.message}`);
    }

    try {
      const { startCleanupScheduler: freshStartCleanup } = require('../services/DatabaseCleanup');
      freshStartCleanup();
      reloaded.push('DatabaseCleanup (restarted)');
    } catch (e: any) {
      errors.push(`DatabaseCleanup restart: ${e.message}`);
    }

    this.logger.info(`Hot reloaded services: ${reloaded.join(', ')}`);
    return { success: errors.length === 0, reloaded, errors };
  }
}