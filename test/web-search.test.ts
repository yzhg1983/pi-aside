// Native Responses parser and registered OpenAI wrapper; fabricated credentials and in-process SSE only.
import type { Api, AssistantMessageEvent, Model, StreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { beforeEach, expect, it, vi } from "vitest";
import { models } from "../src/background/models.ts";
import { defaultSettings, loadSettings, readSettings, saveSettings } from "../src/background/settings.ts";
import { openaiSearch } from "../src/background/web-search.ts";
import { MAX_URL_CHARS, RECOMMENDED_MODELS } from "../src/shared/protocol.ts";

const local = new Map<string, unknown>();
const set = vi.fn(async (items: Record<string, unknown>) => {
	for (const [key, value] of Object.entries(items)) local.set(key, structuredClone(value));
});
vi.stubGlobal("chrome", {
	i18n: { getUILanguage: () => "en" },
	storage: { local: { get: async (key: string) => ({ [key]: local.get(key) }), set } },
});
const model = models.getModel("openai", RECOMMENDED_MODELS.openai)!;
const SOURCES = "web_search_call.action.sources";
const context = normalizeContext({ messages: [{ role: "user", content: "Find a source.", timestamp: 0 }] });
const citation = (url: string, end = 5, start = 0) => ({
	type: "url_citation",
	url,
	start_index: start,
	end_index: end,
	title: "Source",
});
const message = (id: string, text: string, annotations: unknown[] = []) => ({
	type: "message",
	id,
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text, annotations }],
});
function response(items: ReturnType<typeof message>[], ending = "response.completed") {
	const events: Record<string, unknown>[] = [{ type: "response.created", response: { id: "resp_test" } }];
	for (const [index, item] of items.entries()) {
		events.push(
			{ type: "response.output_item.added", output_index: index, item: { ...item, content: [] } },
			{ type: "response.output_text.delta", output_index: index, delta: item.content[0]!.text },
			{ type: "response.output_item.done", output_index: index, item },
		);
	}
	events.push({
		type: ending,
		response: {
			id: "resp_test",
			status: ending === "response.completed" ? "completed" : "failed",
			output: items,
			usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 },
			error: { message: "Search unavailable for this account", code: "search_unavailable" },
		},
	});
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

beforeEach(async () => {
	await saveSettings({ openaiWebSearch: true });
});

it("defaults to On for new and existing profiles; only booleans override it", () => {
	const defaults = defaultSettings();
	expect(defaults.openaiWebSearch).toBe(true);
	for (const stored of [undefined, {}, { openaiWebSearch: "false" }, { openaiWebSearch: null }]) {
		expect(readSettings(stored, defaults).openaiWebSearch).toBe(true);
	}
	expect(readSettings({ openaiWebSearch: false }, defaults).openaiWebSearch).toBe(false);
});

it("persists the switch without changing other settings; a failed save leaves the saved value", async () => {
	const before = await loadSettings();
	await saveSettings({ openaiWebSearch: false });
	expect(local.get("settings")).toMatchObject({ openaiWebSearch: false });
	expect(await loadSettings()).toEqual({ ...before, openaiWebSearch: false });
	set.mockRejectedValueOnce(new Error("Storage failed"));
	await expect(saveSettings({ openaiWebSearch: true })).rejects.toThrow("Storage failed");
	expect((await loadSettings()).openaiWebSearch).toBe(false);
	await saveSettings({ language: "Chinese" });
	expect((await loadSettings()).openaiWebSearch).toBe(false);
});

it("composes async payload hooks and keeps function tools and other include fields", async () => {
	const tool = { type: "function", name: "read_page" };
	const original = { tools: [tool], include: ["reasoning.encrypted_content"] };
	const onPayload = vi.fn(async (payload: unknown, passed: Model<Api>) => {
		expect(payload).toBe(original);
		expect(passed).toBe(model);
		return { ...original, metadata: { hook: "kept" } };
	});
	const adapter = openaiSearch({ onPayload });
	expect(await adapter.options.onPayload!(original, model)).toEqual({
		...original,
		metadata: { hook: "kept" },
		tools: [tool, { type: "web_search" }],
		include: ["reasoning.encrypted_content", SOURCES],
	});
	expect(original.tools).toEqual([tool]);
	expect(onPayload).toHaveBeenCalledOnce();
});

it.each(["web_search", "web_search_preview"])(
	"does not duplicate an existing %s tool or sources include",
	async (type) => {
		const payload = { tools: [{ type, search_context_size: "low" }], include: [SOURCES] };
		const adapter = openaiSearch();
		expect(await adapter.options.onPayload!(payload, model)).toEqual(payload);
	},
);

it("reads the saved setting at request time; Off removes hosted search only", async () => {
	const adapter = openaiSearch();
	const tool = { type: "function", name: "read_page" };
	const payload = {
		tools: [tool, { type: "web_search" }, { type: "web_search_preview" }],
		include: [SOURCES, "reasoning.encrypted_content"],
		metadata: { keep: true },
	};
	await saveSettings({ openaiWebSearch: false });
	expect(await adapter.options.onPayload!(payload, model)).toEqual({
		...payload,
		tools: [tool],
		include: ["reasoning.encrypted_content"],
	});
	expect(await adapter.options.onPayload!({ model: "kept" }, model)).toEqual({ model: "kept" });
	await saveSettings({ openaiWebSearch: true });
	expect(await adapter.options.onPayload!({}, model)).toEqual({ tools: [{ type: "web_search" }], include: [SOURCES] });
});

it.each([
	{ ...model, provider: "openrouter" },
	{ ...model, api: "openai-completions" as const },
	{ ...model, baseUrl: "https://third-party.example/v1" },
])("does not change a request outside the native OpenAI Responses route: $provider/$api/$baseUrl", async (other) => {
	const payload = { tools: [{ type: "function", name: "read_page" }] };
	expect(await openaiSearch().options.onPayload!(payload, other)).toBe(payload);
});

for (const method of ["stream", "streamSimple"] as const) {
	it.each(["sk-proj-fabricated", "fabricated-chatgpt-access-token"])(
		`${method} enables search for %s and retains streamed/final citations and plan accounting`,
		async (apiKey) => {
			const onPayload = vi.fn(() => undefined);
			const onProviderStreamEvent = vi.fn(() => undefined);
			const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
				response([
					message("msg_1", "First", [citation("https://example.com/one")]),
					message("msg_2", "Other", [citation("https://example.com/two"), citation("https://example.com/one")]),
				]),
			);
			const options: StreamOptions = { apiKey, fetch: fetcher, onPayload, onProviderStreamEvent };
			const provider = models.getProvider("openai")!;
			const stream = provider[method](model, context, options);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();
			expect(result.errorMessage).toBeUndefined();
			expect(result.content.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
				"First [1](https://example.com/one)",
				"Other [1](https://example.com/one) [2](https://example.com/two)",
			]);
			expect(events.filter((event) => event.type === "text_end").map((event) => event.content)).toEqual(
				result.content.filter((part) => part.type === "text").map((part) => part.text),
			);
			expect(result.usage.totalTokens).toBe(32);
			expect(result.usage.cost.total === 0).toBe(!apiKey.startsWith("sk-"));
			expect(onPayload).toHaveBeenCalledOnce();
			expect(onProviderStreamEvent).toHaveBeenCalledWith(
				expect.objectContaining({ type: "response.output_item.done" }),
				model,
			);
			const [url, init] = fetcher.mock.calls[0]!;
			expect(String(url)).toBe("https://api.openai.com/v1/responses");
			expect(new Headers(init!.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
			expect(JSON.parse(init!.body as string)).toMatchObject({
				tools: [{ type: "web_search" }],
				include: expect.arrayContaining([SOURCES]),
			});
		},
	);
}

it("omits hosted search when Off and passes an uncited response unchanged", async () => {
	await saveSettings({ openaiWebSearch: false });
	const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const payload = JSON.parse(init!.body as string);
		expect(payload.tools ?? []).toEqual([]);
		expect(payload.include ?? []).not.toContain(SOURCES);
		return response([message("msg_1", "Plain answer.")]);
	});
	const stream = models.getProvider("openai")!.streamSimple(model, context, { apiKey: "sk-fake", fetch: fetcher });
	const result = await stream.result();
	expect(result.errorMessage).toBeUndefined();
	expect(result.content[0]).toMatchObject({ type: "text", text: "Plain answer." });
});

it("rejects unsafe/malformed citations, escapes link delimiters and deduplicates links", async () => {
	const safe = citation("https://example.com/a(b)?q=<value>", 4);
	const annotations = [
		citation("javascript:alert(1)"),
		citation("data:text/html,unsafe"),
		citation("file:///secret"),
		citation("not a URL"),
		citation(`https://example.com/${"a".repeat(MAX_URL_CHARS)}`),
		citation("https://example.com/negative", 4, -1),
		citation("https://example.com/overflow", 999),
		citation("https://example.com/fraction", 3.5),
		citation("https://example.com/reversed", 2, 3),
		safe,
		safe,
	];
	const stream = models.getProvider("openai")!.streamSimple(model, context, {
		apiKey: "sk-fake",
		fetch: async () => response([message("msg_1", "Hi 😀!", annotations)]),
	});
	const result = await stream.result();
	expect(result.content[0]).toMatchObject({
		type: "text",
		text: "Hi 😀 [1](https://example.com/a%28b%29?q=%3Cvalue%3E)!",
	});
});

it("keeps provider errors visible without retrying without search", async () => {
	const fetcher = vi.fn(async () => response([], "response.failed"));
	const stream = models.getProvider("openai")!.streamSimple(model, context, { apiKey: "sk-fake", fetch: fetcher });
	const result = await stream.result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("Search unavailable for this account");
	expect(fetcher).toHaveBeenCalledOnce();
});
