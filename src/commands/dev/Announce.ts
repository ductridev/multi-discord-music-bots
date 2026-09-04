import { Player } from 'lavalink-client';
import { sessionMap } from '../..';
import { Command, type Context, type Lavamusic } from '../../structures/index';
import { EmbedBuilder, TextChannel } from 'discord.js';
import { TranslationService } from '../../services/TranslationService';
import Logger from '../../structures/Logger';

const logger = new Logger('Announce');

export default class Announce extends Command {
    constructor(client: Lavamusic) {
        super(client, {
            name: 'announce',
            description: {
                content: 'Send a message to all active player text channels.',
                examples: ['announce Hello! We are updating!'],
                usage: 'announce <message>',
            },
            category: 'dev',
            aliases: ['broadcast'],
            cooldown: 3,
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
                { name: 'message', description: 'Message to broadcast', type: 3, required: true },
            ],
        });
    }

    public async run(client: Lavamusic, ctx: Context, args: string[]): Promise<any> {
        let content = args.join(' ');
        if (!content) content = ctx.locale('cmd.announce.messages.default_content');

        const originalTitle = '📢 Announcement';

        // Track sent channel IDs to prevent duplicates
        const sentChannelIds = new Set<string>();
        
        // Map to store channel info: channelId -> { guildId, language }
        const channelInfoMap = new Map<string, { guildId: string; language: string }>();
        
        // Set to collect all unique languages needed
        const languagesNeeded = new Set<string>();

        // First pass: collect all channels and their guild languages
        for (const guildMap of sessionMap.values()) {
            for (const player of guildMap.values()) {
                try {
                    const textChannelId = (player as Player)?.textChannelId;
                    const guildId = (player as Player)?.guildId;

                    // A player without a bound text channel or guild can't receive
                    // the announcement — skip it instead of upserting a null guildId.
                    if (!textChannelId || !guildId) continue;

                    // Skip if already processed this channel
                    if (channelInfoMap.has(textChannelId)) {
                        continue;
                    }

                    // Get guild's language setting
                    const guildData = await client.db.get(guildId);
                    const language = guildData?.language || 'EnglishUS';

                    channelInfoMap.set(textChannelId, { guildId, language });
                    languagesNeeded.add(language);
                } catch (e) {
                    logger.warn(`Failed to get language for guild ${(player as Player).guildId}:`, e);
                }
            }
        }

        if (channelInfoMap.size === 0) {
            return ctx.sendMessage('⚠️ No active player channels found.');
        }

        // Translate title and description to all needed languages
        const translationService = TranslationService.getInstance();
        const languageArray = Array.from(languagesNeeded);
        
        let titleTranslations: Map<string, string>;
        let contentTranslations: Map<string, string>;

        try {
            logger.info(`Translating announcement to ${languageArray.length} language(s): ${languageArray.join(', ')}`);
            
            // Detect the source language so a guild already in that language keeps
            // the original text verbatim instead of a Google round-trip that
            // paraphrases it (e.g. Vietnamese -> Vietnamese).
            const contentSource = await translationService.detectLanguage(content);

            // Translate both title and content to all languages
            [titleTranslations, contentTranslations] = await Promise.all([
                translationService.translateToMany(originalTitle, languageArray, 'en'),
                translationService.translateToMany(content, languageArray, contentSource),
            ]);
            
            logger.info('Translation completed successfully');
        } catch (error) {
            logger.error('Translation failed, using original text:', error);
            // Fall back to original text for all languages
            titleTranslations = new Map(languageArray.map(lang => [lang, originalTitle]));
            contentTranslations = new Map(languageArray.map(lang => [lang, content]));
        }

        // Create embeds for each language
        const embedsByLanguage = new Map<string, EmbedBuilder>();
        
        for (const language of languageArray) {
            const translatedTitle = titleTranslations.get(language) || originalTitle;
            const translatedContent = contentTranslations.get(language) || content;

            const embed = new EmbedBuilder()
                .setColor(this.client.color.main)
                .setTitle(translatedTitle)
                .setDescription(translatedContent)
                .setFooter({
                    text: `Sent by ${client.user?.tag} • BuNgo Music Bot 🎵`,
                    iconURL: client.user?.displayAvatarURL() || undefined,
                })
                .setTimestamp();

            embedsByLanguage.set(language, embed);
        }

        // Send translated embeds to each channel
        let sentCount = 0;
        let failedCount = 0;

        for (const [channelId, { language }] of channelInfoMap) {
            try {
                // Skip if already sent to this channel
                if (sentChannelIds.has(channelId)) {
                    continue;
                }

                const channel = client.channels.cache.get(channelId);
                if (channel && channel.isTextBased() && (channel as TextChannel).viewable && (channel as TextChannel).permissionsFor(client.user!)?.has(['SendMessages', 'EmbedLinks'])) {
                    const embed = embedsByLanguage.get(language) || embedsByLanguage.get('EnglishUS')!;
                    await (channel as TextChannel).send({ embeds: [embed] });
                    sentChannelIds.add(channelId);
                    sentCount++;
                }
            } catch (e) {
                logger.warn(`Failed to send announcement to channel ${channelId}:`, e);
                failedCount++;
            }
        }

        const resultMessage = `✅ Announcement sent to ${sentCount} channel(s) in ${languageArray.length} language(s).${failedCount > 0 ? ` (${failedCount} failed)` : ''}`;
        logger.info(resultMessage);
        
        return ctx.sendMessage(resultMessage);
    }
}
