// The page side of the worker connection: hello, snapshot and batches with acks, commands with replies, reconnect.

import { t } from "../shared/i18n.ts";
import {
	applyPatch,
	type Command,
	PANEL_PORT,
	type PageMessage,
	type PanelState,
	PROTOCOL_VERSION,
	type WorkerMessage,
} from "../shared/protocol.ts";

export type Connection = "connecting" | "connected" | "incompatible";

type Request = {
	message: Extract<PageMessage, { type: "command" }>;
	resolve(value: unknown): void;
	reject(error: Error): void;
	/** Sent again after a reconnect: the command is idempotent by its request ID. */
	resend: boolean;
};

const RECONNECT_MS = 500;

/** The tab a page belongs to, from `?tab=<id>` in its URL; null without one. */
export function pageTab(search: string): number | null {
	const value = new URLSearchParams(search).get("tab");
	const tabId = value === null ? Number.NaN : Number(value);
	return Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : null;
}

export class WorkerClient {
	state: PanelState | undefined;
	readonly #log: boolean;
	readonly #onState: (state: PanelState) => void;
	readonly #onConnection: (connection: Connection) => void;
	/** The tab whose chat this page shows; null for the diagnostics page without one. */
	readonly #tabId: number | null;
	#port: chrome.runtime.Port | undefined;
	#seq = 0;
	#nextId = 0;
	readonly #pending = new Map<string, Request>();
	#incompatible = false;

	constructor(options: {
		tabId: number | null;
		log: boolean;
		onState(state: PanelState): void;
		onConnection(connection: Connection): void;
	}) {
		this.#tabId = options.tabId;
		this.#log = options.log;
		this.#onState = options.onState;
		this.#onConnection = options.onConnection;
	}

	start(): void {
		this.#connect();
	}

	/**
	 * Sends a command and resolves with its reply. A send, retry, or edit without a reply when the port drops is sent again
	 * after the reconnect, with the same request ID, so the worker answers with the first admission if there was one.
	 * Other commands reject.
	 */
	request<T = unknown>(command: Command): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const request: Request = {
			message: { type: "command", id: String(++this.#nextId), command },
			resolve: resolve as (value: unknown) => void,
			reject,
			resend: command.type === "send" || command.type === "retry" || command.type === "edit",
		};
		if (this.#port === undefined && !request.resend) {
			reject(new Error(t("notConnected")));
			return promise;
		}
		this.#pending.set(request.message.id, request);
		if (this.#port !== undefined && this.state !== undefined) this.#post(request.message);
		return promise;
	}

	#connect(): void {
		const port = chrome.runtime.connect({ name: PANEL_PORT });
		this.#port = port;
		this.#seq = 0;
		this.state = undefined;
		this.#onConnection("connecting");
		port.onMessage.addListener((message: WorkerMessage) => this.#receive(port, message));
		port.onDisconnect.addListener(() => this.#drop(port, RECONNECT_MS));
		this.#post({ type: "hello", version: PROTOCOL_VERSION, tabId: this.#tabId, log: this.#log });
	}

	/** Leaves `port`: rejects the commands that must not be sent again, then reconnects after `delay`. */
	#drop(port: chrome.runtime.Port, delay: number): void {
		if (this.#port !== port) return;
		this.#port = undefined;
		for (const [id, request] of this.#pending) {
			if (request.resend) continue;
			this.#pending.delete(id);
			request.reject(new Error(t("connectionLost")));
		}
		if (this.#incompatible) return;
		this.#onConnection("connecting");
		setTimeout(() => this.#connect(), delay);
	}

	#receive(port: chrome.runtime.Port, message: WorkerMessage): void {
		if (this.#port !== port) return;
		switch (message.type) {
			case "incompatible":
				this.#incompatible = true;
				this.#onConnection("incompatible");
				return;
			case "snapshot": {
				const first = this.state === undefined;
				this.#seq = message.seq;
				this.state = message.state;
				this.#post({ type: "ack", seq: message.seq });
				if (first) {
					this.#onConnection("connected");
					// Commands made while disconnected, and sends that lost their reply.
					for (const request of this.#pending.values()) this.#post(request.message);
				}
				this.#onState(message.state);
				return;
			}
			case "batch":
				if (this.state === undefined || message.seq !== this.#seq + 1) {
					// A gap is a bug; a new connection starts from a snapshot. Our own disconnect fires no onDisconnect here.
					port.disconnect();
					this.#drop(port, 0);
					return;
				}
				this.#seq = message.seq;
				this.state = applyPatch(this.state, message.patch);
				this.#post({ type: "ack", seq: message.seq });
				this.#onState(this.state);
				return;
			case "reply": {
				const request = this.#pending.get(message.id);
				this.#pending.delete(message.id);
				if (message.ok) request?.resolve(message.result);
				else request?.reject(new Error(message.error));
				return;
			}
		}
	}

	#post(message: PageMessage): void {
		try {
			this.#port?.postMessage(message);
		} catch {
			// The disconnect handler reconnects.
		}
	}
}
