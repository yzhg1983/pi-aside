// The worker's gestures and tab lifecycle (design 6.17), with the real `Tabs`, `Drafts`, and `Chats` on a `chrome`
// stub. The fixture loads first: it installs the stub that `main.ts` registers its listeners on.
import { browser, connect, faux, fire, installs, workerSession } from "./fixtures/worker.ts";
import "../src/background/main.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it, vi } from "vitest";
import { Chats, ChatsDoc } from "../src/background/chats.ts";
import { MENU_ADD, MENU_PAGE_ASK, MENU_PAGE_PRESET, MENU_PRESET } from "../src/background/menus.ts";
import { credentials } from "../src/background/models.ts";
import { UNRESOLVED } from "../src/background/tabs.ts";
import { urlKey } from "../src/background/url-key.ts";
import { t } from "../src/shared/i18n.ts";
import { fillTemplate, PAGE_SELECTION, PRESETS } from "../src/shared/presets.ts";
import { type Draft, type PanelState, PROTOCOL_VERSION } from "../src/shared/protocol.ts";

vi.mock("../src/background/session.ts", () => workerSession);

const context = BACKGROUND_CONTEXT;
const PAGE_A = "https://a.test/a";
const PAGE_B = "https://a.test/b";
const PRESET_ITEM = `${MENU_PRESET}${PRESETS[0]!.id}`;
const PAGE_ITEM = `${MENU_PAGE_PRESET}${PRESETS[0]!.id}`;
/** The first prompt for the whole page of `url`, as `read()` titles it. */
const pagePrompt = (url: string) =>
	fillTemplate(PRESETS[0]!.template, { selection: PAGE_SELECTION, title: url, url, language: "English" });
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** The panels a test opened; they close after it, so no page keeps views or retention passes of the next test. */
const panels: ReturnType<typeof connect>[] = [];
afterEach(() => {
	for (const page of panels.splice(0)) page.disconnect();
});

/** The page script's answer for a document of `url` with `selection`. */
const read = (url: string, selection = "") => [
	{ documentId: `doc ${url}`, result: { url, title: url, selection, password: false, anchor: null } },
];

/** Holds the next page script until the test settles it. */
function holdCapture() {
	const held = Promise.withResolvers<ReturnType<typeof read>>();
	browser.inject = () => held.promise;
	return held;
}

function menuClick(tabId: number, url: string, item: string, selectionText?: string): void {
	fire(
		"contextMenus.onClicked",
		{ menuItemId: item, frameId: 0, pageUrl: url, editable: false, selectionText },
		{ id: tabId, url, title: url },
	);
}

/** A response that records the text of the input the model got. */
function answer(seen: string[]) {
	return (context: TranscriptContext) => {
		const content = context.messages.at(-1)?.content;
		seen.push(
			typeof content === "string"
				? content
				: (content ?? []).map((part) => ("text" in part ? part.text : "")).join(""),
		);
		return fauxAssistantMessage("answer");
	};
}

async function drafts(): Promise<Draft[]> {
	return ((await browser.session.store.get("drafts")).drafts ?? []) as Draft[];
}

async function chatIndex() {
	const { harness } = await workerSession.session();
	return (await harness.snapshot(ChatsDoc, context))?.chats ?? [];
}

/** A panel of tab `tabId` after its snapshot, and its commands. */
async function panel(tabId: number) {
	const page = connect(tabId);
	panels.push(page);
	page.send({ type: "hello", version: PROTOCOL_VERSION, tabId, log: false });
	// The hello of an unresolved tab waits up to 2 s for its lookup.
	const snapshot = await vi.waitFor(() => {
		const found = page.received.find((message) => message.type === "snapshot");
		if (found === undefined) throw new Error("no snapshot yet");
		return found;
	}, 5000);
	let next = 0;
	return {
		state: snapshot.state as PanelState,
		async run(command: Extract<Parameters<typeof page.send>[0], { type: "command" }>["command"]) {
			const id = `c${next++}`;
			page.send({ type: "command", id, command });
			return vi.waitFor(() => {
				const reply = page.received.find((message) => message.type === "reply" && message.id === id);
				if (reply === undefined) throw new Error("no reply yet");
				return reply;
			});
		},
	};
}

it.each([
	["New chat", "new", false, 11],
	["History", "history", false, 13],
	["New chat, while the gesture's write is held,", "new", true, 15],
	["History, while the gesture's write is held,", "history", true, 17],
] as const)(
	"a selection send whose capture ends after %s is rejected and becomes a draft",
	async (_, how, slow, tabId) => {
		browser.open.add(tabId).add(tabId + 1);
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		const { chats } = await workerSession.session();
		await chats.send(tabId, 0, null, { requestId: `first ${tabId}`, content: "hello" }, null);
		await chats.send(tabId + 1, 0, null, { requestId: `other ${tabId}`, content: "other" }, null);
		const other = workerSession.tabs.get(tabId + 1)!.chat!;
		const before = (await chatIndex()).length;

		const capture = holdCapture();
		// Slow: the gesture's `storage.session` write is still running when the switch arrives, right after the click.
		const release = slow ? browser.session.holdSet() : undefined;
		menuClick(tabId, PAGE_A, PRESET_ITEM);
		// Otherwise the tab resolves at once; the capture is still running.
		if (!slow) await new Promise((resolve) => setTimeout(resolve, 50));
		const switched = how === "new" ? chats.newChat(tabId, 0) : chats.openChat(tabId, 0, other);
		await new Promise((resolve) => setTimeout(resolve, 50));
		release?.();
		await switched;
		capture.resolve(read(PAGE_A, "some text"));

		await vi.waitFor(async () =>
			expect((await drafts()).filter((draft) => draft.tabId === tabId)).toEqual([
				expect.objectContaining({ note: "This tab's chat changed; nothing was sent", key: urlKey(PAGE_A, null) }),
			]),
		);
		expect(workerSession.tabs.get(tabId)).toMatchObject({ chat: how === "new" ? null : other, rev: 1 });
		expect(await chatIndex()).toHaveLength(before);
		expect(faux.state.callCount).toBe(2);
		faux.state.callCount = 0;
	},
);

it("a typed message keeps the key of the gesture that captured its page, also after a newer capture", async () => {
	const tabId = 21;
	browser.open.add(tabId);
	faux.setResponses([fauxAssistantMessage("answer")]);
	browser.inject = async () => read(PAGE_A);
	fire("action.onClicked", { id: tabId, url: PAGE_A, title: "A" });
	await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(PAGE_A));
	const shown = await panel(tabId);
	expect(shown.state.page).toMatchObject({ url: PAGE_A, key: urlKey(PAGE_A, null) });

	// A gesture on B captured before the send arrived; the panel still showed A.
	browser.inject = async () => read(PAGE_B);
	fire("action.onClicked", { id: tabId, url: PAGE_B, title: "B" });
	await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(PAGE_B));
	const reply = await shown.run({
		type: "send",
		rev: shown.state.rev,
		conversationId: null,
		requestId: "typed 21",
		text: "about A",
		draftId: null,
		quote: false,
		page: shown.state.page,
		whenBusy: "followUp",
		attachments: [],
	});
	expect(reply).toMatchObject({ ok: true });
	expect((await chatIndex()).at(-1)).toMatchObject({ request: "typed 21", key: urlKey(PAGE_A, null) });
});

it("a gesture on another page does not give a restored tab's page that page's key", async () => {
	const tabId = 22;
	browser.open.add(tabId);
	faux.setResponses([fauxAssistantMessage("answer")]);
	// A worker before this one captured A; the tab's lookup never ran.
	const pageA = { ...read(PAGE_A)[0]!, tabId, frameId: 0, url: PAGE_A, title: "A", capturedAt: 1 };
	await workerSession.tabs.set(tabId, () => ({
		...UNRESOLVED,
		url: PAGE_A,
		page: { tabId, frameId: 0, documentId: pageA.documentId, url: PAGE_A, title: "A", capturedAt: 1, key: PAGE_A },
	}));
	// The capture of B never answers: the lookup runs after 2 s, by B's key.
	holdCapture();
	fire("action.onClicked", { id: tabId, url: PAGE_B, title: "B" });
	const shown = await panel(tabId);
	expect(workerSession.tabs.get(tabId)).toMatchObject({ chat: null, url: PAGE_B });
	expect(shown.state.page?.url).toBe(PAGE_A);

	// The tab answers the send's look at where it is (design 6.28), though the capture still does not.
	browser.inject = async () => read(PAGE_B);
	const reply = await shown.run({
		type: "send",
		rev: shown.state.rev,
		conversationId: null,
		requestId: "typed 22",
		text: "about A",
		draftId: null,
		quote: false,
		page: shown.state.page,
		whenBusy: "followUp",
		attachments: [],
	});
	expect(reply).toMatchObject({ ok: true });
	expect((await chatIndex()).at(-1)).toMatchObject({ request: "typed 22", key: PAGE_A });
}, 10_000);

it.each([
	["A preset send", PRESET_ITEM, "Chrome reloaded the tab; nothing was sent"],
	["Add to message", MENU_ADD, null],
])(
	"%s whose capture ends after Chrome replaced the tab is a draft of its new ID; after a close, of none",
	async (_, item, note) => {
		const [replaced, added, closed] = item === MENU_ADD ? [31, 32, 33] : [41, 42, 43];
		browser.open.add(replaced).add(closed);
		const before = (await chatIndex()).length;

		// Chrome could not read the page, and the context menu's copy of the selection is the fallback.
		const first = holdCapture();
		menuClick(replaced, PAGE_A, item, "picked");
		fire("tabs.onReplaced", added, replaced);
		browser.open.delete(replaced);
		browser.open.add(added);
		first.reject(new Error(`No tab with id: ${replaced}`));
		await vi.waitFor(async () =>
			expect((await drafts()).filter((draft) => draft.tabId === added)).toEqual([
				expect.objectContaining({ text: item === MENU_ADD ? "picked" : expect.stringContaining("picked"), note }),
			]),
		);
		expect((await drafts()).some((draft) => draft.tabId === replaced)).toBe(false);

		const second = holdCapture();
		menuClick(closed, PAGE_A, item, "picked");
		fire("tabs.onRemoved", closed);
		browser.open.delete(closed);
		second.reject(new Error(`No tab with id: ${closed}`));
		await settle();
		expect((await drafts()).some((draft) => draft.tabId === closed)).toBe(false);
		expect(await chatIndex()).toHaveLength(before);
	},
);

it("a notice for a tab Chrome replaced goes to its new ID; one for a closed tab is dropped", async () => {
	browser.open.add(51).add(53);
	const first = holdCapture();
	menuClick(51, PAGE_A, PRESET_ITEM);
	fire("tabs.onReplaced", 52, 51);
	browser.open.delete(51);
	browser.open.add(52);
	first.resolve(read(PAGE_A));
	await settle();
	expect((await panel(52)).state.notice).toMatchObject({ text: "Select text on the page first" });

	const second = holdCapture();
	menuClick(53, PAGE_A, PRESET_ITEM);
	fire("tabs.onRemoved", 53);
	browser.open.delete(53);
	second.resolve(read(PAGE_A));
	await settle();
	expect((await panel(53)).state.notice).toBeNull();
});

it.each([
	["closed", 71],
	["replaced", 73],
] as const)("a tab %s while its save fails admits no late selection send from its old ID", async (how, tabId) => {
	browser.open.add(tabId);
	faux.setResponses([fauxAssistantMessage("first")]);
	const { chats } = await workerSession.session();
	const first = await chats.send(tabId, 0, null, { requestId: `first ${tabId}`, content: "hello" }, null);
	const chat = workerSession.tabs.get(tabId)!.chat!;
	await vi.waitFor(async () => expect((await chats.list(tabId)).some((summary) => summary.running)).toBe(false));
	const calls = faux.state.callCount;

	const capture = holdCapture();
	menuClick(tabId, PAGE_A, PRESET_ITEM, "picked");
	await new Promise((resolve) => setTimeout(resolve, 50));
	// The drop or the move fails to save: the old ID keeps its entry.
	browser.session.failSet();
	browser.open.delete(tabId);
	if (how === "closed") {
		fire("tabs.onRemoved", tabId);
	} else {
		browser.open.add(tabId + 1);
		fire("tabs.onReplaced", tabId + 1, tabId);
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(workerSession.tabs.get(tabId)?.chat).toBe(chat);
	// Chrome could not read the page; the context menu's copy of the selection is the fallback.
	capture.reject(new Error(`No tab with id: ${tabId}`));

	if (how === "replaced") {
		await vi.waitFor(async () =>
			expect((await drafts()).filter((draft) => draft.tabId === tabId + 1)).toEqual([
				expect.objectContaining({ note: "Chrome reloaded the tab; nothing was sent" }),
			]),
		);
	} else {
		await settle();
	}
	expect((await drafts()).some((draft) => draft.tabId === tabId)).toBe(false);
	expect(faux.state.callCount).toBe(calls);
	// A resend of what was admitted before still gets its admission.
	expect(await chats.send(tabId, 0, chat, { requestId: `first ${tabId}`, content: "hello" }, null)).toBe(first);
});

it("a panel that closes during its hello keeps no view of its tab's chat", async () => {
	const tabId = 81;
	browser.open.add(tabId);
	faux.setResponses([fauxAssistantMessage("answer")]);
	const { chats, harness } = await workerSession.session();
	await chats.send(tabId, 0, null, { requestId: "first 81", content: "hello" }, null);
	const chat = workerSession.tabs.get(tabId)!.chat!;
	await vi.waitFor(async () => expect((await chats.list(tabId)).some((summary) => summary.running)).toBe(false));
	chats.retain(new Set());

	const gate = Promise.withResolvers<void>();
	const conversation = harness.conversation.bind(harness);
	const spy = vi.spyOn(harness, "conversation").mockImplementation(async (...args) => {
		if (Number(args[0]) === chat) await gate.promise;
		return conversation(...args);
	});
	try {
		const page = connect(tabId);
		page.send({ type: "hello", version: PROTOCOL_VERSION, tabId, log: false });
		// The hello attaches the chat's view; the panel closes before it is ready.
		await vi.waitFor(() => expect(spy.mock.calls.some(([id]) => Number(id) === chat)).toBe(true));
		// No other page is connected, so no later change runs a retention pass.
		page.disconnect();
		gate.resolve();
		await settle();
		expect(page.received).toEqual([]);
		expect(chats.view(chat)).toBeUndefined();
	} finally {
		spy.mockRestore();
	}
});

it("a page captured in a replaced tab's new ID before the move ran stays, and the chat moves to it", async () => {
	const [old, added] = [91, 92];
	browser.open.add(old);
	faux.setResponses([fauxAssistantMessage("answer")]);
	const { chats } = await workerSession.session();
	await chats.send(old, 0, null, { requestId: "first 91", content: "hello" }, null);
	const chat = workerSession.tabs.get(old)!.chat!;

	// An earlier command holds the queue, so the move waits.
	const gate = Promise.withResolvers<void>();
	const held = workerSession.commands(() => gate.promise);
	browser.open.delete(old);
	browser.open.add(added);
	fire("tabs.onReplaced", added, old);
	browser.inject = async () => read(PAGE_B);
	fire("action.onClicked", { id: added, url: PAGE_B, title: "B" });
	await vi.waitFor(() => expect(workerSession.tabs.get(added)?.page?.url).toBe(PAGE_B));
	gate.resolve();
	await held;

	await vi.waitFor(() => expect(workerSession.tabs.get(old)).toBeUndefined());
	expect(workerSession.tabs.get(added)).toMatchObject({
		chat,
		url: PAGE_B,
		page: { url: PAGE_B, key: urlKey(PAGE_B, null) },
	});
});

// The pi menu without a selection (design 6.18).

it("a page prompt sends the tab's top-level page, and its entry and History show the prompt and the page", async () => {
	const tabId = 101;
	// A page no earlier test has a chat of: the prompt starts one.
	const url = "https://a.test/page-prompt";
	browser.open.add(tabId);
	const seen: string[] = [];
	faux.setResponses([answer(seen)]);
	const frames: (number[] | undefined)[] = [];
	browser.inject = async (_, frameIds) => {
		frames.push(frameIds);
		return read(url);
	};
	// The right-click was in a frame; the prompt is about the tab's page.
	fire(
		"contextMenus.onClicked",
		{ menuItemId: PAGE_ITEM, frameId: 3, frameUrl: "https://frame.test/", pageUrl: "https://frame.test/" },
		{ id: tabId, url, title: "A" },
	);
	await vi.waitFor(() => expect(seen).toHaveLength(1));
	// The read, and the watcher for where the page sends the tab (design 6.28): both in the top frame.
	expect(frames.length).toBeGreaterThan(0);
	expect(frames.every((ids) => ids?.length === 1 && ids[0] === 0)).toBe(true);
	expect(seen[0]).toBe(`${pagePrompt(url)}\n\n[Attached page: "${url}" (${url})]`);
	expect((await chatIndex()).at(-1)).toMatchObject({
		id: workerSession.tabs.get(tabId)?.chat,
		key: urlKey(url, null),
	});

	const { chats } = await workerSession.session();
	expect((await chats.list(tabId))[0]).toMatchObject({ title: `${PRESETS[0]!.name}: ${url}` });
	const shown = await panel(tabId);
	expect(shown.state.chat.entries[0]).toMatchObject({
		role: "user",
		text: PRESETS[0]!.name,
		quote: null,
		source: { title: url, url },
	});
	expect((await drafts()).filter((draft) => draft.tabId === tabId)).toEqual([]);
});

it("a page prompt that is saved clears the storage banner, as a send from the panel does (design 8)", async () => {
	const tabId = 105;
	const url = "https://a.test/storage-prompt";
	browser.open.add(tabId);
	await workerSession.storageFull.note(new DOMException("The quota has been exceeded.", "QuotaExceededError"));
	expect(workerSession.storageFull.full).toBe(true);
	const seen: string[] = [];
	faux.setResponses([answer(seen)]);
	browser.inject = async () => read(url);
	fire("contextMenus.onClicked", { menuItemId: PAGE_ITEM, frameId: 0, pageUrl: url }, { id: tabId, url, title: "A" });
	await vi.waitFor(() => expect(seen).toHaveLength(1));
	await vi.waitFor(() => expect(workerSession.storageFull.full).toBe(false));
});

it("Ask pi about this page attaches the page and sends nothing", async () => {
	const tabId = 102;
	browser.open.add(tabId);
	const calls = faux.state.callCount;
	browser.inject = async () => read(PAGE_A);
	menuClick(tabId, PAGE_A, MENU_PAGE_ASK);
	await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(PAGE_A));
	await settle();
	expect(faux.state.callCount).toBe(calls);
	expect((await drafts()).filter((draft) => draft.tabId === tabId)).toEqual([]);
	expect((await panel(tabId)).state.notice).toBeNull();
});

it.each([
	["a page pi cannot read", 103, PAGE_ITEM, "pi cannot read this page: Cannot access contents of the page"],
	["a deleted prompt", 104, `${MENU_PAGE_PRESET}gone`, "This prompt was deleted. Nothing was sent."],
])("a page prompt for %s sends nothing and says why", async (_, tabId, item, notice) => {
	browser.open.add(tabId);
	const calls = faux.state.callCount;
	browser.inject = async () => {
		if (item === PAGE_ITEM) throw new Error("Cannot access contents of the page");
		return read(PAGE_A);
	};
	menuClick(tabId, PAGE_A, item);
	await settle();
	expect((await panel(tabId)).state.notice).toMatchObject({ text: notice });
	expect(faux.state.callCount).toBe(calls);
	expect((await drafts()).filter((draft) => draft.tabId === tabId)).toEqual([]);
});

it("a prompt that is off sends nothing from the menu, for a selection or the page, and says so", async () => {
	const page = await panel(140);
	expect(await page.run({ type: "switch-prompt", promptId: "summarize", on: false })).toMatchObject({ ok: true });
	// The default stays on.
	expect(await page.run({ type: "switch-prompt", promptId: PRESETS[0]!.id, on: false })).toMatchObject({ ok: false });
	const calls = faux.state.callCount;
	for (const [tabId, item] of [
		[141, `${MENU_PRESET}summarize`],
		[142, `${MENU_PAGE_PRESET}summarize`],
	] as const) {
		browser.open.add(tabId);
		browser.inject = async () => read(PAGE_A, "some text");
		menuClick(tabId, PAGE_A, item, "some text");
		await settle();
		expect((await panel(tabId)).state.notice).toMatchObject({ text: "This prompt is off. Nothing was sent." });
		expect((await drafts()).filter((draft) => draft.tabId === tabId)).toEqual([]);
	}
	expect(faux.state.callCount).toBe(calls);
	expect(await page.run({ type: "switch-prompt", promptId: "summarize", on: true })).toMatchObject({ ok: true });
});

it.each([
	["unchanged keeps the prompt's name", false, 105],
	["edited is a plain message", true, 107],
])(
	"a refused page prompt is a draft of its page; sent later %s, about that page, not the tab's newer one",
	async (_, edited, tabId) => {
		browser.open.add(tabId);
		const seen: string[] = [];
		faux.setResponses([fauxAssistantMessage("first"), answer(seen)]);
		const { chats } = await workerSession.session();
		await chats.send(tabId, 0, null, { requestId: `first ${tabId}`, content: "hello" }, null);
		await vi.waitFor(async () => expect((await chats.list(tabId)).some((summary) => summary.running)).toBe(false));

		// New chat arrives while the capture runs: the gesture's send is refused.
		const capture = holdCapture();
		menuClick(tabId, PAGE_A, PAGE_ITEM);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await chats.newChat(tabId, 0);
		capture.resolve(read(PAGE_A));
		const keyA = urlKey(PAGE_A, null);
		await vi.waitFor(async () =>
			expect((await drafts()).filter((draft) => draft.tabId === tabId)).toEqual([
				expect.objectContaining({
					text: pagePrompt(PAGE_A),
					selection: null,
					page: expect.objectContaining({ url: PAGE_A, documentId: `doc ${PAGE_A}`, key: keyA }),
					prompt: PRESETS[0]!.name,
					key: keyA,
					note: "This tab's chat changed; nothing was sent",
				}),
			]),
		);

		// A gesture on B; the panel sends the draft with its own page, as `attachedPage()` picks it.
		browser.inject = async () => read(PAGE_B);
		fire("action.onClicked", { id: tabId, url: PAGE_B, title: "B" });
		await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(PAGE_B));
		const shown = await panel(tabId);
		const draft = shown.state.drafts[0]!;
		const text = edited ? `${draft.text} Briefly.` : draft.text;
		const reply = await shown.run({
			type: "send",
			rev: shown.state.rev,
			conversationId: null,
			requestId: `draft ${tabId}`,
			text,
			draftId: draft.id,
			quote: true,
			page: draft.page,
			whenBusy: "followUp",
			attachments: [],
		});
		expect(reply).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		// About A, and the model is told the tab shows B now (design 6.28).
		expect(seen[0]).toBe(
			`${text}\n\n[Attached page: "${PAGE_A}" (${PAGE_A}); the tab now shows "${PAGE_B}" (${PAGE_B})]`,
		);
		expect((await chatIndex()).at(-1)).toMatchObject({ request: `draft ${tabId}`, key: keyA });
		const title = (await chats.list(tabId)).find((summary) => summary.active)?.title;
		if (edited) expect(title).toMatch(/^Explain this text from/);
		else expect(title).toBe(`${PRESETS[0]!.name}: ${PAGE_A}`);
		expect((await drafts()).filter((draft) => draft.tabId === tabId)).toEqual([]);
	},
);

it("a page prompt refused because Chrome replaced the tab is a draft of the new ID; after a close, of none", async () => {
	const [replaced, added, closed] = [111, 112, 113];
	browser.open.add(replaced).add(closed);
	const before = (await chatIndex()).length;
	browser.inject = async () => read(PAGE_A);

	// An earlier command holds the queue: the capture ends, and the send waits until the tab is gone.
	let gate = Promise.withResolvers<void>();
	let held = workerSession.commands(() => gate.promise);
	menuClick(replaced, PAGE_A, PAGE_ITEM);
	await vi.waitFor(() => expect(workerSession.tabs.get(replaced)?.page?.url).toBe(PAGE_A));
	browser.open.delete(replaced);
	browser.open.add(added);
	fire("tabs.onReplaced", added, replaced);
	gate.resolve();
	await held;
	await vi.waitFor(async () =>
		expect((await drafts()).filter((draft) => draft.tabId === added)).toEqual([
			expect.objectContaining({
				prompt: PRESETS[0]!.name,
				page: expect.objectContaining({ url: PAGE_A }),
				note: "Chrome reloaded the tab; nothing was sent",
			}),
		]),
	);

	gate = Promise.withResolvers<void>();
	held = workerSession.commands(() => gate.promise);
	menuClick(closed, PAGE_A, PAGE_ITEM);
	await vi.waitFor(() => expect(workerSession.tabs.get(closed)?.page?.url).toBe(PAGE_A));
	browser.open.delete(closed);
	fire("tabs.onRemoved", closed);
	gate.resolve();
	await held;
	await settle();
	expect((await drafts()).some((draft) => draft.tabId === replaced || draft.tabId === closed)).toBe(false);
	expect(await chatIndex()).toHaveLength(before);
});

it.each([
	["OpenAI", "openai", "eyJhbGciOiJSUzI1NiJ9.fake", "sk-proj-fake"],
	["Anthropic", "anthropic", "sk-ant-oat01-fake", "sk-ant-api03-fake"],
] as const)(
	"saving a %s subscription token is refused; an API key is saved, and an empty value removes it",
	async (_, provider, token, key) => {
		const shown = await panel(121);
		const stored = () => (browser.local.get("credentials") as Record<string, unknown> | undefined)?.[provider];
		expect(await shown.run({ type: "set-key", provider, key: token })).toMatchObject({
			ok: false,
			error: t("subscriptionRefused"),
		});
		expect(stored()).toBeUndefined();
		expect(await shown.run({ type: "set-key", provider, key })).toMatchObject({ ok: true });
		expect(stored()).toEqual({ type: "api_key", key });
		expect(await shown.run({ type: "set-key", provider, key: "" })).toMatchObject({ ok: true });
		expect(stored()).toBeUndefined();
	},
);

it("a key saved while a removal stops the provider's work waits for the stop; a failed stop is finished first (design 6.20)", async () => {
	const shown = await panel(131);
	const stored = () => (browser.local.get("credentials") as Record<string, unknown> | undefined)?.openrouter;
	const marker = () => browser.local.get("stoppingProviders");
	expect(await shown.run({ type: "set-key", provider: "openrouter", key: "sk-or-old" })).toMatchObject({ ok: true });
	const stopping = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const stop = vi.spyOn(Chats.prototype, "stopProvider").mockImplementationOnce(async () => {
		stopping.resolve();
		await stopped.promise;
	});
	try {
		const removal = shown.run({ type: "set-key", provider: "openrouter", key: "" });
		await stopping.promise;
		expect(stored()).toBeUndefined();
		expect(marker()).toEqual({ openrouter: expect.any(String) });
		const replacement = shown.run({ type: "set-key", provider: "openrouter", key: "sk-or-new" });
		await settle();
		expect(stored()).toBeUndefined();
		stopped.resolve();
		expect(await removal).toMatchObject({ ok: true });
		expect(await replacement).toMatchObject({ ok: true });
		expect(stored()).toEqual({ type: "api_key", key: "sk-or-new" });
		expect(marker()).toEqual({});

		// A stop that fails keeps the marker; the next save stops the work before it saves.
		stop.mockRejectedValueOnce(new Error("stop failed"));
		expect(await shown.run({ type: "set-key", provider: "openrouter", key: "" })).toMatchObject({
			ok: false,
			error: "stop failed",
		});
		expect(stored()).toBeUndefined();
		expect(marker()).toEqual({ openrouter: expect.any(String) });
		const calls = stop.mock.calls.length;
		expect(await shown.run({ type: "set-key", provider: "openrouter", key: "sk-or-again" })).toMatchObject({
			ok: true,
		});
		expect(stop.mock.calls.length).toBe(calls + 1);
		expect(marker()).toEqual({});
		expect(stored()).toEqual({ type: "api_key", key: "sk-or-again" });
	} finally {
		stop.mockRestore();
	}
});

it("Sign out revokes the refresh token it deleted: the one a refresh that held the store's lock wrote", async () => {
	const shown = await panel(133);
	const AUTH = "https://auth.openai.com";
	const revoked: string[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === `${AUTH}/.well-known/openid-configuration`) {
			return Response.json({
				issuer: AUTH,
				jwks_uri: `${AUTH}/.well-known/jwks.json`,
				revocation_endpoint: `${AUTH}/oauth/revoke`,
			});
		}
		if (url === `${AUTH}/oauth/revoke`) {
			revoked.push(String(new URLSearchParams(String(init?.body)).get("token")));
			return new Response(null, { status: 200 });
		}
		return new Response(null, { status: 404 });
	});
	try {
		const account = { clientId: "oaiapp_1", subject: "user-1", email: "someone@example.com" };
		await credentials.modify("openai", async () => ({
			type: "oauth",
			access: "at-old",
			refresh: "rt-old",
			expires: Date.now() + 3_600_000,
			...account,
			idToken: "id-1",
			scopes: [],
		}));
		// A refresh holds the store's lock; Sign out reads rt-old meanwhile.
		const release = Promise.withResolvers<void>();
		const refreshing = credentials.modify("openai", async (current) => {
			await release.promise;
			return current?.type === "oauth" ? { ...current, access: "at-new", refresh: "rt-new" } : current;
		});
		const signingOut = shown.run({ type: "chatgpt-sign-out" });
		await vi.waitFor(() => expect(browser.local.get("stoppingProviders")).toEqual({ openai: expect.any(String) }));
		release.resolve();
		await refreshing;
		expect(await signingOut).toMatchObject({ ok: true });
		expect(revoked).toEqual(["rt-new"]);
		expect(await credentials.read("openai")).toBeUndefined();
		expect(browser.local.get("chatgptAccount")).toEqual(account);
		expect(browser.local.get("stoppingProviders")).toEqual({});
	} finally {
		vi.unstubAllGlobals();
	}
});

it("a change of tool modes installs the page tools again and sends waiting cards back to their calls; only the chat's tab answers a card (design 6.23)", async () => {
	browser.open.add(91).add(92);
	faux.setResponses([fauxAssistantMessage("hi")]);
	const { chats } = await workerSession.session();
	await chats.send(91, 0, null, { requestId: "tools 91", content: "hello" }, null);
	const chat = workerSession.tabs.get(91)!.chat as number;
	const { asks } = workerSession;
	const waiting = asks.ask(
		{ kind: "act", conversationId: chat, run: 7, origin: "https://a.test" },
		undefined,
		asks.version,
	);
	const page = await panel(91);
	expect(page.state.asks).toEqual([{ id: expect.any(String), kind: "act", origin: "https://a.test" }]);
	const askId = page.state.asks[0]!.id;
	const other = await panel(92);
	expect(await other.run({ type: "answer-ask", askId, answer: "allow" })).toMatchObject({ ok: false });

	const before = installs.length;
	await page.run({ type: "set-settings", settings: { tools: { act: "on" } } });
	expect(await waiting).toBe("recheck");
	expect(installs.slice(before)).toEqual([
		expect.objectContaining({
			tools: { read: "on", observe: "on", act: "on", script: "ask", screenshot: "on" },
			callsPerAnswer: 50,
		}),
	]);
	// A save that changes no mode installs nothing.
	await page.run({ type: "set-settings", settings: { thinking: "low" } });
	expect(installs).toHaveLength(before + 1);

	const again = asks.ask(
		{ kind: "act", conversationId: chat, run: 7, origin: "https://a.test" },
		undefined,
		asks.version,
	);
	await page.run({ type: "answer-ask", askId: asks.cards(chat)[0]!.id, answer: "allow" });
	expect(await again).toBe("allow");
	expect(asks.granted(chat, 7, "https://a.test")).toBe(true);
	expect(asks.granted(chat, 8, "https://a.test")).toBe(false);
	await page.run({ type: "set-settings", settings: { tools: { act: "ask" }, thinking: "off" } });
});

it("a site card's Allow grants no acting: Chrome's access, which the panel requested, is the grant (design 6.28)", async () => {
	browser.open.add(91);
	faux.setResponses([fauxAssistantMessage("hi")]);
	const { chats } = await workerSession.session();
	await chats.send(91, 0, null, { requestId: "sites 91", content: "hello" }, null);
	const chat = workerSession.tabs.get(91)!.chat as number;
	const { asks } = workerSession;
	const page = await panel(91);

	const unknown = asks.ask({ kind: "site", conversationId: chat, run: 3, origin: null }, undefined, asks.version);
	await page.run({ type: "answer-ask", askId: asks.cards(chat)[0]!.id, answer: "deny" });
	expect(await unknown).toBe("deny");

	const waiting = asks.ask(
		{ kind: "site", conversationId: chat, run: 3, origin: "https://b.test" },
		undefined,
		asks.version,
	);
	await page.run({ type: "answer-ask", askId: asks.cards(chat)[0]!.id, answer: "allow" });
	expect(await waiting).toBe("allow");
	expect(asks.granted(chat, 3, "https://b.test")).toBe(false);
});

it("mode saves from two panels that cross install the mode saved last (design 6.23)", async () => {
	browser.open.add(91).add(92);
	const one = await panel(91);
	const two = await panel(92);
	await one.run({ type: "set-settings", settings: { tools: { act: "on" } } });
	// Both commands start before either save ends: each reads the same settings before its save.
	await Promise.all([
		one.run({ type: "set-settings", settings: { tools: { act: "off" } } }),
		two.run({ type: "set-settings", settings: { tools: { act: "on" } } }),
	]);
	expect(installs.at(-1)).toMatchObject({ tools: { act: "on" } });
	await one.run({ type: "set-settings", settings: { tools: { act: "ask" } } });
});

it("a change of the modes takes back allowances also when the tools offered stay the same, as while Chrome blocks scripts (design 6.23)", async () => {
	browser.open.add(91);
	const page = await panel(91);
	// Chrome's switch keeps run_script Off for the model, so Ask, Off, and Ask again install the same tools.
	const install = vi.spyOn(workerSession, "installPageTools").mockResolvedValue(false);
	const { asks } = workerSession;
	const version = asks.version;
	await page.run({ type: "set-settings", settings: { tools: { script: "off" } } });
	expect(asks.version).toBe(version + 1);
	// A save that changes no mode takes back nothing.
	await page.run({ type: "set-settings", settings: { thinking: "low" } });
	expect(asks.version).toBe(version + 1);
	await page.run({ type: "set-settings", settings: { tools: { script: "ask" }, thinking: "off" } });
	expect(asks.version).toBe(version + 2);
	install.mockRestore();
});

it("a mode save succeeds when the session cannot open; the tools follow once it opens", async () => {
	browser.open.add(91);
	const page = await panel(91);
	const before = installs.length;
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(workerSession, "session").mockRejectedValueOnce(new Error("storage failed"));
	expect(await page.run({ type: "set-settings", settings: { tools: { act: "on" } } })).toMatchObject({ ok: true });
	expect(installs).toHaveLength(before);
	expect(error).toHaveBeenCalledWith("[pi-aside] page tools wait for the session", expect.any(Error));
	await page.run({ type: "set-settings", settings: { thinking: "low" } });
	expect(installs.at(-1)).toMatchObject({ tools: { act: "on" } });
	await page.run({ type: "set-settings", settings: { tools: { act: "ask" }, thinking: "off" } });
});

it("Delete all chats erases the chats and every tab's drafts (design 6.31)", async () => {
	const page = await panel(91);
	const before = workerSession.deletedAll;
	expect(await page.run({ type: "delete-all-chats" })).toMatchObject({ ok: true });
	expect(workerSession.deletedAll).toBe(before + 1);
	expect(await drafts()).toEqual([]);
});

it("a write refused for a full disk shows the storage banner until all chats are deleted (design 8)", async () => {
	const tabId = 91;
	browser.open.add(tabId);
	faux.setResponses([fauxAssistantMessage("answer")]);
	const { chats } = await workerSession.session();
	await chats.send(tabId, 0, null, { requestId: "first 91", content: "hello" }, null);
	const chat = workerSession.tabs.get(tabId)!.chat!;
	await vi.waitFor(async () => expect((await chats.list(tabId)).some((summary) => summary.running)).toBe(false));
	const page = await panel(tabId);
	expect(page.state.status.storageFull).toBe(false);

	const rename = vi
		.spyOn(chats, "rename")
		.mockRejectedValueOnce(new DOMException("The quota has been exceeded.", "QuotaExceededError"));
	try {
		expect(await page.run({ type: "rename-chat", target: chat, title: "renamed" })).toMatchObject({ ok: false });
	} finally {
		rename.mockRestore();
	}
	expect(workerSession.storageFull.full).toBe(true);
	expect((await browser.session.store.get("storageFull")).storageFull).toBe(true);
	// A panel that opens now, as after a worker restart, shows it too.
	expect((await panel(tabId)).state.status.storageFull).toBe(true);

	// Another error is not a full disk; the banner stays until space is freed.
	const failing = vi.spyOn(chats, "rename").mockRejectedValueOnce(new Error("network"));
	try {
		await page.run({ type: "rename-chat", target: chat, title: "renamed" });
	} finally {
		failing.mockRestore();
	}
	expect(workerSession.storageFull.full).toBe(true);

	// Remove from History only hides the chat: its data stays, so no room is freed (design 6.30).
	expect(await page.run({ type: "remove-chat", target: chat })).toMatchObject({ ok: true });
	await settle();
	expect(workerSession.storageFull.full).toBe(true);

	expect(await page.run({ type: "delete-all-chats" })).toMatchObject({ ok: true });
	await vi.waitFor(() => expect(workerSession.storageFull.full).toBe(false));
	expect((await browser.session.store.get("storageFull")).storageFull).toBe(false);
});

it("a send's attachments are checked again and go into its entry; Stop's draft of one says they were not kept (design 6.42)", async () => {
	const tabId = 61;
	browser.open.add(tabId);
	faux.state.callCount = 0;
	// Streams nothing until Stop aborts it.
	const hang = (_: unknown, options?: { signal?: AbortSignal }) =>
		new Promise<never>((_, reject) =>
			options?.signal?.addEventListener("abort", () => reject(new Error("interrupted"))),
		);
	faux.setResponses([hang, fauxAssistantMessage("never")]);
	// A page of its own: a gesture on a page continues that page's newer chat.
	const url = "https://a.test/attachments";
	browser.inject = async () => read(url);
	fire("action.onClicked", { id: tabId, url, title: "Attachments" });
	await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(url));
	let shown = await panel(tabId);
	const send = (requestId: string, attachments: unknown[]) =>
		shown.run({
			type: "send",
			rev: shown.state.rev,
			conversationId: shown.state.chat.conversationId,
			requestId,
			text: "",
			draftId: null,
			quote: false,
			page: null,
			whenBusy: "followUp",
			attachments: attachments as never[],
		});
	const notes = { kind: "file", name: "notes.txt", text: "hello" };
	expect(await send("bad 61", [{ ...notes, text: "a\0b" }])).toMatchObject({
		ok: false,
		error: t("attachInvalid"),
	});
	expect(await send("first 61", [notes])).toMatchObject({ ok: true });
	const { harness } = await workerSession.session();
	const chat = workerSession.tabs.get(tabId)!.chat!;
	const records = await harness.commit(
		(tx) => tx.scanEntries({ conversationId: chat as never, order: "ascending" }, 10),
		context,
	);
	expect(records.items[0]).toMatchObject({
		kind: "web.input",
		data: { text: "", attachments: [{ kind: "file", name: "notes.txt", chars: 5 }] },
	});
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	shown = await panel(tabId);
	expect(await send("queued 61", [notes, notes])).toMatchObject({ ok: true });
	expect(await shown.run({ type: "abort", rev: shown.state.rev })).toMatchObject({ ok: true });
	await vi.waitFor(async () =>
		expect((await drafts()).filter((draft) => draft.tabId === tabId)).toMatchObject([
			{ text: "", note: t("attachmentsNotKept") },
		]),
	);
	faux.state.callCount = 0;
});
