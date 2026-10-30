import { afterEach, expect, it, vi } from "vitest";
import {
	allowedSites,
	answerError,
	answerHelp,
	answerLine,
	type ComposerFacts,
	composerStatus,
	contextText,
	fileName,
	filterModels,
	formatDuration,
	formatElapsed,
	formatTokens,
	groupChats,
	historyGroup,
	historyTime,
	hostOf,
	isLong,
	type ModelFacts,
	modelName,
	modelTags,
	offeredModels,
	pageAddress,
	progressLine,
	providerStatus,
	resumedText,
	shortModel,
	siteName,
	sitePattern,
	thinkingPicker,
	usageHelp,
	usageText,
	useModelState,
	verifyText,
} from "../src/panel/format.ts";
import { safeHref } from "../src/panel/markdown.ts";
import { type ModelInfo, PROVIDERS, type Status, type Usage } from "../src/shared/protocol.ts";
import chinese from "../static/_locales/zh_CN/messages.json" with { type: "json" };

afterEach(() => vi.unstubAllGlobals());

/** A model that has every thinking level. */
const THINKS: ModelInfo["thinking"] = {
	off: "off",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

it("translates presentation but keeps model tags, history groups, content, and raw errors stable", () => {
	vi.stubGlobal("chrome", {
		i18n: {
			getMessage: (key: keyof typeof chinese, values: string[]) =>
				chinese[key].message.replace(/\$([1-9])/g, (_match, index: string) => values[Number(index) - 1] ?? ""),
		},
	});
	const model: ModelInfo = {
		provider: "openai",
		id: "gpt-5.4-mini",
		name: "GPT-5.4 mini",
		api: "x",
		reasoning: true,
		thinking: THINKS,
		contextWindow: 128_000,
	};
	expect(modelTags(model, { provider: "openai", modelId: model.id })).toEqual(["current", "recommended"]);
	expect(modelName(model)).toBe("GPT-5.4 mini");
	expect(providerStatus({ key: true, permission: true, plan: false, ended: false, waiting: false }).text).toBe("就绪");
	expect(verifyText({ result: "accepted" }).text).toBe("已接受");
	expect(verifyText({ result: "no_key" }).text).toBe("没有密钥");
	expect(verifyText({ result: "forbidden", status: 403 }).text).toContain("HTTP 403");
	expect(thinkingPicker(model, "high").title).toMatch(/^思考：High。/);
	// The levels keep their English names in Chinese (design 6.36).
	expect(thinkingPicker({ ...model, thinking: { ...THINKS, medium: "low" } }, "medium").levels.medium.title).toBe(
		"GPT-5.4 mini 没有 Medium 级别，将使用 Low。",
	);
	expect(siteName("<all_urls>")).toBe("所有网站");
	expect(siteName("https://github.com/*")).toBe("github.com");
	const now = new Date(2026, 9, 21, 15, 0).getTime();
	expect(historyGroup(now, now)).toBe("Today");
	expect(historyTime(now - 20 * 60_000, now)).toBe("20 分钟");
	expect(resumedText(now - 30_000, now)).toBe("已继续刚刚开始的对话");
	expect(resumedText(now - 20 * 60_000, now)).toBe("已继续 20 分钟前开始的对话");
	const raw = "Provider says: Invalid API key <script>$1</script>";
	expect(answerError(raw)).toEqual({ text: raw, usage: false });
	expect(
		composerStatus({
			error: raw,
			note: null,
			sending: false,
			setup: null,
			busy: false,
			hasText: false,
			enter: "steer",
		}).text,
	).toBe(raw);
});

it("shortens model IDs and pages for the header and source lines", () => {
	expect(shortModel("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4.5");
	expect(shortModel("~deepseek/deepseek-flash-latest")).toBe("deepseek-flash-latest");
	expect(shortModel("deepseek-flash")).toBe("deepseek-flash");
	expect(shortModel("odd/")).toBe("odd/");
	expect(hostOf("https://www.sqlite.org/howitworks.html")).toBe("www.sqlite.org");
	// A look-alike host shows as punycode.
	expect(hostOf("https://раураl.com/")).toBe("xn--l-7sba6dbr.com");
	expect(hostOf("not a url")).toBe("not a url");
});

it("shows a chat's page in History as its host and path", () => {
	expect(pageAddress("https://www.github.com/earendil-works/pi-durable/?tab=readme#install")).toBe(
		"github.com/earendil-works/pi-durable",
	);
	expect(pageAddress("https://example.com/")).toBe("example.com");
	expect(pageAddress("http://localhost:3000/docs")).toBe("localhost:3000/docs");
	expect(pageAddress("https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC")).toBe("zh.wikipedia.org/wiki/北京");
	// Not UTF-8: stays encoded. A look-alike host shows as punycode.
	expect(pageAddress("https://example.com/%E5")).toBe("example.com/%E5");
	expect(pageAddress("https://раураl.com/login")).toBe("xn--l-7sba6dbr.com/login");
	expect(pageAddress("file:///tmp/a.html")).toBe("file:///tmp/a.html");
	expect(pageAddress("not a url")).toBe("not a url");
});

const spent = (usage: Partial<Usage>): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	planCost: 0,
	cacheHit: null,
	...usage,
});

it("shows usage as pi's footer does, cost marked as an estimate, and folds long quotes (design 6.21)", () => {
	expect(
		usageText(
			spent({
				input: 1_700_000,
				output: 208_000,
				cacheRead: 29_000_000,
				cacheWrite: 1234,
				cost: 9.0321,
				cacheHit: 0.994,
			}),
		),
	).toBe("↑1.7M ↓208k R29M W1.2k CH99.4% ~$9.032");
	expect(usageText(spent({ input: 999, output: 12_345, cost: 0.0035 }))).toBe("↑999 ↓12k ~$0.0035");
	// No price for the model: no cost; no hit rate without a cache read or write.
	expect(usageText(spent({ input: 2450, output: 900, cacheHit: 0 }))).toBe("↑2.5k ↓900");
	// A plan's estimate and a key's cost are one sum: neither is a bill.
	expect(usageText(spent({ input: 2450, output: 900, planCost: 0.0123 }))).toBe("↑2.5k ↓900 ~$0.012");
	expect(usageText(spent({ input: 10, cost: 0.004, planCost: 0.0005 }))).toBe("↑10 ~$0.0045");
	expect(usageText(spent({ input: 14_000, cost: 0.0052, planCost: 0.0101 }))).toBe("↑14k ~$0.015");
	expect(usageText(spent({ input: 10, cacheRead: 30, cacheHit: 0.75 }))).toBe("↑10 R30 CH75.0%");
	expect(usageText(spent({ cacheWrite: 10, cacheHit: null }))).toBe("W10");
	// The last call missed the cache after earlier calls read from it: 0, not left out.
	expect(usageText(spent({ input: 400, cacheRead: 9000, cacheHit: 0 }))).toBe("↑400 R9.0k CH0.0%");
	expect(usageText(spent({}))).toBe("");
	expect(formatTokens(10_000_000)).toBe("10M");
	expect(formatTokens(9_999)).toBe("10.0k");
	expect(isLong("a\nb\nc\nd\ne\nf")).toBe(false);
	expect(isLong("a\nb\nc\nd\ne\nf\ng")).toBe(true);
	expect(isLong("x".repeat(361))).toBe(true);
});

it("hides empty context and uses the catalog window without an auto suffix", () => {
	expect(contextText({ tokens: 0, auto: true }, 500_000)).toBe("");
	expect(contextText({ tokens: 144_000, auto: true }, 500_000)).toBe("28.8%/500k");
	expect(contextText({ tokens: 144_000, auto: false }, 500_000)).toBe("28.8%/500k");
	expect(contextText({ tokens: null, auto: true }, 500_000)).toBe("?/500k");
	for (const window of [undefined, 0, -1]) expect(contextText({ tokens: 144_000, auto: true }, window)).toBe("");
});

it("shows the most important composer status", () => {
	const idle: ComposerFacts = {
		error: undefined,
		note: null,
		sending: false,
		setup: null,
		busy: false,
		hasText: false,
		enter: "steer",
	};
	const text = (facts: Partial<ComposerFacts>) => composerStatus({ ...idle, ...facts });
	// Nothing to say: the line hides.
	expect(text({})).toEqual({ text: "", tone: "plain" });
	expect(text({ busy: true }).text).toBe("Esc stops the answer");
	// What Enter and Alt+Enter do with the text while pi works (design 6.39).
	expect(text({ busy: true, hasText: true }).text).toBe("Enter joins the task · Alt+Enter sends after the answer");
	expect(text({ busy: true, hasText: true, enter: "followUp" }).text).toBe(
		"Enter sends after the answer · Alt+Enter joins the task",
	);
	expect(text({ hasText: true, enter: "followUp" }).text).toBe("");
	expect(text({ sending: true, busy: true }).text).toBe("Sending...");
	expect(text({ note: "No OpenRouter key: add one to send", sending: true })).toEqual({
		text: "Not sent: No OpenRouter key: add one to send",
		tone: "bad",
	});
	expect(text({ error: "Not connected", note: "x" })).toEqual({ text: "Not connected", tone: "bad" });
	expect(text({ setup: "key", busy: true }).text).toBe("Add a key to send");
	expect(text({ setup: "permission" }).text).toBe("Allow access to send");
	// Manual check 9: a loaded draft's note outranks the setup text.
	expect(text({ setup: "key", note: "No OpenRouter key: add one to send" }).text).toBe(
		"Not sent: No OpenRouter key: add one to send",
	);
});

it("links every provider's key page as a web link", () => {
	for (const provider of Object.values(PROVIDERS)) {
		expect(new URL(provider.keysUrl).protocol).toBe("https:");
		expect(safeHref(provider.keysUrl)).toBe(provider.keysUrl);
	}
	expect(verifyText({ result: "accepted" })).toEqual({ text: "accepted", ok: true });
	expect(verifyText({ result: "rejected", status: 401 })).toEqual({ text: "rejected (HTTP 401)", ok: false });
	expect(verifyText({ result: "no_permission" })).toEqual({ text: "no permission", ok: false });
	// A 403 can mean only that the key may not list models: not a bad key (design 6.19).
	expect(verifyText({ result: "forbidden", status: 403 })).toEqual({
		text: "forbidden (HTTP 403): the key may lack permission for this check; sends can still work",
		ok: null,
	});
	expect(verifyText({ result: "limited", status: 429 })).toEqual({
		text: "limited (HTTP 429): too many requests, or no credit",
		ok: false,
	});
});

it("lists models with short names and tags, and says why one cannot be used", () => {
	const model = (provider: ModelInfo["provider"], id: string, name: string): ModelInfo => ({
		provider,
		id,
		name,
		api: "x",
		reasoning: true,
		thinking: THINKS,
		contextWindow: 128_000,
	});
	const catalog = [
		model("openrouter", "anthropic/claude-haiku-4.5", "Anthropic: Claude Haiku 4.5"),
		model("openrouter", "~anthropic/claude-haiku-latest", "Anthropic: Claude Haiku Latest"),
		model("openrouter", "openai/gpt-5.1-mini", "OpenAI: GPT-5.1 mini"),
		model("openai", "gpt-5.4-mini", "GPT-5.4 mini"),
		model("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5"),
		model("deepseek", "deepseek-flash", "DeepSeek: Flash"),
	];
	const all = new Set(["openrouter", "openai", "anthropic", "deepseek"] as const);
	const ids = (keyed: ReadonlySet<ModelInfo["provider"]>, filter: string) =>
		filterModels(catalog, keyed, filter).map((found) => `${found.provider}/${found.id}`);
	// Every word, in the name or in provider/model.
	expect(ids(all, " HAIKU ")).toEqual([
		"openrouter/anthropic/claude-haiku-4.5",
		"openrouter/~anthropic/claude-haiku-latest",
		"anthropic/claude-haiku-5-5",
	]);
	expect(ids(all, "anthropic/")).toEqual([
		"openrouter/anthropic/claude-haiku-4.5",
		"openrouter/~anthropic/claude-haiku-latest",
		"anthropic/claude-haiku-5-5",
	]);
	expect(ids(all, "openai gpt-5")).toEqual(["openrouter/openai/gpt-5.1-mini", "openai/gpt-5.4-mini"]);
	expect(ids(all, "haiku 5.5")).toEqual(["anthropic/claude-haiku-5-5"]);
	// A word does not match across the end of the name and the start of the ID: "…Flash" + "deepseek/…".
	expect(ids(all, "flashdeepseek")).toEqual([]);
	// Only the providers with a key.
	expect(ids(new Set(["anthropic", "deepseek"] as const), "")).toEqual([
		"anthropic/claude-haiku-5-5",
		"deepseek/deepseek-flash",
	]);
	expect(ids(new Set(), "")).toEqual([]);
	expect(catalog.map(modelName)).toEqual([
		"Claude Haiku 4.5",
		"Claude Haiku Latest",
		"GPT-5.1 mini",
		"GPT-5.4 mini",
		"Claude Haiku 5.5",
		"DeepSeek: Flash",
	]);
	const current = { provider: "openrouter" as const, modelId: "anthropic/claude-haiku-4.5" };
	expect(catalog.map((found) => modelTags(found, current))).toEqual([
		["current"],
		["recommended"],
		[],
		["recommended"],
		["recommended"],
		["recommended"],
	]);

	const other = { provider: "deepseek" as const, modelId: "deepseek-flash" };
	const idle: ModelFacts = { selected: other, current, hasKey: true, busy: false };
	const state = (facts: Partial<ModelFacts>) => useModelState({ ...idle, ...facts });
	expect(state({})).toEqual({ enabled: true, reason: "" });
	expect(state({ selected: undefined })).toEqual({ enabled: false, reason: "" });
	// The worker allows the chat's own model while busy; the panel has nothing to change.
	expect(state({ selected: current, busy: true })).toEqual({ enabled: false, reason: "This chat uses it" });
	expect(state({ hasKey: false }).reason).toBe("Add a DeepSeek key in Settings first");
	expect(state({ busy: true })).toEqual({ enabled: false, reason: "Wait for the answer, or stop it" });
});

it("says in a word or two where each provider stands", () => {
	const ready = { key: true, permission: true, plan: false, ended: false, waiting: false };
	expect(providerStatus(ready)).toEqual({ text: "Ready", tone: "ok" });
	expect(providerStatus({ ...ready, plan: true })).toEqual({ text: "ChatGPT plan", tone: "ok" });
	expect(providerStatus({ ...ready, permission: false })).toEqual({ text: "Needs access", tone: "warn" });
	// An ended sign-in outranks the missing access: signing in again comes first.
	expect(providerStatus({ ...ready, plan: true, ended: true, permission: false })).toEqual({
		text: "Sign-in ended",
		tone: "warn",
	});
	expect(providerStatus({ ...ready, key: false })).toEqual({ text: "Not set up", tone: "unset" });
	expect(providerStatus({ ...ready, key: false, waiting: true })).toEqual({
		text: "Waiting for sign-in",
		tone: "unset",
	});
});

it("disables the thinking picker for a model that cannot think (design 6.16)", () => {
	const flash: ModelInfo = {
		provider: "deepseek",
		id: "deepseek-flash",
		name: "DeepSeek: Flash",
		api: "x",
		reasoning: false,
		thinking: { off: "off", low: "off", medium: "off", high: "off", xhigh: "off", max: "off" },
		contextWindow: 128_000,
	};
	expect(thinkingPicker(flash, "high")).toMatchObject({ enabled: false, title: "DeepSeek: Flash does not think" });
	const picker = thinkingPicker({ ...flash, reasoning: true, thinking: THINKS }, "medium");
	expect(picker.enabled).toBe(true);
	expect(picker.title).toMatch(/^Thinking: Medium\. /);
	// Before the catalog loaded, or a model it lacks: the picker stays, with every level.
	const unknown = thinkingPicker(undefined, "max");
	expect(unknown).toMatchObject({ enabled: true, title: expect.stringMatching(/^Thinking: Max\. /) });
	expect(Object.values(unknown.levels).every((level) => level.enabled)).toBe(true);
});

it("greys out the levels a model lacks and says what it gets instead (design 6.35)", () => {
	// DeepSeek Flash in pi-ai's catalog: no Medium or Extra high, so both round down.
	const flash: ModelInfo = {
		provider: "deepseek",
		id: "deepseek-flash",
		name: "DeepSeek: Flash",
		api: "x",
		reasoning: true,
		thinking: { off: "off", low: "low", medium: "low", high: "high", xhigh: "high", max: "max" },
		contextWindow: 128_000,
	};
	const medium = thinkingPicker(flash, "medium");
	expect(medium.title).toMatch(/ DeepSeek: Flash has no Medium level; it uses Low\.$/);
	expect(medium.levels.medium).toEqual({
		enabled: false,
		title: "DeepSeek: Flash has no Medium level; it uses Low.",
	});
	expect(medium.levels.xhigh.title).toBe("DeepSeek: Flash has no Extra high level; it uses High.");
	expect(medium.levels.high).toEqual({ enabled: true, title: "" });
	expect(thinkingPicker(flash, "max").title).toMatch(/ Max can take much longer and cost much more than High\.$/);
	// A model that cannot turn thinking off keeps Off, and says it thinks anyway.
	const fable: ModelInfo = {
		...flash,
		provider: "anthropic",
		id: "claude-fable-5",
		name: "Claude Fable 5",
		thinking: { ...THINKS, off: "default" },
	};
	expect(thinkingPicker(fable, "off").levels.off).toEqual({
		enabled: true,
		title: "Claude Fable 5 cannot turn thinking off; it thinks at its default level.",
	});
	// A level pi-ai moves down to Minimal, which the picker does not offer, is named too.
	const small: ModelInfo = { ...flash, thinking: { ...THINKS, low: "minimal" } };
	expect(thinkingPicker(small, "low").levels.low.title).toBe("DeepSeek: Flash has no Low level; it uses Minimal.");
});

// Times are built with local Date constructors, so these hold in any time zone.
it("groups History by local calendar day", () => {
	const at = (...parts: [number, number, number, number, number]) => new Date(...parts).getTime();
	const now = at(2026, 9, 21, 0, 1);
	expect(historyGroup(at(2026, 9, 21, 0, 0), now)).toBe("Today");
	expect(historyGroup(at(2026, 9, 20, 23, 59), now)).toBe("Yesterday");
	expect(historyGroup(at(2026, 9, 19, 0, 0), now)).toBe("Previous 7 days");
	expect(historyGroup(at(2026, 9, 15, 0, 0), now)).toBe("Previous 7 days");
	expect(historyGroup(at(2026, 9, 14, 23, 59), now)).toBe("Earlier");
	// A clock change: a chat "from the future" is today.
	expect(historyGroup(now + 5 * 60_000, now)).toBe("Today");
	// DST days have 23 hours (US: 2026-03-08, EU: 2026-03-29) or 25 (US: 2026-11-01, EU: 2026-10-25).
	expect(historyGroup(at(2026, 2, 7, 23, 30), at(2026, 2, 9, 0, 30))).toBe("Previous 7 days");
	expect(historyGroup(at(2026, 2, 28, 23, 30), at(2026, 2, 30, 0, 30))).toBe("Previous 7 days");
	expect(historyGroup(at(2026, 10, 1, 0, 10), at(2026, 10, 2, 0, 30))).toBe("Yesterday");
	expect(historyGroup(at(2026, 9, 25, 0, 10), at(2026, 9, 26, 0, 30))).toBe("Yesterday");

	// The list is newest first by index; a skewed row stays under the group above it.
	const chats = [at(2026, 9, 21, 0, 0), at(2026, 9, 20, 9, 0), at(2026, 9, 21, 0, 0), at(2026, 9, 1, 9, 0)];
	expect(
		groupChats(
			chats.map((createdAt) => ({ createdAt })),
			now,
		).map(({ group, chats }) => [group, chats.length]),
	).toEqual([
		["Today", 1],
		["Yesterday", 2],
		["Earlier", 1],
	]);
});

it("labels History rows with a short time", () => {
	const at = (...parts: [number, number, number, number, number]) => new Date(...parts).getTime();
	const now = at(2026, 9, 21, 15, 0);
	const time = (createdAt: number) => historyTime(createdAt, now, "en-US");
	expect(time(now + 60_000)).toBe("now");
	expect(time(now - 59_000)).toBe("now");
	expect(time(now - 20 * 60_000)).toBe("20 min");
	expect(time(at(2026, 9, 21, 11, 30))).toBe("3 h");
	expect(time(at(2026, 9, 20, 23, 59))).toMatch(/^11:59\sPM$/);
	expect(time(at(2026, 9, 17, 9, 0))).toBe("Sat");
	expect(time(at(2026, 9, 8, 9, 0))).toBe("Oct 8");
	expect(time(at(2025, 11, 31, 9, 0))).toBe("Dec 31, 2025");
});

it("says how old a chat the tab continued is", () => {
	const at = (...parts: [number, number, number, number, number]) => new Date(...parts).getTime();
	const now = at(2026, 9, 21, 15, 0);
	const text = (createdAt: number) => resumedText(createdAt, now, "en-US");
	expect(text(now - 30_000)).toBe("Continued a chat started just now");
	expect(text(now - 20 * 60_000)).toBe("Continued a chat started 20 min ago");
	expect(text(at(2026, 9, 20, 9, 5))).toMatch(/^Continued a chat started yesterday at 9:05\sAM$/);
	expect(text(at(2026, 9, 17, 9, 0))).toBe("Continued a chat started on Sat");
	expect(text(at(2026, 9, 8, 9, 0))).toBe("Continued a chat started on Oct 8");
});

it("explains the usage line row by row, with each part's value (design 6.21)", () => {
	const usage = spent({ input: 4800, output: 77, cacheRead: 4000, cost: 0.011, cacheHit: 0.454 });
	const context = { context: { tokens: 9000, auto: true }, window: 500_000 };
	expect(`${usageText(usage)} ${contextText(context.context, context.window)}`).toBe(
		"↑4.8k ↓77 R4.0k CH45.4% ~$0.011 1.8%/500k",
	);
	expect(usageHelp(usage, context).split("\n")).toEqual([
		"This chat, including summaries and tool calls",
		"↑ Input, not from cache: 4.8k tokens",
		"↓ Output: 77 tokens",
		"R Read from cache: 4.0k tokens",
		"CH Cache hit: 45.4% of the last request",
		"Cost: about $0.011, estimated from list prices; not a bill",
		"Context: 1.8% of the model's 500k-token window",
		"Near the limit, pi summarizes older messages automatically.",
	]);
	// Unknown context after a compaction; no context rows before the catalog is loaded or with nothing in context.
	expect(usageHelp(null, { context: { tokens: null, auto: true }, window: 272_000 }).split("\n")).toEqual([
		"This chat, including summaries and tool calls",
		"Context: unknown until the next answer (window: 272k tokens)",
		"Near the limit, pi summarizes older messages automatically.",
	]);
	expect(usageHelp(usage, { context: { tokens: 9000, auto: true }, window: undefined })).not.toContain("Context");
	expect(usageHelp(usage, { context: { tokens: 0, auto: true }, window: 500_000 })).not.toContain("Context");
});

it("formats durations", () => {
	expect([0, 850, 999.4, 999.6, 12_400, 59_940, 59_960, 112_000, 3_600_000].map(formatDuration)).toEqual([
		"0ms",
		"850ms",
		"999ms",
		"1.0s",
		"12.4s",
		"59.9s",
		"1m 0s",
		"1m 52s",
		"60m 0s",
	]);
});

it("shows a running answer's time in whole seconds and its tools so far (design 6.21)", () => {
	expect([0, 4900, 59_999, 65_000, -50].map(formatElapsed)).toEqual(["0s", "4s", "59s", "1m 5s", "0s"]);
	expect(progressLine({ startedAt: 1000, tools: 0 }, 5200)).toBe("4s");
	expect(progressLine({ startedAt: 1000, tools: 1 }, 5200)).toBe("4s · 1 tool");
	expect(progressLine({ startedAt: 0, tools: 3 }, 65_000)).toBe("1m 5s · 3 tools");
});

it("shows an answer's time and tools on its line, and the rest in its tooltip (design 6.21)", () => {
	const stats = {
		modelMs: 9100,
		toolMs: 3300,
		tools: [
			{ name: "read_page", calls: 2, failed: 0 },
			{ name: "screenshot_page", calls: 1, failed: 1 },
		],
	};
	const usage = spent({ input: 6000, output: 210, cacheRead: 9000, cost: 0.011, cacheHit: 0.6 });
	expect(answerLine(stats)).toBe("12.4s · 3 tools");
	expect(answerHelp(usage, stats).split("\n")).toEqual([
		"Time: 12.4s (model 9.1s · tools 3.3s)",
		"",
		"Tools:",
		"read_page ×2",
		"screenshot_page ×1 (1 failed)",
		"",
		"Tokens: 15k in (60% cached) · 210 out",
		"Cost: ~$0.011",
	]);
	// No tools: the time alone. Unknown time: the tools alone. Neither: no line.
	const alone = { modelMs: 3200, toolMs: 0, tools: [] };
	expect(answerLine(alone)).toBe("3.2s");
	expect(answerHelp(null, alone)).toBe("Time: 3.2s");
	expect(answerLine({ ...stats, modelMs: null })).toBe("3 tools");
	expect(answerLine({ modelMs: null, toolMs: 0, tools: [{ name: "read_page", calls: 1, failed: 0 }] })).toBe("1 tool");
	expect(answerLine(null)).toBe("");
	expect(answerHelp(null, null)).toBe("");
	// Cache writes only when there are some; a share never rounds up to 100%; the plan note with a plan estimate.
	expect(
		answerHelp(
			spent({ input: 1, cacheRead: 999, cacheWrite: 1200, output: 5, planCost: 0.0123, cacheHit: 0.9995 }),
			null,
		).split("\n"),
	).toEqual([
		"Tokens: 2.2k in (99% cached) · 1.2k cache write · 5 out",
		"Cost: ~$0.012",
		"On the ChatGPT plan, which does not bill per token",
	]);
});

it("shows OpenAI's words for a ChatGPT plan's usage limit, Verify for a failed refresh, and other errors as they are", () => {
	// pi-ai's message for the error, with the usage page it appends.
	const limit =
		'OpenAI API error (429): {"error":{"code":"subscription_sharing_usage_limit_exceeded"}}\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage';
	expect(answerError(limit)).toEqual({
		text: "Usage limit reached. Review your plan or this app's limit in ChatGPT settings.",
		usage: true,
	});
	expect(answerError("Stopped")).toEqual({ text: "Stopped", usage: false });
	// pi-ai's refresh failure carries its cause: a code that ends the session, or a failure that may pass.
	expect(answerError("OAuth refresh failed for openai: OpenAI sign-in failed (400: invalid_grant)")).toEqual({
		text: "The ChatGPT sign-in ended. Choose Sign in again in pi's Settings.",
		usage: false,
	});
	for (const error of [
		"OAuth refresh failed for openai: OpenAI sign-in failed (401: invalid_client)",
		"OAuth refresh failed for openai: OpenAI sign-in failed (503)",
		"OAuth refresh failed for openai: Failed to fetch",
		"OAuth refresh failed for openai",
	]) {
		expect(answerError(error)).toEqual({
			text: "The ChatGPT sign-in could not be renewed. Verify it in Settings.",
			usage: false,
		});
	}
	expect(verifyText({ result: "expired", status: 400 })).toEqual({
		text: "expired (HTTP 400): the ChatGPT sign-in ended; choose Sign in again",
		ok: false,
	});
});

it("lists a ChatGPT sign-in's OpenAI models only where its plan offers them, once known (design 6.20)", () => {
	const catalog: ModelInfo[] = [
		{
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-responses",
			reasoning: true,
			thinking: THINKS,
			contextWindow: 500_000,
		},
		{
			provider: "openai",
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
			api: "openai-responses",
			reasoning: true,
			thinking: THINKS,
			contextWindow: 500_000,
		},
		{
			provider: "openrouter",
			id: "openai/gpt-5.5",
			name: "GPT-5.5",
			api: "openai-completions",
			reasoning: true,
			thinking: THINKS,
			contextWindow: 500_000,
		},
	];
	const access = (plan: boolean, planModels: string[] | null): Status["access"] => ({
		openrouter: { key: true, permission: true, plan: false, planModels: null },
		openai: { key: true, permission: true, plan, planModels },
		anthropic: { key: false, permission: false, plan: false, planModels: null },
		deepseek: { key: false, permission: false, plan: false, planModels: null },
	});
	const ids = (models: ModelInfo[]) => models.map((model) => `${model.provider}/${model.id}`);
	expect(ids(offeredModels(catalog, access(true, ["gpt-5.4-mini", "gpt-9"])))).toEqual([
		"openai/gpt-5.4-mini",
		"openrouter/openai/gpt-5.5",
	]);
	// Until a fetch succeeds, and with a key, every OpenAI model shows.
	expect(offeredModels(catalog, access(true, null))).toEqual(catalog);
	expect(offeredModels(catalog, access(false, null))).toEqual(catalog);
});

it("asks for a page's site with any port, and lists the allowed sites without the providers'", () => {
	expect(sitePattern("https://GitHub.com:8443/o/r/commit/a?x=1#L2")).toBe("https://github.com/*");
	expect(sitePattern("http://gerrit.internal/c/1")).toBe("http://gerrit.internal/*");
	expect(sitePattern("file:///tmp/a.html")).toBeNull();
	expect(sitePattern("chrome://newtab/")).toBeNull();
	expect(sitePattern("not a url")).toBeNull();

	const granted = [
		"https://openrouter.ai/*",
		"https://github.com/*",
		"http://127.0.0.1:1455/*",
		"http://gerrit.internal/*",
		"https://github.com/o/*",
		"chrome://favicon/*",
	];
	const kept = ["https://openrouter.ai/*", "http://127.0.0.1:1455/*"];
	expect(allowedSites(granted, kept)).toEqual(["http://gerrit.internal/*", "https://github.com/*"]);
	expect(allowedSites(granted, kept).map(siteName)).toEqual(["http://gerrit.internal", "github.com"]);
	// Broad grants, as Chrome's site access settings can give, are listed too, in words.
	const broad = allowedSites(["https://*/*", "http://*/*", "https://*.example.com/*", "*://*/*", "<all_urls>"], kept);
	expect(broad.map(siteName)).toEqual([
		"All sites",
		"All sites",
		"All http sites",
		"*.example.com",
		"All https sites",
	]);
});

it("names an exported chat's file after its title (design 6.30)", () => {
	expect(fileName("Durable agents")).toBe("Durable agents");
	expect(fileName('a/b\\c:d*e?f"g<h>i|j\tk')).toBe("a b c d e f g h i j k");
	expect(fileName("  ...  ")).toBe("pi chat");
	expect(fileName("")).toBe("pi chat");
	expect(fileName("对话 <script>$1</script>")).toBe("对话 script $1 script");
	expect(fileName("x".repeat(200))).toHaveLength(80);
});
