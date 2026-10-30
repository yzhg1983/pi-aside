// Prompts for selections ("presets" in the code). The user edits them in Settings; these are the built-in ones. A
// template may use only the variables below; any other `{{name}}` stays as written. A name may use `{{language}}`.
// The language a prompt answers in is in the prompt, after the selection, where the model reads it last (design 6.15).

import { type MessageKey, t } from "./i18n.ts";
import type { Language } from "./protocol.ts";

export const PRESET_VARIABLES = ["selection", "title", "url", "language"] as const;
export type PresetVariable = (typeof PRESET_VARIABLES)[number];

/** `off`: kept in Settings, but out of the pi menu and the slash commands (design 6.14); stored only when true. */
export type Preset = { id: string; name: string; template: string; off?: true };

/** In the pi menu and the slash commands. */
export function presetOn(preset: Preset): boolean {
	return preset.off !== true;
}

const SOURCE = 'this text from "{{title}}" ({{url}})';
/** The answer's language, for a prompt whose answer is not text in another language (Translate, Draft a reply). */
export const ANSWER = "\n\nAnswer in {{language}}.";

export const PRESETS: readonly Preset[] = [
	{ id: "explain", name: "Explain", template: `Explain ${SOURCE}:\n\n{{selection}}${ANSWER}` },
	{
		id: "summarize",
		name: "Summarize",
		template: `Summarize ${SOURCE} in a few sentences, then list its key points as short bullets:\n\n{{selection}}${ANSWER}`,
	},
	{
		id: "translate",
		name: "Translate to {{language}}",
		template: `Translate ${SOURCE} into {{language}}. Reply with the translation only.\n\n{{selection}}`,
	},
	{
		id: "proofread",
		name: "Proofread",
		template: `Proofread ${SOURCE}. Reply with the corrected text in its own language, then list the changes briefly.\n\n{{selection}}\n\nWrite the list of changes in {{language}}.`,
	},
	{
		id: "reply",
		name: "Draft a reply",
		template: `Draft a reply to ${SOURCE}, in its language and tone.\n\n{{selection}}`,
	},
];

export const DEFAULT_PRESET = "explain";
/** What `{{selection}}` becomes when a prompt is sent from the menu for the whole page: the page is attached instead. */
export const PAGE_SELECTION = "(the attached page)";
/** Each prompt is a context-menu item. */
export const MAX_PRESETS = 20;
export const MAX_PRESET_NAME = 60;
export const MAX_TEMPLATE_CHARS = 8000;

/** Why a prompt cannot be saved, and the field to fix; undefined when it can. Its name must be new in `presets`. */
export function presetError(
	preset: Preset,
	presets: readonly Preset[],
): { field: "name" | "template"; text: string } | undefined {
	const name = preset.name.trim();
	const same = (other: Preset) => other.id !== preset.id && other.name.trim().toLowerCase() === name.toLowerCase();
	if (name === "") return { field: "name", text: t("promptNameRequired") };
	if (name.length > MAX_PRESET_NAME) return { field: "name", text: t("promptNameTooLong", [MAX_PRESET_NAME]) };
	if (presets.some(same)) return { field: "name", text: t("promptNameDuplicate") };
	if (!preset.template.includes("{{selection}}")) return { field: "template", text: t("promptSelectionRequired") };
	if (preset.template.length > MAX_TEMPLATE_CHARS)
		return { field: "template", text: t("promptTemplateTooLong", [MAX_TEMPLATE_CHARS]) };
	return undefined;
}

/** Placeholders that are not variables, such as a misspelled `{{titel}}`: they stay as written. */
export function unknownVariables(template: string): string[] {
	const names = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!);
	return [...new Set(names)].filter((name) => !(PRESET_VARIABLES as readonly string[]).includes(name));
}

/**
 * Fills the allowlisted variables in one pass, so text that a value brings in, such as `{{url}}` inside a selection,
 * is never expanded.
 */
export function fillTemplate(template: string, values: Readonly<Record<PresetVariable, string>>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
		(PRESET_VARIABLES as readonly string[]).includes(name) ? values[name as PresetVariable] : match,
	);
}

/** The name with its language: "Translate to German". The other variables have no value here and stay as written. */
export function presetName(preset: Preset, language: string): string {
	// A function: a replacement string would expand `$&` in the language.
	return preset.name.replaceAll("{{language}}", () => language);
}

const PRESET_NAMES: Record<string, MessageKey> = {
	explain: "presetExplain",
	summarize: "presetSummarize",
	translate: "presetTranslate",
	proofread: "presetProofread",
	reply: "presetReply",
};

/** Translate display names only for exact built-ins; editable names, template bodies and custom variables stay canonical. */
export function presetDisplayName(preset: Preset, language: Language): string {
	const original = PRESETS.find((item) => item.id === preset.id);
	if (original === undefined || original.name !== preset.name || original.template !== preset.template)
		return presetName(preset, language);
	return t(PRESET_NAMES[original.id]!, [t(language === "Chinese" ? "languageChinese" : "languageEnglish")]);
}
