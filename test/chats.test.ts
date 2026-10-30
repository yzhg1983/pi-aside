import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type CompactionPolicy,
	type ConversationId,
	createRegistry,
	defineDoc,
	defineTask,
	type EntryDraft,
	type EntryRecord,
	Harness,
	InboxDoc,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, it, vi } from "vitest";
import {
	ChatsDoc,
	type ChatsOptions,
	pageInput,
	QUEUE_SETTINGS,
	TabChanged,
	typedInput,
} from "../src/background/chats.ts";
import { INPUT_KIND, MESSAGE_KIND, SELECTION_KIND } from "../src/background/projection.ts";
import { attached, fileBlock } from "../src/shared/attachments.ts";
import type { MessageAttachment, SelectionEntryData, Thinking } from "../src/shared/protocol.ts";
import { memoryStore, openChats, panel } from "./fixtures/tabs.ts";

const context = BACKGROUND_CONTEXT;
const PAGE = "https://example.com/article";

/** A provider request that streams nothing until its signal aborts. */
function hang(_transcript: unknown, options?: { signal?: AbortSignal }): Promise<AssistantMessage> {
	return new Promise((_, reject) => {
		options?.signal?.addEventListener("abort", () => reject(new Error("interrupted")));
	});
}

/** A response that waits for `gate`, then answers `text`. */
function held(gate: Promise<void>, text: string) {
	return async () => {
		await gate;
		return fauxAssistantMessage(text);
	};
}

const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context).catch(() => {});
});

function setup(
	options: {
		check?: (model: ModelRef) => Promise<void>;
		imageLimit?: (model: ModelRef) => Promise<number | null>;
		saving?: (model: ModelRef) => Promise<void>;
		compaction?: Partial<CompactionPolicy>;
		paused?: boolean;
		moved?: ChatsOptions["moved"];
	} = {},
) {
	// Named like a real provider: panels show only the models of providers the extension supports.
	// "text" cannot read images (design 6.42).
	const faux = fauxProvider({
		provider: "openrouter",
		models: [{ id: "one", reasoning: true }, { id: "two" }, { id: "text", input: ["text"] }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: faux.getModel().provider, modelId: "one" };
	let defaultModel: ModelRef = model;
	const settings = { thinking: "off" as Thinking, thinkingModels: [] as ModelRef[] };
	const path = join(mkdtempSync(join(tmpdir(), "pi-aside-chats-")), "session.sqlite");
	const changed = vi.fn();
	const memory = memoryStore();
	const browser = { store: memory.store, open: new Set([1, 2, 3]) };
	let admitFailures = 0;
	const start = async () => {
		const registry = createRegistry();
		const harness = await Harness.open(
			await openNodeSqliteStorage(path),
			{
				models,
				registry,
				settings: {
					...QUEUE_SETTINGS,
					...(options.compaction === undefined ? {} : { compaction: options.compaction }),
				},
			},
			context,
		);
		open.push(harness);
		const { chats, tabs } = await openChats(harness, browser, {
			admit: async (operation) => {
				if (admitFailures > 0) {
					admitFailures -= 1;
					throw new Error("the worker stopped");
				}
				return operation();
			},
			check: options.check ?? (async () => {}),
			imageLimit:
				options.imageLimit ??
				(async (asked) =>
					models.getModel(asked.provider as "openrouter", asked.modelId)?.input.includes("image") ? 20 : null),
			defaultModel: async () => defaultModel,
			setDefaultModel: async (next) => {
				await options.saving?.(next);
				defaultModel = next;
			},
			thinking: async (asked) => {
				settings.thinkingModels.push(asked);
				return settings.thinking;
			},
			...(options.moved === undefined ? {} : { moved: options.moved }),
			changed,
		});
		if (!options.paused) harness.resume();
		// As a panel's hello does.
		await tabs.load();
		return { harness, registry, chats, tabs, tab: (tabId: number) => panel(chats, tabs, tabId) };
	};
	return {
		faux,
		model,
		changed,
		start,
		settings,
		path,
		memory,
		browser,
		failAdmit() {
			admitFailures += 1;
		},
	};
}

it("a running chat's progress keeps its start across tool rounds, which hand the run to a new task (design 6.21)", async () => {
	const { faux, start } = setup();
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	faux.setResponses([
		async () => {
			await first.promise;
			return fauxAssistantMessage([{ type: "toolCall", id: "c", name: "missing_tool", arguments: {} }], {
				stopReason: "toolUse",
			});
		},
		held(second.promise, "done"),
	]);
	const { tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "hello" }, PAGE);
	await vi.waitFor(() => expect(one.chat.progress).not.toBeNull());
	const started = one.chat.progress!.startedAt;
	await new Promise((resolve) => setTimeout(resolve, 20));
	first.resolve();
	await vi.waitFor(() => expect(one.chat.progress?.tools).toBe(1));
	expect(one.chat.progress?.startedAt).toBe(started);
	second.resolve();
	await vi.waitFor(() => expect(one.chat.progress).toBeNull());
});

it("steers that join a run keep the run's start and its tool count (design 6.39)", async () => {
	const { faux, start } = setup();
	const round = Promise.withResolvers<void>();
	const last = Promise.withResolvers<void>();
	const call = (id: string) =>
		fauxAssistantMessage([{ type: "toolCall", id, name: "missing_tool", arguments: {} }], { stopReason: "toolUse" });
	faux.setResponses([
		call("c1"),
		async () => {
			await round.promise;
			return call("c2");
		},
		held(last.promise, "done"),
	]);
	const { tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "task" }, PAGE);
	await vi.waitFor(() => expect(one.chat.progress?.tools).toBe(1));
	const started = one.chat.progress!.startedAt;
	await new Promise((resolve) => setTimeout(resolve, 20));
	await one.send({ requestId: "r2", content: "fix", whenBusy: "steer" });
	await one.send({ requestId: "r3", content: "fix more", whenBusy: "steer" });
	round.resolve();
	// Both steers are in the transcript after the second round, together; the run goes on with both rounds' tools and
	// its start.
	await vi.waitFor(() =>
		expect(one.chat.entries.filter((entry) => entry.role === "user").map((entry) => entry.text)).toEqual([
			"task",
			"fix",
			"fix more",
		]),
	);
	await vi.waitFor(() => expect(one.chat.progress?.tools).toBe(2));
	expect(one.chat.progress?.startedAt).toBe(started);
	last.resolve();
	await vi.waitFor(() => expect(one.chat.progress).toBeNull());
	// The answer's line counts the whole run, the rounds before both steers too.
	const answer = one.chat.entries.find((entry) => entry.text === "done");
	expect(answer?.stats?.tools).toEqual([{ name: "missing_tool", calls: 2, failed: 2 }]);
	expect(answer?.usage?.output).toBe(one.chat.entries.reduce((total, entry) => total + (entry.usage?.output ?? 0), 0));
});

it("a message sent after Stop in a run's tools starts its own answer's line", async () => {
	const { faux, start } = setup();
	faux.setResponses([
		fauxAssistantMessage([{ type: "toolCall", id: "c1", name: "missing_tool", arguments: {} }], {
			stopReason: "toolUse",
		}),
		hang,
		// Made when asked, so pi-ai times it and the answer has a line.
		async () => fauxAssistantMessage("next"),
	]);
	const { tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "task" }, PAGE);
	// Stopped after the tool round, before the model streamed anything: the run's last record is the tool result.
	await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
	await one.abort();
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	await one.send({ requestId: "r2", content: "again", whenBusy: "steer" });
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("next"));
	expect(one.chat.entries.at(-1)?.stats?.tools).toEqual([]);
});

it("a fresh tab's first send creates an indexed chat with the page's key, keeps the tab's rev, and shows the answer", async () => {
	const { faux, model, start } = setup();
	faux.setResponses([fauxAssistantMessage("hi there")]);
	const { harness, tabs, tab } = await start();
	const one = tab(1);
	expect(one.id).toBeNull();

	await one.send({ requestId: "r1", content: "hello" }, PAGE);
	const id = one.id!;
	expect(await harness.snapshot(ChatsDoc, context)).toEqual({
		chats: [{ id, createdAt: expect.any(Number), request: "r1", key: PAGE }],
	});
	expect(tabs.get(1)).toMatchObject({ chat: id, rev: 0, resumed: null });
	await vi.waitFor(() => expect(one.chat.entries.map((entry) => entry.text)).toEqual(["hello", "hi there"]));
	expect(one.chat).toMatchObject({ conversationId: id, model, busy: false, retry: null });
});

it("rule 2: an unresolved tab gets the newest chat started on its page, with a note until its next send", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);
	const { harness, chats, tabs, tab } = await start();
	await tab(1).send({ requestId: "r1", content: "older" }, PAGE);
	await tab(2).send({ requestId: "r2", content: "newer" }, PAGE);
	const newer = (await harness.snapshot(ChatsDoc, context))!.chats[1]!;

	// Tab 3's gesture recorded its URL; the lookup runs once.
	await tabs.set(3, (entry) => entry);
	await chats.lookup(3, PAGE);
	expect(tabs.get(3)).toMatchObject({ chat: newer.id, rev: 0, resumed: newer.createdAt });
	await vi.waitFor(() => expect(tab(3).chat.entries[0]?.text).toBe("newer"));
	await chats.lookup(3, "https://example.com/other");
	expect(tabs.get(3)?.chat).toBe(newer.id);

	await tab(3).send({ requestId: "r3", content: "more" });
	expect(tabs.get(3)).toMatchObject({ chat: newer.id, rev: 0, resumed: null });

	// No chat started on the page, no key, or no entry: fresh, fresh, untouched.
	await tabs.set(4, (entry) => entry);
	await chats.lookup(4, "https://example.com/other");
	await tabs.set(5, (entry) => entry);
	await chats.lookup(5, null);
	await chats.lookup(6, PAGE);
	expect([tabs.get(4)?.chat, tabs.get(5)?.chat, tabs.get(6)]).toEqual([null, null, undefined]);
});

it("two sends in one fresh tab both reach the chat the first creates", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	const { harness, tab } = await start();
	const one = tab(1);
	await Promise.all([
		one.send({ requestId: "r1", content: "first" }),
		one.send({ requestId: "r2", content: "second" }),
	]);
	expect((await harness.snapshot(ChatsDoc, context))?.chats).toHaveLength(1);
	await vi.waitFor(() =>
		expect(one.chat.entries.filter((entry) => entry.role === "user").map((entry) => entry.text)).toEqual([
			"first",
			"second",
		]),
	);
});

it("two fresh tabs on one page each create a chat, and rule 2 then finds the newer", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
	const { chats, tabs, tab } = await start();
	await Promise.all([
		tab(1).send({ requestId: "r1", content: "one" }, PAGE),
		tab(2).send({ requestId: "r2", content: "two" }, PAGE),
	]);
	expect(tab(1).id).not.toBe(tab(2).id);
	await tabs.set(3, (entry) => entry);
	await chats.lookup(3, PAGE);
	expect(tab(3).id).toBe(tab(2).id);
});

it("resend: a worker stop after creating the chat, before recording it, records it and sends once", async () => {
	const { faux, memory, start } = setup();
	faux.setResponses([fauxAssistantMessage("answer")]);
	const { harness, tab } = await start();
	memory.failSet();
	await expect(tab(1).send({ requestId: "r1", content: "hello" })).rejects.toThrow("storage failed");
	expect(tab(1).id).toBeNull();
	const created = (await harness.snapshot(ChatsDoc, context))!.chats[0]!.id;

	await tab(1).send({ requestId: "r1", content: "hello" });
	expect(tab(1).id).toBe(created);
	expect((await harness.snapshot(ChatsDoc, context))?.chats).toHaveLength(1);
	await vi.waitFor(() => expect(tab(1).chat.entries.map((entry) => entry.text)).toEqual(["hello", "answer"]));
});

it("resend: a worker stop after recording the chat, before submitting, submits to it", async () => {
	const { faux, failAdmit, start } = setup();
	faux.setResponses([fauxAssistantMessage("answer")]);
	const { harness, tab } = await start();
	failAdmit();
	await expect(tab(1).send({ requestId: "r1", content: "hello" })).rejects.toThrow("the worker stopped");
	const created = tab(1).id;
	expect(created).not.toBeNull();
	await vi.waitFor(() => expect(tab(1).chat.conversationId).toBe(created));
	expect(tab(1).chat.entries).toEqual([]);

	await tab(1).send({ requestId: "r1", content: "hello" });
	expect(tab(1).id).toBe(created);
	expect((await harness.snapshot(ChatsDoc, context))?.chats).toHaveLength(1);
	await vi.waitFor(() => expect(tab(1).chat.entries.map((entry) => entry.text)).toEqual(["hello", "answer"]));
});

it("resend: an admitted send returns its admission, also after the tab switched, and does not switch it back", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("answer")]);
	const first = await start();
	const submission = await first.tab(1).send({ requestId: "r1", content: "hello" });
	const chat = first.tab(1).id;
	await vi.waitFor(() => expect(first.tab(1).chat.busy).toBe(false));
	await first.tab(1).newChat();
	// The panel saw no chat when it sent, and resends with the `rev` it had.
	expect(await first.chats.send(1, 0, null, { requestId: "r1", content: "hello" }, null)).toBe(submission);
	expect(first.tabs.get(1)).toMatchObject({ chat: null, rev: 1 });
	first.chats.dispose();
	await first.harness.close(context);

	// After a worker restart too; the tab kept its entry in `storage.session`.
	const second = await start();
	expect(await second.chats.send(1, 0, chat, { requestId: "r1", content: "hello" }, null)).toBe(submission);
	expect(faux.state.callCount).toBe(1);
});

it.each([
	["New chat and another send", "new"],
	["History", "history"],
] as const)(
	"resend: a fresh tab's admitted first send is found after %s moved the tab to another chat",
	async (_, how) => {
		const { faux, start } = setup();
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);
		const first = await start();
		// Another tab's chat, for History.
		await first.tab(2).send({ requestId: "other", content: "other" });
		const other = first.tab(2).id!;
		// The reply to R is lost: its panel saw no chat and `rev` 0.
		const submission = await first.tab(1).send({ requestId: "R", content: "hello" });
		const created = first.tab(1).id!;
		await vi.waitFor(() => expect(first.tab(1).chat.busy).toBe(false));
		if (how === "new") {
			await first.tab(1).newChat();
			await first.tab(1).send({ requestId: "S", content: "next" });
			await vi.waitFor(() => expect(first.tab(1).chat.entries.at(-1)?.text).toBe("c"));
		} else {
			await first.tab(1).openChat(other);
		}
		const holds = first.tab(1).id;
		expect(holds).not.toBe(created);

		expect(await first.chats.send(1, 0, null, { requestId: "R", content: "hello" }, null)).toBe(submission);
		expect(first.tab(1).id).toBe(holds);
		first.chats.dispose();
		await first.harness.close(context);

		// After a worker restart too.
		const second = await start();
		expect(await second.chats.send(1, 0, null, { requestId: "R", content: "hello" }, null)).toBe(submission);
		expect(second.tab(1).id).toBe(holds);
		expect(faux.state.callCount).toBe(how === "new" ? 3 : 2);
	},
);

it("New chat and History raise rev: a late unadmitted command from before is rejected and sends nothing", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("answer")]);
	const { harness, chats, tab } = await start();
	await tab(1).send({ requestId: "r1", content: "hello" });
	const old = tab(1).id!;
	await vi.waitFor(() => expect(tab(1).chat.busy).toBe(false));
	await tab(1).newChat();

	await expect(chats.send(1, 0, old, { requestId: "r2", content: "late" }, null)).rejects.toBeInstanceOf(TabChanged);
	await expect(chats.send(1, 0, old, { requestId: "r2", content: "late" }, null)).rejects.toThrow(
		"This tab's chat changed; nothing was sent",
	);
	await expect(chats.abort(1, 0)).rejects.toThrow("This tab's chat changed; nothing was stopped");
	await expect(chats.retry(1, 0, old, 1, "r3")).rejects.toBeInstanceOf(TabChanged);
	await expect(chats.setModel(1, 0, { provider: "openrouter", modelId: "two" })).rejects.toThrow(
		"the model did not change",
	);
	await expect(chats.newChat(1, 0)).rejects.toBeInstanceOf(TabChanged);
	await expect(chats.openChat(1, 0, old)).rejects.toBeInstanceOf(TabChanged);

	await tab(1).openChat(old);
	expect(tab(1).rev).toBe(2);
	await expect(chats.send(1, 1, null, { requestId: "r4", content: "late" }, null)).rejects.toBeInstanceOf(TabChanged);
	expect((await harness.snapshot(ChatsDoc, context))?.chats).toHaveLength(1);
	expect(faux.state.callCount).toBe(1);
});

it("a command for a closed tab is rejected after the admission lookup, also while its entry is left", async () => {
	const { faux, browser, start } = setup();
	faux.setResponses([fauxAssistantMessage("answer")]);
	const { chats, tabs, tab } = await start();
	const submission = await tab(3).send({ requestId: "r1", content: "hello" });
	const chat = tab(3).id;
	// Chrome closed tab 3, and its drop ran.
	browser.open.delete(3);
	await tabs.update((entries) => entries.delete(3));

	expect(await chats.send(3, 0, chat, { requestId: "r1", content: "hello" }, null)).toBe(submission);
	await expect(chats.send(3, 0, chat, { requestId: "r2", content: "hello" }, null)).rejects.toThrow(
		"The tab was closed; nothing was sent",
	);
	await expect(chats.newChat(3, 0)).rejects.toThrow("The tab was closed");
	expect(tabs.get(3)).toBeUndefined();
	// A tab without an entry that is open is fresh.
	await chats.send(1, 0, null, { requestId: "r3", content: "hello" }, null);
	expect(tab(1).id).not.toBeNull();

	// Tab 1 closed too, but saving its drop failed: the entry is still there, and the ID admits nothing new.
	browser.open.delete(1);
	expect(tabs.get(1)).toBeDefined();
	await expect(chats.send(1, 0, tab(1).id, { requestId: "r4", content: "late" }, null)).rejects.toThrow(
		"The tab was closed; nothing was sent",
	);
	await expect(chats.abort(1, 0)).rejects.toThrow("The tab was closed");
});

it("New chat and History while the chat answers: the answer finishes and is saved in the old chat", async () => {
	const { faux, start } = setup();
	const gate = Promise.withResolvers<void>();
	faux.setResponses([held(gate.promise, "late answer"), fauxAssistantMessage("other answer")]);
	const { chats, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "first" });
	const first = one.id!;
	await vi.waitFor(() => expect(one.chat.busy).toBe(true));

	await one.newChat();
	expect(one.id).toBeNull();
	await one.send({ requestId: "r2", content: "second" });
	const second = one.id!;
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("other answer"));
	// Back to the first chat while it still answers.
	await one.openChat(first);
	expect(one.chat.busy).toBe(true);
	gate.resolve();
	await vi.waitFor(() => expect(one.chat.entries.map((entry) => entry.text)).toEqual(["first", "late answer"]));
	await chats.attach(second);
	expect(chats.view(second)?.entries.map((entry) => entry.text)).toEqual(["second", "other answer"]);
});

it("chats in two tabs answer at the same time", async () => {
	const { faux, start } = setup();
	const gate = Promise.withResolvers<void>();
	faux.setResponses([held(gate.promise, "one"), held(gate.promise, "two")]);
	const { tab } = await start();
	await tab(1).send({ requestId: "r1", content: "first" });
	await tab(2).send({ requestId: "r2", content: "second" });
	await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
	gate.resolve();
	await vi.waitFor(() => expect(tab(1).chat.entries.at(-1)?.text).toBe("one"));
	await vi.waitFor(() => expect(tab(2).chat.entries.at(-1)?.text).toBe("two"));
});

it("a view still attaching when the last page showing its chat leaves is dropped once ready", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("answer")]);
	const { harness, chats, tab } = await start();
	await tab(1).send({ requestId: "r1", content: "hello" });
	const id = tab(1).id!;
	await vi.waitFor(() => expect(tab(1).chat.busy).toBe(false));
	chats.retain(new Set());
	expect(chats.view(id)).toBeUndefined();

	const gate = Promise.withResolvers<void>();
	const conversation = harness.conversation.bind(harness);
	vi.spyOn(harness, "conversation").mockImplementationOnce(async (...args) => {
		await gate.promise;
		return conversation(...args);
	});
	// A page shows the chat and leaves before its view is ready.
	chats.retain(new Set([id]));
	chats.retain(new Set());
	gate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(chats.view(id)).toBeUndefined();

	// The next page that shows it attaches it again.
	chats.retain(new Set([id]));
	await vi.waitFor(() => expect(chats.view(id)?.entries.map((entry) => entry.text)).toEqual(["hello", "answer"]));
});

it("History lists chats by their first input, running chats first, also beyond the newest 50", async () => {
	const { faux, start } = setup();
	faux.setResponses([hang, ...Array.from({ length: 51 }, (_, index) => fauxAssistantMessage(`answer ${index}`))]);
	const { tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r0", content: "Running chat\nmore" });
	const running = one.id!;
	await vi.waitFor(() => expect(one.chat.busy).toBe(true));
	for (let index = 1; index <= 50; index += 1) {
		await one.newChat();
		await one.send({ requestId: `r${index}`, content: `Chat ${index}` });
	}
	const current = one.id!;
	await vi.waitFor(async () => expect((await one.list()).filter((chat) => chat.running)).toHaveLength(1));

	const listed = await one.list();
	expect(listed).toHaveLength(51);
	expect(listed[0]).toEqual({
		id: running,
		createdAt: expect.any(Number),
		title: "Running chat more",
		page: null,
		active: false,
		running: true,
		edited: false,
	});
	expect(listed[1]).toMatchObject({ id: current, title: "Chat 50", active: true, running: false });
	expect(listed.at(-1)).toMatchObject({ title: "Chat 1" });

	// Stopped, it is the oldest of 51 and drops out of the newest 50.
	await tab(2).openChat(running);
	await tab(2).abort();
	await vi.waitFor(async () => expect((await one.list()).some((chat) => chat.running)).toBe(false));
	expect((await one.list()).map((chat) => chat.id)).not.toContain(running);
	await expect(one.openChat(999)).rejects.toThrow("That chat no longer exists");
});

it("a chat without an input is listed only in the tab that shows it", async () => {
	const { faux, failAdmit, start } = setup();
	faux.setResponses([fauxAssistantMessage("answer")]);
	const { tab } = await start();
	await tab(1).send({ requestId: "r1", content: "Kept" });
	const kept = tab(1).id!;
	// Tab 2's first send created its chat, and its admission failed.
	failAdmit();
	await expect(tab(2).send({ requestId: "r2", content: "lost" })).rejects.toThrow("the worker stopped");
	const empty = tab(2).id!;

	const summary = (id: number, title: string, active: boolean) => ({
		id,
		createdAt: expect.any(Number),
		title,
		page: null,
		active,
		running: false,
		edited: false,
	});
	await vi.waitFor(async () => expect((await tab(1).list()).some((chat) => chat.running)).toBe(false));
	expect(await tab(1).list()).toEqual([summary(kept, "Kept", true)]);
	expect(await tab(2).list()).toEqual([summary(empty, "New chat", true), summary(kept, "Kept", false)]);
});

it.each([
	["the same tab", 1],
	["another tab on the chat", 2],
])("Stop from %s also stops a send that was admitted after it was made", async (_, stopper) => {
	const gate = Promise.withResolvers<void>();
	let hold = false;
	const { faux, start } = setup({ check: async () => (hold ? gate.promise : undefined) });
	faux.setResponses([hang, fauxAssistantMessage("must not run")]);
	const { harness, tab } = await start();
	await tab(1).send({ requestId: "r1", content: "first" });
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	if (stopper === 2) await tab(2).openChat(tab(1).id!);

	hold = true;
	const second = tab(1).send({ requestId: "r2", content: "second" });
	const stopped = tab(stopper).abort();
	// Stop must not finish before the earlier send, which is still in its key check.
	setTimeout(() => gate.resolve(), 50);
	const submission = await second;
	await stopped;
	expect((await (await harness.submission(submission, context))!.wait(context)).status).toBe("unanswered");
	await vi.waitFor(() => expect(tab(1).chat.busy).toBe(false));
	expect(faux.state.callCount).toBe(1);
});

it("a steer joins the run at its next tool round; a follow-up waits for the answer (design 6.39)", async () => {
	const { faux, start } = setup();
	const gate = Promise.withResolvers<void>();
	const asked: string[][] = [];
	const record = (context: { messages: readonly { role: string; content: unknown }[] }) =>
		asked.push(
			context.messages
				.filter((message) => message.role === "user")
				.map((message) =>
					typeof message.content === "string"
						? message.content
						: (message.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join(""),
				),
		);
	faux.setResponses([
		async (context) => {
			record(context);
			await gate.promise;
			return fauxAssistantMessage([{ type: "toolCall", id: "c", name: "missing_tool", arguments: {} }], {
				stopReason: "toolUse",
			});
		},
		(context) => {
			record(context);
			return fauxAssistantMessage("done");
		},
		(context) => {
			record(context);
			return fauxAssistantMessage("later answered");
		},
	]);
	const { tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "task" });
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	await one.send({ requestId: "r2", content: "later" });
	await one.send({ requestId: "r3", content: "fix a", whenBusy: "steer" });
	await one.send({ requestId: "r4", content: "fix b", whenBusy: "steer" });
	await vi.waitFor(() =>
		expect(one.chat.queued.map(({ text, mode }) => [text, mode])).toEqual([
			["later", "followUp"],
			["fix a", "steer"],
			["fix b", "steer"],
		]),
	);
	gate.resolve();
	await vi.waitFor(() => expect(faux.state.callCount).toBe(3));
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	// Both steers reach the model together after the tool round; the follow-up starts the next run.
	expect(asked).toEqual([["task"], ["task", "fix a", "fix b"], ["task", "fix a", "fix b", "later"]]);
	expect(one.chat.queued).toEqual([]);
});

it("Stop returns the text of the inputs it withdrew from the queue, not of the run it stopped", async () => {
	const { faux, start } = setup();
	faux.setResponses([hang, fauxAssistantMessage("must not run")]);
	const { tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "first" });
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	await one.send({ requestId: "r2", content: "second" });
	await one.send(typedInput("r3", "third", attached([IMAGE, NOTES])));
	await vi.waitFor(() => expect(one.chat.queued.map((input) => input.text)).toEqual(["second", "third"]));

	// Drafts keep the text, and how many attachments were not kept (design 6.42).
	expect(await one.abort()).toEqual([
		{ text: "second", lost: 0 },
		{ text: "third", lost: 2 },
	]);
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	expect(one.chat.queued).toEqual([]);
	// The stopped run's input is in the transcript, with Retry.
	expect(one.chat.entries.filter((entry) => entry.role === "user").map((entry) => entry.text)).toEqual(["first"]);
	expect(faux.state.callCount).toBe(1);
	// Nothing queued, nothing returned; a fresh tab has no chat to stop.
	expect(await one.abort()).toEqual([]);
	expect(await tab(2).abort()).toEqual([]);
});

it("a model choice in a fresh tab is the model of its first send, also while the choice is saved", async () => {
	const gate = Promise.withResolvers<void>();
	const { faux, start } = setup({ saving: () => gate.promise });
	faux.setResponses([fauxAssistantMessage("from two")]);
	const { tab } = await start();
	const chosen = tab(1).setModel({ provider: "openrouter", modelId: "two" });
	const sent = tab(1).send({ requestId: "r1", content: "hello" });
	setTimeout(() => gate.resolve(), 20);
	await chosen;
	await sent;
	expect(tab(1).chat.model?.modelId).toBe("two");
	expect(tab(1).rev).toBe(0);
});

it("the model of a busy chat cannot change; an idle chat's can", async () => {
	const { faux, start } = setup();
	faux.setResponses([hang, fauxAssistantMessage("from two")]);
	const { harness, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "hello" });
	const id = one.id!;
	await vi.waitFor(() => expect(one.chat.busy).toBe(true));
	await expect(one.setModel({ provider: "openrouter", modelId: "two" })).rejects.toThrow(/busy/);

	await one.abort();
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	await one.setModel({ provider: "openrouter", modelId: "two" });
	expect(one.chat.model?.modelId).toBe("two");
	const conversation = await harness.conversation(id as ConversationId, context);
	expect((await conversation!.agent(context)).model?.modelId).toBe("two");
});

it("stopProvider stops the chats with work on a provider whose credential went, queued inputs too, and no other", async () => {
	const { faux, start } = setup();
	faux.setResponses([hang]);
	const { chats, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "hello" });
	await vi.waitFor(() => expect(one.chat.busy).toBe(true));
	await one.send({ requestId: "r2", content: "then this" });
	await vi.waitFor(() => expect(one.chat.queued).toHaveLength(1));

	await chats.stopProvider("openai");
	expect(one.chat.busy).toBe(true);
	await chats.stopProvider("openrouter");
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	expect(one.chat.queued).toEqual([]);
	expect(one.chat.entries.map((entry) => entry.text)).not.toContain("then this");
});

it("stopProvider stops a send admitted just before it, and the input queued behind it", async () => {
	const { faux, start } = setup();
	faux.setResponses([hang]);
	const { chats, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "hello" });
	await one.send({ requestId: "r2", content: "then this" });
	await chats.stopProvider("openrouter");
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	expect(one.chat.queued).toEqual([]);
	expect(one.chat.entries.map((entry) => entry.text)).not.toContain("then this");
	expect(faux.state.callCount).toBeLessThanOrEqual(1);
});

it.each(["Stop", "credential removal"])("%s cannot commit its abort until recovery is armed", async (how) => {
	const { faux, failAdmit, start } = setup();
	faux.setResponses([hang]);
	const { chats, tab } = await start();
	await tab(1).send({ requestId: "abort-arm", content: "hello" });
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	const stop = () => (how === "Stop" ? tab(1).abort() : chats.stopProvider("openrouter"));
	failAdmit();
	await expect(stop()).rejects.toThrow("the worker stopped");
	expect(tab(1).chat.busy).toBe(true);
	await stop();
	await vi.waitFor(() => expect(tab(1).chat.busy).toBe(false));
});

it("History follows SDK blocked reasons after registry removal and reinstallation", async () => {
	const { failAdmit, start } = setup({ paused: true });
	const { harness, registry, tab } = await start();
	// Create an indexed chat without admitting a generation; this Harness stays paused throughout the test.
	failAdmit();
	await expect(tab(1).send({ requestId: "history-blocked", content: "hello" })).rejects.toThrow("the worker stopped");
	const task = defineTask<null, { phase: "wait" }, null>({
		name: "test.history",
		version: 1,
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async () => {
				throw Error("must stay paused");
			},
		},
	});
	const extension = { name: "history", tasks: [task] };
	registry.install(extension);
	const conversation = (await harness.conversation(tab(1).id as ConversationId, context))!;
	await conversation.commit(
		(tx) => tx.createTask(task, null, { ownership: { kind: "conversation" }, background: true }),
		context,
	);
	await vi.waitFor(async () => expect((await tab(1).list())[0]?.running).toBe(true));
	registry.uninstall(extension);
	await vi.waitFor(async () => expect((await tab(1).list())[0]?.running).toBe(false));
	registry.install(extension);
	await vi.waitFor(async () => expect((await tab(1).list())[0]?.running).toBe(true));
});

it("the thinking level reaches the next send of an idle chat; a running answer and its queue keep theirs", async () => {
	const { faux, start, settings } = setup();
	const levels: (string | undefined)[] = [];
	const answer = (text: string) => (_transcript: unknown, options?: { reasoning?: string }) => {
		levels.push(options?.reasoning);
		return fauxAssistantMessage(text);
	};
	const release = Promise.withResolvers<void>();
	faux.setResponses([
		answer("one"),
		async (_transcript, options) => {
			levels.push(options?.reasoning);
			await release.promise;
			return fauxAssistantMessage("two");
		},
		answer("three"),
		answer("four"),
		answer("five"),
	]);
	const { harness, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "first" });
	const id = one.id!;
	await vi.waitFor(() => expect(one.chat.entries).toHaveLength(2));

	settings.thinking = "high";
	await one.send({ requestId: "r2", content: "second" });
	await vi.waitFor(() => expect(levels).toHaveLength(2));
	// Changed while the chat answers: the input queued behind the answer keeps its level.
	settings.thinking = "low";
	await one.send({ requestId: "r3", content: "third" });
	release.resolve();
	await vi.waitFor(() => expect(one.chat.entries).toHaveLength(6));
	await one.send({ requestId: "r4", content: "fourth" });
	await vi.waitFor(() => expect(one.chat.entries).toHaveLength(8));
	// pi-durable sends no reasoning option for "off".
	expect(levels).toEqual([undefined, "high", "high", "low"]);
	const conversation = await harness.conversation(id as ConversationId, context);
	expect((await conversation!.agent(context)).thinkingLevel).toBe("low");

	// A new chat starts with the current level.
	settings.thinking = "medium";
	await one.newChat();
	await one.send({ requestId: "r5", content: "fifth" });
	const created = await harness.conversation(one.id as ConversationId, context);
	expect((await created!.agent(context)).thinkingLevel).toBe("medium");
	// The level is asked for the chat's model, so it can be fitted to the model's levels (design 6.35).
	expect(new Set(settings.thinkingModels.map((asked) => `${asked.provider}/${asked.modelId}`))).toEqual(
		new Set(["openrouter/one"]),
	);
});

it("a send the check rejects commits nothing", async () => {
	const { start } = setup({
		check: async () => {
			throw new Error("No OpenRouter key: add one to send");
		},
	});
	const { harness, tabs, tab } = await start();
	await expect(tab(1).send({ requestId: "r1", content: "hello" })).rejects.toThrow(/No OpenRouter key/);
	expect(tabs.get(1)).toBeUndefined();
	expect(await harness.snapshot(ChatsDoc, context)).toBeUndefined();
});

it("History shows the first page a chat's inputs were about, and no page for a chat without one", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
	const { tab } = await start();
	const page = (url: string, title: string) => ({ tabId: 1, frameId: 0, documentId: null, url, title, capturedAt: 0 });
	const selection = (text: string, url: string, title: string): SelectionEntryData => ({
		text,
		preset: "Explain",
		page: page(url, title),
		edited: false,
	});
	// A typed message without a page first: the chat has the page of its next input.
	await tab(1).send({ requestId: "r1", content: "Hi" });
	await vi.waitFor(() => expect(tab(1).chat.busy).toBe(false));
	const data = selection("Hallo", "https://example.com/a", "A");
	await tab(1).send({ requestId: "r2", content: "Explain Hallo", entry: { kind: SELECTION_KIND, data } });
	await vi.waitFor(() => expect(tab(1).chat.busy).toBe(false));
	await tab(2).send({ requestId: "r3", content: "No page" });
	await vi.waitFor(() => expect(tab(2).chat.busy).toBe(false));

	const listed = await tab(1).list();
	expect(listed.map((chat) => [chat.title, chat.page])).toEqual([
		["No page", null],
		["Hi", { url: "https://example.com/a", title: "A" }],
	]);
});

it("an interrupted answer offers Retry, which sends the selection input again", async () => {
	const { faux, start } = setup();
	faux.setResponses([hang, fauxAssistantMessage("translated")]);
	const { tab } = await start();
	const one = tab(1);
	const data: SelectionEntryData = {
		text: "Hallo",
		preset: "Translate to English",
		page: { tabId: 1, frameId: 0, documentId: null, url: "https://example.com/", title: "Example", capturedAt: 0 },
		edited: false,
	};
	await one.send({ requestId: "r1", content: "Translate Hallo", entry: { kind: SELECTION_KIND, data } });
	// Aborted before its request, the run would leave `hang` to the retry.
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	await one.abort();
	await vi.waitFor(() => expect(one.chat.retry).not.toBeNull());
	const input = one.chat.entries[0]!;
	const quote = { preset: "Translate to English", text: "Hallo" };
	expect(input).toMatchObject({ role: "user", text: "Translate Hallo", quote });
	expect(one.chat.retry).toBe(input.id);

	const retried = await one.retry(input.id, "r2");
	// A lost reply: the resend returns the same submission.
	expect(await one.retry(input.id, "r2")).toBe(retried);
	// Another panel's Retry button, shown before this retry.
	await expect(one.retry(input.id, "r3")).rejects.toThrow(/busy/);
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("translated"));
	expect(one.chat.retry).toBeNull();
	await expect(one.retry(input.id, "r4")).rejects.toThrow(/answered/);
	expect(faux.state.callCount).toBe(2);
	const inputs = one.chat.entries.filter((entry) => entry.role === "user");
	// Retry sends the entry's data again, so the retried input still shows as the preset and the quote.
	expect(inputs.map((entry) => entry.quote)).toEqual([quote, quote]);
});

it("Edit forks the chat before the input; the tab shows the fork, the original stays, and a resend finds it (design 6.34)", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), fauxAssistantMessage("a3")]);
	const { harness, chats, tabs, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "first" }, PAGE);
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a1"));
	await one.send({ requestId: "r2", content: "second" });
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a2"));
	const original = one.id!;
	const second = one.chat.entries[2]!;
	expect(second).toMatchObject({ role: "user", text: "second", sent: "second" });

	const id = await one.edit(second.id, "second, edited", "e1");
	const fork = one.id!;
	expect(fork).not.toBe(original);
	expect(tabs.get(1)).toMatchObject({ chat: fork, rev: 1 });
	await vi.waitFor(() =>
		expect(one.chat.entries.map((entry) => entry.text)).toEqual(["first", "a1", "second, edited", "a3"]),
	);
	expect(one.chat.editedFrom).toBe(original);
	// The model got the chat up to the edited input, and not the answer it replaced.
	const sent = await (await harness.conversation(fork as ConversationId, context))!.context(context);
	expect(sent.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
	expect(JSON.stringify(sent.messages)).not.toContain("a2");
	expect((await harness.snapshot(ChatsDoc, context))?.chats.at(-1)).toEqual({
		id: fork,
		createdAt: expect.any(Number),
		request: "e1",
		key: PAGE,
		from: original,
	});

	// A lost reply: the resend, with the rev the panel saw, returns the same submission and makes no other chat.
	expect(await chats.edit(1, 0, original, second.id, "second, edited", [], "e1")).toBe(id);
	expect((await harness.snapshot(ChatsDoc, context))?.chats).toHaveLength(2);
	expect(faux.state.callCount).toBe(3);

	// The original is unchanged; History marks the fork.
	const two = tab(2);
	await two.openChat(original);
	await vi.waitFor(() => expect(two.chat.entries.map((entry) => entry.text)).toEqual(["first", "a1", "second", "a2"]));
	expect(two.chat.editedFrom).toBeNull();
	const listed = await one.list();
	expect(listed.map(({ id, title, edited }) => ({ id, title, edited }))).toEqual([
		{ id: fork, title: "first", edited: true },
		{ id: original, title: "first", edited: false },
	]);
	// Rule 2: the page continues the newer chat.
	await tabs.set(3, (entry) => entry);
	await chats.lookup(3, PAGE);
	expect(tabs.get(3)?.chat).toBe(fork);
});

it("Edit of a first input starts an empty chat of the same kind; it is refused while busy, stale, or empty", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), hang]);
	const { harness, chats, tab } = await start();
	const one = tab(1);
	const page = { tabId: 1, frameId: 0, documentId: "d", url: PAGE, title: "Article", capturedAt: 0 };
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	await one.send({
		requestId: "r1",
		content: [{ type: "text", text: 'Sum up\n\n[Attached page: "Article" (https://example.com/article)]' }, image],
		entry: { kind: MESSAGE_KIND, data: { text: "Sum up", page } },
	});
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a1"));
	const original = one.id!;
	const input = one.chat.entries[0]!;
	expect(input).toMatchObject({ text: "Sum up", sent: "Sum up" });

	await expect(one.edit(input.id, "  ", "e0")).rejects.toThrow("Write a message to send");
	await one.edit(input.id, "Sum up briefly", "e1");
	const fresh = one.id!;
	await vi.waitFor(() => expect(one.chat.entries.map((entry) => entry.text)).toEqual(["Sum up briefly", "a2"]));
	expect(one.chat.entries[0]).toMatchObject({ source: { title: "Article", url: PAGE } });
	expect(one.chat.editedFrom).toBe(original);
	const records = await harness.commit(
		(tx) => tx.scanEntries({ conversationId: fresh as ConversationId, order: "ascending" }, 10),
		context,
	);
	expect(records.items[0]).toMatchObject({
		kind: MESSAGE_KIND,
		data: { text: "Sum up briefly", page },
		model: [{ role: "user", content: 'Sum up briefly\n\n[Attached page: "Article" (https://example.com/article)]' }],
	});

	// A panel's older rev, from before the edit.
	await expect(chats.edit(1, 0, original, input.id, "again", [], "e2")).rejects.toBeInstanceOf(TabChanged);
	// An input of another chat.
	await expect(one.edit(input.id, "again", "e3")).rejects.toThrow("That message is no longer in the chat");
	await one.send({ requestId: "r2", content: "more" });
	await vi.waitFor(() => expect(one.chat.busy).toBe(true));
	await expect(one.edit(one.chat.entries[0]!.id, "again", "e4")).rejects.toThrow("Stop the answer first");
	await one.abort();
	expect((await harness.snapshot(ChatsDoc, context))?.chats).toHaveLength(2);
});

it("a fork's screenshots and images from its original are found (design 6.34)", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), fauxAssistantMessage("a3")]);
	const { tab } = await start();
	const one = tab(1);
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	await one.send({ requestId: "r1", content: [{ type: "text", text: "look" }, image] });
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a1"));
	await one.send({ requestId: "r2", content: "second" });
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a2"));
	const first = one.chat.entries[0]!.id;
	await one.edit(one.chat.entries[2]!.id, "other", "e1");
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a3"));
	expect(await one.image(first)).toEqual({ mimeType: "image/png", data: "AAAA" });
});

it("a tab keeps its chat across a worker restart", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("kept")]);
	const first = await start();
	await first.tab(1).send({ requestId: "r1", content: "hello" });
	const id = first.tab(1).id!;
	await vi.waitFor(() => expect(first.tab(1).chat.busy).toBe(false));
	first.chats.dispose();
	await first.harness.close(context);

	const second = await start();
	expect(second.tab(1).id).toBe(id);
	await second.chats.attach(id);
	expect(second.tab(1).chat.entries.map((entry) => entry.text)).toEqual(["hello", "kept"]);
});

it("a version-1 index keeps its chats without keys, and drops its active chat", async () => {
	const { faux, path, start } = setup();
	faux.setResponses([fauxAssistantMessage("old answer")]);
	const ChatsDocV1 = defineDoc<{
		active: number | null;
		chats: { id: number; createdAt: number; request: string | null }[];
	}>({
		kind: "piaside.chats",
		version: 1,
		scope: "session",
		initial: () => ({ active: null, chats: [] }),
		checkpointWhen: () => false,
	});
	const models = createModels();
	models.setProvider(fauxProvider({ provider: "openrouter", models: [{ id: "one" }] }).provider);
	const before = await Harness.open(
		await openNodeSqliteStorage(path),
		{ models, registry: createRegistry() },
		context,
	);
	const conversation = await before.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: { provider: "openrouter", modelId: "one" } },
			init: async (tx, id) => {
				const index = await tx.doc(ChatsDocV1);
				index.chats.push({ id: Number(id), createdAt: 5, request: "r1" });
				index.active = Number(id);
			},
		},
		context,
	);
	await conversation.submit({ type: "input", content: "Old chat", requestId: "r1" }, context);
	await before.close(context);

	const { harness, chats, tabs, tab } = await start();
	const id = Number(conversation.id);
	expect(await harness.snapshot(ChatsDoc, context)).toEqual({
		chats: [{ id, createdAt: 5, request: "r1", key: null }],
	});
	expect((await tab(1).list()).map((chat) => chat.title)).toEqual(["Old chat"]);
	await tabs.set(1, (entry) => entry);
	await chats.lookup(1, PAGE);
	expect(tab(1).id).toBeNull();
});

it("keeps an answer's usage line when a second compaction keeps an entry from before the first marker", async () => {
	// Default retention; the long answer, just under it, makes the first compaction keep the answer before it and the
	// second keep the long answer.
	const { faux, model, start } = setup({ compaction: { keepRecentTokens: 20_000 } });
	faux.setResponses([fauxAssistantMessage("First summary."), fauxAssistantMessage("Second summary.")]);
	const { harness, chats } = await start();
	const spent = (input: number, output: number, total: number) => ({
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	});
	const user = (text: string): EntryDraft => ({
		kind: "pi.user",
		model: [{ role: "user", content: text, timestamp: 0 }],
	});
	const answer = (text: string, usage: ReturnType<typeof spent>): EntryDraft => ({
		kind: "pi.assistant",
		model: [{ ...fauxAssistantMessage(text), usage, stopReason: "stop", content: [{ type: "text", text }] }],
	});
	const conversation = await harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model } },
		context,
	);
	const { first, long } = await harness.commit(async (tx) => {
		await tx.appendEntry(conversation.id, user("Question"));
		const call: EntryDraft = {
			kind: "pi.assistant",
			model: [
				{
					...fauxAssistantMessage(""),
					usage: spent(1000, 10, 0.002),
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "c", name: "read_page", arguments: {} }],
				},
			],
		};
		await tx.appendEntry(conversation.id, call);
		await tx.appendEntry(conversation.id, {
			kind: "pi.toolResult",
			model: [
				{
					role: "toolResult",
					toolCallId: "c",
					toolName: "read_page",
					content: [{ type: "text", text: "page" }],
					isError: false,
					timestamp: 0,
				},
			],
		});
		const first = await tx.appendEntry(conversation.id, answer("Final", spent(200, 10, 0.001)));
		await tx.appendEntry(conversation.id, user("Q"));
		const long = await tx.appendEntry(conversation.id, answer("y".repeat(69_993), spent(300, 19_998, 0.003)));
		return { first: Number(first.id), long: long.id };
	}, context);
	const id = Number(conversation.id);
	await chats.attach(id);
	const line = () => chats.view(id)?.entries.find((entry) => entry.id === first)?.usage?.input;
	expect(line()).toBe(1200);
	const markers = async () =>
		harness.commit(async (tx) => {
			const page = await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 200);
			return page.items.filter((record: EntryRecord) => record.kind === "pi.compaction");
		}, context);

	// The first compaction keeps the answer, not the tool call before it.
	await conversation.compact(undefined, context);
	await vi.waitFor(() => expect(line()).toBe(200));
	const [marker] = await markers();
	expect(Number(marker!.head)).toBe(first);
	// The second keeps the long answer, which comes before the first marker.
	await harness.commit((tx) => tx.appendEntry(conversation.id, user("Next")), context);
	await conversation.compact(undefined, context);
	await vi.waitFor(async () => expect((await markers())[1]?.head).toBe(long));
	const [, second] = await markers();
	expect(Number(long)).toBeLessThan(Number(marker!.id));
	await vi.waitFor(() => expect(chats.view(id)?.entries.some((entry) => entry.id === Number(second!.id))).toBe(true));
	await vi.waitFor(() => expect(chats.view(id)?.entries.some((entry) => entry.text === "Question")).toBe(true));
	expect(line()).toBe(200);

	await harness.close(context);
	const reopened = await start();
	await reopened.chats.attach(id);
	await vi.waitFor(() =>
		expect(reopened.chats.view(id)?.entries.find((entry) => entry.id === first)?.usage?.input).toBe(200),
	);
});

it("after a compaction the chat still shows what it summarized, also after a restart", async () => {
	const { faux, start } = setup({ compaction: { keepRecentTokens: 1 } });
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), fauxAssistantMessage("Summary.")]);
	const { harness, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "q1" });
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	await one.send({ requestId: "r2", content: "q2" });
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	const conversation = await harness.conversation(one.id as ConversationId, context);
	await conversation!.compact(undefined, context);

	const notice = "Earlier messages were summarized.";
	const shown = () => one.chat.entries.map((entry) => entry.text);
	await vi.waitFor(() => expect(shown()).toContain(notice));
	await vi.waitFor(() => expect(shown().filter((text) => text !== notice)).toEqual(["q1", "a1", "q2", "a2"]));

	await harness.close(context);
	const reopened = await start();
	await reopened.chats.attach(reopened.tab(1).id!);
	await vi.waitFor(() => expect(reopened.tab(1).chat.entries.map((entry) => entry.text)).toContain("q1"));
	expect(
		reopened
			.tab(1)
			.chat.entries.map((entry) => entry.text)
			.filter((text) => text !== notice),
	).toEqual(["q1", "a1", "q2", "a2"]);
});

it("a request over the model's real window is summarized and sent again, not failed (design 6.21)", async () => {
	// The safety net under a plan's larger window (design 6.21): OpenAI's overflow error makes
	// pi-durable compact and prepare the request again.
	const { faux, start } = setup({ compaction: { keepRecentTokens: 1 } });
	faux.setResponses([
		fauxAssistantMessage("first answer"),
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Your input exceeds the context window of this model. Please adjust your input and try again.",
		}),
		fauxAssistantMessage("Summary of the chat so far."),
		fauxAssistantMessage("recovered"),
	]);
	const { tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "first" }, PAGE);
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	await one.send({ requestId: "r2", content: "second" }, PAGE);
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("recovered"));
	const texts = one.chat.entries.map((entry) => entry.text);
	expect(texts).toContain("Earlier messages were summarized.");
	// The rejected attempt stays with OpenAI's error; the answer after the summary has none.
	expect(one.chat.entries.map((entry) => entry.error)).toContain(
		"Your input exceeds the context window of this model. Please adjust your input and try again.",
	);
	expect(one.chat.entries.at(-1)?.error).toBeNull();
});

it("History renames a chat, and an empty title brings back its first input's (design 6.30)", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("an answer")]);
	const { chats, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "What is this page about?" }, PAGE);
	const id = one.id!;
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	await chats.rename(id, "  Project   notes  ");
	expect((await one.list()).find((chat) => chat.id === id)?.title).toBe("Project notes");
	await chats.rename(id, "x".repeat(300));
	expect((await one.list()).find((chat) => chat.id === id)?.title).toHaveLength(120);
	await chats.rename(id, "");
	expect((await one.list()).find((chat) => chat.id === id)?.title).toBe("What is this page about?");
});

it("History removes a chat: not listed, opened, or continued by its page; its tab starts fresh; Undo restores it (design 6.30)", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), hang]);
	const { chats, tabs, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "On the page" }, PAGE);
	const removed = one.id!;
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	const rev = one.rev;

	await chats.remove(removed);
	expect((await one.list()).map((chat) => chat.id)).not.toContain(removed);
	// The tab that showed it starts fresh, with a new rev, so an older panel's command is refused.
	expect(tabs.get(1)).toMatchObject({ chat: null, rev: rev + 1 });
	await expect(tab(2).openChat(removed)).rejects.toThrow("That chat no longer exists");
	// Rule 2 does not continue it on its page.
	await tabs.update((entries) =>
		entries.set(3, { chat: undefined, rev: 0, resumed: null, url: PAGE, anchor: null, page: null }),
	);
	await chats.lookup(3, PAGE);
	expect(tabs.get(3)?.chat).toBeNull();

	// Undo: listed again, and no tab shows it until one opens it.
	await chats.restore(removed);
	expect((await one.list()).map((chat) => chat.id)).toContain(removed);
	expect(tabs.get(1)?.chat).toBeNull();

	// A chat that runs is not removed.
	await one.send({ requestId: "r2", content: "Second chat" });
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	await one.send({ requestId: "r3", content: "Keeps running" });
	await vi.waitFor(() => expect(one.chat.busy).toBe(true));
	await expect(chats.remove(one.id!)).rejects.toThrow("Stop the answer first");
	expect((await one.list()).map((chat) => chat.id)).toContain(one.id!);
});

it("a removal whose tab update fails removes nothing: the chat stays listed, not hidden yet still taking the tab's messages (design 6.30)", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	const { chats, tabs, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "Kept" });
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	const id = one.id!;

	vi.spyOn(tabs, "update").mockRejectedValueOnce(new Error("storage.session is full"));
	await expect(chats.remove(id)).rejects.toThrow("storage.session is full");
	expect((await one.list()).map((chat) => chat.id)).toContain(id);
	expect(tabs.get(1)?.chat).toBe(id);
	await one.send({ requestId: "r2", content: "Still here" });
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("second"));
	expect(one.id).toBe(id);
});

it("a History row reaches only the chat it listed: after Delete all, a new chat with its ID is refused (design 6.30)", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("first")]);
	const { chats, tabs, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "Listed" });
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	const row = (await one.list()).find((chat) => chat.id === one.id)!;
	// The same ID with another start, as an old row has after Delete all once a fresh database numbered a new chat so.
	const stale = row.createdAt - 1;
	const gone = "That chat no longer exists";
	await expect(chats.rename(row.id, "renamed", stale)).rejects.toThrow(gone);
	await expect(chats.markdown(row.id, 0, stale)).rejects.toThrow(gone);
	await expect(chats.remove(row.id, stale)).rejects.toThrow(gone);
	await expect(chats.openChat(2, tabs.get(2)?.rev ?? 0, row.id, stale)).rejects.toThrow(gone);
	// Also in the tab that shows that ID: the old row's chat is gone.
	await expect(chats.openChat(1, tabs.get(1)!.rev, row.id, stale)).rejects.toThrow(gone);
	await chats.openChat(1, tabs.get(1)!.rev, row.id, row.createdAt);
	expect((await one.list()).find((chat) => chat.id === row.id)).toMatchObject({ title: row.title });

	// The row's own start reaches it.
	await chats.remove(row.id, row.createdAt);
	await expect(chats.restore(row.id, stale)).rejects.toThrow(gone);
	await chats.restore(row.id, row.createdAt);
	expect((await one.list()).map((chat) => chat.id)).toContain(row.id);
});

it("History export keeps the blank lines inside a message, which can be code or a string's data (design 6.30)", async () => {
	const { faux, start } = setup();
	const code = "```js\nconst text = `one\n\n\ntwo`;\n```";
	faux.setResponses([fauxAssistantMessage(`Here:\n\n${code}\n\n`)]);
	const { chats, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "Keep\n\n\nthese" });
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	const { markdown } = await chats.markdown(one.id!, 0);
	// One blank line between the parts, and the message's own lines as they are.
	expect(markdown).toMatch(/UTC\n\n## You\n\nKeep\n\n\nthese\n\n## pi\n\nHere:\n\n/);
	expect(markdown.endsWith(`Here:\n\n${code}\n`)).toBe(true);
});

it("History exports a chat as Markdown: its title, questions, answers, steps, and pages (design 6.30)", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("The page explains **durable** agents."), fauxAssistantMessage("Two.")]);
	const { chats, tab } = await start();
	const one = tab(1);
	await one.send(
		{
			requestId: "r1",
			content: "What is it?",
			entry: {
				kind: MESSAGE_KIND,
				data: {
					text: "What is it?",
					page: { tabId: 1, frameId: 0, documentId: "d", url: PAGE, title: "An [article]", capturedAt: 0 },
				},
			},
		},
		PAGE,
	);
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	await one.send({ requestId: "r2", content: "How many?" });
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("Two."));
	await chats.rename(one.id!, "Durable agents");
	const { title, markdown } = await chats.markdown(one.id!, Date.UTC(2026, 9, 25, 12, 0));
	expect(title).toBe("Durable agents");
	expect(markdown).toContain("# Durable agents\n");
	expect(markdown).toContain("exported from pi 2026-10-25 12:00 UTC");
	expect(markdown).toContain("## You\n\nWhat is it?\n\nPage: [An article](<https://example.com/article>)");
	expect(markdown).toContain("## pi\n\nThe page explains **durable** agents.");
	expect(markdown).toContain("## You\n\nHow many?\n\n## pi\n\nTwo.\n");
	await chats.remove(one.id!);
	await expect(chats.markdown(one.id!, 0)).rejects.toThrow("That chat no longer exists");
});

it("a message about a page the tab left says where the tab is: to the model, and under the message (design 6.28)", () => {
	const page = { tabId: 1, frameId: 0, documentId: "d", url: PAGE, title: "Article", capturedAt: 0 };
	const attached = `[Attached page: "Article" (${PAGE})`;
	expect(pageInput("r", "Sum up", page, undefined).content).toBe(`Sum up\n\n${attached}]`);
	const shows = pageInput("r", "Sum up", page, undefined, { url: "https://example.com/next", title: 'Next "one"' });
	expect(shows.content).toBe(`Sum up\n\n${attached}; the tab now shows "Next \\"one\\"" (https://example.com/next)]`);
	expect(shows.entry?.data).toEqual({
		text: "Sum up",
		page,
		moved: { url: "https://example.com/next", title: 'Next "one"' },
	});
	expect(pageInput("r", "Sum up", page, undefined, { site: "https://b.test" }).content).toBe(
		`Sum up\n\n${attached}; the tab has since moved to a page pi cannot read; it was last seen going to https://b.test]`,
	);
	expect(pageInput("r", "Sum up", page, "Summarize", { site: null }).content).toBe(
		`Sum up\n\n${attached}; the tab has since moved to a page pi cannot read]`,
	);
});

it("an edited message says where the tab is when it is sent again, not when it was first sent (design 6.28)", async () => {
	let moved: { site: string | null } | undefined = { site: "https://b.test" };
	const asked: unknown[] = [];
	const { faux, start } = setup({
		moved: async (page) => {
			asked.push(page.url);
			return moved;
		},
	});
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), fauxAssistantMessage("a3")]);
	const { harness, tab } = await start();
	const one = tab(1);
	const page = { tabId: 1, frameId: 0, documentId: "d", url: PAGE, title: "Article", capturedAt: 0 };
	await one.send({ ...pageInput("r1", "Sum up", page, undefined, { site: null }) });
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a1"));
	expect(one.chat.entries[0]).toMatchObject({ moved: { site: null } });

	await one.edit(one.chat.entries[0]!.id, "Sum up briefly", "e1");
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a2"));
	expect(asked).toEqual([PAGE]);
	expect(one.chat.entries[0]).toMatchObject({ text: "Sum up briefly", moved: { site: "https://b.test" } });
	const records = await harness.commit(
		(tx) => tx.scanEntries({ conversationId: one.id as ConversationId, order: "ascending" }, 10),
		context,
	);
	expect(records.items[0]?.model?.[0]).toMatchObject({
		content: `Sum up briefly\n\n[Attached page: "Article" (${PAGE}); the tab has since moved to a page pi cannot read; it was last seen going to https://b.test]`,
	});

	// Back on the page: no note.
	moved = undefined;
	await one.edit(one.chat.entries[0]!.id, "Sum up again", "e2");
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a3"));
	expect(one.chat.entries[0]).not.toHaveProperty("moved");
});

// Attachments (design 6.42).

const IMAGE: MessageAttachment = { kind: "image", width: 4, height: 3, image: { mimeType: "image/png", data: "AAAA" } };
const PHOTO: MessageAttachment = {
	kind: "image",
	width: 3,
	height: 4,
	image: { mimeType: "image/jpeg", data: "BBBB" },
};
const NOTES: MessageAttachment = { kind: "file", name: "notes.csv", text: "a,b\n1,2" };

it("a typed message with attachments is a web.input entry: one block each after the text, listed in the transcript (design 6.42)", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
	const { harness, chats, tab } = await start();
	const one = tab(1);
	const first = await one.send(typedInput("r1", "Compare", attached([NOTES, IMAGE, PHOTO])));
	// A lost reply: the resend, with the same attachments, finds the same submission.
	expect(await one.send(typedInput("r1", "Compare", attached([NOTES, IMAGE, PHOTO])))).toBe(first);
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a1"));
	const input = one.chat.entries[0]!;
	expect(input).toMatchObject({
		text: "Compare",
		sent: "Compare",
		attachments: [
			{ kind: "file", name: "notes.csv", chars: 7 },
			{ kind: "image", width: 4, height: 3, chars: 4 },
			{ kind: "image", width: 3, height: 4, chars: 4 },
		],
	});
	const sent = await (await harness.conversation(one.id as ConversationId, context))!.context(context);
	expect(sent.messages[0]).toMatchObject({
		role: "user",
		content: [
			{ type: "text", text: "Compare" },
			{ type: "text", text: '[Attached file: "notes.csv", 7 characters]\na,b\n1,2\n[End of file "notes.csv"]' },
			{ type: "image", mimeType: "image/png", data: "AAAA" },
			{ type: "image", mimeType: "image/jpeg", data: "BBBB" },
		],
	});
	expect(faux.state.callCount).toBe(1);
	// Each image by its place among the entry's images; a wrong place has none.
	expect(await chats.image(1, input.id, 1)).toEqual({ mimeType: "image/jpeg", data: "BBBB" });
	for (const index of [2, -1, 0.5]) expect(await chats.image(1, input.id, index)).toBeNull();

	// Text that looks like a file's block is only text: no entry data names it.
	const look = fileBlock("notes.csv", "a,b");
	await one.send({ requestId: "r2", content: look });
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a2"));
	expect(one.chat.entries[2]).toMatchObject({ text: look });
	expect(one.chat.entries[2]?.attachments).toBeUndefined();
	// The History title of an attachment-only first message is its first file's name.
	const only = tab(2);
	faux.setResponses([fauxAssistantMessage("a3")]);
	await only.send(typedInput("r3", "", attached([NOTES])));
	await vi.waitFor(() => expect(only.chat.entries.at(-1)?.text).toBe("a3"));
	expect(only.chat.entries[0]).toMatchObject({ text: "", attachments: [{ kind: "file", name: "notes.csv" }] });
	expect((await only.list()).find((chat) => chat.id === only.id)?.title).toBe("notes.csv");
});

it("data that names attachments its content does not match shows as the content's text, and Edit keeps none", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2"), fauxAssistantMessage("a3")]);
	const { tab } = await start();
	const one = tab(1);
	const image = { kind: "image", width: 4, height: 3, chars: 4 };
	await one.send({
		requestId: "r1",
		content: [
			{ type: "text", text: "Question" },
			{ type: "text", text: "This block is not the declared image" },
		],
		entry: { kind: INPUT_KIND, data: { text: "Question", attachments: [image] } },
	});
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a1"));
	const page = { tabId: 1, frameId: 0, documentId: "d", url: PAGE, title: "Article", capturedAt: 0 };
	await one.send({
		requestId: "r2",
		content: "Shown text",
		entry: { kind: MESSAGE_KIND, data: { text: "Other text", page, attachments: [image] } },
	});
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a2"));
	const [typed, , message] = one.chat.entries;
	expect(typed).toMatchObject({
		text: "Question\nThis block is not the declared image",
		sent: "Question\nThis block is not the declared image",
		source: null,
	});
	expect(typed?.attachments).toBeUndefined();
	expect(message).toMatchObject({ text: "Shown text", sent: "Shown text", source: null });
	expect(message?.attachments).toBeUndefined();
	// No attachment to keep: the data's list is not trusted.
	await expect(one.edit(typed!.id, "Question", "e1", [0])).rejects.toThrow("The attachments of this message changed");
});

it("Retry sends the attachments again; a page message's attachments follow its page note", async () => {
	const { faux, start } = setup();
	faux.setResponses([hang, fauxAssistantMessage("again")]);
	const { harness, tab } = await start();
	const one = tab(1);
	const page = { tabId: 1, frameId: 0, documentId: "d", url: PAGE, title: "Article", capturedAt: 0 };
	await one.send(pageInput("r1", "", page, undefined, undefined, attached([IMAGE])));
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	await one.abort();
	await vi.waitFor(() => expect(one.chat.retry).not.toBeNull());
	await one.retry(one.chat.entries[0]!.id, "r2");
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("again"));
	const inputs = one.chat.entries.filter((entry) => entry.role === "user");
	expect(inputs).toHaveLength(2);
	for (const input of inputs)
		expect(input).toMatchObject({
			text: "",
			source: { title: "Article", url: PAGE },
			attachments: [{ kind: "image", width: 4, height: 3 }],
		});
	const sent = await (await harness.conversation(one.id as ConversationId, context))!.context(context);
	expect(sent.messages.at(-2)).toMatchObject({
		role: "user",
		content: [
			{ type: "text", text: '[Attached page: "Article" (https://example.com/article)]' },
			{ type: "image", data: "AAAA" },
		],
	});
});

it("a new image needs a model that reads images; on a text-only model, the chat's older images do not stop a send", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
	const { tab } = await start();
	const one = tab(1);
	await one.send(typedInput("r1", "What is this?", attached([IMAGE])));
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a1"));
	await one.setModel({ provider: "openrouter", modelId: "text" });
	await expect(one.send(typedInput("r2", "And this?", attached([PHOTO])))).rejects.toThrow("can't read images");
	// pi-ai sends the older image as its placeholder (design 6.42); a file is text and goes.
	await one.send(typedInput("r3", "Thanks", attached([NOTES])));
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a2"));
	expect(faux.state.callCount).toBe(2);
});

it("a send's images count with the chat's and its queued inputs' against the limit (design 6.42)", async () => {
	const { faux, start } = setup({ imageLimit: async () => 2 });
	faux.setResponses([hang, fauxAssistantMessage("a2")]);
	const { tab } = await start();
	const one = tab(1);
	await one.send(typedInput("r1", "one", attached([IMAGE])));
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	await one.send({ ...typedInput("r2", "two", attached([PHOTO])), whenBusy: "followUp" });
	await vi.waitFor(() => expect(one.chat.queued).toHaveLength(1));
	// One in the chat, one queued: a third is over, and is not admitted.
	await expect(one.send({ ...typedInput("r3", "three", attached([IMAGE])), whenBusy: "followUp" })).rejects.toThrow(
		"This chat already sends 2 images with each request; this message would make 3, more than pi allows (2).",
	);
	expect(one.chat.queued).toHaveLength(1);
	// Text needs no room.
	await one.send({ requestId: "r4", content: "text goes", whenBusy: "followUp" });
	await vi.waitFor(() => expect(one.chat.queued).toHaveLength(2));
	await one.abort();
	await vi.waitFor(() => expect(one.chat.busy).toBe(false));
	// The queued ones were withdrawn: room for one more.
	await one.send(typedInput("r5", "again", attached([PHOTO])));
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a2"));
});

it("Edit counts the images of the chat it forks from, also those a later compaction summarized (design 6.42)", async () => {
	let limit = 2;
	const { faux, start } = setup({ imageLimit: async () => limit, compaction: { keepRecentTokens: 1 } });
	faux.setResponses([
		fauxAssistantMessage("a1"),
		fauxAssistantMessage("a2"),
		fauxAssistantMessage("a3"),
		fauxAssistantMessage("Summary."),
		fauxAssistantMessage("a4"),
	]);
	const { harness, tab } = await start();
	const one = tab(1);
	await one.send(typedInput("r1", "one", attached([IMAGE])));
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a1"));
	await one.send(typedInput("r2", "two", attached([PHOTO])));
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a2"));
	await one.send({ requestId: "r3", content: "three" });
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a3"));
	const conversation = (await harness.conversation(one.id as ConversationId, context))!;
	await conversation.compact(undefined, context);
	const images = async () =>
		JSON.stringify((await conversation.context(context)).messages).split('"type":"image"').length - 1;
	await vi.waitFor(async () => expect(await images()).toBe(0));

	limit = 1;
	// The fork starts with "one", whose image the chat no longer sends.
	const two = one.chat.entries.find((entry) => entry.text === "two")!;
	await expect(one.edit(two.id, "two, edited", "e1", [0])).rejects.toThrow("would make 2, more than pi allows (1)");
	// Without the image, the edit goes.
	await one.edit(two.id, "two, edited", "e2", []);
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a4"));
});

it("Edit keeps the chosen attachments in their order, refuses a wrong choice, and edits a message of attachments only (design 6.42)", async () => {
	const { faux, start } = setup();
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
	const { harness, tab } = await start();
	const one = tab(1);
	await one.send(typedInput("r1", "", attached([NOTES, IMAGE, PHOTO])));
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a1"));
	const input = one.chat.entries[0]!;
	expect(input).toMatchObject({ text: "", sent: "" });

	for (const keep of [[3], [0, 0], [-1], [0.5]])
		await expect(one.edit(input.id, "x", "e0", keep)).rejects.toThrow("The attachments of this message changed");
	await expect(one.edit(input.id, " ", "e0", [])).rejects.toThrow("Write a message to send");
	await one.edit(input.id, "", "e1", [2, 0]);
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("a2"));
	expect(one.chat.entries[0]).toMatchObject({
		text: "",
		attachments: [
			{ kind: "file", name: "notes.csv" },
			{ kind: "image", width: 3, height: 4 },
		],
	});
	const records = await harness.commit(
		(tx) => tx.scanEntries({ conversationId: one.id as ConversationId, order: "ascending" }, 10),
		context,
	);
	expect(records.items[0]).toMatchObject({
		kind: INPUT_KIND,
		data: { text: "", attachments: [{ kind: "file" }, { kind: "image" }] },
		model: [
			{
				role: "user",
				content: [
					{ type: "text", text: fileBlock("notes.csv", NOTES.text) },
					{ type: "image", data: "BBBB" },
				],
			},
		],
	});
});

it("admission reads the queue before the chat: an image that moves between the two reads counts twice, never not at all (design 6.42)", async () => {
	const { faux, start } = setup({ imageLimit: async () => 2 });
	const round = Promise.withResolvers<void>();
	faux.setResponses([
		async () => {
			await round.promise;
			return fauxAssistantMessage([{ type: "toolCall", id: "c1", name: "missing_tool", arguments: {} }], {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("done"),
	]);
	const { harness, tab } = await start();
	const one = tab(1);
	await one.send({ requestId: "r1", content: "task" });
	await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	await one.send({ ...typedInput("r2", "steer", attached([IMAGE])), whenBusy: "steer" });
	await vi.waitFor(() => expect(one.chat.queued).toHaveLength(1));
	// The next admission's read of the queue still has the steer; then the run takes it into the chat, before the read of
	// the chat.
	const snapshot = harness.snapshot.bind(harness);
	let armed = true;
	const spy = vi.spyOn(harness, "snapshot").mockImplementation(async (...args) => {
		const read = await snapshot(...args);
		// snapshot() is overloaded; the spy sees only its last signature.
		if ((args[0] as unknown) !== InboxDoc || !armed) return read;
		armed = false;
		round.resolve();
		await vi.waitFor(() => expect(one.chat.entries.map((entry) => entry.text)).toContain("steer"));
		return read;
	});
	await expect(one.send({ ...typedInput("r3", "more", attached([PHOTO])), whenBusy: "followUp" })).rejects.toThrow(
		"This chat already sends 2 images with each request; this message would make 3",
	);
	spy.mockRestore();
	await vi.waitFor(() => expect(one.chat.entries.at(-1)?.text).toBe("done"));
});
