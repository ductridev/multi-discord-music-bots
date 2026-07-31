const fs = require('node:fs');
const path = require('node:path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');

// Keys to add to event.interaction. `from` names an event.message key to copy
// within the same file when present; `vi`/`en` are the fallbacks.
const KEYS = [
	{ key: 'voice_channel_full', from: 'voice_channel_full' },
	{ key: 'no_bots_configured', from: 'no_bots_configured' },
	{ key: 'no_free_bots', from: 'no_free_bots' },
	{ key: 'maintenance', from: 'maintenance' },
	{
		key: 'delegated_to_bot',
		from: null,
		vi: '**{bot}** sẽ xử lý lệnh này — bot đó đang rảnh và sắp vào kênh của bạn 🎶',
		en: '**{bot}** will handle this — it is free and joining your channel 🎶',
	},
];

const FALLBACK_VI = {
	voice_channel_full: 'Kênh <#{channel}> đầy rồi! Sang kênh khác hoặc tăng giới hạn thành viên 😅',
	no_bots_configured: 'Chưa có bot nhạc nào trong server! Mời bot vào trước nhé 🎵',
	no_free_bots: 'Không có bot nào rảnh! Thêm bot khác vào server xem 🤖',
	maintenance: 'Bot đang bảo trì! Quay lại sau nhé 🔧',
};

const FALLBACK_EN = {
	voice_channel_full: 'Channel <#{channel}> is full! Try another channel or raise the user limit 😅',
	no_bots_configured: 'No music bots here yet! Invite a bot first 🎵',
	no_free_bots: 'No bots available right now! Consider adding more bots to the server 🤖',
	maintenance: 'The bot is under maintenance! Check back soon 🔧',
};

let changed = 0;

for (const file of fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'))) {
	const full = path.join(LOCALES_DIR, file);
	const originalContent = fs.readFileSync(full, 'utf8');
	const json = JSON.parse(originalContent);

	json.event = json.event || {};
	json.event.interaction = json.event.interaction || {};
	const message = json.event.message || {};
	const isVietnamese = file === 'Vietnamese.json';

	const added = [];
	for (const spec of KEYS) {
		if (json.event.interaction[spec.key] !== undefined) continue;

		let value;
		if (spec.from && typeof message[spec.from] === 'string') {
			value = message[spec.from];
		} else if (isVietnamese) {
			value = spec.vi || FALLBACK_VI[spec.key];
		} else {
			value = spec.en || FALLBACK_EN[spec.key];
		}

		if (!value) throw new Error(`No value available for ${spec.key} in ${file}`);
		json.event.interaction[spec.key] = value;
		added.push(spec.key);
	}

	if (added.length > 0) {
		// Reuse whatever indentation this file already uses, so the diff shows only
		// the added keys. The first indented line of a JSON object is one indent
		// unit deep, so its leading whitespace is the unit.
		const indentMatch = originalContent.match(/\n([ \t]+)/);
		const indent = indentMatch ? indentMatch[1] : '\t';

		fs.writeFileSync(full, JSON.stringify(json, null, indent), 'utf8');
		changed++;
		console.log(`${file}: added ${added.join(', ')}`);
	} else {
		console.log(`${file}: nothing to add`);
	}
}

console.log(`\nPatched ${changed} file(s).`);
