import { expect, it } from "vitest";
import { Pages, type PortLike } from "../src/background/pages.ts";
import { EMPTY_CHAT } from "../src/background/projection.ts";
import { PRESETS } from "../src/shared/presets.ts";
import {
	applyPatch,
	type ChatEntry,
	MAX_UNACKED,
	type PanelState,
	PROTOCOL_VERSION,
	type WorkerMessage,
} from "../src/shared/protocol.ts";

function port() {
	const sent: WorkerMessage[] = [];
	const value: PortLike & { sent: WorkerMessage[]; disconnected: boolean } = {
		sent,
		disconnected: false,
		postMessage: (message) => sent.push(structuredClone(message)),
		disconnect() {
			value.disconnected = true;
		},
	};
	return value;
}

const entry = (id: number): ChatEntry => ({
	id,
	role: "user",
	text: `m${id}`,
	quote: null,
	source: null,
	error: null,
	thinking: null,
	usage: null,
	stats: null,
	detail: null,
	image: false,
	step: false,
});

function setup() {
	let current: Omit<PanelState, "log"> = {
		status: {
			boot: 1,
			workerStartedAt: 0,
			harnessOpenMs: null,
			harnessError: null,
			storageFull: false,
			access: {
				openrouter: { key: false, permission: false, plan: false, planModels: null },
				openai: { key: false, permission: false, plan: false, planModels: null },
				anthropic: { key: false, permission: false, plan: false, planModels: null },
				deepseek: { key: false, permission: false, plan: false, planModels: null },
			},
			chatgpt: { waiting: false, account: null, ended: false },
			wake: { active: false, at: null },
			keepaliveEnabled: true,
			keepalive: false,
			attachment: null,
		},
		settings: {
			openaiWebSearch: true,
			model: { provider: "openrouter", modelId: "m" },
			selectionAction: "send",
			enterWhileBusy: "steer",
			defaultPreset: "explain",
			language: "English",
			thinking: "off",
			prompts: [...PRESETS],
			tools: { read: "on", observe: "on", act: "ask", script: "off", screenshot: "on" },
			callsPerAnswer: 50,
		},
		chat: { ...EMPTY_CHAT, conversationId: 1, entries: [entry(1)] },
		drafts: [],
		rev: 0,
		resumed: null,
		sending: 0,
		page: null,
		notice: null,
		asks: [],
	};
	// Each tab's `rev` is its ID, so a page shows whose state it got.
	const pages = new Pages((tabId, log) => ({
		...structuredClone(current),
		rev: tabId ?? -1,
		log: log ? ["line"] : [],
	}));
	return {
		pages,
		update(change: (state: Omit<PanelState, "log">) => Omit<PanelState, "log">) {
			current = change(current);
		},
	};
}

/** What the page holds after applying everything it received. */
function replay(messages: WorkerMessage[]): PanelState | undefined {
	let state: PanelState | undefined;
	for (const message of messages) {
		if (message.type === "snapshot") state = message.state;
		else if (message.type === "batch" && state !== undefined) state = applyPatch(state, message.patch);
	}
	return state;
}

it("a page of another protocol version is told so and disconnected", () => {
	const { pages } = setup();
	const page = port();
	expect(pages.hello(page, { type: "hello", version: PROTOCOL_VERSION + 1, tabId: 1, log: false })).toBe(false);
	expect(page.sent).toEqual([{ type: "incompatible", version: PROTOCOL_VERSION }]);
	expect(page.disconnected).toBe(true);
	expect(pages.size).toBe(0);
});

it("sends a snapshot, then only what changed: new entries from the first changed index", () => {
	const { pages, update } = setup();
	const page = port();
	const diagnostics = port();
	pages.hello(page, { type: "hello", version: PROTOCOL_VERSION, tabId: 1, log: false });
	pages.hello(diagnostics, { type: "hello", version: PROTOCOL_VERSION, tabId: null, log: true });
	expect(page.sent).toMatchObject([{ type: "snapshot", seq: 1, state: { log: [] } }]);
	expect(diagnostics.sent).toMatchObject([{ type: "snapshot", seq: 1, state: { log: ["line"] } }]);

	pages.flush();
	expect(page.sent).toHaveLength(1);

	update((state) => ({ ...state, sending: 1, chat: { ...state.chat, entries: [entry(1), entry(2)], busy: true } }));
	pages.flush();
	expect(page.sent[1]).toEqual({
		type: "batch",
		seq: 2,
		patch: { sending: 1, chat: { ...EMPTY_CHAT, conversationId: 1, busy: true, from: 1, entries: [entry(2)] } },
	});

	// Another chat: everything is replaced, also entries with the same IDs.
	update((state) => ({ ...state, chat: { ...EMPTY_CHAT, conversationId: 2, entries: [entry(1)] } }));
	pages.flush();
	expect(page.sent[2]).toMatchObject({ type: "batch", seq: 3, patch: { chat: { conversationId: 2, from: 0 } } });
	const { log: _, ...expected } = replay(page.sent)!;
	update((state) => {
		expect(expected).toEqual({ ...state, rev: 1 });
		return state;
	});
});

it("a page that falls behind gets no batches, then one snapshot when it acks", () => {
	const { pages, update } = setup();
	const page = port();
	pages.hello(page, { type: "hello", version: PROTOCOL_VERSION, tabId: 1, log: false });
	for (let sending = 1; sending <= MAX_UNACKED + 3; sending++) {
		update((state) => ({ ...state, sending }));
		pages.flush();
	}
	// The snapshot and MAX_UNACKED - 1 batches, none acked.
	expect(page.sent).toHaveLength(MAX_UNACKED);
	pages.ack(page, 2);
	expect(page.sent).toHaveLength(MAX_UNACKED + 1);
	expect(page.sent.at(-1)).toMatchObject({
		type: "snapshot",
		seq: MAX_UNACKED + 1,
		state: { sending: MAX_UNACKED + 3 },
	});
	// Acks beyond what was sent count as the newest.
	pages.ack(page, 100);
	update((state) => ({ ...state, sending: 0 }));
	pages.flush();
	expect(page.sent.at(-1)).toEqual({ type: "batch", seq: MAX_UNACKED + 2, patch: { sending: 0 } });
	expect(replay(page.sent)?.sending).toBe(0);
});

it("a page whose port throws is dropped", () => {
	const { pages, update } = setup();
	const page = port();
	pages.hello(page, { type: "hello", version: PROTOCOL_VERSION, tabId: 1, log: false });
	page.postMessage = () => {
		throw new Error("disconnected");
	};
	update((state) => ({ ...state, sending: 1 }));
	pages.flush();
	expect(pages.has(page)).toBe(false);
});

it("each page gets its tab's state; the pages' tabs are known", () => {
	const { pages } = setup();
	const one = port();
	const two = port();
	const diagnostics = port();
	pages.hello(one, { type: "hello", version: PROTOCOL_VERSION, tabId: 1, log: false });
	pages.hello(two, { type: "hello", version: PROTOCOL_VERSION, tabId: 2, log: false });
	pages.hello(diagnostics, { type: "hello", version: PROTOCOL_VERSION, tabId: null, log: true });
	expect([one, two, diagnostics].map((page) => replay(page.sent)?.rev)).toEqual([1, 2, -1]);
	expect(pages.tabs()).toEqual(new Set([1, 2]));
	expect([pages.tabOf(two), pages.tabOf(diagnostics), pages.tabOf(port())]).toEqual([2, null, undefined]);
	pages.remove(two);
	expect(pages.tabs()).toEqual(new Set([1]));
});
