const fs = require('node:fs');
const path = require('node:path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');

const VI =
	'⚠️ Lệnh prefix sắp ngừng hoạt động vì Discord thu hồi quyền đọc tin nhắn. Dùng lệnh gạch chéo `/{command}` hoặc nhắc tên bot: `@{bot} {command}` nhé!';
const EN =
	'⚠️ Prefix commands are going away — Discord is revoking message access. Use the slash command `/{command}` or mention the bot: `@{bot} {command}`';

let changed = 0;

for (const file of fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'))) {
	const full = path.join(LOCALES_DIR, file);
	const raw = fs.readFileSync(full, 'utf8');
	const json = JSON.parse(raw);

	json.event = json.event || {};
	json.event.message = json.event.message || {};
	json.event.interaction = json.event.interaction || {};

	let touched = false;

	if (json.event.interaction.slash_deprecated !== undefined) {
		delete json.event.interaction.slash_deprecated;
		touched = true;
	}

	if (json.event.message.prefix_deprecated === undefined) {
		json.event.message.prefix_deprecated = file === 'Vietnamese.json' ? VI : EN;
		touched = true;
	}

	if (touched) {
		// Reuse whatever indentation this file already uses, and append no
		// trailing newline — these files do not end with one. The first indented
		// line of a JSON object is one unit deep, so its leading whitespace is
		// the unit. 16 of the 19 files round-trip byte-identically this way.
		const indentMatch = raw.match(/\n([ \t]+)/);
		const indent = indentMatch ? indentMatch[1] : '\t';
		fs.writeFileSync(full, JSON.stringify(json, null, indent), 'utf8');
		changed++;
		console.log(`${file}: updated`);
	} else {
		console.log(`${file}: nothing to do`);
	}
}

console.log(`\nUpdated ${changed} file(s).`);
