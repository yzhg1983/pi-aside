import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { type Step, stepText } from "../src/background/page-agent.ts";
import {
	inputTitle,
	MESSAGE_KIND,
	pageOf,
	projectChat,
	projectEarlier,
	projectEntries,
	SELECTION_KIND,
} from "../src/background/projection.ts";
import english from "../static/_locales/en/messages.json" with { type: "json" };
import chinese from "../static/_locales/zh_CN/messages.json" with { type: "json" };

type Entry = { id: number; kind: string; model?: Message[]; data?: unknown; head?: number; byTaskId?: number };

function user(id: number, text: string, kind = "pi.user", data?: unknown): Entry {
	return { id, kind, model: [{ role: "user", content: text, timestamp: 0 }], ...(data === undefined ? {} : { data }) };
}

function assistant(
	id: number,
	stopReason: AssistantMessage["stopReason"],
	text = "answer",
	errorMessage?: string,
): Entry {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: " thought " },
			{ type: "text", text },
		],
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
	};
	return { id, kind: "pi.assistant", model: [message as unknown as Message] };
}

function view(entries: Entry[], docs: Record<string, unknown> = {}): ConversationView {
	return { conversation: { id: 7 }, entries, docs } as unknown as ConversationView;
}

const busy = { "pi.live": { run: { taskId: 1, inputs: [] } } };

it("offers Retry for the last input only when the chat is idle and its answer is not complete", () => {
	expect(projectChat(view([user(1, "q"), assistant(2, "stop")])).retry).toBeNull();
	expect(projectChat(view([user(1, "q"), assistant(2, "length")])).retry).toBeNull();
	expect(projectChat(view([user(1, "q"), assistant(2, "error", "", "429 rate limited")])).retry).toBe(1);
	expect(projectChat(view([user(1, "q"), assistant(2, "aborted")])).retry).toBe(1);
	// No answer at all: the browser closed during the request.
	expect(projectChat(view([user(1, "q"), assistant(2, "stop"), user(3, "again")])).retry).toBe(3);
	expect(projectChat(view([user(1, "q")], busy)).retry).toBeNull();
	// A tool round: the final answer decides.
	expect(projectChat(view([user(1, "q"), assistant(2, "toolUse"), assistant(4, "error")])).retry).toBe(1);
	expect(projectChat(view([])).retry).toBeNull();
});

const page = { tabId: 1, frameId: 0, documentId: "d", url: "https://x/", title: "X", capturedAt: 0 };

const none = {
	quote: null,
	source: null,
	error: null,
	thinking: null,
	usage: null,
	stats: null,
	detail: null,
	image: false,
	step: false,
};
/** A tool's line, or the model's text before a tool call: drawn as the step log (design 6.23). */
const step = { ...none, step: true };
const source = { title: "X", url: "https://x/" };

it("shows the text, the thinking, and the reason an answer ended early", () => {
	const chat = projectChat(
		view([
			user(1, "Explain x", SELECTION_KIND, { preset: "Explain", text: "x", page }),
			assistant(2, "error", "partial", "429 rate limited"),
			assistant(3, "aborted", ""),
			{ id: 4, kind: "pi.compaction" },
			{ id: 5, kind: "app.bookkeeping" },
		]),
	);
	expect(chat.entries).toEqual([
		// Stored before the `edited` flag: the prompt as sent.
		{ ...none, id: 1, role: "user", text: "Explain x", source, sent: "Explain x" },
		{ ...none, id: 2, role: "assistant", text: "partial", error: "429 rate limited", thinking: "thought" },
		{ ...none, id: 3, role: "assistant", text: "", error: "Stopped", stopped: true, thinking: "thought" },
		{ ...none, id: 4, role: "notice", text: "Earlier messages were summarized." },
	]);
});

it("shows a selection with its prompt unchanged as the preset and the quote, also while queued", () => {
	const selection = (edited: unknown) => ({ preset: "Explain", text: "x", page, edited });
	const chat = projectChat(
		view(
			[
				user(1, "Explain x from X", SELECTION_KIND, selection(false)),
				user(2, "What is x here?\n\nx", SELECTION_KIND, selection(true)),
				user(3, "Explain x from X", SELECTION_KIND, selection("no")),
			],
			{
				...busy,
				"pi.inbox": {
					items: [
						{
							id: 8,
							mode: "followUp",
							content: "Explain x from X",
							entry: { kind: SELECTION_KIND, data: selection(false) },
						},
						{
							id: 9,
							mode: "steer",
							content: 'And y?\n\n[Attached page: "X" (https://x/)]',
							entry: { kind: MESSAGE_KIND, data: { text: "And y?", page } },
						},
					],
				},
			},
		),
	);
	const quote = { preset: "Explain", text: "x" };
	expect(chat.entries.map(({ text, quote, source }) => ({ text, quote, source }))).toEqual([
		{ text: "Explain x from X", quote, source },
		// Edited in the composer: the text as sent.
		{ text: "What is x here?\n\nx", quote: null, source },
		{ text: "Explain x from X", quote: null, source },
	]);
	// The page note is for the model only. Each keeps how it waits: for the answer, or for the next tool round.
	expect(chat.queued).toEqual([
		{ id: 8, text: "Explain x from X", quote, source, sent: "Explain x from X", mode: "followUp" },
		{ id: 9, text: "And y?", quote: null, source, sent: "And y?", mode: "steer" },
	]);
});

it("shows the live answer, the queue, and the model of a supported provider", () => {
	const chat = projectChat(
		view([user(1, "q")], {
			"pi.live": {
				run: { taskId: 1, inputs: [] },
				generation: {
					attempt: 2,
					message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
					retry: { at: 0, error: "overloaded" },
				},
			},
			"pi.inbox": {
				items: [
					{ id: 9, mode: "followUp", content: "next" },
					{ id: 10, mode: "write", entry: {} },
				],
			},
			"pi.agent": { model: { provider: "deepseek", modelId: "deepseek-flash" } },
		}),
	);
	expect(chat).toMatchObject({
		conversationId: 7,
		model: { provider: "deepseek", modelId: "deepseek-flash" },
		live: { text: "partial", thinking: "", attempt: 2, retry: "overloaded" },
		busy: true,
		queued: [{ id: 9, text: "next" }],
	});
	const other = projectChat(view([], { "pi.agent": { model: { provider: "faux", modelId: "x" } } }));
	expect(other.model).toBeNull();
});

it("shows thinking before a tool call, joins thinking blocks, and leaves out redacted ones", () => {
	const message = (id: number, content: unknown[], stopReason = "stop"): Entry => ({
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content, stopReason } as unknown as Message],
	});
	const chat = projectChat(
		view(
			[
				user(1, "q"),
				message(
					2,
					[
						{ type: "thinking", thinking: "I should read the page." },
						{ type: "toolCall", id: "read", name: "read_page", arguments: {} },
					],
					"toolUse",
				),
				message(
					3,
					[
						{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
						{ type: "toolCall", id: "read", name: "read_page", arguments: {} },
					],
					"toolUse",
				),
				message(4, [
					{ type: "thinking", thinking: "First." },
					{ type: "thinking", thinking: "", redacted: true },
					{ type: "thinking", thinking: "Second." },
					{ type: "text", text: "Answer" },
				]),
			],
			{
				"pi.live": {
					run: { taskId: 1, inputs: [] },
					generation: {
						attempt: 1,
						message: { role: "assistant", content: [{ type: "thinking", thinking: "Hmm" }] },
					},
				},
			},
		),
	);
	expect(chat.entries).toEqual([
		{ ...none, id: 1, role: "user", text: "q", sent: "q" },
		// Thinking before a tool call is a step on the way to the answer.
		{ ...step, id: 2, role: "assistant", text: "", thinking: "I should read the page." },
		{ ...none, id: 4, role: "assistant", text: "Answer", thinking: "First.\n\nSecond." },
	]);
	expect(chat.live).toEqual({ text: "", thinking: "Hmm", attempt: 1, retry: null });
});

/** A tool call without text, which projects to nothing. */
function toolCall(id: number): Entry {
	return {
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [], stopReason: "toolUse" } as unknown as Message],
	};
}

function toolResult(id: number, isError: boolean, text: string, details?: unknown, toolName = "read_page"): Entry {
	const message = {
		role: "toolResult",
		toolCallId: "c",
		toolName,
		content: [{ type: "text", text }],
		isError,
		details,
	};
	return { id, kind: "pi.toolResult", model: [message as unknown as Message] };
}

it("shows a message with a page as typed, a tool round as its result, and finds an input's page", () => {
	const message = user(1, 'Sum up\n\n[Attached page: "X" (https://x/)]', MESSAGE_KIND, { text: "Sum up", page });
	const chat = projectChat(
		view([
			message,
			toolCall(2),
			toolResult(3, false, "{}", { title: "X", url: "https://x/" }),
			toolResult(4, true, "Cannot read the page"),
			assistant(5, "stop", "Summary"),
		]),
	);
	expect(chat.entries).toEqual([
		// Copy and Edit get the text as typed, without the page note.
		{ ...none, id: 1, role: "user", text: "Sum up", source, sent: "Sum up" },
		{ ...step, id: 3, role: "notice", text: "Read the page: X", read: "page" },
		{ ...step, id: 4, role: "notice", text: "read_page failed", error: "Cannot read the page" },
		{
			...none,
			id: 5,
			role: "assistant",
			text: "Summary",
			thinking: "thought",
			stats: { modelMs: null, toolMs: 0, tools: [{ name: "read_page", calls: 2, failed: 1 }] },
		},
	]);
	expect(pageOf(message as unknown as Parameters<typeof pageOf>[0])).toEqual(page);
	expect(pageOf(user(6, "plain") as unknown as Parameters<typeof pageOf>[0])).toBeNull();
});

it("shows an action as its summary with what pi did, and an observe by its page (design 6.23)", () => {
	const act = (id: number, isError: boolean, text: string, details?: unknown) =>
		toolResult(id, isError, text, details, "act_on_page");
	const chat = projectChat(
		view([
			toolResult(1, false, "{}", { title: "X", url: "https://x/", find: "save" }, "observe_page"),
			act(2, false, "{}", { summary: "Open the diff", done: 'Clicked row "a.cc" (a12)' }),
			act(3, false, "{}", { summary: null, done: "Scrolled the page down" }),
			act(4, true, "a12 is gone", { summary: "Open the diff" }),
			act(5, true, "Tool act_on_page was aborted"),
		]),
	);
	expect(chat.entries).toEqual([
		{ ...step, id: 1, role: "notice", text: "Observed the page: X (find: save)" },
		// Edit warns that it does not undo these (design 6.34).
		{ ...step, id: 2, role: "notice", text: "Open the diff", detail: 'Clicked row "a.cc" (a12)', acted: true },
		{ ...step, id: 3, role: "notice", text: "Acted on the page", detail: "Scrolled the page down", acted: true },
		{ ...step, id: 4, role: "notice", text: "Open the diff", error: "a12 is gone" },
		{ ...step, id: 5, role: "notice", text: "act_on_page failed", error: "Tool act_on_page was aborted" },
	]);
});

it("marks a script's code, which the panel folds, but not what an action did (design 6.23)", () => {
	const script = (id: number, isError: boolean, text: string, details?: unknown) =>
		toolResult(id, isError, text, details, "run_script");
	const chat = projectChat(
		view([
			script(1, false, "{}", { summary: "Count rows", code: "rows.length" }),
			script(2, true, "{}", { summary: "Count rows", code: "rows.length", error: "rows is not defined" }),
			script(3, true, "The user denied this script"),
			toolResult(4, false, "{}", { summary: "Open it", done: "Clicked Open" }, "act_on_page"),
		]),
	);
	expect(chat.entries).toEqual([
		{ ...step, id: 1, role: "notice", text: "Count rows", detail: "rows.length", acted: true, code: true },
		{
			...step,
			id: 2,
			role: "notice",
			text: "Count rows",
			detail: "rows.length",
			error: "rows is not defined",
			acted: true,
			code: true,
		},
		{ ...step, id: 3, role: "notice", text: "run_script failed", error: "The user denied this script", acted: true },
		{ ...step, id: 4, role: "notice", text: "Open it", detail: "Clicked Open", acted: true },
	]);
	expect(chat.entries.slice(2).map((entry) => "code" in entry)).toEqual([false, false]);
});

it("says a navigation in the interface language, and keeps what the model read after it", () => {
	const zh = { "Went to $1": "已前往 $1", "Reloaded the page": "已重新加载页面" } as Record<string, string>;
	vi.stubGlobal("chrome", {
		i18n: {
			getMessage: (key: string, values: string[] = []) =>
				zh[(english as Record<string, { message: string }>)[key]?.message ?? ""]?.replace("$1", values[0] ?? "") ??
				"",
		},
	});
	try {
		const act = (id: number, details: unknown) => toolResult(id, false, "{}", details, "act_on_page");
		const chat = projectChat(
			view([
				act(1, { summary: "Go", done: "Went to https://x/2", went: "https://x/2" }),
				act(2, { summary: "Go", done: "Reloaded the page; tab 4 stays in the background", went: "reload" }),
				// Saved before `went`: as the model read it.
				act(3, { summary: "Go", done: "Went to https://x/3" }),
			]),
		);
		expect(chat.entries.map((entry) => entry.detail)).toEqual([
			"已前往 https://x/2",
			"已重新加载页面; tab 4 stays in the background",
			"Went to https://x/3",
		]);
	} finally {
		vi.unstubAllGlobals();
	}
});

it("says each step in the interface language, and keeps what the model read after it", () => {
	vi.stubGlobal("chrome", {
		i18n: {
			getMessage: (key: string, values: string[] = []) =>
				((chinese as Record<string, { message: string }>)[key]?.message ?? "").replace(
					/\$(\d)/g,
					(_, n: string) => values[Number(n) - 1] ?? "",
				),
		},
	});
	try {
		const act = (id: number, step: unknown, after = "", summary: string | null = "Go") =>
			toolResult(id, false, "{}", { summary, done: stepText(step as Step) + after, step }, "act_on_page");
		const chat = projectChat(
			view([
				act(
					1,
					{ kind: "click", target: 'button "Save" (a12)' },
					"; it opened tab 10, and the page tools now work on it",
				),
				act(2, { kind: "type", text: "pi", target: 'textbox "Search" (a3)', submitted: true }),
				act(3, { kind: "press", key: "Enter", target: null }),
				act(4, { kind: "choose", option: "Large", target: 'combobox "Size" (a4)' }),
				act(5, { kind: "scroll", target: null, direction: "down", end: "bottom" }),
				act(6, { kind: "reveal", target: 'img "Chart" (a5)' }),
				act(7, { kind: "switchTab", tab: 10 }, "", null),
				act(8, { kind: "closeTab", tab: 10, closed: true, back: 1 }, "", null),
				toolResult(
					9,
					false,
					"{}",
					{
						width: 1280,
						height: 800,
						scrolled: "Scrolled the page top (at the top)",
						scrollStep: { kind: "scroll", target: null, direction: "top", end: "top" },
					},
					"screenshot_page",
				),
				// Saved before steps: as the model read it.
				toolResult(10, false, "{}", { summary: "Go", done: "Clicked it" }, "act_on_page"),
			]),
		);
		expect(chat.entries.map((entry) => [entry.text, entry.detail])).toEqual([
			["Go", '已点击 button "Save" (a12); it opened tab 10, and the page tools now work on it'],
			["Go", '已在 textbox "Search" (a3) 中输入 "pi"，并提交了表单'],
			["Go", "已按下 Enter"],
			["Go", '已在 combobox "Size" (a4) 中选择 "Large"'],
			["Go", "已将页面向下滚动（已到底部）"],
			["Go", '已将 img "Chart" (a5) 滚动到可见位置'],
			["已切换到标签页 10", null],
			["已关闭标签页 10；页面工具现在作用于标签页 1", null],
			["已截图", "已将页面滚动到顶部（已到顶部）; 1280 × 800"],
			["Go", "Clicked it"],
		]);
	} finally {
		vi.unstubAllGlobals();
	}
});

it("shows a page prompt as its name, with its page (design 6.18)", () => {
	const filled = "Explain this text from the page:\n\n(the attached page)";
	const data = { text: filled, page, prompt: "Explain" };
	const chat = projectChat(view([user(1, `${filled}\n\n[Attached page: "X" (https://x/)]`, MESSAGE_KIND, data)]));
	// Shown by its name; Copy and Edit get the filled prompt.
	expect(chat.entries).toEqual([{ ...none, id: 1, role: "user", text: "Explain", source, sent: filled }]);
	// An empty prompt is no prompt.
	const plain = projectChat(view([user(1, filled, MESSAGE_KIND, { ...data, prompt: "" })]));
	expect(plain.entries[0]?.text).toBe(filled);
});

it("merges selection reads separately from whole-page reads", () => {
	const selected = { title: "X", url: "https://x/", scope: "selection" };
	const chat = projectChat(
		view([
			toolResult(1, false, "{}", selected),
			toolResult(2, false, "{}", selected),
			toolResult(3, false, "{}", { title: "X", url: "https://x/" }),
			toolResult(4, false, "{}", selected),
		]),
	);
	expect(chat.entries.map(({ id, text }) => [id, text])).toEqual([
		[2, "Read selected text: X · 2 reads"],
		[3, "Read the page: X"],
		[4, "Read selected text: X"],
	]);
});

it("shows successive reads of the same page as one notice with the ID of the last read", () => {
	const read = (id: number, details: unknown = { title: "X", url: "https://x/" }) =>
		toolResult(id, false, "{}", details);
	const changed = { title: "X", url: "https://x/", pageChanged: true };
	const texts = (chat: ReturnType<typeof projectChat>) => chat.entries.map((entry) => [entry.id, entry.text]);
	// A long page in parts; a read after the tab changed, a failed read, and text between reads end a group.
	const entries = [
		user(1, "q"),
		toolCall(2),
		read(3),
		toolCall(4),
		read(5),
		toolCall(6),
		read(7),
		read(8, changed),
		read(9, changed),
		toolResult(10, true, "Cannot read the page"),
		toolResult(11, true, "Cannot read the page"),
		read(12),
		assistant(13, "toolUse", "Reading more"),
		read(14),
	];
	expect(texts(projectChat(view(entries)))).toEqual([
		[1, "q"],
		[7, "Read the page: X · 3 reads"],
		[9, "Read the page: X (the tab has changed since) · 2 reads"],
		[10, "read_page failed"],
		[11, "read_page failed"],
		[12, "Read the page: X"],
		[13, "Reading more"],
		[14, "Read the page: X"],
	]);
	// The group grows only at the end: one more read replaces the last entry.
	expect(texts(projectChat(view(entries.slice(0, 5))))).toEqual([
		[1, "q"],
		[5, "Read the page: X · 2 reads"],
	]);

	// Reads before a compaction merge too; the compaction notice ends the group.
	const earlier = projectEarlier(
		[user(1, "q"), read(2), read(3)] as unknown as Parameters<typeof projectEarlier>[0],
		4,
	);
	expect(texts(projectChat(view([{ id: 5, kind: "pi.compaction" }, read(6)]), earlier))).toEqual([
		[1, "q"],
		[3, "Read the page: X · 2 reads"],
		[5, "Earlier messages were summarized."],
		[6, "Read the page: X"],
	]);
});

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

/** Calls whose cost has these parts and total. A call on the ChatGPT plan has its parts at list prices, its total 0. */
const priced = (input: number, output: number, parts: [number, number], total: number) => ({
	...usage(input, output, 0, 0, total),
	cost: { input: parts[0], output: parts[1], cacheRead: 0, cacheWrite: 0, total },
});

/** An entry with the usage of its model call. */
function spending<T extends Entry>(entry: T, spent: ReturnType<typeof usage>): T {
	(entry.model![0] as AssistantMessage).usage = spent;
	return entry;
}

it("shows what each answer and the whole chat spent: an answer's cache hit rate over its calls, the chat's of the last call (design 6.21)", () => {
	const chat = projectChat(
		view(
			[
				user(1, "q"),
				// The answer read the page first: its line has both calls, and their hit rate.
				spending(toolCall(2), usage(1000, 50, 0, 0, 0.002)),
				toolResult(3, false, "{}", { title: "X", url: "https://x/" }),
				spending(assistant(4, "stop"), usage(200, 300, 800, 0, 0.003)),
				user(5, "q2"),
				spending(assistant(6, "stop"), usage(100, 20, 1800, 100, 0.001)),
			],
			{
				"pi.usage": {
					models: { "openai/a": usage(1300, 370, 2600, 100, 0.006), "deepseek/b": usage(10, 5, 0, 0, 0.001) },
					tools: { read_page: usage(0, 0, 0, 0, 0) },
				},
			},
		),
	);
	expect(chat.entries.map((entry) => [entry.id, entry.usage])).toEqual([
		[1, null],
		[3, null],
		[4, { input: 1200, output: 350, cacheRead: 800, cacheWrite: 0, cost: 0.005, planCost: 0, cacheHit: 0.4 }],
		[5, null],
		[6, { input: 100, output: 20, cacheRead: 1800, cacheWrite: 100, cost: 0.001, planCost: 0, cacheHit: 0.9 }],
	]);
	expect(chat.usage).toEqual({
		input: 1310,
		output: 375,
		cacheRead: 2600,
		cacheWrite: 100,
		cost: 0.007,
		planCost: 0,
		cacheHit: 0.9,
	});
	expect(projectChat(view([])).usage).toBeNull();
});

it("estimates the answers on the ChatGPT plan apart from what answers cost (design 6.21)", () => {
	const chat = projectChat(
		view(
			[
				user(1, "q"),
				spending(toolCall(2), priced(100, 10, [0.0015, 0.0005], 0.002)),
				spending(assistant(3, "stop"), priced(200, 20, [0.004, 0.001], 0)),
			],
			{
				"pi.usage": {
					// One model's calls with a key and on the plan, summed in one bucket.
					models: { "openai/a": priced(300, 30, [0.0055, 0.0015], 0.002) },
					tools: {},
				},
			},
		),
	);
	const answer = chat.entries.find((entry) => entry.id === 3)?.usage;
	expect(answer?.cost).toBe(0.002);
	expect(answer?.planCost).toBeCloseTo(0.005, 12);
	expect(chat.usage?.cost).toBe(0.002);
	expect(chat.usage?.planCost).toBeCloseTo(0.005, 12);
	// Calls with a key, summed part by part: a rounding error over their total is no estimate.
	const keyed = { models: { "openai/a": priced(0, 0, [0.1, 0.2], 0.3) }, tools: {} };
	expect(projectChat(view([], { "pi.usage": keyed })).usage?.planCost).toBe(0);
});

it("counts each call once: a turn's calls go to its last answer, none to the steps before it", () => {
	const thinkingCall: Entry = {
		id: 4,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "Read more." }, { type: "toolCall" }],
				stopReason: "toolUse",
			} as unknown as Message,
		],
	};
	const entries = [
		user(1, "q"),
		spending(toolCall(2), usage(100, 10, 0, 0, 0.001)),
		spending(toolCall(3), usage(100, 10, 900, 0, 0.001)),
		// A tool call with thinking is shown as a step: the turn goes on.
		spending(thinkingCall, usage(50, 10, 950, 0, 0.001)),
		spending(toolCall(5), usage(10, 10, 9000, 0, 0.001)),
		// The final call missed the cache; the turn's hit rate is over all its calls.
		spending(assistant(6, "stop"), usage(400, 20, 0, 0, 0.002)),
		user(7, "q2"),
		spending(assistant(8, "error", "", "429"), usage(30, 0, 0, 0, 0)),
		user(9, "q3"),
		spending(assistant(10, "aborted"), usage(0, 0, 0, 50, 0.0001)),
		// A run in progress: its last call is hidden, and the chat's CH is that call's.
		user(11, "q4"),
		spending(toolCall(12), usage(25, 5, 75, 0, 0)),
	];
	const chat = projectChat(
		view(entries, { ...busy, "pi.usage": { models: { "openai/a": usage(0, 0, 0, 0, 0) }, tools: {} } }),
	);
	const shown = Object.fromEntries(chat.entries.map((entry) => [entry.id, entry.usage]));
	expect(shown[4]).toBeNull();
	expect(shown[6]).toEqual({
		input: 660,
		output: 60,
		cacheRead: 10_850,
		cacheWrite: 0,
		cost: expect.closeTo(0.006, 12),
		planCost: 0,
		cacheHit: expect.closeTo(10_850 / 11_510, 12),
	});
	expect(shown[8]).toEqual({ input: 30, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, planCost: 0, cacheHit: 0 });
	// A write-only prompt reads nothing from the cache.
	expect(shown[10]).toEqual({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 50,
		cost: 0.0001,
		planCost: 0,
		cacheHit: 0,
	});
	expect(chat.usage?.cacheHit).toBe(0.75);
	// The same records projected as earlier entries give the same lines.
	expect(
		projectEntries(entries as unknown as Parameters<typeof projectEntries>[0]).map((entry) => entry.usage),
	).toEqual(chat.entries.map((entry) => entry.usage));
});

/** An entry whose message took `durationMs`, a tool result's ending at `timestamp`. */
function timed<T extends Entry>(entry: T, durationMs: number, timestamp = 0): T {
	Object.assign(entry.model![0]!, { durationMs, timestamp });
	return entry;
}

it("times a turn's model calls and tools, overlaps once, and counts its tools on its last answer (design 6.21)", () => {
	const entries = [
		user(1, "q"),
		timed(toolCall(2), 2000),
		// Two reads at once, 1 s each, overlapping by 0.5 s.
		timed(toolResult(3, false, "{}", { title: "X", url: "https://x/" }), 1000, 11_000),
		timed(toolResult(4, false, "{}", { title: "X", url: "https://x/" }), 1000, 11_500),
		timed(assistant(5, "toolUse", "Now a screenshot."), 3000),
		// A call the user denied: refused before it ran, so no duration.
		toolResult(6, true, "The user denied this script", undefined, "run_script"),
		timed(toolResult(7, false, "{}", undefined, "screenshot_page"), 500, 20_000),
		timed(assistant(8, "stop"), 4000),
		user(9, "q2"),
		timed(toolCall(10), 1000),
	];
	const stats = (chat: ReturnType<typeof projectChat>) =>
		Object.fromEntries(chat.entries.map((entry) => [entry.id, entry.stats]));
	const idle = stats(projectChat(view(entries.slice(0, 8))));
	expect(idle[5]).toBeNull();
	expect(idle[8]).toEqual({
		modelMs: 9000,
		toolMs: 2000,
		tools: [
			{ name: "read_page", calls: 2, failed: 0 },
			{ name: "run_script", calls: 1, failed: 1 },
			{ name: "screenshot_page", calls: 1, failed: 0 },
		],
	});
	// A turn that runs has no stats yet; the turns before it keep theirs.
	const running = stats(projectChat(view([...entries, timed(assistant(11, "toolUse", "Reading."), 1000)], busy)));
	expect(running[8]).toEqual(idle[8]);
	expect(running[11]).toBeNull();
	// A call stored before pi-ai measured it: the time is not known, the tools still are.
	const legacy = stats(
		projectChat(view([user(1, "q"), toolCall(2), toolResult(3, false, "{}"), assistant(4, "stop")])),
	);
	expect(legacy[4]).toEqual({ modelMs: null, toolMs: 0, tools: [{ name: "read_page", calls: 1, failed: 0 }] });
	// An attempt cut short by a worker restart is stored without its time; the answer asked again keeps its time.
	const recovered = stats(
		projectChat(view([user(1, "q"), assistant(2, "aborted", "Hal"), timed(assistant(3, "stop"), 1500)])),
	);
	expect(recovered[3]).toEqual({ modelMs: 1500, toolMs: 0, tools: [] });
	// Stopped before any call was measured: no time to show.
	expect(stats(projectChat(view([user(1, "q"), assistant(2, "aborted", "Hal")])))[2]).toBeNull();
});

it("a steer joins its run's turn, a burst of steers too, and a send after them starts a new one (design 6.39)", () => {
	const steer = (id: number, text: string, byTaskId = 1): Entry => ({ ...user(id, text), byTaskId });
	const stats = (entries: Entry[], id: number) =>
		projectChat(view(entries)).entries.find((entry) => entry.id === id)?.stats;
	const run = [user(1, "task"), toolCall(2), toolResult(3, false, "{}"), steer(4, "fix"), steer(5, "fix more")];
	expect(stats([...run, toolCall(6), toolResult(7, false, "{}"), assistant(8, "stop")], 8)?.tools).toEqual([
		{ name: "read_page", calls: 2, failed: 0 },
	]);
	// Stopped after the steers were placed, before the model's next output: the next send starts its own turn.
	expect(stats([...run, user(6, "again"), assistant(7, "stop")], 7)).toBeNull();
	// An input another task placed after the steers is not one of their burst.
	expect(stats([...run, steer(6, "next", 2), assistant(7, "stop")], 7)).toBeNull();
});

it("gives a running chat its run's start, first entry, and turn's tools so far, and an idle one none", () => {
	const entries = [
		user(1, "q"),
		assistant(2, "stop"),
		user(3, "q2"),
		toolCall(4),
		toolResult(5, false, "{}"),
		toolCall(6),
	];
	expect(projectChat(view(entries, busy), undefined, 1234).progress).toEqual({ startedAt: 1234, tools: 1, from: 3 });
	expect(projectChat(view(entries), undefined, 1234).progress).toBeNull();
});

/** Records as the Harness stores them, for `projectEarlier`. */
const records = (entries: Entry[]) => entries as unknown as Parameters<typeof projectEarlier>[0];

it("after a compaction with no call since, takes the chat's hit rate from the last call before it, hidden too", () => {
	const docs = { "pi.usage": { models: { "openai/a": usage(250, 10, 750, 0, 0) }, tools: {} } };
	const active = view([{ id: 5, kind: "pi.compaction", head: 4 }, user(4, "q2")], docs);
	const visible = projectEarlier(
		records([user(1, "q"), spending(assistant(2, "stop"), usage(250, 10, 750, 0, 0))]),
		4,
	);
	expect(projectChat(active, visible).usage?.cacheHit).toBe(0.75);
	// A hidden tool call after it missed the cache: 0, not the answer's 75%.
	const hidden = projectEarlier(
		records([
			user(1, "q"),
			spending(assistant(2, "stop"), usage(250, 10, 750, 0, 0)),
			spending(toolCall(3), usage(1000, 10, 0, 0, 0)),
		]),
		4,
	);
	expect(projectChat(active, hidden).usage?.cacheHit).toBe(0);
	expect(projectChat(active, projectEarlier(records([user(1, "q")]), 4)).usage?.cacheHit).toBeNull();
	// A call with no prompt has no rate.
	const empty = projectChat(view([user(4, "q"), spending(assistant(5, "error"), usage(0, 0, 0, 0, 0))], docs));
	expect(empty.entries[1]!.usage?.cacheHit).toBeNull();
	expect(empty.usage?.cacheHit).toBeNull();
});

it("keeps an answer's line when a later compaction moves it before the active context", () => {
	// The first compaction kept the answer (3) but not the tool call before it (2); its marker (4) follows the answer.
	const hidden = spending(toolCall(2), usage(1000, 10, 0, 0, 0.002));
	const answer = spending(assistant(3, "stop"), usage(200, 20, 0, 0, 0.001));
	const marker = { id: 4, kind: "pi.compaction", head: 3 };
	const own = { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001, planCost: 0, cacheHit: 0 };
	const active = projectChat(view([marker, answer, user(5, "q2")]));
	expect(active.entries.find((entry) => entry.id === 3)?.usage).toEqual(own);
	// A second compaction (head 5) moves the answer to the earlier entries, read in append order.
	const earlier = projectEarlier(records([user(1, "q"), hidden, answer, marker, user(5, "q2")]), 5);
	expect(earlier.entries.find((entry) => entry.id === 3)?.usage).toEqual(own);
	// The second compaction kept an entry from before the first marker (5 before 6), so that marker is after the head.
	const overlap = projectEarlier(
		records(
			[
				user(1, "q"),
				hidden,
				answer,
				user(4, "q2"),
				spending(assistant(5, "stop"), usage(300, 30, 0, 0, 0.003)),
			].concat([
				{ id: 6, kind: "pi.compaction", head: 3 },
				user(7, "q3"),
				{ id: 8, kind: "pi.compaction", head: 5 },
			]),
		),
		5,
	);
	expect(overlap.entries.map((entry) => entry.id)).toEqual([1, 3, 4]);
	expect(overlap.entries.find((entry) => entry.id === 3)?.usage).toEqual(own);
	// A reset starts a group at itself.
	const reset = projectEarlier(
		records([spending(toolCall(1), usage(5, 5, 0, 0, 0)), { id: 2, kind: "pi.reset", head: 2 }, answer]),
		4,
	);
	expect(reset.entries.find((entry) => entry.id === 3)?.usage).toEqual(own);
});

it("puts what a compaction summarized before the active context, and titles chats by their first input", () => {
	const earlier = projectEarlier(
		[
			user(1, "first question"),
			assistant(2, "stop", "first answer"),
			{ id: 3, kind: "app.bookkeeping" },
		] as unknown as Parameters<typeof projectEarlier>[0],
		4,
	);
	const chat = projectChat(view([{ id: 6, kind: "pi.compaction" }, user(4, "q2"), assistant(5, "error")]), earlier);
	expect(chat.entries.map((entry) => [entry.id, entry.text])).toEqual([
		[1, "first question"],
		[2, "first answer"],
		[6, "Earlier messages were summarized."],
		[4, "q2"],
		[5, "answer"],
	]);
	// Retry still looks at the active context only.
	expect(chat.retry).toBe(4);

	const title = (entry: Entry) => inputTitle(entry as unknown as Parameters<typeof inputTitle>[0]);
	expect(
		title(user(1, "Explain x from a page", SELECTION_KIND, { preset: "Explain", text: "the\nselection", page })),
	).toBe("Explain: the selection");
	expect(title(user(1, "What is this?", SELECTION_KIND, { preset: "Explain", text: "x", page, edited: true }))).toBe(
		"What is this?",
	);
	expect(title(user(1, "Sum up\n\n[Attached page]", MESSAGE_KIND, { text: "Sum up", page }))).toBe("Sum up");
	// A page prompt: its name and the page's title, or its URL without one.
	const prompted = { text: "Summarize this:\n\n(the whole page)", page, prompt: "Summarize" };
	expect(title(user(1, "Summarize this", MESSAGE_KIND, prompted))).toBe(`Summarize: ${page.title}`);
	expect(title(user(1, "Summarize this", MESSAGE_KIND, { ...prompted, page: { ...page, title: "" } }))).toBe(
		`Summarize: ${page.url}`,
	);
	expect(title(user(1, "x".repeat(200)))).toHaveLength(80);
	// The cap would split the emoji: it is left out whole.
	expect(title(user(1, `${"x".repeat(78)}😀tail`))).toBe(`${"x".repeat(78)}…`);
	expect(title(assistant(2, "stop"))).toBeUndefined();
});

it("a message sent after the tab left its page shows where the tab was; a malformed move shows nothing (design 6.28)", () => {
	const sent = (moved: unknown) =>
		projectChat(view([user(1, "Sum up\n\n[Attached page]", MESSAGE_KIND, { text: "Sum up", page, moved })]))
			.entries[0];
	expect(sent({ url: "https://y/", title: "Y" })).toMatchObject({ source, moved: { url: "https://y/", title: "Y" } });
	expect(sent({ site: "https://b.test" })).toMatchObject({ moved: { site: "https://b.test" } });
	expect(sent({ site: null })).toMatchObject({ moved: { site: null } });
	for (const malformed of [undefined, null, "https://y/", {}, { url: "https://y/" }, { site: 3 }])
		expect(sent(malformed)).not.toHaveProperty("moved");
});
