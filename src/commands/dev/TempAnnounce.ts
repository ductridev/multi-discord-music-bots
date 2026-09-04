import { Command, type Context, type Lavamusic } from '../../structures/index';
import { EmbedBuilder } from 'discord.js';
import {
  createTemporaryAnnouncement,
  getTemporaryAnnouncementsByFilter,
  getTemporaryAnnouncement,
  deleteTemporaryAnnouncement,
  getTemporaryAnnouncementStats,
} from '../../utils/database/migration-new-dashboard';
import TemporaryAnnouncementService from '../../services/TemporaryAnnouncementService';

/**
 * Parse duration string to milliseconds
 * Supports: s (seconds), m (minutes), h (hours), d (days), w (weeks)
 * Examples: "30s", "5m", "2h", "1d", "1w", "1d12h30m"
 */
function parseDuration(durationStr: string): number {
  const regex = /(\d+)([smhdw])/g;
  let totalMs = 0;
  let match;

  const units: Record<string, number> = {
    s: 1000,           // seconds
    m: 60 * 1000,      // minutes
    h: 60 * 60 * 1000, // hours
    d: 24 * 60 * 60 * 1000, // days
    w: 7 * 24 * 60 * 60 * 1000, // weeks
  };

  while ((match = regex.exec(durationStr)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    totalMs += value * units[unit];
  }

  return totalMs;
}

/**
 * Format milliseconds to human-readable duration
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Format date to relative time or absolute date
 */
function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMs < 0) {
    return 'Expired';
  }

  if (diffDays > 0) {
    return `in ${diffDays}d ${diffHours % 24}h`;
  }
  if (diffHours > 0) {
    return `in ${diffHours}h ${diffMins % 60}m`;
  }
  return `in ${diffMins}m`;
}

export default class TempAnnounce extends Command {
  constructor(client: Lavamusic) {
    super(client, {
      name: 'tempannounce',
      description: {
        content: 'Manage temporary recurring announcements.',
        examples: [
          'tempannounce create "Title" "Description" 24h',
          'tempannounce list',
          'tempannounce info <id>',
          'tempannounce delete <id>',
          'tempannounce trigger <id>',
          'tempannounce cleanup',
          'tempannounce stats',
        ],
        usage: 'tempannounce <create|list|info|delete|trigger|cleanup|stats>',
      },
      category: 'dev',
      aliases: ['ta', 'tempa'],
      cooldown: 3,
      args: true,
      player: {
        voice: false,
        dj: false,
        active: false,
        djPerm: null,
      },
      permissions: {
        dev: true,
        client: ['SendMessages', 'ReadMessageHistory', 'ViewChannel', 'EmbedLinks'],
        user: [],
      },
      slashCommand: true,
      options: [
        {
          name: 'action',
          description: 'What to do',
          type: 3,
          required: true,
          choices: [
            { name: 'create', value: 'create' },
            { name: 'list', value: 'list' },
            { name: 'info', value: 'info' },
            { name: 'delete', value: 'delete' },
            { name: 'trigger', value: 'trigger' },
            { name: 'cleanup', value: 'cleanup' },
            { name: 'stats', value: 'stats' },
          ],
        },
        { name: 'id', description: 'Announcement id (info/delete/trigger)', type: 3, required: false },
        { name: 'title', description: 'Embed title (create)', type: 3, required: false },
        { name: 'description', description: 'Embed description (create)', type: 3, required: false },
        { name: 'duration', description: 'Time until expiry, e.g. 24h, 7d (create)', type: 3, required: false },
        { name: 'interval', description: 'Time between sends, e.g. 30m (create)', type: 3, required: false },
        {
          name: 'filter',
          description: 'List filter',
          type: 3,
          required: false,
          choices: [
            { name: 'all', value: 'all' },
            { name: 'active', value: 'active' },
            { name: 'expired', value: 'expired' },
          ],
        },
      ],
    });
  }

  public async run(client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
    // Slash options are rebuilt into the prefix-style args array so the
    // existing subcommand handlers run unchanged.
    if (ctx.isInteraction) {
      const action = (ctx.options.getString('action') ?? 'help').toLowerCase();
      if (action === 'create') {
        const title = ctx.options.getString('title') ?? '';
        const description = ctx.options.getString('description') ?? '';
        const duration = ctx.options.getString('duration') ?? '';
        const interval = ctx.options.getString('interval');
        args = ['create', `"${title}"`, `"${description}"`, duration, ...(interval ? [interval] : [])];
      } else if (action === 'list') {
        const filter = ctx.options.getString('filter');
        args = ['list', ...(filter ? [filter] : [])];
      } else if (['info', 'delete', 'trigger'].includes(action)) {
        args = [action, ctx.options.getString('id') ?? ''];
      } else {
        args = [action];
      }
    }

    const subCommand = args[0]?.toLowerCase();

    switch (subCommand) {
      case 'create':
        return this.handleCreate(client, ctx, args.slice(1));
      case 'list':
        return this.handleList(client, ctx, args.slice(1));
      case 'info':
        return this.handleInfo(client, ctx, args.slice(1));
      case 'delete':
        return this.handleDelete(client, ctx, args.slice(1));
      case 'trigger':
        return this.handleTrigger(client, ctx, args.slice(1));
      case 'cleanup':
        return this.handleCleanup(client, ctx);
      case 'stats':
        return this.handleStats(client, ctx);
      case 'help':
      default:
        return this.handleHelp(client, ctx);
    }
  }

  private async handleHelp(_client: Lavamusic, ctx: Context): Promise<any> {
    const embed = new EmbedBuilder()
      .setColor(this.client.color.main)
      .setTitle('📢 Temporary Announcement Commands')
      .setDescription('Manage temporary recurring announcements that automatically expire.')
      .addFields(
        {
          name: '`tempannounce create <title> <description> <duration> [interval]`',
          value: 'Create a new temporary announcement.\n' +
            '• `title` - Embed title (use quotes for spaces)\n' +
            '• `description` - Embed description (use quotes for spaces)\n' +
            '• `duration` - How long until expiration (e.g., 24h, 7d, 1w)\n' +
            '• `interval` - Time between sends (optional, default: 30m)',
        },
        {
          name: '`tempannounce list [filter]`',
          value: 'List all temporary announcements.\n' +
            '• `filter` - `all` (default), `active`, or `expired`',
        },
        {
          name: '`tempannounce info <id>`',
          value: 'Show details of a specific announcement.',
        },
        {
          name: '`tempannounce delete <id>`',
          value: 'Delete a temporary announcement.',
        },
        {
          name: '`tempannounce trigger <id>`',
          value: 'Manually trigger an announcement immediately.',
        },
        {
          name: '`tempannounce cleanup`',
          value: 'Remove all expired announcements from the database.',
        },
        {
          name: '`tempannounce stats`',
          value: 'Show announcement statistics.',
        }
      )
      .setFooter({
        text: `Requested by ${ctx.author?.tag}`,
        iconURL: ctx.author?.displayAvatarURL() || undefined,
      })
      .setTimestamp();

    return ctx.sendMessage({ embeds: [embed] });
  }

  private async handleCreate(_client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
    // Parse arguments - expecting: <title> <description> <duration> [interval]
    // Arguments can be quoted for spaces
    const parsedArgs: string[] = [];
    let currentArg = '';
    let inQuotes = false;

    for (const part of args) {
      // Handle arguments that BOTH start AND end with quotes (complete quoted string in one arg)
      if (part.startsWith('"') && part.endsWith('"') && part.length > 1) {
        if (inQuotes) {
          // If we were in quotes, close the current arg first
          currentArg += ' ' + part.slice(1, -1);
          parsedArgs.push(currentArg);
          currentArg = '';
          inQuotes = false;
        } else {
          // Standalone complete quoted string - just strip quotes
          parsedArgs.push(part.slice(1, -1));
        }
      } else if (part.startsWith('"') && !inQuotes) {
        inQuotes = true;
        currentArg = part.slice(1);
      } else if (part.endsWith('"') && inQuotes) {
        inQuotes = false;
        currentArg += ' ' + part.slice(0, -1);
        parsedArgs.push(currentArg);
        currentArg = '';
      } else if (inQuotes) {
        currentArg += ' ' + part;
      } else {
        parsedArgs.push(part);
      }
    }
    if (currentArg) {
      parsedArgs.push(currentArg);
    }

    const title = parsedArgs[0];
    const description = parsedArgs[1];

    if (!title || !description) {
      return ctx.sendMessage(
        '❌ Missing required arguments.\n' +
        'Usage: `tempannounce create "Title" "Description" <duration> [interval]`\n' +
        'Example: `tempannounce create "Maintenance" "Bot will restart in 2 hours" 24h 30m`'
      );
    }

    // Regex to match duration patterns like 30s, 5m, 2h, 1d, 1w
    const durationPattern = /^\d+[smhdw]$/;

    // First duration-matching argument is the duration (index 2)
    // Second duration-matching argument is the interval (index 3)
    // (title=0, description=1, duration=2, interval=3)
    const durationStr = parsedArgs[2];
    const intervalStr = (parsedArgs.length > 3 && durationPattern.test(parsedArgs[3]))
      ? parsedArgs[3]
      : undefined;

    if (!durationStr) {
      return ctx.sendMessage(
        '❌ Missing duration argument.\n' +
        'Usage: `tempannounce create "Title" "Description" <duration> [interval]`\n' +
        'Example: `tempannounce create "Maintenance" "Bot will restart in 2 hours" 1w 30m 1h`'
      );
    }

    // Parse duration
    const durationMs = parseDuration(durationStr);
    if (durationMs <= 0) {
      return ctx.sendMessage(
        '❌ Invalid duration format. Use formats like: 30m, 2h, 1d, 1w, or combinations like 1d12h'
      );
    }

    // Parse interval (default: 30 minutes)
    let intervalMs = 30 * 60 * 1000;
    if (intervalStr) {
      intervalMs = parseDuration(intervalStr);
      if (intervalMs <= 0) {
        return ctx.sendMessage(
          '❌ Invalid interval format. Use formats like: 30m, 1h, 2h'
        );
      }
    }

    // Ensure interval is not longer than duration
    if (intervalMs > durationMs) {
      return ctx.sendMessage(
        '❌ Interval cannot be longer than the duration.'
      );
    }

    // Calculate expiration time
    const expiresAt = new Date(Date.now() + durationMs);

    try {
      const announcement = await createTemporaryAnnouncement({
        title,
        description,
        intervalMs,
        expiresAt,
        createdBy: ctx.author?.id || 'unknown',
        createdByName: ctx.author?.username || ctx.author?.tag,
      });

      const embed = new EmbedBuilder()
        .setColor(this.client.color.main)
        .setTitle('✅ Temporary Announcement Created')
        .addFields(
          { name: 'ID', value: announcement.id, inline: true },
          { name: 'Title', value: title, inline: true },
          { name: 'Description', value: description.length > 200 ? description.slice(0, 200) + '...' : description, inline: false },
          { name: 'Interval', value: formatDuration(intervalMs), inline: true },
          { name: 'Expires', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`, inline: true },
          { name: 'Expires At', value: expiresAt.toISOString(), inline: true },
        )
        .setFooter({
          text: `Created by ${ctx.author?.tag}`,
          iconURL: ctx.author?.displayAvatarURL() || undefined,
        })
        .setTimestamp();

      return ctx.sendMessage({ embeds: [embed] });
    } catch (error) {
      console.error('Failed to create announcement:', error);
      return ctx.sendMessage(`❌ Failed to create announcement: ${error}`);
    }
  }

  private async handleList(_client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
    const filter = (args[0]?.toLowerCase() || 'all') as 'all' | 'active' | 'expired';

    if (!['all', 'active', 'expired'].includes(filter)) {
      return ctx.sendMessage('❌ Invalid filter. Use: `all`, `active`, or `expired`');
    }

    try {
      const announcements = await getTemporaryAnnouncementsByFilter(filter);

      if (announcements.length === 0) {
        return ctx.sendMessage(`No ${filter === 'all' ? '' : filter + ' '}announcements found.`);
      }

      const now = new Date();

      const embed = new EmbedBuilder()
        .setColor(this.client.color.main)
        .setTitle(`📢 Temporary Announcements (${filter})`)
        .setDescription(
          announcements
            .map((a) => {
              const isExpired = a.expiresAt <= now || !a.isActive;
              const status = isExpired ? '❌' : '✅';
              const expiresIn = a.expiresAt > now ? formatDate(a.expiresAt) : 'Expired';
              return `${status} **${a.title}**\n` +
                `   ID: \`${a.id}\`\n` +
                `   Expires: ${expiresIn} | Sends: ${a.sendCount}`;
            })
            .join('\n\n')
        )
        .setFooter({
          text: `Total: ${announcements.length} announcement(s)`,
        })
        .setTimestamp();

      return ctx.sendMessage({ embeds: [embed] });
    } catch (error) {
      console.error('Failed to list announcements:', error);
      return ctx.sendMessage(`❌ Failed to list announcements: ${error}`);
    }
  }

  private async handleInfo(_client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
    const id = args[0];

    if (!id) {
      return ctx.sendMessage('❌ Please provide an announcement ID.\nUsage: `tempannounce info <id>`');
    }

    try {
      const announcement = await getTemporaryAnnouncement(id);

      if (!announcement) {
        return ctx.sendMessage(`❌ Announcement with ID \`${id}\` not found.`);
      }

      const now = new Date();
      const isExpired = announcement.expiresAt <= now || !announcement.isActive;
      const lastSent = announcement.lastSentAt
        ? `<t:${Math.floor(announcement.lastSentAt.getTime() / 1000)}:R>`
        : 'Never';
      const createdAt = `<t:${Math.floor(announcement.createdAt.getTime() / 1000)}:R>`;
      const expiresAt = `<t:${Math.floor(announcement.expiresAt.getTime() / 1000)}:R>`;

      const embed = new EmbedBuilder()
        .setColor(isExpired ? this.client.color.red : this.client.color.main)
        .setTitle(`${isExpired ? '❌' : '✅'} ${announcement.title}`)
        .setDescription(announcement.description)
        .addFields(
          { name: 'ID', value: `\`${announcement.id}\``, inline: true },
          { name: 'Status', value: isExpired ? 'Expired/Inactive' : 'Active', inline: true },
          { name: 'Send Count', value: `${announcement.sendCount}`, inline: true },
          { name: 'Interval', value: formatDuration(announcement.intervalMs), inline: true },
          { name: 'Created', value: createdAt, inline: true },
          { name: 'Expires', value: expiresAt, inline: true },
          { name: 'Last Sent', value: lastSent, inline: true },
          { name: 'Created By', value: announcement.createdByName || `<@${announcement.createdBy}>`, inline: true },
          { name: 'Color', value: `#${announcement.color || '5865F2'}`, inline: true },
        )
        .setFooter({
          text: `Requested by ${ctx.author?.tag}`,
          iconURL: ctx.author?.displayAvatarURL() || undefined,
        })
        .setTimestamp();

      return ctx.sendMessage({ embeds: [embed] });
    } catch (error) {
      console.error('Failed to get announcement info:', error);
      return ctx.sendMessage(`❌ Failed to get announcement info: ${error}`);
    }
  }

  private async handleDelete(_client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
    const id = args[0];

    if (!id) {
      return ctx.sendMessage('❌ Please provide an announcement ID.\nUsage: `tempannounce delete <id>`');
    }

    try {
      // First check if it exists
      const announcement = await getTemporaryAnnouncement(id);

      if (!announcement) {
        return ctx.sendMessage(`❌ Announcement with ID \`${id}\` not found.`);
      }

      await deleteTemporaryAnnouncement(id);

      const embed = new EmbedBuilder()
        .setColor(this.client.color.red)
        .setTitle('🗑️ Announcement Deleted')
        .setDescription(`Successfully deleted announcement **${announcement.title}**`)
        .addFields(
          { name: 'ID', value: `\`${id}\``, inline: true },
          { name: 'Total Sends', value: `${announcement.sendCount}`, inline: true },
        )
        .setTimestamp();

      return ctx.sendMessage({ embeds: [embed] });
    } catch (error) {
      console.error('Failed to delete announcement:', error);
      return ctx.sendMessage(`❌ Failed to delete announcement: ${error}`);
    }
  }

  private async handleTrigger(_client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
    const id = args[0];

    if (!id) {
      return ctx.sendMessage('❌ Please provide an announcement ID.\nUsage: `tempannounce trigger <id>`');
    }

    try {
      const result = await TemporaryAnnouncementService.triggerAnnouncement(id);

      if (!result.success) {
        return ctx.sendMessage(`❌ Failed to trigger announcement: ${result.error}`);
      }

      return ctx.sendMessage(`✅ Announcement triggered successfully! Sent to ${result.sentCount} channel(s).`);
    } catch (error) {
      console.error('Failed to trigger announcement:', error);
      return ctx.sendMessage(`❌ Failed to trigger announcement: ${error}`);
    }
  }

  private async handleCleanup(_client: Lavamusic, ctx: Context): Promise<any> {
    try {
      const deleted = await TemporaryAnnouncementService.cleanupExpired();

      const embed = new EmbedBuilder()
        .setColor(this.client.color.main)
        .setTitle('🧹 Cleanup Complete')
        .setDescription(`Deleted **${deleted}** expired announcement(s)`)
        .setTimestamp();

      return ctx.sendMessage({ embeds: [embed] });
    } catch (error) {
      console.error('Failed to cleanup announcements:', error);
      return ctx.sendMessage(`❌ Failed to cleanup announcements: ${error}`);
    }
  }

  private async handleStats(_client: Lavamusic, ctx: Context): Promise<any> {
    try {
      const stats = await getTemporaryAnnouncementStats();

      const embed = new EmbedBuilder()
        .setColor(this.client.color.main)
        .setTitle('📊 Temporary Announcement Statistics')
        .addFields(
          { name: 'Total Announcements', value: `${stats.total}`, inline: true },
          { name: 'Active', value: `${stats.active}`, inline: true },
          { name: 'Expired', value: `${stats.expired}`, inline: true },
          { name: 'Total Sends', value: `${stats.totalSends}`, inline: true },
        )
        .setFooter({
          text: `Requested by ${ctx.author?.tag}`,
          iconURL: ctx.author?.displayAvatarURL() || undefined,
        })
        .setTimestamp();

      return ctx.sendMessage({ embeds: [embed] });
    } catch (error) {
      console.error('Failed to get announcement stats:', error);
      return ctx.sendMessage(`❌ Failed to get announcement stats: ${error}`);
    }
  }
}
