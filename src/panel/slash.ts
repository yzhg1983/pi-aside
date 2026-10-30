// Slash commands (design 6.33): a message that starts with `/name` runs that prompt. `/name text` fills `{{selection}}`
// with the text; `/name` alone runs it for the attached page, as the page menu does (6.18). A built-in prompt's name is
// its English ID in every interface language (`/explain`, `/reply`), also once edited; another prompt's is its name as
// Settings shows it, lowercase, with dashes for spaces ("解释代码" is `/解释代码`). The name as shown also works, and the
// list finds a prompt by any part of it, so `/解释` finds Explain in the Chinese interface. A message whose first word
// names no prompt is sent as typed, so "/etc/hosts?" stays a question.

import { fillTemplate, PAGE_SELECTION, PRESETS, type Preset, presetDisplayName, presetOn } from "../shared/presets.ts";
import type { Language } from "../shared/protocol.ts";

/** `alias`: the name as shown, as a command; the same as `command` for a prompt that is not built in. */
export type SlashCommand = { command: string; alias: string; name: string; preset: Preset };

/** "Translate to English" -> "translate-to-english". */
export function commandName(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * The commands of the prompts that are on, in their order; a name that two prompts share goes to the first. A prompt
 * that is off has none, so its `/name` is sent as typed.
 */
export function slashCommands(prompts: readonly Preset[], language: Language): SlashCommand[] {
	const commands: SlashCommand[] = [];
	for (const preset of prompts.filter(presetOn)) {
		const name = presetDisplayName(preset, language);
		const alias = commandName(name);
		const command = PRESETS.some((builtIn) => builtIn.id === preset.id) ? preset.id : alias;
		if (command !== "" && !commands.some((other) => other.command === command))
			commands.push({ command, alias, name, preset });
	}
	return commands;
}

/**
 * The commands to offer while the message is only a slash and what follows it: those whose name starts with it first,
 * then those whose name as shown starts with it, then those whose name as shown has it anywhere. `/` lists them all.
 */
export function matchingCommands(message: string, commands: readonly SlashCommand[]): SlashCommand[] {
	const typed = /^\/(\S*)$/.exec(message)?.[1];
	if (typed === undefined) return [];
	const part = typed.toLowerCase();
	const rank = (each: SlashCommand) =>
		each.command.startsWith(part) ? 0 : each.alias.startsWith(part) ? 1 : each.alias.includes(part) ? 2 : 3;
	return commands
		.map((each) => ({ each, rank: rank(each) }))
		.filter(({ rank }) => rank < 3)
		.sort((a, b) => a.rank - b.rank)
		.map(({ each }) => each);
}

export type Expanded =
	| { kind: "text"; text: string }
	/** `/name` alone with no page to run it for. */
	| { kind: "needs-text"; name: string };

/**
 * What to send for `message`; null when it is no command. `page` is the attached page, null for none. A prompt for
 * typed text without a page leaves out its source, so `this text from "{{title}}" ({{url}})` reads `this text`.
 */
export function expandCommand(
	message: string,
	commands: readonly SlashCommand[],
	language: Language,
	page: { title: string; url: string } | null,
): Expanded | null {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(message.trim());
	if (match === null) return null;
	const name = match[1]!.toLowerCase();
	const found = commands.find((each) => each.command === name) ?? commands.find((each) => each.alias === name);
	if (found === undefined) return null;
	const typed = match[2]?.trim() ?? "";
	if (typed === "" && page === null) return { kind: "needs-text", name: `/${found.command}` };
	const values = { selection: typed || PAGE_SELECTION, title: page?.title ?? "", url: page?.url ?? "", language };
	// Out of the template, not the filled text, so typed text that has the same words keeps them.
	const template =
		page === null ? found.preset.template.replaceAll(' from "{{title}}" ({{url}})', "") : found.preset.template;
	return { kind: "text", text: fillTemplate(template, values) };
}
