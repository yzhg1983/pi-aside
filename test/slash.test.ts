import { afterEach, expect, it, vi } from "vitest";
import { commandName, expandCommand, matchingCommands, slashCommands } from "../src/panel/slash.ts";
import { PAGE_SELECTION, PRESETS } from "../src/shared/presets.ts";
import chinese from "../static/_locales/zh_CN/messages.json" with { type: "json" };

afterEach(() => vi.unstubAllGlobals());

const page = { title: "How SQLite Works", url: "https://www.sqlite.org/howitworks.html" };
const commands = slashCommands(PRESETS, "English");

it("names built-in prompts by their English ID, and others by their name as shown", () => {
	expect(commands.map((each) => each.command)).toEqual(["explain", "summarize", "translate", "proofread", "reply"]);
	expect(commands.map((each) => each.alias)).toEqual([
		"explain",
		"summarize",
		"translate-to-english",
		"proofread",
		"draft-a-reply",
	]);
	expect(commandName("  My   Own prompt ")).toBe("my-own-prompt");
	const own = { id: "6f1c", name: "解释代码", template: "Explain this code: {{selection}}" };
	const edited = { id: "reply", name: "Answer politely", template: "Answer: {{selection}}" };
	expect(slashCommands([edited, own], "English").map((each) => [each.command, each.alias])).toEqual([
		["reply", "answer-politely"],
		["解释代码", "解释代码"],
	]);
	// A prompt that is off has no command.
	const off = PRESETS.map((preset) => (preset.id === "summarize" ? { ...preset, off: true as const } : preset));
	expect(slashCommands(off, "English").map((each) => each.command)).toEqual([
		"explain",
		"translate",
		"proofread",
		"reply",
	]);
	expect(expandCommand("/summarize text", slashCommands(off, "English"), "English", page)).toBeNull();
	// A name two prompts share goes to the first.
	const twin = { id: "twin", name: "EXPLAIN", template: "Mine: {{selection}}" };
	expect(slashCommands([...PRESETS, twin], "English").filter((each) => each.command === "explain")).toHaveLength(1);
});

it("offers prompts by the start of their command, then by any part of their name", () => {
	expect(matchingCommands("/", commands)).toHaveLength(5);
	expect(matchingCommands("/S", commands).map((each) => each.command)).toEqual(["summarize", "translate"]);
	expect(matchingCommands("/su", commands).map((each) => each.command)).toEqual(["summarize"]);
	// Command starts first, then the shown name's start, then anywhere in it.
	expect(matchingCommands("/dr", commands).map((each) => each.command)).toEqual(["reply"]);
	expect(matchingCommands("/r", commands).map((each) => each.command)).toEqual([
		"reply",
		"summarize",
		"translate",
		"proofread",
	]);
	expect(matchingCommands("/english", commands).map((each) => each.command)).toEqual(["translate"]);
	expect(matchingCommands("/q", commands)).toEqual([]);
	expect(matchingCommands("/summarize ", commands)).toEqual([]);
	expect(matchingCommands("ask /summarize", commands)).toEqual([]);
	expect(matchingCommands("", commands)).toEqual([]);
});

it("fills the prompt with the typed text, or runs it for the attached page", () => {
	expect(expandCommand("/explain  WAL mode\nand checkpoints ", commands, "English", page)).toEqual({
		kind: "text",
		text: 'Explain this text from "How SQLite Works" (https://www.sqlite.org/howitworks.html):\n\nWAL mode\nand checkpoints\n\nAnswer in English.',
	});
	expect(expandCommand("/Summarize", commands, "English", page)).toMatchObject({
		kind: "text",
		text: expect.stringContaining(`:\n\n${PAGE_SELECTION}\n\nAnswer in English.`),
	});
	// Without a page: no empty source, and a command alone needs text.
	expect(expandCommand("/translate Bonjour", commands, "English", null)).toEqual({
		kind: "text",
		text: "Translate this text into English. Reply with the translation only.\n\nBonjour",
	});
	expect(expandCommand("/proofread", commands, "English", null)).toEqual({ kind: "needs-text", name: "/proofread" });
	// The source goes out of the prompt, not out of the text: typed text with the same words keeps them.
	expect(expandCommand('/translate a from "" () b', commands, "English", null)).toMatchObject({
		text: expect.stringMatching(/\n\na from "" \(\) b$/),
	});
});

it("runs a prompt by its name as shown too", () => {
	expect(expandCommand("/draft-a-reply Thanks!", commands, "English", page)).toEqual(
		expandCommand("/reply Thanks!", commands, "English", page),
	);
	expect(expandCommand("/needs-text", commands, "English", page)).toBeNull();
});

it("leaves messages that name no prompt as typed", () => {
	for (const message of ["/etc/hosts?", "/unknown do this", "explain /explain", "/", "plain question"])
		expect(expandCommand(message, commands, "English", page)).toBeNull();
	// Values never expand: a {{url}} in the typed text stays.
	expect(expandCommand("/explain {{url}}", commands, "English", page)).toMatchObject({
		text: expect.stringContaining(":\n\n{{url}}\n\n"),
	});
});

it("keeps English commands in the Chinese interface, and finds prompts by their Chinese names", () => {
	vi.stubGlobal("chrome", {
		i18n: {
			getMessage: (key: keyof typeof chinese, values: string[] = []) =>
				chinese[key].message.replace(/\$([1-9])/g, (_match, index: string) => values[Number(index) - 1] ?? ""),
		},
	});
	const own = { id: "6f1c", name: "解释代码", template: "Explain this code: {{selection}}" };
	const zh = slashCommands([...PRESETS, own], "Chinese");
	expect(zh.map((each) => [each.command, each.name])).toEqual([
		["explain", "解释"],
		["summarize", "总结"],
		["translate", "翻译为中文"],
		["proofread", "校对"],
		["reply", "起草回复"],
		["解释代码", "解释代码"],
	]);
	// A command start ranks before a shown name start.
	expect(matchingCommands("/解释", zh).map((each) => each.command)).toEqual(["解释代码", "explain"]);
	expect(matchingCommands("/代码", zh).map((each) => each.command)).toEqual(["解释代码"]);
	expect(matchingCommands("/ex", zh).map((each) => each.command)).toEqual(["explain"]);
	for (const command of ["/explain 你好", "/解释 你好"])
		expect(expandCommand(command, zh, "Chinese", page)).toMatchObject({
			kind: "text",
			text: expect.stringMatching(/^Explain this text from .*你好\n\nAnswer in Chinese\.$/s),
		});
	expect(expandCommand("/解释代码 x = 1", zh, "Chinese", page)).toEqual({
		kind: "text",
		text: "Explain this code: x = 1",
	});
});
