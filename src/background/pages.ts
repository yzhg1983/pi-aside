import {
	diffState,
	MAX_UNACKED,
	type PageMessage,
	type PanelState,
	PROTOCOL_VERSION,
	type WorkerMessage,
} from "../shared/protocol.ts";

/** The part of `chrome.runtime.Port` the worker uses. */
export type PortLike = { postMessage(message: WorkerMessage): void; disconnect(): void };

type Page = {
	port: PortLike;
	tabId: number | null;
	log: boolean;
	/** Sequence number of the newest message sent, and the newest one the page acked. */
	seq: number;
	acked: number;
	/** The state the page has once it applied everything sent. */
	sent: PanelState;
	/** Changes were held back because the page fell `MAX_UNACKED` behind; its next ack gets a snapshot. */
	behind: boolean;
};

/**
 * The connected extension pages and what each was sent. `state(tabId, log)` builds one page's state from the worker's
 * current values; `flush()` sends each page the difference.
 */
export class Pages {
	readonly #pages = new Map<PortLike, Page>();
	readonly #state: (tabId: number | null, log: boolean) => PanelState;

	constructor(state: (tabId: number | null, log: boolean) => PanelState) {
		this.#state = state;
	}

	get size(): number {
		return this.#pages.size;
	}

	/** The tabs of the connected pages. */
	tabs(): Set<number> {
		const tabs = new Set<number>();
		for (const page of this.#pages.values()) if (page.tabId !== null) tabs.add(page.tabId);
		return tabs;
	}

	/** The tab of the page on `port`, as its `hello` named it; undefined before its `hello`. */
	tabOf(port: PortLike): number | null | undefined {
		return this.#pages.get(port)?.tabId;
	}

	/** A page's first message. Another protocol version gets `incompatible` and is disconnected. */
	hello(port: PortLike, message: Extract<PageMessage, { type: "hello" }>): boolean {
		if (message.version !== PROTOCOL_VERSION) {
			this.#post(port, { type: "incompatible", version: PROTOCOL_VERSION });
			port.disconnect();
			return false;
		}
		const page: Page = {
			port,
			tabId: message.tabId,
			log: message.log,
			seq: 0,
			acked: 0,
			sent: this.#state(message.tabId, message.log),
			behind: false,
		};
		this.#pages.set(port, page);
		this.#snapshot(page);
		return true;
	}

	has(port: PortLike): boolean {
		return this.#pages.has(port);
	}

	ack(port: PortLike, seq: number): void {
		const page = this.#pages.get(port);
		if (page === undefined) return;
		page.acked = Math.max(page.acked, Math.min(seq, page.seq));
		if (page.behind && page.seq - page.acked < MAX_UNACKED) {
			page.behind = false;
			this.#snapshot(page);
		}
	}

	remove(port: PortLike): void {
		this.#pages.delete(port);
	}

	flush(): void {
		for (const page of this.#pages.values()) {
			if (page.behind) continue;
			const next = this.#state(page.tabId, page.log);
			const patch = diffState(page.sent, next);
			if (patch === undefined) continue;
			if (page.seq - page.acked >= MAX_UNACKED) {
				page.behind = true;
				continue;
			}
			page.sent = next;
			page.seq += 1;
			this.#post(page.port, { type: "batch", seq: page.seq, patch });
		}
	}

	reply(port: PortLike, message: Extract<WorkerMessage, { type: "reply" }>): void {
		this.#post(port, message);
	}

	#snapshot(page: Page): void {
		page.sent = this.#state(page.tabId, page.log);
		page.seq += 1;
		this.#post(page.port, { type: "snapshot", seq: page.seq, state: page.sent });
	}

	#post(port: PortLike, message: WorkerMessage): void {
		try {
			port.postMessage(message);
		} catch {
			// The page is gone; its disconnect event follows.
			this.#pages.delete(port);
		}
	}
}
