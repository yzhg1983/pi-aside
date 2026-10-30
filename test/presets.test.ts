import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { models } from "../src/background/models.ts";
import {
	defaultSettings,
	movedPreset,
	readSettings,
	settingsChange,
	switchedPreset,
	withoutPreset,
	withPreset,
} from "../src/background/settings.ts";
import {
	ANSWER,
	fillTemplate,
	MAX_PRESETS,
	PRESETS,
	presetError,
	presetName,
	unknownVariables,
} from "../src/shared/presets.ts";
import { CHATGPT, PROVIDERS, type ProviderId, RECOMMENDED_MODELS } from "../src/shared/protocol.ts";

it("fills the allowlisted variables in one pass and keeps any other placeholder as written", () => {
	const values = { selection: "see {{url}} and {{title}}", title: "T", url: "https://x/", language: "German" };
	expect(fillTemplate("{{title}} {{url}} {{other}}: {{selection}}", values)).toBe(
		"T https://x/ {{other}}: see {{url}} and {{title}}",
	);
});

it("fills only the language in a prompt's name", () => {
	expect(presetName(PRESETS.find((preset) => preset.id === "translate")!, "German")).toBe("Translate to German");
	// A name is never blank, and a language is not a replacement pattern.
	expect(presetName({ id: "x", name: "{{selection}} in {{language}}", template: "" }, "$&")).toBe(
		"{{selection}} in $&",
	);
});

it("a built-in prompt names its answer's language last, unless its answer is text in another language", () => {
	const values = { selection: "Hello world.", title: "T", url: "https://x/", language: "Chinese" };
	const filled = Object.fromEntries(PRESETS.map((preset) => [preset.id, fillTemplate(preset.template, values)]));
	expect(filled.explain).toMatch(/Hello world\.\n\nAnswer in Chinese\.$/);
	expect(filled.summarize).toMatch(/Hello world\.\n\nAnswer in Chinese\.$/);
	// The corrected text keeps its own language; the list of changes is the user's.
	expect(filled.proofread).toMatch(/Hello world\.\n\nWrite the list of changes in Chinese\.$/);
	expect(filled.translate).toContain("into Chinese");
	expect(filled.translate).not.toContain("Answer in");
	expect(filled.reply).not.toContain("Chinese");
	expect(ANSWER).toBe("\n\nAnswer in {{language}}.");
});

it("defaults to following Chrome without pinning its current language", () => {
	expect(defaultSettings().language).toBe("auto");
});

it("reads stored settings over the defaults, field by field", () => {
	const defaults = defaultSettings();
	expect(readSettings(undefined, defaults)).toEqual(defaults);
	expect(
		readSettings(
			{
				model: { provider: "nope", modelId: "x" },
				selectionAction: "compose",
				defaultPreset: "summarize",
				language: "Chinese",
			},
			defaults,
		),
	).toEqual({ ...defaults, selectionAction: "compose", defaultPreset: "summarize", language: "Chinese" });
	// Enter while pi works joins the task by default; only the two modes read (design 6.39).
	expect(defaults.enterWhileBusy).toBe("steer");
	expect(readSettings({ enterWhileBusy: "followUp" }, defaults).enterWhileBusy).toBe("followUp");
	expect(readSettings({ enterWhileBusy: "reject" }, defaults).enterWhileBusy).toBe("steer");
	expect(defaults.thinking).toBe("off");
	expect(readSettings({ thinking: "high" }, defaults).thinking).toBe("high");
	expect(readSettings({ thinking: "max" }, defaults).thinking).toBe("max");
	// Only the levels in the list: "minimal" is a pi-ai level, not one of the picker's.
	expect(readSettings({ thinking: "minimal" }, defaults).thinking).toBe("off");
	// Only the languages in the list: one stored before it, such as "German", reads as the default.
	expect(
		readSettings(
			{ model: { provider: "deepseek", modelId: "m" }, selectionAction: "x", language: "German" },
			defaults,
		),
	).toEqual({ ...defaults, model: { provider: "deepseek", modelId: "m" } });
});

it("reads each tool mode and the calls per answer, and merges a change of one mode into the others (design 6.23)", () => {
	const defaults = defaultSettings();
	// run_script defaults to Ask: it is offered only while Chrome's Allow User Scripts switch is on too.
	expect(defaults.tools).toEqual({ read: "on", observe: "on", act: "ask", script: "ask", screenshot: "on" });
	// A saved Off stays Off under the new default.
	expect(readSettings({ tools: { script: "off" } }, defaults).tools.script).toBe("off");
	expect(defaults.callsPerAnswer).toBe(50);
	// Ask is a mode of act_on_page and run_script only.
	expect(
		readSettings({ tools: { read: "ask", observe: "off", act: "on", script: "ask", screenshot: "ask" } }, defaults)
			.tools,
	).toEqual({
		read: "on",
		observe: "off",
		act: "on",
		script: "ask",
		screenshot: "on",
	});
	expect(readSettings({ tools: { screenshot: "off" } }, defaults).tools.screenshot).toBe("off");
	expect(readSettings({ tools: "on" }, defaults).tools).toEqual(defaults.tools);
	expect(readSettings({ tools: { act: "always" } }, defaults).tools.act).toBe("ask");
	// An invalid mode reads as the default, which for run_script is Ask: still a card for every script.
	expect(readSettings({ tools: { script: "always" } }, defaults).tools.script).toBe("ask");
	expect(
		[1, 5, 120, 200, 1000, 7.5, "60"].map(
			(calls) => readSettings({ callsPerAnswer: calls }, defaults).callsPerAnswer,
		),
	).toEqual([5, 5, 120, 200, 200, 50, 50]);

	const current = {
		...defaults,
		tools: {
			read: "off" as const,
			observe: "on" as const,
			act: "on" as const,
			script: "on" as const,
			screenshot: "on" as const,
		},
	};
	expect(settingsChange({ tools: { act: "ask" }, callsPerAnswer: 9 })(current)).toEqual({
		tools: { read: "off", observe: "on", act: "ask", script: "on", screenshot: "on" },
		callsPerAnswer: 9,
	});
	expect(settingsChange({ thinking: "low" })(current)).toEqual({ thinking: "low" });
});

it("says why a prompt cannot be saved, and which field to fix", () => {
	const prompt = { id: "p", name: "Simplify", template: "Simplify:\n\n{{selection}}" };
	expect(presetError(prompt, PRESETS)).toBeUndefined();
	expect(presetError({ ...prompt, name: "  " }, PRESETS)).toEqual({ field: "name", text: "Give the prompt a name" });
	expect(presetError({ ...prompt, name: " explain " }, PRESETS)?.text).toBe("Another prompt has this name");
	// Its own name is not a clash: saving an unchanged prompt works.
	expect(presetError(PRESETS[0]!, PRESETS)).toBeUndefined();
	expect(presetError({ ...prompt, name: "x".repeat(61) }, PRESETS)?.field).toBe("name");
	expect(presetError({ ...prompt, template: "Simplify {{selected}}" }, PRESETS)).toEqual({
		field: "template",
		text: "Add {{selection}} where the selected text goes",
	});
	expect(presetError({ ...prompt, template: `{{selection}}${"x".repeat(7987)}` }, PRESETS)).toBeUndefined();
	expect(presetError({ ...prompt, template: `{{selection}}${"x".repeat(7988)}` }, PRESETS)?.field).toBe("template");
	expect(unknownVariables("{{titel}} {{selection}} {{x}} {{titel}} {{language}}")).toEqual(["titel", "x"]);
});

it("reads stored prompts, keeps the ones that can be used, and moves a missing default to the first", () => {
	const defaults = defaultSettings();
	const mine = { id: "mine", name: "Simplify", template: "Simplify {{selection}}" };
	const stored = {
		defaultPreset: "gone",
		prompts: [
			mine,
			{ id: "mine", name: "Same ID", template: "{{selection}}" },
			{ id: "b", name: "simplify", template: "{{selection}}" },
			{ id: "c", name: "No selection", template: "Hello" },
			{ id: 3, name: "Bad ID", template: "{{selection}}" },
			null,
		],
	};
	expect(readSettings(stored, defaults)).toEqual({ ...defaults, defaultPreset: "mine", prompts: [mine] });
	// A stored default that is gone goes to the first prompt, even when the built-in default is still there; with none
	// stored, the built-in default stays.
	const explain = PRESETS[0]!;
	expect(readSettings({ defaultPreset: "gone", prompts: [mine, explain] }, defaults).defaultPreset).toBe("mine");
	expect(readSettings({ prompts: [mine, explain] }, defaults).defaultPreset).toBe("explain");
	// None can be used: the built-in prompts.
	expect(readSettings({ prompts: [{ id: "c", name: "x", template: "y" }] }, defaults).prompts).toEqual(PRESETS);
	// The first usable ones up to the limit; the rest are not read.
	const many = Array.from({ length: 25 }, (_, index) => ({
		id: `${index}`,
		name: `P${index}`,
		template: "{{selection}}",
	}));
	const prompts = readSettings({ prompts: [{ id: "bad" }, many[0], ...many] }, defaults).prompts;
	expect(prompts).toEqual(many.slice(0, MAX_PRESETS));
});

it("saves a prompt in place or at the end, and deletes all but the last", () => {
	const edited = { id: "explain", name: " Explain simply ", template: "Explain simply: {{selection}}" };
	const saved = withPreset(PRESETS, edited);
	expect(saved[0]).toEqual({ ...edited, name: "Explain simply" });
	expect(saved).toHaveLength(PRESETS.length);
	const added = withPreset(PRESETS, { id: "new", name: "Simplify", template: "{{selection}}" });
	expect(added.at(-1)?.id).toBe("new");
	expect(() => withPreset(PRESETS, { id: "new", name: "Summarize", template: "{{selection}}" })).toThrow(
		"Another prompt has this name",
	);
	const full = Array.from({ length: MAX_PRESETS }, (_, index) => ({
		id: `${index}`,
		name: `P${index}`,
		template: "{{selection}}",
	}));
	expect(() => withPreset(full, { id: "new", name: "One more", template: "{{selection}}" })).toThrow(
		`At most ${MAX_PRESETS} prompts`,
	);
	// A full list still takes changes to its prompts.
	expect(withPreset(full, { id: "0", name: "Zero", template: "{{selection}}" })[0]?.name).toBe("Zero");
	expect(withoutPreset(PRESETS, "summarize").map((preset) => preset.id)).not.toContain("summarize");
	expect(() => withoutPreset([PRESETS[0]!], "explain")).toThrow("Keep at least one prompt");
	const ids = (prompts: readonly { id: string }[]) => prompts.map((preset) => preset.id).join(" ");
	expect(ids(movedPreset(PRESETS, "summarize", -1))).toBe("summarize explain translate proofread reply");
	expect(ids(movedPreset(PRESETS, "summarize", 1))).toBe("explain translate summarize proofread reply");
	// The ends hold, and a prompt another panel deleted moves nothing.
	expect(ids(movedPreset(PRESETS, "explain", -1))).toBe(ids(PRESETS));
	expect(ids(movedPreset(PRESETS, "reply", 1))).toBe(ids(PRESETS));
	expect(ids(movedPreset(PRESETS, "gone", 1))).toBe(ids(PRESETS));
});

it("turns a prompt off and on, keeps the default on, and keeps a prompt that is on", () => {
	const defaults = defaultSettings();
	const off = switchedPreset(PRESETS, "summarize", false, "explain");
	expect(off[1]).toEqual({ ...PRESETS[1], off: true });
	// On again, it equals the built-in prompt: an unedited list is not stored.
	expect(switchedPreset(off, "summarize", true, "explain")).toEqual(PRESETS);
	expect(() => switchedPreset(PRESETS, "explain", false, "explain")).toThrow("Ask pi uses this prompt");
	// A prompt another panel deleted switches nothing.
	expect(switchedPreset(PRESETS, "gone", false, "explain")).toEqual(PRESETS);
	// A save keeps a prompt on or off as it was, whatever the form sent; a new prompt is on.
	expect(withPreset(off, { ...PRESETS[1]!, name: "Sum up" })[1]).toEqual({ ...PRESETS[1], name: "Sum up", off: true });
	expect(withPreset(PRESETS, { ...PRESETS[1]!, off: true })[1]).toEqual(PRESETS[1]);
	const added = { id: "new", name: "Simplify", template: "{{selection}}" };
	expect(withPreset(PRESETS, { ...added, off: true }).at(-1)).toEqual(added);
	// The last prompt that is on stays; one that is off can go.
	const onlyExplain = PRESETS.map((preset) => (preset.id === "explain" ? preset : { ...preset, off: true as const }));
	expect(() => withoutPreset(onlyExplain, "explain")).toThrow("Keep at least one prompt that is on");
	expect(withoutPreset(onlyExplain, "reply")).toHaveLength(PRESETS.length - 1);
	// A prompt that is off cannot become the default.
	expect(() => settingsChange({ defaultPreset: "summarize" })({ ...defaults, prompts: off })).toThrow(
		"This prompt is off",
	);
	expect(settingsChange({ defaultPreset: "translate" })({ ...defaults, prompts: off })).toEqual({
		defaultPreset: "translate",
	});
});

it("reads prompts that are off, with the default on and at least one prompt on", () => {
	const defaults = defaultSettings();
	const off = switchedPreset(PRESETS, "summarize", false, "explain");
	expect(readSettings({ prompts: off }, defaults).prompts).toEqual(off);
	// Only `off: true` is kept.
	expect(readSettings({ prompts: [{ ...PRESETS[0], off: false }, ...PRESETS.slice(1)] }, defaults).prompts).toEqual(
		PRESETS,
	);
	// A default that is off hands over to the first prompt that is on.
	const explainOff = PRESETS.map((preset) => (preset.id === "explain" ? { ...preset, off: true as const } : preset));
	expect(readSettings({ defaultPreset: "explain", prompts: explainOff }, defaults).defaultPreset).toBe("summarize");
	expect(readSettings({ prompts: explainOff }, defaults).defaultPreset).toBe("summarize");
	// With none on, the first is.
	const allOff = PRESETS.map((preset) => ({ ...preset, off: true as const }));
	const read = readSettings({ prompts: allOff }, defaults);
	expect(read.prompts).toEqual([PRESETS[0], ...allOff.slice(1)]);
	expect(read.defaultPreset).toBe("explain");
});

it("recommends models that are in the catalog the worker registers", () => {
	for (const [provider, modelId] of Object.entries(RECOMMENDED_MODELS)) {
		expect(models.getModel(provider as ProviderId, modelId), `${provider}/${modelId}`).toBeDefined();
	}
	// Every provider has its models, and only the four do.
	expect(
		models
			.getProviders()
			.map((provider) => provider.id)
			.sort(),
	).toEqual(Object.keys(PROVIDERS).sort());
});

it("asks for the providers' origins, Sign in with ChatGPT's, and the sites the user allows, only when asked", () => {
	const manifest = JSON.parse(readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8"));
	expect(manifest.optional_host_permissions).toEqual([
		...Object.values(PROVIDERS).map((provider) => provider.origin),
		CHATGPT.auth,
		CHATGPT.loopback,
		// "Always allow pi on <site>" asks for one site at a time (design 6.22).
		"https://*/*",
		"http://*/*",
		// All sites, from a click on pi's site card or in Settings > Advanced > Sites (design 6.28).
		"<all_urls>",
	]);
	expect(manifest.host_permissions).toBeUndefined();
	// The callback page is reachable from OpenAI's sign-in only (design 6.20).
	expect(manifest.web_accessible_resources).toEqual([
		{ resources: ["chatgpt-callback.html"], matches: ["https://auth.openai.com/*"] },
	]);
	expect(manifest.permissions).toContain("declarativeNetRequestWithHostAccess");
	expect(manifest.permissions).not.toContain("declarativeNetRequest");
});
