import { activeBots } from '../..';
import { Command, type Context, type Lavamusic } from '../../structures/index';
import { compileTypeScript, isDockerEnvironment, reloadBot, type ReloadResult } from '../../utils/HotReload';

export default class Reload extends Command {
  constructor(client: Lavamusic) {
    super(client, {
      name: 'reload',
      description: {
        content: 'Hot reload commands, events, plugins, or services without restarting the bot.',
        examples: ['reload', 'reload events', 'reload services', 'reload all', 'reload commands --all'],
        usage: 'reload [commands|events|plugins|services|all] [--all] [--no-build]',
      },
      category: 'dev',
      aliases: ['hr', 'hotreload'],
      cooldown: 10,
      args: false,
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
          name: 'target',
          description: 'What to reload',
          type: 3,
          required: false,
          choices: [
            { name: 'commands', value: 'commands' },
            { name: 'events', value: 'events' },
            { name: 'plugins', value: 'plugins' },
            { name: 'services', value: 'services' },
            { name: 'all', value: 'all' },
          ],
        },
        { name: 'all', description: 'Reload every bot in the fleet', type: 5, required: false },
        { name: 'no_build', description: 'Skip the TypeScript build', type: 5, required: false },
      ],
    });
  }

  public async run(client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
    let target: 'commands' | 'events' | 'plugins' | 'services' | 'all';
    let reloadAllBots: boolean;
    let noBuild: boolean;

    if (ctx.isInteraction) {
      target = (ctx.options.getString('target') || 'commands') as typeof target;
      reloadAllBots = ctx.options.getBoolean('all') ?? false;
      noBuild = ctx.options.getBoolean('no_build') ?? false;
    } else {
      const flags = args.filter(a => a.startsWith('--'));
      const positional = args.filter(a => !a.startsWith('--'));
      target = (positional[0]?.toLowerCase() || 'commands') as typeof target;
      reloadAllBots = flags.includes('--all');
      noBuild = flags.includes('--no-build');
    }

    const inDocker = isDockerEnvironment();
    const skipBuild = inDocker || noBuild;

    if (!['commands', 'events', 'plugins', 'services', 'all'].includes(target)) {
      return ctx.sendMessage({
        embeds: [
          client.embed()
            .setColor(client.color.red)
            .setDescription(`Invalid target: \`${target}\`. Use: \`commands\`, \`events\`, \`plugins\`, \`services\`, or \`all\`.`)
        ],
      });
    }

    await ctx.sendMessage({
      embeds: [
        client.embed()
          .setColor(client.color.main)
          .setDescription(`${inDocker ? '🐳 Docker detected — reloading from dist/...' : skipBuild ? '⏭️ Skipping build...' : '🔨 Compiling TypeScript...'}\nTarget: \`${target}\` | Bots: \`${reloadAllBots ? 'all' : client.childEnv.name}\``)
      ],
    });

    // Step 1: Compile TypeScript (unless --no-build)
    if (!skipBuild) {
      const buildResult = await compileTypeScript();
      if (!buildResult.success) {
        const errorOutput = buildResult.output.length > 1500
          ? buildResult.output.substring(0, 1500) + '...'
          : buildResult.output;
        return ctx.editMessage({
          embeds: [
            client.embed()
              .setColor(client.color.red)
              .setTitle('❌ Build Failed')
              .setDescription(`\`\`\`\n${errorOutput}\n\`\`\``)
          ],
        });
      }
    }

    // Step 2: Reload target on selected bots
    const botsToReload = reloadAllBots ? activeBots : [client];
    const results: ReloadResult[] = [];

    for (const bot of botsToReload) {
      const result = await reloadBot(bot, target);
      results.push(result);
    }

    // Step 3: Build result embed
    const embed = client.embed().setTitle('🔄 Hot Reload Results');
    let allSuccess = true;

    for (const result of results) {
      const lines: string[] = [];

      if (result.commands) {
        const icon = result.commands.success ? '✅' : '❌';
        lines.push(`${icon} Commands: ${result.commands.loaded} loaded`);
        if (result.commands.errors.length > 0) {
          lines.push(`  Errors: ${result.commands.errors.join(', ')}`);
          allSuccess = false;
        }
      }
      if (result.events) {
        const icon = result.events.success ? '✅' : '❌';
        lines.push(`${icon} Events: ${result.events.loaded} loaded`);
        if (result.events.errors.length > 0) {
          lines.push(`  Errors: ${result.events.errors.join(', ')}`);
          allSuccess = false;
        }
      }
      if (result.plugins) {
        const icon = result.plugins.success ? '✅' : '❌';
        lines.push(`${icon} Plugins reloaded`);
        if (result.plugins.errors.length > 0) {
          lines.push(`  Errors: ${result.plugins.errors.join(', ')}`);
          allSuccess = false;
        }
      }
      if (result.services) {
        const icon = result.services.success ? '✅' : '❌';
        lines.push(`${icon} Services: ${result.services.reloaded.length} reloaded`);
        if (result.services.reloaded.length > 0) {
          lines.push(`  ${result.services.reloaded.join(', ')}`);
        }
        if (result.services.errors.length > 0) {
          lines.push(`  Errors: ${result.services.errors.join(', ')}`);
          allSuccess = false;
        }
      }

      embed.addFields({
        name: `Bot: ${result.bot}`,
        value: lines.join('\n') || 'No actions taken',
      });
    }

    embed.setColor(allSuccess ? client.color.green : client.color.red);

    return ctx.editMessage({ embeds: [embed] });
  }
}
