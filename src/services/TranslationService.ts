/**
 * Translation Service
 * Handles automatic translation of text using Google Translate API
 * with database persistence and in-memory LRU caching for performance optimization
 */

import translate from 'google-translate-api-x';
import { PrismaClient } from '@prisma/client';
import Logger from '../structures/Logger';

const logger = new Logger('TranslationService');

// Lazy-load Prisma client to avoid issues during import
let _prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
	if (!_prisma) {
		_prisma = new PrismaClient();
	}
	return _prisma;
}

/**
 * Cache entry for storing translated text in memory
 */
interface MemoryCacheEntry {
	/** The translated text */
	translatedText: string;
	/** Timestamp when the entry was created (in milliseconds) */
	createdAt: number;
	/** The source language ISO code */
	sourceLang: string;
	/** The target language ISO code */
	targetLang: string;
}

/**
 * LRU Cache node for doubly-linked list implementation
 */
interface LRUNode {
	key: string;
	entry: MemoryCacheEntry;
	prev: LRUNode | null;
	next: LRUNode | null;
}

/**
 * Mapping from internal language names to ISO 639-1 codes
 * Used by Google Translate API
 */
const LANGUAGE_TO_ISO_MAP: Record<string, string> = {
	ChineseCN: 'zh-CN',
	ChineseTW: 'zh-TW',
	Dutch: 'nl',
	EnglishUS: 'en',
	French: 'fr',
	German: 'de',
	Hindi: 'hi',
	Indonesian: 'id',
	Italian: 'it',
	Japanese: 'ja',
	Korean: 'ko',
	Norwegian: 'no',
	Polish: 'pl',
	PortuguesePT: 'pt',
	Russian: 'ru',
	SpanishES: 'es',
	Thai: 'th',
	Turkish: 'tr',
	Vietnamese: 'vi',
};

/**
 * Default TTL for cache entries (24 hours in milliseconds)
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Default maximum in-memory cache size (number of entries)
 */
const DEFAULT_MAX_CACHE_SIZE = 1000;

/**
 * TranslationService class
 * Provides translation functionality with database persistence and in-memory LRU caching
 */
export class TranslationService {
	/** In-memory cache storage using Map for O(1) lookups */
	private memoryCache: Map<string, LRUNode> = new Map();

	/** Head of the doubly-linked list (most recently used) */
	private head: LRUNode | null = null;

	/** Tail of the doubly-linked list (least recently used) */
	private tail: LRUNode | null = null;

	/** Maximum number of entries in the in-memory cache */
	private maxCacheSize: number;

	/** Time-to-live for cache entries in milliseconds */
	private ttlMs: number;

	/** Source language for translations (default: auto-detect) */
	private defaultSourceLang: string = 'auto';

	/** Singleton instance */
	private static instance: TranslationService | null = null;

	/** Flag to track if cleanup interval is running */
	private cleanupInterval: NodeJS.Timeout | null = null;

	/**
	 * Private constructor for singleton pattern
	 * @param maxCacheSize Maximum number of in-memory cache entries
	 * @param ttlMs Time-to-live for cache entries in milliseconds
	 */
	private constructor(maxCacheSize: number = DEFAULT_MAX_CACHE_SIZE, ttlMs: number = DEFAULT_TTL_MS) {
		this.maxCacheSize = maxCacheSize;
		this.ttlMs = ttlMs;
		this.startCleanupInterval();
		logger.info(`TranslationService initialized with max cache size: ${maxCacheSize}, TTL: ${ttlMs}ms`);
	}

	/**
	 * Get the singleton instance of TranslationService
	 * @param maxCacheSize Maximum number of cache entries (only used on first call)
	 * @param ttlMs Time-to-live for cache entries (only used on first call)
	 */
	public static getInstance(maxCacheSize?: number, ttlMs?: number): TranslationService {
		if (!TranslationService.instance) {
			TranslationService.instance = new TranslationService(maxCacheSize, ttlMs);
		}
		return TranslationService.instance;
	}

	/**
	 * Reset the singleton instance (useful for testing)
	 */
	public static resetInstance(): void {
		if (TranslationService.instance) {
			TranslationService.instance.stopCleanupInterval();
		}
		TranslationService.instance = null;
	}

	/**
	 * Start the periodic cleanup interval for expired cache entries
	 * Runs every hour to clean up expired entries from both memory and database
	 */
	private startCleanupInterval(): void {
		if (this.cleanupInterval) return;

		// Run cleanup every hour
		this.cleanupInterval = setInterval(
			async () => {
				try {
					await this.cleanupExpired();
				} catch (error) {
					logger.error('Error during scheduled cleanup:', error);
				}
			},
			60 * 60 * 1000
		); // 1 hour

		logger.info('Started translation cache cleanup interval');
	}

	/**
	 * Stop the cleanup interval
	 */
	private stopCleanupInterval(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
			logger.info('Stopped translation cache cleanup interval');
		}
	}

	/**
	 * Generate a cache key from text and language codes
	 * @param text The text to translate
	 * @param sourceLang Source language ISO code
	 * @param targetLang Target language ISO code
	 * @returns A unique cache key
	 */
	private generateCacheKey(text: string, sourceLang: string, targetLang: string): string {
		const textHash = this.simpleHash(text);
		return `${sourceLang}:${targetLang}:${textHash}`;
	}

	/**
	 * Simple hash function for strings
	 * @param str The string to hash
	 * @returns A hash string
	 */
	private simpleHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return hash.toString(36);
	}

	/**
	 * Move a node to the head of the LRU list (most recently used)
	 * @param node The node to move
	 */
	private moveToHead(node: LRUNode): void {
		if (node === this.head) return;

		if (node.prev) {
			node.prev.next = node.next;
		}
		if (node.next) {
			node.next.prev = node.prev;
		}

		if (node === this.tail) {
			this.tail = node.prev;
		}

		node.prev = null;
		node.next = this.head;
		if (this.head) {
			this.head.prev = node;
		}
		this.head = node;

		if (!this.tail) {
			this.tail = node;
		}
	}

	/**
	 * Add a new entry to the in-memory cache
	 * @param key The cache key
	 * @param entry The cache entry
	 */
	private addToMemoryCache(key: string, entry: MemoryCacheEntry): void {
		while (this.memoryCache.size >= this.maxCacheSize && this.tail) {
			this.memoryCache.delete(this.tail.key);
			if (this.tail.prev) {
				this.tail.prev.next = null;
			}
			this.tail = this.tail.prev;
		}

		const node: LRUNode = {
			key,
			entry,
			prev: null,
			next: this.head,
		};

		if (this.head) {
			this.head.prev = node;
		}
		this.head = node;

		if (!this.tail) {
			this.tail = node;
		}

		this.memoryCache.set(key, node);
	}

	/**
	 * Get an entry from the in-memory cache
	 * @param key The cache key
	 * @returns The cache entry or null if not found or expired
	 */
	private getFromMemoryCache(key: string): MemoryCacheEntry | null {
		const node = this.memoryCache.get(key);
		if (!node) return null;

		const now = Date.now();
		if (now - node.entry.createdAt > this.ttlMs) {
			this.memoryCache.delete(key);
			if (node.prev) {
				node.prev.next = node.next;
			}
			if (node.next) {
				node.next.prev = node.prev;
			}
			if (node === this.head) {
				this.head = node.next;
			}
			if (node === this.tail) {
				this.tail = node.prev;
			}
			return null;
		}

		this.moveToHead(node);
		return node.entry;
	}

	/**
	 * Get an entry from the database cache
	 * @param textHash The hash of the text
	 * @param sourceLang Source language ISO code
	 * @param targetLang Target language ISO code
	 * @returns The translated text or null if not found or expired
	 */
	private async getFromDatabaseCache(
		textHash: string,
		sourceLang: string,
		targetLang: string
	): Promise<string | null> {
		try {
			const prisma = getPrisma();
			const cached = await prisma.translationCache.findUnique({
				where: {
					textHash_sourceLang_targetLang: {
						textHash,
						sourceLang,
						targetLang,
					},
				},
			});

			if (!cached) return null;

			// Check if expired
			if (cached.expiresAt <= new Date()) {
				// Delete expired entry
				await prisma.translationCache.delete({
					where: { id: cached.id },
				});
				return null;
			}

			logger.debug(`Database cache hit for translation to ${targetLang}`);
			return cached.translatedText;
		} catch (error) {
			logger.error('Error reading from database cache:', error);
			return null;
		}
	}

	/**
	 * Save a translation to the database cache
	 * @param textHash The hash of the original text
	 * @param sourceText The original text
	 * @param sourceLang Source language ISO code
	 * @param targetLang Target language ISO code
	 * @param translatedText The translated text
	 */
	private async saveToDatabaseCache(
		textHash: string,
		sourceText: string,
		sourceLang: string,
		targetLang: string,
		translatedText: string
	): Promise<void> {
		try {
			const prisma = getPrisma();
			const expiresAt = new Date(Date.now() + this.ttlMs);

			await prisma.translationCache.upsert({
				where: {
					textHash_sourceLang_targetLang: {
						textHash,
						sourceLang,
						targetLang,
					},
				},
				update: {
					translatedText,
					sourceText,
					expiresAt,
				},
				create: {
					textHash,
					sourceText,
					sourceLang,
					targetLang,
					translatedText,
					expiresAt,
				},
			});

			logger.debug(`Saved translation to database cache for ${targetLang}`);
		} catch (error) {
			logger.error('Error saving to database cache:', error);
		}
	}

	/**
	 * Convert internal language name to ISO code
	 * @param language Internal language name (e.g., "Vietnamese", "ChineseCN")
	 * @returns ISO 639-1 code or "en" as fallback
	 */
	public languageToIso(language: string): string {
		if (LANGUAGE_TO_ISO_MAP[language]) return LANGUAGE_TO_ISO_MAP[language];
		// Already an ISO code (e.g. a detected source language) — pass it through
		// rather than defaulting to English, so it can match a target and skip a
		// pointless same-language round-trip.
		const lower = language.toLowerCase();
		for (const iso of Object.values(LANGUAGE_TO_ISO_MAP)) {
			if (iso.toLowerCase() === lower) return iso;
		}
		return 'en';
	}

	/**
	 * Detect the ISO 639-1 language of a piece of text.
	 * @param text The text to inspect
	 * @returns The detected ISO code, or 'auto' if detection fails
	 */
	public async detectLanguage(text: string): Promise<string> {
		if (!text || text.trim().length === 0) return 'auto';
		try {
			// google-translate-api-x reports the detected source on any translation;
			// translating to English is the cheapest probe and its result is cached.
			const result = await translate(text, { to: 'en', autoCorrect: false });
			return (result as { from?: { language?: { iso?: string } } })?.from?.language?.iso || 'auto';
		} catch (error) {
			logger.error('Language detection failed:', error);
			return 'auto';
		}
	}

	/**
	 * Get all supported language codes
	 * @returns Array of ISO language codes
	 */
	public getSupportedLanguages(): string[] {
		return Object.keys(LANGUAGE_TO_ISO_MAP);
	}

	/**
	 * Check if a language is supported
	 * @param language Internal language name
	 * @returns True if the language is supported
	 */
	public isLanguageSupported(language: string): boolean {
		return language in LANGUAGE_TO_ISO_MAP;
	}

	/**
	 * Translate text to a target language
	 * @param text The text to translate
	 * @param targetLanguage The target language (internal name or ISO code)
	 * @param sourceLanguage The source language (optional, defaults to auto-detect)
	 * @returns Promise resolving to the translated text (or original text on error)
	 */
	public async translate(text: string, targetLanguage: string, sourceLanguage?: string): Promise<string> {
		if (!text || text.trim().length === 0) {
			return text;
		}

		const targetIso = this.languageToIso(targetLanguage);
		const sourceIso = sourceLanguage ? this.languageToIso(sourceLanguage) : this.defaultSourceLang;

		if (sourceIso !== 'auto' && sourceIso === targetIso) {
			return text;
		}

		const textHash = this.simpleHash(text);
		const cacheKey = this.generateCacheKey(text, sourceIso, targetIso);

		// 1. Check in-memory cache first
		const memoryCached = this.getFromMemoryCache(cacheKey);
		if (memoryCached) {
			logger.debug(`Memory cache hit for translation to ${targetIso}`);
			return memoryCached.translatedText;
		}

		// 2. Check database cache
		const dbCached = await this.getFromDatabaseCache(textHash, sourceIso, targetIso);
		if (dbCached) {
			// Store in memory cache for faster future access
			const entry: MemoryCacheEntry = {
				translatedText: dbCached,
				createdAt: Date.now(),
				sourceLang: sourceIso,
				targetLang: targetIso,
			};
			this.addToMemoryCache(cacheKey, entry);
			return dbCached;
		}

		// 3. Perform translation
		try {
			logger.debug(`Translating text to ${targetIso}...`);
			const result = await translate(text, {
				to: targetIso,
				from: sourceIso === 'auto' ? undefined : sourceIso,
				autoCorrect: false,
			});

			const translatedText = result.text;

			// 4. Save to both caches
			const entry: MemoryCacheEntry = {
				translatedText,
				createdAt: Date.now(),
				sourceLang: sourceIso,
				targetLang: targetIso,
			};
			this.addToMemoryCache(cacheKey, entry);
			await this.saveToDatabaseCache(textHash, text, sourceIso, targetIso, translatedText);

			logger.debug(
				`Translation completed for ${targetIso}: "${text.substring(0, 50)}..." -> "${translatedText.substring(0, 50)}..."`
			);
			return translatedText;
		} catch (error) {
			logger.error(`Translation failed for ${targetIso}:`, error);
			return text;
		}
	}

	/**
	 * Translate multiple texts to a target language in batch
	 * @param texts Array of texts to translate
	 * @param targetLanguage The target language (internal name or ISO code)
	 * @param sourceLanguage The source language (optional, defaults to auto-detect)
	 * @returns Promise resolving to an array of translated texts (or original texts on error)
	 */
	public async translateBatch(texts: string[], targetLanguage: string, sourceLanguage?: string): Promise<string[]> {
		if (texts.length === 0) {
			return [];
		}

		const targetIso = this.languageToIso(targetLanguage);
		const sourceIso = sourceLanguage ? this.languageToIso(sourceLanguage) : this.defaultSourceLang;

		if (sourceIso !== 'auto' && sourceIso === targetIso) {
			return [...texts];
		}

		const results: string[] = new Array(texts.length);
		const uncachedIndices: number[] = [];
		const uncachedTexts: string[] = [];
		const uncachedHashes: string[] = [];

		// Check caches for each text
		for (let i = 0; i < texts.length; i++) {
			const text = texts[i];
			if (!text || text.trim().length === 0) {
				results[i] = text;
				continue;
			}

			const textHash = this.simpleHash(text);
			const cacheKey = this.generateCacheKey(text, sourceIso, targetIso);

			// Check memory cache
			const memoryCached = this.getFromMemoryCache(cacheKey);
			if (memoryCached) {
				results[i] = memoryCached.translatedText;
				continue;
			}

			// Will check database cache and translate if needed
			results[i] = text; // Placeholder
			uncachedIndices.push(i);
			uncachedTexts.push(text);
			uncachedHashes.push(textHash);
		}

		// Check database cache for uncached texts
		const stillUncachedIndices: number[] = [];
		const stillUncachedTexts: string[] = [];
		const stillUncachedHashes: string[] = [];

		for (let i = 0; i < uncachedIndices.length; i++) {
			const originalIndex = uncachedIndices[i];
			const text = uncachedTexts[i];
			const textHash = uncachedHashes[i];

			const dbCached = await this.getFromDatabaseCache(textHash, sourceIso, targetIso);
			if (dbCached) {
				results[originalIndex] = dbCached;
				// Store in memory cache
				const cacheKey = this.generateCacheKey(text, sourceIso, targetIso);
				const entry: MemoryCacheEntry = {
					translatedText: dbCached,
					createdAt: Date.now(),
					sourceLang: sourceIso,
					targetLang: targetIso,
				};
				this.addToMemoryCache(cacheKey, entry);
			} else {
				stillUncachedIndices.push(originalIndex);
				stillUncachedTexts.push(text);
				stillUncachedHashes.push(textHash);
			}
		}

		// If all texts were cached, return results
		if (stillUncachedTexts.length === 0) {
			logger.debug(`All ${texts.length} texts found in cache for ${targetIso}`);
			return results;
		}

		// Perform batch translation for uncached texts
		try {
			logger.debug(`Batch translating ${stillUncachedTexts.length} texts to ${targetIso}...`);
			const translations = await translate(stillUncachedTexts, {
				to: targetIso,
				from: sourceIso === 'auto' ? undefined : sourceIso,
				autoCorrect: false,
			});

			const translationResults = Array.isArray(translations) ? translations : [translations];

			// Process and cache results
			for (let i = 0; i < stillUncachedIndices.length; i++) {
				const originalIndex = stillUncachedIndices[i];
				const originalText = stillUncachedTexts[i];
				const textHash = stillUncachedHashes[i];
				const translatedText = translationResults[i]?.text || originalText;
				results[originalIndex] = translatedText;

				// Save to memory cache
				const cacheKey = this.generateCacheKey(originalText, sourceIso, targetIso);
				const entry: MemoryCacheEntry = {
					translatedText,
					createdAt: Date.now(),
					sourceLang: sourceIso,
					targetLang: targetIso,
				};
				this.addToMemoryCache(cacheKey, entry);

				// Save to database cache
				await this.saveToDatabaseCache(textHash, originalText, sourceIso, targetIso, translatedText);
			}

			logger.debug(`Batch translation completed for ${targetIso}`);
			return results;
		} catch (error) {
			logger.error(`Batch translation failed for ${targetIso}:`, error);
			// Return original texts for failed translations
			for (const index of stillUncachedIndices) {
				results[index] = texts[index];
			}
			return results;
		}
	}

	/**
	 * Translate text to multiple target languages
	 * @param text The text to translate
	 * @param targetLanguages Array of target languages (internal names or ISO codes)
	 * @param sourceLanguage The source language (optional, defaults to auto-detect)
	 * @returns Promise resolving to a map of language code -> translated text
	 */
	public async translateToMany(
		text: string,
		targetLanguages: string[],
		sourceLanguage?: string
	): Promise<Map<string, string>> {
		const results = new Map<string, string>();

		const translations = await Promise.all(
			targetLanguages.map(async (lang) => {
				const translated = await this.translate(text, lang, sourceLanguage);
				return { lang, translated };
			})
		);

		for (const { lang, translated } of translations) {
			results.set(lang, translated);
		}

		return results;
	}

	/**
	 * Clear all entries from the in-memory cache
	 */
	public clearMemoryCache(): void {
		this.memoryCache.clear();
		this.head = null;
		this.tail = null;
		logger.info('Translation memory cache cleared');
	}

	/**
	 * Get cache statistics
	 * @returns Object with cache statistics
	 */
	public getCacheStats(): { memoryCacheSize: number; maxMemoryCacheSize: number; ttlMs: number } {
		return {
			memoryCacheSize: this.memoryCache.size,
			maxMemoryCacheSize: this.maxCacheSize,
			ttlMs: this.ttlMs,
		};
	}

	/**
	 * Remove expired entries from both memory and database caches
	 * @returns Number of entries removed
	 */
	public async cleanupExpired(): Promise<{ memory: number; database: number }> {
		const now = Date.now();
		let memoryRemoved = 0;

		// Clean memory cache
		const keysToDelete: string[] = [];
		for (const [key, node] of this.memoryCache.entries()) {
			if (now - node.entry.createdAt > this.ttlMs) {
				keysToDelete.push(key);
				if (node.prev) node.prev.next = node.next;
				if (node.next) node.next.prev = node.prev;
				if (node === this.head) this.head = node.next;
				if (node === this.tail) this.tail = node.prev;
				memoryRemoved++;
			}
		}
		for (const key of keysToDelete) {
			this.memoryCache.delete(key);
		}

		// Clean database cache
		let databaseRemoved = 0;
		try {
			const prisma = getPrisma();
			const result = await prisma.translationCache.deleteMany({
				where: {
					expiresAt: {
						lte: new Date(),
					},
				},
			});
			databaseRemoved = result.count;
		} catch (error) {
			logger.error('Error cleaning up database cache:', error);
		}

		const total = memoryRemoved + databaseRemoved;
		if (total > 0) {
			logger.info(`Cleaned up ${memoryRemoved} memory entries and ${databaseRemoved} database entries`);
		}

		return { memory: memoryRemoved, database: databaseRemoved };
	}

	/**
	 * Preload translations into cache from database for a specific announcement
	 * Useful for warming up the cache before sending announcements
	 * @param text The text to preload translations for
	 * @param targetLanguages Array of target languages to preload
	 * @param sourceLanguage The source language (optional)
	 */
	public async preloadTranslations(
		text: string,
		targetLanguages: string[],
		sourceLanguage?: string
	): Promise<void> {
		logger.info(`Preloading translations for ${targetLanguages.length} languages...`);
		await this.translateToMany(text, targetLanguages, sourceLanguage);
		logger.info('Translation preloading complete');
	}
}

export default TranslationService;
