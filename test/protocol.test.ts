import { expect, it } from "vitest";
import { EMPTY_CHAT } from "../src/background/projection.ts";
import { applyPatch, type ChatEntry, diffState, type PanelState } from "../src/shared/protocol.ts";

const entry = (id: number, extra: Partial<ChatEntry> = {}): ChatEntry => ({
	id,
	role: "assistant",
	text: `a${id}`,
	quote: null,
	source: null,
	error: null,
	thinking: null,
	usage: null,
	stats: null,
	detail: null,
	image: false,
	step: false,
	...extra,
});

const state = (entries: ChatEntry[], busy: boolean) =>
	({ rev: 1, chat: { ...EMPTY_CHAT, conversationId: 7, entries, busy } }) as unknown as PanelState;

it("sends an entry again when its turn's end adds usage and stats without a new ID (design 6.21)", () => {
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, planCost: 0, cacheHit: null };
	const stats = { modelMs: 1200, toolMs: 300, tools: [{ name: "read_page", calls: 1, failed: 0 }] };
	// Stop during a tool call: the step before it ends the turn, and no entry follows.
	const running = state([entry(1, { role: "user" }), entry(2, { step: true })], true);
	const stopped = state([entry(1, { role: "user" }), entry(2, { step: true, usage, stats })], false);
	const patch = diffState(running, stopped);
	expect(patch?.chat?.from).toBe(1);
	expect(patch?.chat?.entries.map((sent) => sent.id)).toEqual([2]);
	expect(applyPatch(running, patch!)).toEqual(stopped);
	// Entries with the same ID and stats are kept.
	expect(
		diffState(
			stopped,
			state(
				stopped.chat.entries.map((sent) => ({ ...sent })),
				false,
			),
		),
	).toBeUndefined();
});
