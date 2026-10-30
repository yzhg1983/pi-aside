import type { ConversationView } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TokenError, verifyIdToken } from "../src/background/chatgpt.ts";
import { chatMarkdown } from "../src/background/chats.ts";
import { buildMenus } from "../src/background/menus.ts";
import { projectChat } from "../src/background/projection.ts";
import { defaultSettings, loadSettings, readSettings, saveSettings } from "../src/background/settings.ts";
import { answerError } from "../src/panel/format.ts";
import { interfaceLocale, type MessageKey, t } from "../src/shared/i18n.ts";
import { effectiveAnswerLanguage } from "../src/shared/language.ts";
import { fillTemplate, PRESETS, presetDisplayName, presetError } from "../src/shared/presets.ts";
import { isAnswerLanguage } from "../src/shared/protocol.ts";
import english from "../static/_locales/en/messages.json" with { type: "json" };
import chinese from "../static/_locales/zh_CN/messages.json" with { type: "json" };

let locale = "en";
const stored = new Map<string, unknown>();
const removed = vi.fn();

beforeEach(async () => {
	locale = "en";
	stored.clear();
	removed.mockClear();
	vi.stubGlobal("chrome", {
		i18n: {
			getUILanguage: () => locale,
			getMessage: (key: string, values: string[] = []) => {
				const catalog: Record<string, { message: string }> = locale === "zh-CN" ? chinese : english;
				return (
					catalog[key]?.message.replace(/\$\$|\$([1-9])/g, (_match, index: string | undefined) =>
						index === undefined ? "$" : (values[Number(index) - 1] ?? ""),
					) ?? ""
				);
			},
		},
		storage: {
			local: {
				get: async (key: string) => ({ [key]: stored.get(key) }),
				set: async (items: Record<string, unknown>) => {
					for (const [key, value] of Object.entries(items)) stored.set(key, structuredClone(value));
				},
				remove: async (key: string) => {
					stored.delete(key);
				},
			},
		},
		runtime: {},
		contextMenus: {
			removeAll: (done: () => void) => {
				removed();
				done();
			},
			create: (_item: unknown, done: () => void) => {
				done();
			},
		},
	});
	await saveSettings(defaultSettings());
});

afterEach(() => vi.unstubAllGlobals());

it("accepts only automatic or canonical answer language choices", () => {
	for (const value of ["auto", "English", "Chinese"]) expect(isAnswerLanguage(value)).toBe(true);
	for (const value of ["跟随 Chrome", "中文", "en", "Auto", null, 1]) expect(isAnswerLanguage(value)).toBe(false);
	const defaults = defaultSettings();
	expect(defaults.language).toBe("auto");
	for (const value of [undefined, null, "中文", "auto"])
		expect(readSettings({ language: value }, defaults).language).toBe("auto");
	for (const value of ["Chinese", "English"]) expect(readSettings({ language: value }, defaults).language).toBe(value);
});

it.each(["en", "zh-CN", "fr", "zh-TW"])(
	"resolves auto in %s with the same supported locale as interface labels",
	(browserLocale) => {
		locale = browserLocale;
		const supported = browserLocale === "zh-CN";
		expect(interfaceLocale()).toBe(supported ? "zh-CN" : "en");
		expect(effectiveAnswerLanguage("auto")).toBe(supported ? "Chinese" : "English");
		expect(effectiveAnswerLanguage("English")).toBe("English");
		expect(effectiveAnswerLanguage("Chinese")).toBe("Chinese");
	},
);

it("keeps automatic answer choice stored after an unrelated save and resolves it at use time", async () => {
	await saveSettings({ language: "auto" });
	locale = "zh-CN";
	expect((await loadSettings()).language).toBe("auto");
	expect(effectiveAnswerLanguage((await loadSettings()).language)).toBe("Chinese");
	await saveSettings({ openaiWebSearch: false });
	expect(stored.get("settings")).toMatchObject({ language: "auto", openaiWebSearch: false });
	locale = "en";
	expect(effectiveAnswerLanguage((await loadSettings()).language)).toBe("English");
});

it("preserves explicit existing answer choices independently of interface locale", async () => {
	await saveSettings({ language: "English" });
	locale = "zh-CN";
	await saveSettings({ selectionAction: "compose" });
	expect(effectiveAnswerLanguage((await loadSettings()).language)).toBe("English");
	expect(stored.get("settings")).toMatchObject({ language: "English" });
	await saveSettings({ language: "Chinese" });
	locale = "fr";
	expect(effectiveAnswerLanguage((await loadSettings()).language)).toBe("Chinese");
});

it("fills canonical answer names, never auto or a translated option label, without changing prompt bodies", () => {
	locale = "zh-CN";
	const before = JSON.stringify(PRESETS);
	const language = effectiveAnswerLanguage("auto");
	const variables = { selection: "{{language}} is user text", title: "Title", url: "https://example.test/", language };
	for (const preset of PRESETS) {
		const filled = fillTemplate(preset.template, variables);
		expect(filled).toContain("{{language}} is user text");
		expect(filled).not.toContain("in auto");
		if (preset.id === "explain" || preset.id === "summarize") expect(filled).toContain("Answer in Chinese.");
		if (preset.id === "translate") expect(filled).toContain("into Chinese");
		if (preset.id === "proofread") expect(filled).toContain("own language");
		if (preset.id === "reply") expect(filled).toContain("in its language");
	}
	expect(JSON.stringify(PRESETS)).toBe(before);
});

it("translates exact built-in display names but not their canonical editor names or templates", () => {
	locale = "zh-CN";
	const expected = ["解释", "总结", "翻译为中文", "校对", "起草回复"];
	expect(PRESETS.map((preset) => presetDisplayName(preset, "Chinese"))).toEqual(expected);
	expect(presetDisplayName(PRESETS[2]!, "English")).toBe("翻译为英语");
	expect(PRESETS[0]!.name).toBe("Explain");
	expect(PRESETS[2]!.name).toBe("Translate to {{language}}");
	expect(PRESETS[0]!.template).toContain("Explain this text");
});

it("requires original ID, name and template before translating a built-in display name", () => {
	locale = "zh-CN";
	const original = PRESETS[0]!;
	for (const edited of [
		{ ...original, id: "custom" },
		{ ...original, name: "Explain my way" },
		{ ...original, template: `${original.template}\nBe brief.` },
	])
		expect(presetDisplayName(edited, "Chinese")).toBe(edited.name);
	const translate = { ...PRESETS[2]!, template: "My translation prompt: {{selection}}" };
	expect(presetDisplayName(translate, "Chinese")).toBe("Translate to Chinese");
});

it("does not persist translated labels, drop colliding custom names, or restore deleted/reordered prompts", async () => {
	locale = "zh-CN";
	const custom = { id: "mine", name: "解释", template: "My text: {{selection}}" };
	const edited = { ...PRESETS[2]!, template: `${PRESETS[2]!.template}\nCustom footer` };
	const prompts = [custom, edited, PRESETS[0]!];
	await saveSettings({ prompts, defaultPreset: "mine" });
	const before = structuredClone(stored.get("settings"));
	for (const browserLocale of ["en", "zh-CN", "fr"]) {
		locale = browserLocale;
		const current = await loadSettings();
		expect(current.prompts).toEqual(prompts);
		expect(readSettings(before, defaultSettings()).prompts).toEqual(prompts);
		expect(current.defaultPreset).toBe("mine");
		for (const preset of current.prompts) presetDisplayName(preset, effectiveAnswerLanguage(current.language));
	}
	await saveSettings({ openaiWebSearch: false });
	expect(stored.get("settings")).toMatchObject({ prompts, defaultPreset: "mine", language: "auto" });
	expect(prompts.map((preset) => preset.id)).toEqual(["mine", "translate", "explain"]);
});

it("validates canonical names, not localized display labels", () => {
	locale = "zh-CN";
	const custom = { id: "mine", name: "解释", template: "{{selection}}" };
	expect(presetError(custom, PRESETS)).toBeUndefined();
	expect(presetError({ ...custom, name: "" }, PRESETS)?.text).toBe(t("promptNameRequired"));
	expect(presetError({ ...custom, name: "Explain" }, PRESETS)?.text).toBe(t("promptNameDuplicate"));
});

it("rebuilds localized menus after Chrome restarts, preserving prompt order and answer-only overrides", async () => {
	await buildMenus(false);
	const englishMenus = structuredClone(stored.get("menus"));
	expect(englishMenus).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: "ask-pi", title: "Ask pi" }),
			expect.objectContaining({ id: "preset:translate", title: "Translate to English" }),
		]),
	);
	locale = "zh-CN";
	await buildMenus(false);
	expect(removed).toHaveBeenCalledTimes(2);
	expect(stored.get("menus")).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: "preset:explain", title: "解释" }),
			expect.objectContaining({ id: "preset:translate", title: "翻译为中文" }),
		]),
	);
	await buildMenus(false);
	expect(removed).toHaveBeenCalledTimes(2);
	await saveSettings({ language: "English" });
	await buildMenus(false);
	expect(stored.get("menus")).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: "preset:explain", title: "解释" }),
			expect.objectContaining({ id: "preset:translate", title: "翻译为英语" }),
		]),
	);
});

it("merges translated read notices by stable metadata and retains original user/model text and raw errors", () => {
	locale = "zh-CN";
	const read = (id: number, scope: "page" | "selection") => ({
		id,
		kind: "pi.toolResult",
		model: [
			{
				role: "toolResult",
				toolCallId: `c${id}`,
				toolName: "read_page",
				content: [{ type: "text", text: "{}" }],
				isError: false,
				details: { title: "Page title", scope },
			},
		],
	});
	const entries = [
		{ id: 1, kind: "pi.user", model: [{ role: "user", content: "Read the page: custom text", timestamp: 0 }] },
		read(2, "selection"),
		read(3, "selection"),
		read(4, "page"),
		read(5, "page"),
		{
			id: 6,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "An English answer" }],
					stopReason: "error",
					errorMessage: "429 provider-specific detail",
				},
			],
		},
	];
	const view = { conversation: { id: 7 }, entries, docs: {} } as unknown as ConversationView;
	const original = structuredClone(entries);
	const chat = projectChat(view);
	expect(chat.entries.map(({ id, read }) => [id, read])).toEqual([
		[1, undefined],
		[3, "selection"],
		[5, "page"],
		[6, undefined],
	]);
	expect(chat.entries[1]?.text).toBe(t("readCount", [t("readSelectionNotice", ["Page title"]), 2]));
	expect(chat.entries[2]?.text).toBe(t("readCount", [t("readPageNotice", ["Page title"]), 2]));
	expect(chat.entries[0]?.text).toBe("Read the page: custom text");
	expect(chat.entries[3]).toMatchObject({ text: "An English answer", error: "429 provider-specific detail" });
	expect(entries).toEqual(original);
});

it.each(["en", "zh-CN"])(
	"exports a stopped answer in %s without changing chat content or marking Stop as an error",
	(browserLocale) => {
		locale = browserLocale;
		const entries = [
			{ id: 1, kind: "pi.user", model: [{ role: "user", content: "My original question", timestamp: 0 }] },
			{
				id: 2,
				kind: "pi.assistant",
				model: [
					{ role: "assistant", content: [{ type: "text", text: "An English answer" }], stopReason: "aborted" },
				],
			},
			{
				id: 3,
				kind: "pi.assistant",
				model: [
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 provider-specific detail" },
				],
			},
		];
		const before = structuredClone(entries);
		const view = { conversation: { id: 7 }, entries, docs: {} } as unknown as ConversationView;
		const projected = projectChat(view).entries;
		expect(projected[1]).toMatchObject({ stopped: true, error: t("answerStopped") });
		expect(projected[0]).not.toHaveProperty("stopped");
		expect(projected[2]).not.toHaveProperty("stopped");
		const markdown = chatMarkdown("My custom title 中文", 0, 1, projected);
		expect(markdown).toContain("# My custom title 中文");
		expect(markdown).toContain("My original question");
		expect(markdown).toContain("An English answer");
		expect(markdown).toContain(`> ${t("answerStopped")}\n`);
		expect(markdown).not.toContain(`> Error: ${t("answerStopped")}`);
		expect(markdown).toContain("> Error: 429 provider-specific detail");
		// The marker, not the old display text, decides how Stop is exported after a locale change.
		locale = browserLocale === "en" ? "zh-CN" : "en";
		const changedLocale = chatMarkdown("My custom title 中文", 0, 1, projected);
		expect(changedLocale).toContain(`> ${t("answerStopped")}\n`);
		expect(changedLocale).not.toContain(`> Error: ${projected[1]?.error}`);
		expect(entries).toEqual(before);
	},
);

it.each(["en", "zh-CN"])(
	"does not mistake a provider error matching Stop in %s for an aborted answer",
	(browserLocale) => {
		locale = browserLocale;
		const error = t("answerStopped");
		const entries = [
			{
				id: 1,
				kind: "pi.assistant",
				model: [{ role: "assistant", content: [], stopReason: "error", errorMessage: error }],
			},
			{
				id: 2,
				kind: "pi.assistant",
				model: [{ role: "assistant", content: [{ type: "text", text: "Finished" }], stopReason: "stop" }],
			},
		];
		const view = { conversation: { id: 7 }, entries, docs: {} } as unknown as ConversationView;
		const projected = projectChat(view).entries;
		expect(projected[0]).toMatchObject({ error });
		for (const entry of projected) expect(entry).not.toHaveProperty("stopped");
		const markdown = chatMarkdown("Title", 0, 1, projected);
		expect(markdown).toContain(`> Error: ${error}\n`);
		expect(markdown).not.toContain(`> ${error}\n`);
	},
);

it("localizes auth validation while keeping token-error codes readable by the persisted SDK error parser", async () => {
	locale = "zh-CN";
	await expect(verifyIdToken("not-a-jwt", { clientId: "pi" }, [])).rejects.toThrow(t("authNotJwt"));
	const error = new TokenError(400, "invalid_grant");
	expect(error).toMatchObject({ status: 400, code: "invalid_grant", ended: true });
	const stored = `OAuth refresh failed for openai: ${error.message}`;
	expect(answerError(stored)).toEqual({ text: t("signInEnded"), usage: false });
	expect(answerError("provider raw error: invalid field").text).toBe("provider raw error: invalid field");
});

it("uses English fallback without requiring the i18n API in logic test environments", () => {
	vi.stubGlobal("chrome", { i18n: { getUILanguage: () => "zh-CN" } });
	expect(interfaceLocale()).toBe("en");
	expect(t("promptLimit", [20])).toBe("At most 20 prompts");
	expect(() => t("missing-message" as MessageKey)).toThrow("Missing English message");
});
