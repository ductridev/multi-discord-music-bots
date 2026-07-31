import i18n from 'i18n';

import { Locale } from 'discord.js';
import { env } from '../env';
import { Language } from '../types';
import Logger from './Logger';

/**
 * The locale to use when a guild has no language set, and the locale
 * `retryInDefaultLocale` falls through to when a key is missing.
 *
 * This used to read `typeof defaultLanguage === 'string' ? defaultLanguage : 'Vietnamese'`
 * against the default export of `src/config.ts` — which is an object of colours
 * and emoji, never a string. The ternary was therefore always false, so
 * `DEFAULT_LANGUAGE` never reached i18n and the default was hardcoded to
 * Vietnamese no matter how the fleet was configured.
 *
 * `env.ts` types `DEFAULT_LANGUAGE` as a bare string with no check against the
 * `Language` enum, and i18n only loads the locales that enum names, so a value
 * outside it cannot serve as the default. Validated here and degraded to
 * Vietnamese with a warning rather than thrown, because an unrecognised locale
 * in `.env` should not take the whole fleet offline at boot.
 */
export const DEFAULT_LOCALE: string = (Object.keys(Language) as string[]).includes(env.DEFAULT_LANGUAGE)
	? env.DEFAULT_LANGUAGE
	: Language.Vietnamese;

export function initI18n(logger: Logger) {
	if (DEFAULT_LOCALE !== env.DEFAULT_LANGUAGE) {
		logger.warn(
			`DEFAULT_LANGUAGE="${env.DEFAULT_LANGUAGE}" is not a member of the Language enum, so i18n cannot load it. ` +
				`Falling back to ${DEFAULT_LOCALE}. Uncomment that language in src/types.ts to use it.`,
		);
	}

	i18n.configure({
		locales: Object.keys(Language),
		defaultLocale: DEFAULT_LOCALE,
		directory: `${process.cwd()}/locales`,
		retryInDefaultLocale: true,
		// i18n defaults this to true, which makes a missing key write itself into
		// locales/*.json at runtime — and a T() call with an unknown locale mint a
		// whole new file. That is how a stray locales/vi.json appeared earlier.
		// These files are source-controlled assets; missingKeyFn below already
		// handles the missing-key case without touching disk.
		updateFiles: false,
		objectNotation: true,
		register: global,
		logWarnFn: console.warn,
		logErrorFn: console.error,
		missingKeyFn: (_locale, value) => {
			return value;
		},
		mustacheConfig: {
			tags: ['{', '}'],
			disable: false,
		},
	});

	logger.info('I18n has been initialized');
}

export { i18n };

export function T(locale: string, text: string, ...params: any) {
	return i18n.__mf({ phrase: text, locale }, ...params);
}

export function localization(lan: keyof typeof Locale, name: any, desc: any) {
	return {
		name: [Locale[lan], name],
		description: [Locale[lan], T(lan, desc)],
	};
}

export function descriptionLocalization(name: any, text: any) {
	return i18n.getLocales().map((locale: string) => {
		// Check if the locale is a valid key of the Locale enum
		if (locale in Locale) {
			const localeValue = Locale[locale as keyof typeof Locale];
			return localization(localeValue as any, name, text);
		}
		// If locale is not in the enum, handle it accordingly
		return localization(locale as any, name, text); // You can choose how to handle this case
	});
}


