import { beforeEach, expect, it } from "vitest";
import { buildMenus, MENU_PAGE_ASK, MENU_PAGE_PRESET } from "../src/background/menus.ts";
import { saveSettings } from "../src/background/settings.ts";
import { PRESETS } from "../src/shared/presets.ts";

const stored = new Map<string, unknown>();
const calls: string[] = [];
/** Callbacks Chrome has not called yet; the test calls them, with an error or without. */
const pending: { id: string; done: () => void }[] = [];
let holdCreates = false;

const chromeStub = {
	storage: {
		local: {
			get: async (key: string) => (stored.has(key) ? { [key]: stored.get(key) } : {}),
			set: async (items: Record<string, unknown>) => {
				for (const [key, value] of Object.entries(items)) stored.set(key, value);
			},
			remove: async (key: string) => {
				stored.delete(key);
			},
		},
	},
	i18n: { getUILanguage: () => "en" },
	runtime: { lastError: undefined as { message: string } | undefined },
	contextMenus: {
		removeAll(done: () => void) {
			calls.push("removeAll");
			setTimeout(done, 0);
		},
		create({ id, contexts }: { id: string; contexts: string[] }, done: () => void) {
			calls.push(`create ${id} ${contexts.join(",")}`);
			if (holdCreates) pending.push({ id, done });
			else setTimeout(done, 0);
		},
	},
};
(globalThis as unknown as { chrome: typeof chromeStub }).chrome = chromeStub;

function callBack(callback: { done: () => void }, error?: string): void {
	chromeStub.runtime.lastError = error === undefined ? undefined : { message: error };
	callback.done();
	chromeStub.runtime.lastError = undefined;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
	stored.clear();
	calls.length = 0;
	pending.length = 0;
	holdCreates = false;
});

/** One set for a selection, one for the page without one (design 6.18). */
const ITEMS = 2 + PRESETS.length + 1 + PRESETS.length;

it("builds a set for a selection and a set for the page, and stores them once built", async () => {
	await buildMenus(true);
	expect(calls).toEqual([
		"removeAll",
		"create ask-pi selection",
		"create add-to-message selection",
		...PRESETS.map((preset) => `create preset:${preset.id} selection`),
		`create ${MENU_PAGE_ASK} page`,
		...PRESETS.map((preset) => `create ${MENU_PAGE_PRESET}${preset.id} page`),
	]);
	expect(stored.get("menus")).toHaveLength(ITEMS);
	expect(ITEMS).toBe(13);
	calls.length = 0;
	await buildMenus(false);
	expect(calls).toEqual([]);
	// A build that a stopped worker left unfinished stored nothing.
	stored.delete("menus");
	await buildMenus(false);
	expect(calls[0]).toBe("removeAll");
	expect(stored.get("menus")).toHaveLength(ITEMS);
});

it("compares menu fields rather than JSON property order after native storage reorders keys", async () => {
	await buildMenus(true);
	const saved = stored.get("menus") as { id: string; title: string; contexts: string[] }[];
	stored.set(
		"menus",
		saved.map(({ id, title, contexts }) => ({ contexts, id, title })),
	);
	calls.length = 0;
	await buildMenus(false);
	expect(calls).toEqual([]);
});

it("rebuilds at the first worker start after an update that added the page set", async () => {
	// As the previous version stored them: the selection items, without their contexts.
	stored.set("menus", [
		{ id: "ask-pi", title: "Ask pi" },
		{ id: "add-to-message", title: "Add to message" },
		...PRESETS.map((preset) => ({ id: `preset:${preset.id}`, title: preset.name })),
	]);
	await buildMenus(false);
	expect(calls[0]).toBe("removeAll");
	expect(calls).toContain(`create ${MENU_PAGE_ASK} page`);
	expect(stored.get("menus")).toHaveLength(ITEMS);
});

it("rejects with Chrome's error after every create has called back, and only then starts the next build", async () => {
	holdCreates = true;
	const first = buildMenus(true);
	const firstResult = first.then(
		() => "built",
		(error: Error) => error.message,
	);
	await tick();
	expect(pending).toHaveLength(ITEMS);
	callBack(pending[0]!, "Cannot create item with duplicate id ask-pi");
	const second = buildMenus(true);
	await tick();
	// The first build has failed, but the other creates have not called back: the second must wait.
	expect(calls.filter((call) => call === "removeAll")).toHaveLength(1);
	for (const callback of pending.slice(1)) callBack(callback);
	expect(await firstResult).toBe("Cannot create item with duplicate id ask-pi");
	expect(stored.has("menus")).toBe(false);
	holdCreates = false;
	await second;
	expect(calls.filter((call) => call === "removeAll")).toHaveLength(2);
	expect(stored.get("menus")).toHaveLength(ITEMS);
});

it("leaves out the prompts that are off, in both sets", async () => {
	const off = PRESETS.map((preset) => (preset.id === "summarize" ? { ...preset, off: true as const } : preset));
	await saveSettings({ prompts: off });
	await buildMenus(true);
	expect(calls.filter((call) => call.includes("summarize"))).toEqual([]);
	expect(stored.get("menus")).toHaveLength(ITEMS - 2);
	calls.length = 0;
	// On again: the next build puts it back.
	await saveSettings({ prompts: [...PRESETS] });
	await buildMenus(false);
	expect(calls).toContain("create preset:summarize selection");
	expect(calls).toContain(`create ${MENU_PAGE_PRESET}summarize page`);
});
