import { afterEach, expect, it, vi } from "vitest";
import { Drafts, draftEdited, MAX_DRAFTS } from "../src/background/drafts.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

it("a draft sent as it was is not edited, though the panel trimmed it", () => {
	// The selection ended in a line break; the panel sends the composer text trimmed.
	expect(draftEdited("Explain this:\n\nsome text", "Explain this:\r\n\r\nsome text\n")).toBe(false);
	expect(draftEdited("Explain this:\n\nsome text?", "Explain this:\n\nsome text\n")).toBe(true);
	expect(draftEdited("What is this?", "Explain this:\n\nsome text")).toBe(true);
});

it("drafts move with a replaced tab, go with a closed one, and a tab without drafts saves nothing", async () => {
	const saved: Record<string, unknown> = {};
	const set = vi.fn(async (items: Record<string, unknown>) => {
		Object.assign(saved, structuredClone(items));
	});
	vi.stubGlobal("chrome", { storage: { session: { get: async () => structuredClone(saved), set } } });
	const drafts = new Drafts(() => {});
	const fields = { text: "t", selection: null, page: null, prompt: null, key: null, note: null, insert: false };
	await drafts.add({ ...fields, tabId: 1 });
	await drafts.add({ ...fields, tabId: 2 });
	expect(set).toHaveBeenCalledTimes(2);

	await drafts.moveTab(1, 5);
	expect([drafts.forTab(1), drafts.forTab(5).length]).toEqual([[], 1]);
	await drafts.removeTab(2);
	expect(drafts.forTab(2)).toEqual([]);
	expect(set).toHaveBeenCalledTimes(4);
	await drafts.removeTab(9);
	await drafts.moveTab(9, 10);
	expect(set).toHaveBeenCalledTimes(4);

	// Delete all chats: every tab's drafts go (design 6.31).
	await drafts.clear();
	expect(drafts.forTab(5)).toEqual([]);
	expect(saved.drafts).toEqual([]);
});

it("drafts moved onto a replaced tab's new ID, which already has one, keep the newest ten", async () => {
	const saved: Record<string, unknown> = {};
	vi.stubGlobal("chrome", {
		storage: {
			session: {
				get: async () => structuredClone(saved),
				set: async (items: Record<string, unknown>) => Object.assign(saved, structuredClone(items)),
			},
		},
	});
	const drafts = new Drafts(() => {});
	const fields = { selection: null, page: null, prompt: null, key: null, note: null, insert: false };
	for (let index = 0; index < MAX_DRAFTS; index++) await drafts.add({ ...fields, text: `old ${index}`, tabId: 1 });
	// A selection that ended after the replacement went to the new ID before the move ran.
	await drafts.add({ ...fields, text: "late", tabId: 5 });

	await drafts.moveTab(1, 5);
	expect(drafts.forTab(1)).toEqual([]);
	expect(drafts.forTab(5).map((draft) => draft.text)).toEqual([
		...Array.from({ length: MAX_DRAFTS - 1 }, (_, index) => `old ${index + 1}`),
		"late",
	]);
	expect(saved.drafts).toHaveLength(MAX_DRAFTS);
});
