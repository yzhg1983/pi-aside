import { beforeEach, expect, it } from "vitest";
import { ChromeCredentialStore, markStopping, stopMarkers, unmarkStopping } from "../src/background/credentials.ts";

const local = new Map<string, unknown>();
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
};

beforeEach(() => local.clear());

it("a worker start's unmark and another provider's mark at once keep the new marker, and only it (design 6.20)", async () => {
	const openai = await markStopping("openai");
	const [, openrouter] = await Promise.all([unmarkStopping("openai", openai), markStopping("openrouter")]);
	expect(await stopMarkers()).toEqual({ openrouter });
});

it("an unmark with an older token leaves the marker of a removal that marked the provider again", async () => {
	const first = await markStopping("openai");
	const second = await markStopping("openai");
	await unmarkStopping("openai", first);
	expect(await stopMarkers()).toEqual({ openai: second });
	await unmarkStopping("openai", second);
	expect(await stopMarkers()).toEqual({});
});

it("take returns the credential as a modify that held the lock left it, and deletes it", async () => {
	const store = new ChromeCredentialStore();
	await store.modify("openai", async () => ({ type: "api_key", key: "sk-old" }));
	const release = Promise.withResolvers<void>();
	const refreshing = store.modify("openai", async () => {
		await release.promise;
		return { type: "api_key", key: "sk-new" };
	});
	const taken = store.take("openai");
	release.resolve();
	await refreshing;
	expect(await taken).toEqual({ type: "api_key", key: "sk-new" });
	expect(await store.read("openai")).toBeUndefined();
});
