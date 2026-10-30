import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkerClient } from "../src/panel/client.ts";
import type { Command, PageMessage, PanelState, WorkerMessage } from "../src/shared/protocol.ts";

/** A port whose disconnect, like Chrome's, notifies only the other end. */
class FakePort {
	readonly sent: PageMessage[] = [];
	disconnected = false;
	readonly #messages: ((message: WorkerMessage) => void)[] = [];
	readonly #disconnects: (() => void)[] = [];
	readonly onMessage = { addListener: (listener: (message: WorkerMessage) => void) => this.#messages.push(listener) };
	readonly onDisconnect = { addListener: (listener: () => void) => this.#disconnects.push(listener) };

	postMessage(message: PageMessage): void {
		if (this.disconnected) throw new Error("Attempting to use a disconnected port object");
		this.sent.push(structuredClone(message));
	}

	disconnect(): void {
		this.disconnected = true;
	}

	deliver(message: WorkerMessage): void {
		for (const listener of this.#messages) listener(message);
	}

	/** The worker side went away. */
	drop(): void {
		this.disconnected = true;
		for (const listener of this.#disconnects) listener();
	}

	commands(): Command["type"][] {
		return this.sent.flatMap((message) => (message.type === "command" ? [message.command.type] : []));
	}
}

let ports: FakePort[];
const state = { sending: 0 } as unknown as PanelState;
const send: Command = {
	type: "send",
	rev: 0,
	conversationId: 1,
	requestId: "r1",
	text: "hi",
	draftId: null,
	quote: false,
	page: null,
	whenBusy: "followUp",
	attachments: [],
};

beforeEach(() => {
	ports = [];
	vi.useFakeTimers();
	vi.stubGlobal("chrome", {
		runtime: {
			connect: () => {
				const port = new FakePort();
				ports.push(port);
				return port;
			},
		},
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function connected(): WorkerClient {
	const client = new WorkerClient({ tabId: 1, log: false, onState() {}, onConnection() {} });
	client.start();
	ports[0]!.deliver({ type: "snapshot", seq: 1, state });
	return client;
}

it("a sequence gap rejects the commands that must not be sent again and resends only send and retry", async () => {
	const client = connected();
	const first = ports[0]!;
	const newChat = client.request({ type: "new-chat", rev: 0, attachPage: true });
	const sent = client.request(send);
	expect(first.commands()).toEqual(["new-chat", "send"]);

	first.deliver({ type: "batch", seq: 3, patch: {} });
	expect(first.disconnected).toBe(true);
	await expect(newChat).rejects.toThrow(/lost/);
	vi.advanceTimersByTime(0);
	const second = ports[1]!;
	second.deliver({ type: "snapshot", seq: 1, state });
	expect(second.commands()).toEqual(["send"]);

	// A late notification about the old port changes nothing.
	first.drop();
	vi.advanceTimersByTime(1000);
	expect(ports).toHaveLength(2);
	const resent = second.sent.find((message) => message.type === "command")!;
	second.deliver({ type: "reply", id: resent.type === "command" ? resent.id : "", ok: true, result: 7 });
	expect(await sent).toBe(7);
});

it("the hello names the page's tab", () => {
	connected();
	expect(ports[0]!.sent[0]).toMatchObject({ type: "hello", tabId: 1 });
});

it("a dropped port rejects pending commands except send and retry, and new ones until it reconnects", async () => {
	const client = connected();
	const abort = client.request({ type: "abort", rev: 0 });
	const sent = client.request(send);
	ports[0]!.drop();
	await expect(abort).rejects.toThrow(/lost/);
	await expect(client.request({ type: "list-models" })).rejects.toThrow(/Not connected/);

	vi.advanceTimersByTime(500);
	ports[1]!.deliver({ type: "snapshot", seq: 1, state });
	expect(ports[1]!.commands()).toEqual(["send"]);
	ports[1]!.deliver({ type: "reply", id: "2", ok: false, error: "No key" });
	await expect(sent).rejects.toThrow("No key");
});
