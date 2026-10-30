import { t } from "../shared/i18n.ts";
import { DEFAULT_PRESET, MAX_PRESETS, PRESETS, type Preset, presetError, presetOn } from "../shared/presets.ts";
import {
	CALLS_PER_ANSWER,
	isAnswerLanguage,
	isProvider,
	isThinking,
	isWhenBusy,
	RECOMMENDED_MODELS,
	type Settings,
	type SettingsChange,
	type ToolModes,
} from "../shared/protocol.ts";

const SETTINGS_KEY = "settings";

/** New profiles follow Chrome; the effective answer language is resolved when a request is prepared. */
export function defaultSettings(): Settings {
	return {
		openaiWebSearch: true,
		model: { provider: "openrouter", modelId: RECOMMENDED_MODELS.openrouter },
		selectionAction: "send",
		enterWhileBusy: "steer",
		defaultPreset: DEFAULT_PRESET,
		language: "auto",
		thinking: "off",
		prompts: [...PRESETS],
		// run_script is offered only while Chrome's Allow User Scripts switch is on too (design 6.23).
		tools: { read: "on", observe: "on", act: "ask", script: "ask", screenshot: "on" },
		callsPerAnswer: CALLS_PER_ANSWER.default,
	};
}

/** Stored settings over the defaults: a missing or invalid field takes its default. */
export function readSettings(stored: unknown, defaults: Settings): Settings {
	const value = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
	const model = (typeof value.model === "object" && value.model !== null ? value.model : {}) as Record<
		string,
		unknown
	>;
	const { provider, modelId } = model;
	const { selectionAction, enterWhileBusy, defaultPreset, language, thinking, callsPerAnswer } = value;
	const prompts = readPrompts(value.prompts) ?? defaults.prompts;
	// The default is a prompt that is on: Ask pi and the hotkey use it.
	const known = (id: unknown): id is string => prompts.some((preset) => preset.id === id && presetOn(preset));
	return {
		openaiWebSearch: typeof value.openaiWebSearch === "boolean" ? value.openaiWebSearch : defaults.openaiWebSearch,
		model:
			typeof provider === "string" && isProvider(provider) && typeof modelId === "string" && modelId !== ""
				? { provider, modelId }
				: defaults.model,
		selectionAction:
			selectionAction === "send" || selectionAction === "compose" ? selectionAction : defaults.selectionAction,
		enterWhileBusy: isWhenBusy(enterWhileBusy) ? enterWhileBusy : defaults.enterWhileBusy,
		// A default that is gone, such as a deleted prompt, hands over to the first prompt that is on.
		defaultPreset: known(defaultPreset)
			? defaultPreset
			: typeof defaultPreset !== "string" && known(defaults.defaultPreset)
				? defaults.defaultPreset
				: prompts.find(presetOn)!.id,
		language: isAnswerLanguage(language) ? language : defaults.language,
		thinking: isThinking(thinking) ? thinking : defaults.thinking,
		prompts,
		tools: readTools(value.tools, defaults.tools),
		callsPerAnswer:
			typeof callsPerAnswer === "number" && Number.isInteger(callsPerAnswer)
				? Math.min(CALLS_PER_ANSWER.max, Math.max(CALLS_PER_ANSWER.min, callsPerAnswer))
				: defaults.callsPerAnswer,
	};
}

function readTools(stored: unknown, defaults: ToolModes): ToolModes {
	const { read, observe, act, script, screenshot } = (
		typeof stored === "object" && stored !== null ? stored : {}
	) as Record<string, unknown>;
	const onOff = (mode: unknown) => mode === "off" || mode === "on";
	const mode = (value: unknown) => onOff(value) || value === "ask";
	return {
		read: onOff(read) ? (read as ToolModes["read"]) : defaults.read,
		observe: onOff(observe) ? (observe as ToolModes["observe"]) : defaults.observe,
		act: mode(act) ? (act as ToolModes["act"]) : defaults.act,
		script: mode(script) ? (script as ToolModes["script"]) : defaults.script,
		screenshot: onOff(screenshot) ? (screenshot as ToolModes["screenshot"]) : defaults.screenshot,
	};
}

/** The stored prompts that can be used, in order, at least one of them on; undefined when none can be used. */
function readPrompts(stored: unknown): Preset[] | undefined {
	if (!Array.isArray(stored)) return undefined;
	const prompts: Preset[] = [];
	for (const item of stored as unknown[]) {
		if (prompts.length === MAX_PRESETS) break;
		if (typeof item !== "object" || item === null) continue;
		const { id, name, template, off } = item as Record<string, unknown>;
		if (typeof id !== "string" || id === "" || typeof name !== "string" || typeof template !== "string") continue;
		const preset: Preset = { id, name: name.trim(), template, ...(off === true ? { off } : {}) };
		if (prompts.some((other) => other.id === id) || presetError(preset, prompts) !== undefined) continue;
		prompts.push(preset);
	}
	if (prompts.length === 0) return undefined;
	// Ask pi needs a prompt that is on: with none, the first is.
	if (!prompts.some(presetOn)) prompts[0] = withOff(prompts[0]!, false);
	return prompts;
}

/** The prompt as it is stored: `off` only when true, so a built-in prompt that is on equals its `PRESETS` entry. */
function withOff({ id, name, template }: Preset, off: boolean): Preset {
	return { id, name, template, ...(off ? { off: true as const } : {}) };
}

/**
 * The prompts with `preset` saved: replaced where its ID is, added at the end otherwise. Throws why it cannot be. A
 * replaced prompt stays on or off as saved, whatever `preset` says, and a new one is on: only `switchedPreset()` turns
 * a prompt on or off, so a save from a form opened earlier does not undo another panel's switch.
 */
export function withPreset(prompts: readonly Preset[], preset: Preset): Preset[] {
	const old = prompts.find((other) => other.id === preset.id);
	const saved = withOff({ ...preset, name: preset.name.trim() }, old !== undefined && !presetOn(old));
	const replaces = old !== undefined;
	const error =
		saved.id === ""
			? t("promptIdMissing")
			: (presetError(saved, prompts)?.text ??
				(!replaces && prompts.length >= MAX_PRESETS ? t("promptLimit", [MAX_PRESETS]) : undefined));
	if (error !== undefined) throw new Error(error);
	return replaces ? prompts.map((other) => (other.id === saved.id ? saved : other)) : [...prompts, saved];
}

/** The prompts with `id` moved `by` places, as far as the ends allow; unchanged when `id` is not among them. */
export function movedPreset(prompts: readonly Preset[], id: string, by: number): Preset[] {
	const from = prompts.findIndex((preset) => preset.id === id);
	if (from < 0) return [...prompts];
	const to = Math.min(prompts.length - 1, Math.max(0, from + by));
	const moved = prompts.filter((preset) => preset.id !== id);
	moved.splice(to, 0, prompts[from]!);
	return moved;
}

/** The prompts without `id`. The last one that is on stays: "Ask pi" needs a default prompt. */
export function withoutPreset(prompts: readonly Preset[], id: string): Preset[] {
	const left = prompts.filter((preset) => preset.id !== id);
	if (!left.some(presetOn)) throw new Error(t("promptKeepOne"));
	return left;
}

/**
 * The prompts with `id` on or off; unchanged when `id` is not among them, as after another panel deleted it. The
 * default stays on: Ask pi uses it. Throws why it cannot be.
 */
export function switchedPreset(prompts: readonly Preset[], id: string, on: boolean, defaultPreset: string): Preset[] {
	if (!on && id === defaultPreset) throw new Error(t("promptDefaultOn"));
	return prompts.map((preset) => (preset.id === id ? withOff(preset, !on) : preset));
}

/**
 * A change from Settings: the tool modes it names replace those saved, the others stay. A default prompt that is off,
 * as when another panel turned it off first, throws: another default would not be what was chosen.
 */
export function settingsChange({ tools, ...rest }: SettingsChange): (current: Settings) => Partial<Settings> {
	return (current) => {
		const { defaultPreset } = rest;
		if (
			defaultPreset !== undefined &&
			current.prompts.some((preset) => preset.id === defaultPreset && !presetOn(preset))
		)
			throw new Error(t("promptOffDefault"));
		return { ...rest, ...(tools === undefined ? {} : { tools: { ...current.tools, ...tools } }) };
	};
}

let cached: Settings | undefined;
/** Policy already loaded by every page call; fail closed if used before loading. */
export function currentSettings(): Settings {
	if (cached === undefined) throw new Error("Settings are not loaded");
	return cached;
}
let loaded: Promise<Settings> | undefined;
let saving: Promise<unknown> = Promise.resolve();

/** Read from `storage.local` once per worker. */
export function loadSettings(): Promise<Settings> {
	if (loaded === undefined) {
		const loading = chrome.storage.local.get(SETTINGS_KEY).then((stored) => {
			cached = readSettings(stored[SETTINGS_KEY], defaultSettings());
			return cached;
		});
		loaded = loading;
		loading.catch(() => {
			if (loaded === loading) loaded = undefined;
		});
	}
	return loaded;
}

/**
 * Saves one at a time. A function gets the settings as saved so far, so two panels that edit prompts at once both keep
 * their change; if it throws, nothing is saved.
 */
export function saveSettings(
	change: Partial<Settings> | ((current: Settings) => Partial<Settings>),
): Promise<Settings> {
	const result = saving.then(async () => {
		const current = await loadSettings();
		const next = readSettings({ ...current, ...(typeof change === "function" ? change(current) : change) }, current);
		// Unedited prompts are not stored, so a later version's built-in prompts reach them.
		const { prompts, ...rest } = next;
		await chrome.storage.local.set({
			[SETTINGS_KEY]: JSON.stringify(prompts) === JSON.stringify(PRESETS) ? rest : next,
		});
		cached = next;
		loaded = Promise.resolve(next);
		return next;
	});
	saving = result.catch(() => {});
	return result;
}
