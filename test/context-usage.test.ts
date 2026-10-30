import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { EMPTY_CHAT, projectChat } from "../src/background/projection.ts";
import { contextText } from "../src/panel/format.ts";

const answer = (
	id: number,
	input: number,
	output = 0,
	cacheRead = 0,
	stopReason: AssistantMessage["stopReason"] = "stop",
) => ({
	id,
	kind: "pi.assistant",
	model: [
		{
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			stopReason,
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: 0,
				totalTokens: input + output + cacheRead,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage,
	],
});
const project = (entries: { id: number; kind: string; head?: number; model?: Message[] }[]) =>
	projectChat({ conversation: { id: 1 }, entries, docs: {} } as unknown as ConversationView);

it("formats the current context percentage/window, without a compaction marker, and nothing for an empty chat", () => {
	expect(contextText({ tokens: 144_000, auto: true }, 500_000)).toBe("28.8%/500k");
	expect(contextText({ tokens: 144_000, auto: false }, 500_000)).toBe("28.8%/500k");
	expect(contextText({ tokens: null, auto: true }, 500_000)).toBe("?/500k");
	// A new chat: nothing in its context yet, so no line.
	expect(contextText(EMPTY_CHAT.context, 128_000)).toBe("");
	expect(contextText(EMPTY_CHAT.context, undefined)).toBe("");
	expect(contextText(EMPTY_CHAT.context, 0)).toBe("");
});

it("uses the latest request, including cached input and output, not cumulative spend", () => {
	const chat = project([answer(1, 300_000), answer(2, 4_000, 1_000, 139_000)]);
	expect(chat.context).toEqual({ tokens: 144_000, auto: true });
});

it("estimates trailing messages and does not replace measured context with a failed call", () => {
	const user = { id: 2, kind: "pi.user", model: [{ role: "user", content: "abcdefg", timestamp: 0 } as Message] };
	expect(project([answer(1, 100), user]).context.tokens).toBe(102);
	expect(project([answer(1, 100), answer(2, 0, 0, 0, "error")]).context.tokens).toBe(102);
});

it("does not reuse pre-compaction usage, including retained answers", () => {
	const summary = { id: 3, kind: "pi.compaction", head: 2 };
	expect(project([summary, answer(2, 300_000)]).context.tokens).toBeNull();
	expect(project([summary, answer(2, 300_000), answer(4, 20_000)]).context.tokens).toBe(20_000);
	expect(project([{ id: 5, kind: "pi.reset", head: 5 }]).context.tokens).toBeNull();
	expect(project([]).context.tokens).toBe(0);
});
