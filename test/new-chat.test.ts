// New chat refreshes only the tab's attachment, not message/draft sources or the chat left running.
import { browser, connect, faux, fire, workerSession } from "./fixtures/worker.ts";
import "../src/background/main.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { ChatsDoc } from "../src/background/chats.ts";
import { MESSAGE_KIND } from "../src/background/projection.ts";
import { urlKey } from "../src/background/url-key.ts";
import { type Command, MAX_TITLE_CHARS, MAX_URL_CHARS, PROTOCOL_VERSION } from "../src/shared/protocol.ts";

vi.mock("../src/background/session.ts", () => workerSession);

const context = BACKGROUND_CONTEXT;
const A = "https://example.test/a";
const B = "https://example.test/b";
const C = "https://example.test/c";
const panels: ReturnType<typeof connect>[] = [];
afterEach(() => {
	for (const panel of panels.splice(0)) panel.disconnect();
	vi.restoreAllMocks();
});
let nextTab = 1000;
const read = (url: string, documentId = `doc ${url}`, anchor: boolean | null = null) => [
	{ documentId, result: { url, title: `Title ${url}`, anchor, selection: "", password: false } },
];
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function setup() {
	const tabId = nextTab++;
	browser.open.add(tabId);
	browser.inject = async () => read(A);
	fire("action.onClicked", { id: tabId, url: A });
	await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(A));
	const original = workerSession.tabs.get(tabId)!.page!;
	const { chats, harness } = await workerSession.session();
	faux.setResponses([fauxAssistantMessage("first answer")]);
	await chats.send(
		tabId,
		0,
		null,
		{
			requestId: `first ${tabId}`,
			content: "about A",
			entry: { kind: MESSAGE_KIND, data: { text: "about A", page: original } },
		},
		original.key,
	);
	const chat = workerSession.tabs.get(tabId)!.chat!;
	await (await harness.conversation(chat as ConversationId, context))!.waitForIdle(context);
	const panel = connect(tabId);
	panels.push(panel);
	panel.send({ type: "hello", version: PROTOCOL_VERSION, tabId, log: false });
	await vi.waitFor(() => expect(panel.received.some((message) => message.type === "snapshot")).toBe(true));
	let next = 0;
	const run = async (command: Command) => {
		const id = `c${next++}`;
		panel.send({ type: "command", id, command });
		return vi.waitFor(() => {
			const reply = panel.received.find((message) => message.type === "reply" && message.id === id);
			if (reply === undefined) throw Error("no reply yet");
			return reply;
		});
	};
	return { tabId, chat, original, chats, harness, run };
}

it("New chat clears old attachment metadata in its reset; historical inputs stay unchanged", async () => {
	const { tabId, chat, original, chats, harness } = await setup();
	await chats.newChat(tabId, 0);
	expect(workerSession.tabs.get(tabId)).toMatchObject({ chat: null, rev: 1, page: null, url: null, anchor: null });
	await chats.attach(chat);
	expect(chats.view(chat)?.entries[0]?.source).toMatchObject({ url: A, title: original.title });
	expect((await harness.snapshot(ChatsDoc, context))?.chats.find((item) => item.id === chat)?.key).toBe(original.key);
});

it.each([
	["navigation", B, "new document", null],
	["reload", A, "reloaded document", null],
	["SPA route", `${B}#route`, `doc ${A}`, false],
	["document anchor", `${B}#heading`, "new document", true],
] as const)("New chat uses current metadata after %s", async (_, url, documentId, anchor) => {
	const { tabId, run } = await setup();
	const inject = vi.fn(async () => read(url, documentId, anchor));
	browser.inject = inject;
	expect(await run({ type: "new-chat", rev: 0, attachPage: true })).toMatchObject({ ok: true });
	await vi.waitFor(() =>
		expect(workerSession.tabs.get(tabId)?.page).toMatchObject({
			tabId,
			frameId: 0,
			documentId,
			url,
			title: `Title ${url}`,
			key: urlKey(url, anchor),
		}),
	);
	expect(inject).toHaveBeenCalledWith(tabId, [0], [false]);
	expect(workerSession.tabs.get(tabId)).toMatchObject({ url, anchor, chat: null, rev: 1 });
});

it("metadata keeps the full lookup URL but bounds the attached URL and title", async () => {
	const { tabId, run } = await setup();
	const url = `${B}?x=${"x".repeat(MAX_URL_CHARS)}`;
	browser.inject = async () => [
		{
			documentId: "long URL",
			result: {
				url,
				title: "T".repeat(MAX_TITLE_CHARS + 20),
				selection: "",
				password: false,
			},
		},
	];
	await run({ type: "new-chat", rev: 0, attachPage: true });
	await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.documentId).toBe("long URL"));
	expect(workerSession.tabs.get(tabId)).toMatchObject({
		url,
		anchor: null,
		page: {
			url: url.slice(0, MAX_URL_CHARS),
			title: "T".repeat(MAX_TITLE_CHARS),
			key: null,
		},
	});
});

it.each(["denied", "missing", "restricted"] as const)(
	"New chat leaves no stale attachment when metadata is %s",
	async (reason) => {
		const { tabId, run } = await setup();
		const inject = vi.fn(async () => {
			if (reason === "denied") throw Error("Cannot access contents of the page");
			return reason === "missing" ? [] : read("about:blank");
		});
		browser.inject = inject;
		expect(await run({ type: "new-chat", rev: 0, attachPage: true })).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(inject).toHaveBeenCalled());
		await settle();
		expect(workerSession.tabs.get(tabId)).toMatchObject({ page: null, url: null, anchor: null, rev: 1 });
	},
);

it("Don't attach skips the automatic read and a rejected New chat changes nothing", async () => {
	const { tabId, original, run } = await setup();
	const inject = vi.fn(async () => read(B));
	browser.inject = inject;
	expect(await run({ type: "new-chat", rev: 9, attachPage: true })).toMatchObject({ ok: false });
	expect(workerSession.tabs.get(tabId)?.page).toEqual(original);
	expect(await run({ type: "new-chat", rev: 0, attachPage: false })).toMatchObject({ ok: true });
	expect(workerSession.tabs.get(tabId)?.page).toBeNull();
	expect(inject).not.toHaveBeenCalled();
});

it("a slow metadata read does not hold New chat or the shared command queue", async () => {
	const { tabId, chats, harness, run } = await setup();
	const gate = Promise.withResolvers<ReturnType<typeof read>>();
	browser.inject = () => gate.promise;
	try {
		expect(await run({ type: "new-chat", rev: 0, attachPage: true })).toMatchObject({ ok: true });
		expect(workerSession.tabs.get(tabId)?.page).toBeNull();
		faux.setResponses([fauxAssistantMessage("second answer")]);
		await chats.send(tabId, 1, null, { requestId: `second ${tabId}`, content: "plain question" }, null);
		await (await harness.conversation(workerSession.tabs.get(tabId)!.chat! as ConversationId, context))!.waitForIdle(
			context,
		);
		gate.resolve(read(B));
		await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(B));
	} finally {
		gate.resolve(read(B));
	}
});

it("a gesture from before New chat cannot put the old page back after the refresh", async () => {
	const { tabId, run } = await setup();
	const old = Promise.withResolvers<ReturnType<typeof read>>();
	browser.inject = () => old.promise;
	fire("action.onClicked", { id: tabId, url: A });
	await settle();
	browser.inject = async () => read(B);
	try {
		await run({ type: "new-chat", rev: 0, attachPage: true });
		await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(B));
		old.resolve(read(A));
		await settle();
		expect(workerSession.tabs.get(tabId)?.page?.url).toBe(B);
	} finally {
		old.resolve(read(A));
	}
});

it("a capture in a replacement tab may finish after it inherits a different chat revision", async () => {
	const { tabId, chat, chats } = await setup();
	await chats.newChat(tabId, 0);
	await chats.openChat(tabId, 1, chat);
	const added = tabId + 20_000;
	browser.open.delete(tabId);
	browser.open.add(added);
	const move = Promise.withResolvers<void>();
	const frame = Promise.withResolvers<ReturnType<typeof read>>();
	const held = workerSession.commands(() => move.promise);
	try {
		fire("tabs.onReplaced", added, tabId);
		const inject = vi.fn(() => frame.promise);
		browser.inject = inject;
		fire("action.onClicked", { id: added, url: C });
		await vi.waitFor(() => expect(inject).toHaveBeenCalled());
		move.resolve();
		await held;
		await vi.waitFor(() => expect(workerSession.tabs.get(added)?.rev).toBe(2));
		frame.resolve(read(C));
		await vi.waitFor(() => expect(workerSession.tabs.get(added)?.page?.url).toBe(C));
	} finally {
		move.resolve();
		frame.resolve(read(C));
	}
});

it.each(["History", "New chat", "gesture", "close", "replacement", "timeout"] as const)(
	"a late refresh cannot overwrite %s",
	async (change) => {
		const { tabId, chat, chats, run } = await setup();
		const gate = Promise.withResolvers<ReturnType<typeof read>>();
		browser.inject = () => gate.promise;
		const timeout = new AbortController();
		if (change === "timeout") vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
		try {
			await run({ type: "new-chat", rev: 0, attachPage: true });
			browser.inject = async () => read(C);
			if (change === "History") await chats.openChat(tabId, 1, chat);
			else if (change === "New chat") {
				faux.setResponses([fauxAssistantMessage("next")]);
				await chats.send(tabId, 1, null, { requestId: `next ${tabId}`, content: "question" }, null);
				await run({ type: "new-chat", rev: 1, attachPage: true });
				await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(C));
			} else if (change === "gesture") {
				fire("action.onClicked", { id: tabId, url: C });
				await vi.waitFor(() => expect(workerSession.tabs.get(tabId)?.page?.url).toBe(C));
			} else if (change === "close" || change === "replacement") {
				browser.open.delete(tabId);
				if (change === "replacement") browser.open.add(tabId + 10_000);
				fire(
					change === "close" ? "tabs.onRemoved" : "tabs.onReplaced",
					...(change === "close" ? [tabId] : [tabId + 10_000, tabId]),
				);
				await vi.waitFor(() => expect(workerSession.tabs.get(tabId)).toBeUndefined());
			} else {
				timeout.abort();
				await settle();
			}
			gate.resolve(read(B));
			await settle();
			expect(workerSession.tabs.get(tabId)?.page?.url).not.toBe(B);
			if (change === "close" || change === "replacement") expect(workerSession.tabs.get(tabId)).toBeUndefined();
			else if (change === "History" || change === "timeout") expect(workerSession.tabs.get(tabId)?.page).toBeNull();
		} finally {
			gate.resolve(read(B));
		}
	},
);
