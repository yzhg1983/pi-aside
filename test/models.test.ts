// Keys for the four providers (design 6.19): subscription tokens are refused wherever a key is used, and Verify reports
// what each provider answered. Fabricated values only; `fetch` is stubbed, so nothing reaches a provider.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	checkModel,
	chosenThinking,
	credentials,
	models,
	sentThinking,
	thinkingFor,
	verifyKey,
} from "../src/background/models.ts";
import { type ProviderId, RECOMMENDED_MODELS } from "../src/shared/protocol.ts";

const local = new Map<string, unknown>();
let granted = true;
(globalThis as { chrome?: unknown }).chrome = {
	storage: {
		local: {
			setAccessLevel: async () => {},
			get: async (key: string) => (local.has(key) ? { [key]: structuredClone(local.get(key)) } : {}),
			set: async (items: Record<string, unknown>) => {
				for (const [key, value] of Object.entries(items)) local.set(key, structuredClone(value));
			},
		},
	},
	permissions: { contains: async () => granted },
};

beforeEach(() => {
	local.clear();
	granted = true;
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const store = (provider: ProviderId, key: string) =>
	credentials.modify(provider, async () => ({ type: "api_key", key }));
const model = (provider: ProviderId) => ({ provider, modelId: RECOMMENDED_MODELS[provider] });

it.each([
	// pi-ai's `isChatGPTSignIn()`: a value without `sk-` at OpenAI's default endpoint.
	["OpenAI", "openai", "eyJhbGciOiJSUzI1NiJ9.fake", "sk-proj-fake"],
	// pi-ai's `isOAuthToken()`: a value with `sk-ant-oat`.
	["Anthropic", "anthropic", "sk-ant-oat01-fake", "sk-ant-api03-fake"],
] as const)("a stored %s subscription token is used nowhere; an API key is", async (name, provider, token, key) => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal("fetch", fetch);
	await store(provider, token);
	await expect(checkModel(model(provider))).rejects.toThrow(
		`The ${name} key is a subscription token; pi needs an API key`,
	);
	// What pi-ai reads for each request, recovered ones included.
	expect(await models.getAuth(provider)).toBeUndefined();
	expect(await verifyKey(provider)).toEqual({ result: "no_key" });
	expect(fetch).not.toHaveBeenCalled();

	await store(provider, key);
	await expect(checkModel(model(provider))).resolves.toBeUndefined();
	expect(await models.getAuth(provider)).toBeDefined();
	// Without the host permission, a request gets no key.
	granted = false;
	expect(await models.getAuth(provider)).toBeUndefined();
	await expect(checkModel(model(provider))).rejects.toThrow(`No permission to reach ${name}: grant it to send`);
});

it("takes any value for OpenRouter and DeepSeek, which have no subscription sign-in", async () => {
	for (const provider of ["openrouter", "deepseek"] as const) {
		await store(provider, "not-sk-shaped");
		await expect(checkModel(model(provider))).resolves.toBeUndefined();
		expect(await models.getAuth(provider)).toBeDefined();
	}
});

it.each([
	["openrouter", "https://openrouter.ai/api/v1/key", { authorization: "Bearer sk-or-fake" }, "sk-or-fake"],
	["openai", "https://api.openai.com/v1/models", { authorization: "Bearer sk-proj-fake" }, "sk-proj-fake"],
	[
		"anthropic",
		"https://api.anthropic.com/v1/models",
		{
			"x-api-key": "sk-ant-api03-fake",
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		"sk-ant-api03-fake",
	],
	["deepseek", "https://api.deepseek.com/models", { authorization: "Bearer ds-fake" }, "ds-fake"],
] as const)(
	"Verify asks %s at %s with the key's headers, and reports each answer",
	async (provider, url, headers, key) => {
		await store(provider, key);
		const answers: (number | Error)[] = [200, 401, 403, 429, 500, new TypeError("Failed to fetch")];
		answers.push(new DOMException("The operation timed out.", "TimeoutError"));
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			const next = answers.shift()!;
			if (next instanceof Error) throw next;
			return new Response("{}", { status: next });
		});
		vi.stubGlobal("fetch", fetch);
		const results = [];
		for (let index = 0; index < 7; index++) results.push(await verifyKey(provider));
		expect(results).toEqual([
			{ result: "accepted", status: 200 },
			{ result: "rejected", status: 401 },
			{ result: "forbidden", status: 403 },
			{ result: "limited", status: 429 },
			{ result: "network_error", status: 500 },
			{ result: "network_error" },
			{ result: "timeout" },
		]);
		for (const [called, init] of fetch.mock.calls) {
			expect(called).toBe(url);
			expect(init?.headers).toEqual(headers);
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		}

		// No request without the host permission, or without a key.
		fetch.mockClear();
		granted = false;
		expect(await verifyKey(provider)).toEqual({ result: "no_permission" });
		await credentials.delete(provider);
		expect(await verifyKey(provider)).toEqual({ result: "no_key" });
		expect(fetch).not.toHaveBeenCalled();
	},
);

it("fits the thinking setting to each model's levels, rounding down (design 6.35)", () => {
	const model = (provider: ProviderId, id: string) => {
		const found = models.getModel(provider, id);
		if (found === undefined) throw new Error(`${provider}/${id} is not in the catalog`);
		return found;
	};
	const sent = (provider: ProviderId, id: string) => sentThinking(model(provider, id));
	// No Medium or Extra high: the next lower level, so a missing level never costs more.
	expect(sent("deepseek", "deepseek-flash")).toEqual({
		off: "off",
		low: "low",
		medium: "low",
		high: "high",
		xhigh: "high",
		max: "max",
	});
	// No Max: the next lower level, as before.
	expect(sent("openai", "gpt-5.2")).toMatchObject({ high: "high", xhigh: "xhigh", max: "xhigh" });
	// Nothing lower than High: the next higher level, never Off.
	expect(sent("deepseek", "deepseek-v4-pro")).toMatchObject({ low: "high", medium: "high", max: "max" });
	expect(sent("openai", "gpt-5-pro")).toMatchObject({ low: "high", xhigh: "high", max: "high" });
	// Thinking cannot be turned off: Off sends no level, so the provider's default applies.
	expect(sent("anthropic", "claude-fable-5").off).toBe("default");
	expect(sent("anthropic", "claude-haiku-5-5")).toMatchObject({ off: "off", xhigh: "xhigh", max: "max" });
	// A thinking budget, without the new levels: both send High.
	expect(sent("anthropic", "claude-opus-4-5")).toMatchObject({ high: "high", xhigh: "high", max: "high" });
	// What a chat gets: the same, by reference; a model not in the catalog gets the setting.
	expect(thinkingFor({ provider: "deepseek", modelId: "deepseek-flash" }, "medium")).toBe("low");
	expect(thinkingFor({ provider: "deepseek", modelId: "not-a-model" }, "medium")).toBe("medium");
	expect(chosenThinking(model("deepseek", "deepseek-flash"), "off")).toBe("off");
});
