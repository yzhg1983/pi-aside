// The Ask cards of the page tools, and what their answers allow (design 6.23, 6.28), in worker memory: a worker restart
// while a card waits shows the card again. An Allow to act lasts for one answer, and "For this chat" adds the chat's
// later answers on that site; a Run is for one tool task, and "For this answer" adds the site's next scripts in that
// answer, "For this chat" those in the chat's later answers too; a site card grants nothing here: Chrome holds that
// grant.

import type { AskCard } from "../shared/protocol.ts";

/** "recheck": the modes changed while the card waited; the caller reads them again. */
export type AskAnswer = "allow" | "deny" | "recheck";

/**
 * What a card asks: for Chrome's access to a site pi needs, `origin` when pi knows it (design 6.28), to act on
 * `origin`, or to run this task's script in document `documentId`.
 */
export type AskRequest = { conversationId: number; run: number } & (
	| { kind: "site"; origin: string | null }
	| { kind: "act"; origin: string }
	| { kind: "script"; origin: string; taskId: string; documentId: string; code: string; summary: string | null }
);

/**
 * How long a card's Allow lasts (design 6.23). A script card: this script, the rest of the answer, or the chat. An act
 * card: the answer, or the chat ("once" and "answer" are the same there).
 */
export type RunScope = "once" | "answer" | "chat";

/**
 * Where "For this chat" is kept, as `${kind} ${conversationId} ${origin}` keys: the worker stops when idle, and with it
 * its memory, so a chat's allowance must outlive it. `chrome.storage.session` keeps it until Chrome closes
 * (`session.ts`); tests keep it in memory.
 */
export type ChatGrantStore = { get(): Promise<string[]>; set(keys: string[]): Promise<void> };

export function memoryGrants(): ChatGrantStore {
	let keys: string[] = [];
	return {
		get: async () => keys,
		set: async (next) => {
			keys = next;
		},
	};
}

/** A script the user ran from its card: the code shown and the document named on it. */
export type ScriptRun = { run: number; documentId: string; code: string };

type Waiting = {
	card: AskCard;
	request: AskRequest;
	signal: AbortSignal | undefined;
	settle: (answer: AskAnswer) => void;
};

export class Asks {
	/** `${conversationId} ${run} ${origin}`: acting allowed. */
	readonly #grants = new Set<string>();
	/** `${conversationId} ${run} ${origin}`: scripts allowed. Apart from acting: an Allow to act never runs a script. */
	readonly #scripts = new Set<string>();
	/**
	 * `act ${conversationId} ${origin}` or `script ${conversationId} ${origin}`: acting or scripts allowed in every answer
	 * of the chat, with those stored merged in. The two kinds stay apart, as in an answer.
	 */
	readonly #chats = new Set<string>();
	#loaded: Promise<void> | undefined;
	readonly #store: ChatGrantStore;
	/** By `${conversationId} ${taskId}`: a provider may give a call ID again, a task ID is never reused. */
	readonly #runs = new Map<string, ScriptRun>();
	readonly #waiting = new Map<string, Waiting>();
	readonly #changed: () => void;
	#version = 0;

	constructor(changed: () => void, store: ChatGrantStore = memoryGrants()) {
		this.#changed = changed;
		this.#store = store;
	}

	/** Reads the stored chat allowances once per worker; a store that fails to read adds none. */
	#load(): Promise<void> {
		this.#loaded ??= this.#store.get().then(
			(keys) => {
				for (const key of keys) this.#chats.add(key);
			},
			() => {},
		);
		return this.#loaded;
	}

	/** Stores the chat allowances, after the stored ones were merged in; a failed write keeps them for this worker. */
	#saveChats(): void {
		void this.#load()
			.then(() => this.#store.set([...this.#chats]))
			.catch(() => {});
	}

	/** Reads the stored chat allowances, once per worker: `granted()` sees them after it. */
	ready(): Promise<void> {
		return this.#load();
	}

	/**
	 * Whether the user allowed acting on `origin` for the rest of this run of the chat, or for the chat (design 6.23).
	 * Synchronous, for the check right before an action is sent; the hook before it called `ready()`.
	 */
	granted(conversationId: number, run: number, origin: string): boolean {
		return (
			this.#grants.has(`${conversationId} ${run} ${origin}`) || this.#chats.has(`act ${conversationId} ${origin}`)
		);
	}

	/** Whether the user allowed scripts on `origin` for the rest of this run of the chat, or for the chat (design 6.23). */
	async scriptsGranted(conversationId: number, run: number, origin: string): Promise<boolean> {
		if (this.#scripts.has(`${conversationId} ${run} ${origin}`)) return true;
		await this.#load();
		return this.#chats.has(`script ${conversationId} ${origin}`);
	}

	/**
	 * A Run for a script on a site the user allowed for this answer, without a card: execute() checks it as it checks
	 * a Run from a card, so the code and the document are the ones the hook saw.
	 */
	runGranted(request: Extract<AskRequest, { kind: "script" }>, signal: AbortSignal | undefined): void {
		this.#run(request, signal);
	}

	#run(request: Extract<AskRequest, { kind: "script" }>, signal: AbortSignal | undefined): void {
		const key = `${request.conversationId} ${request.taskId}`;
		this.#runs.set(key, { run: request.run, documentId: request.documentId, code: request.code });
		// Stopped before its script was sent: the Run goes with it.
		signal?.addEventListener("abort", () => this.#runs.delete(key), { once: true });
	}

	/** One run's answers per chat: the chat's runs before `run` are over. */
	#over(conversationId: number, run: number): void {
		const chat = `${conversationId} `;
		for (const grants of [this.#grants, this.#scripts])
			for (const key of grants) if (key.startsWith(chat) && !key.startsWith(`${chat}${run} `)) grants.delete(key);
		for (const [key, ran] of this.#runs) if (key.startsWith(chat) && ran.run !== run) this.#runs.delete(key);
	}

	/** The Run the user gave task `taskId`'s card, if any. */
	ran(conversationId: number, taskId: string): ScriptRun | undefined {
		return this.#runs.get(`${conversationId} ${taskId}`);
	}

	/** The task's call has ended: its Run cannot be used again. */
	forget(conversationId: number, taskId: string): void {
		this.#runs.delete(`${conversationId} ${taskId}`);
	}

	/**
	 * Delete all chats (design 6.31): the Allows, Runs, and "For this chat" allowances go, stored ones too; a fresh
	 * database numbers chats from 1 again, so an old one would reach another chat. Rejects when the stored ones could
	 * not be cleared, so the database is not deleted.
	 */
	async clear(): Promise<void> {
		this.#grants.clear();
		this.#scripts.clear();
		this.#runs.clear();
		await this.#load();
		this.#chats.clear();
		await this.#store.set([]);
	}

	/** Counts the changes of the modes (`recheck()`); a caller reads it before it reads the modes. */
	get version(): number {
		return this.#version;
	}

	/**
	 * Shows a card until the user answers, the modes change, or `signal` ends, which rejects. A caller that read the
	 * modes at `version` gets "recheck" at once, without a card, if they changed since.
	 */
	ask(request: AskRequest, signal: AbortSignal | undefined, version: number): Promise<AskAnswer> {
		signal?.throwIfAborted();
		if (version !== this.#version) return Promise.resolve("recheck");
		return new Promise((resolve, reject) => {
			const id = crypto.randomUUID();
			const stop = () => {
				this.#waiting.delete(id);
				this.#changed();
				reject(signal?.reason);
			};
			signal?.addEventListener("abort", stop, { once: true });
			const card: AskCard =
				request.kind === "script"
					? { id, kind: "script", origin: request.origin, summary: request.summary, code: request.code }
					: request.kind === "act"
						? { id, kind: "act", origin: request.origin }
						: { id, kind: "site", origin: request.origin };
			this.#waiting.set(id, {
				card,
				request,
				signal,
				settle: (answer) => {
					signal?.removeEventListener("abort", stop);
					this.#waiting.delete(id);
					this.#changed();
					resolve(answer);
				},
			});
			this.#changed();
		});
	}

	/**
	 * The user's answer; false when the card is gone. Allow covers acting on an act card's origin for the rest of the
	 * run, and `scope` "chat" in the chat's later runs too. On a script card it lets the call run its code in the card's
	 * document; `scope` "answer" also lets the site's later scripts in the run go without a card, and "chat" those in the
	 * chat's later runs. A site card's Allow grants nothing here: Chrome's access, which the panel requested, is the grant.
	 */
	answer(id: string, allow: boolean, scope: RunScope = "once"): boolean {
		const waiting = this.#waiting.get(id);
		if (waiting === undefined) return false;
		const { request, signal } = waiting;
		if (allow) {
			this.#over(request.conversationId, request.run);
			if (request.kind === "act") this.#grants.add(`${request.conversationId} ${request.run} ${request.origin}`);
			else if (request.kind === "script") {
				this.#run(request, signal);
				if (scope === "answer") this.#scripts.add(`${request.conversationId} ${request.run} ${request.origin}`);
			}
			if (request.kind !== "site" && scope === "chat") {
				this.#chats.add(`${request.kind} ${request.conversationId} ${request.origin}`);
				this.#saveChats();
			}
		}
		waiting.settle(allow ? "allow" : "deny");
		return true;
	}

	/** The cards of chat `conversationId`, oldest first. */
	cards(conversationId: number): AskCard[] {
		return [...this.#waiting.values()]
			.filter(({ request }) => request.conversationId === conversationId)
			.map(({ card }) => card);
	}

	/**
	 * The modes changed: every waiting card goes, and its call reads them again. A chat's allowances go too: they were
	 * given under the modes that were.
	 */
	recheck(): void {
		this.#version++;
		for (const waiting of [...this.#waiting.values()]) waiting.settle("recheck");
		// At once in memory, so an action checked after this does not use them; the stored ones once read.
		const had = this.#chats.size > 0;
		this.#chats.clear();
		void this.#load()
			.then(() => {
				if (!had && this.#chats.size === 0) return;
				this.#chats.clear();
				return this.#store.set([]);
			})
			.catch(() => {});
	}
}
