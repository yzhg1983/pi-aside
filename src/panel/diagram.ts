// Mermaid diagrams in answers (design 6.32). A closed ```mermaid fence (markdown.ts) becomes a picture: a worker
// (diagram-worker.ts) lays it out with pele into SVG text, and the panel shows that as an <img> from a blob: URL. An
// image runs no script and loads nothing, and the panel never parses the SVG, so model output still never becomes DOM
// other than text (6.11). A fence that cannot be drawn, in time or at all, stays code.
//
// Model output is untrusted and layout is a library's, so the bounds are fixed: at most MAX_DIAGRAM_CHARS of source and
// MAX_DIAGRAMS per answer, one render at a time, and a render that runs past RENDER_MS ends the worker. The limit starts
// when the worker is ready; one that is not within START_MS is ended too. Each diagram renders once per theme: the
// panel redraws a streaming answer on every update.

export const MAX_DIAGRAM_CHARS = 10_000;
/** Per answer; later fences stay code. */
export const MAX_DIAGRAMS = 5;
export const RENDER_MS = 3000;
export const START_MS = 15_000;
/** Pictures kept; the oldest goes first. */
const MAX_CACHED = 100;

/** pele's colors, its `--pele-*` variables (`surfaceAlt` is `--pele-surface-alt`); the unset ones keep pele's. */
export type DiagramColors = {
	bg: string;
	fg: string;
	line?: string;
	accent?: string;
	muted?: string;
	surface?: string;
	surfaceAlt?: string;
	border?: string;
};
export type DiagramRequest = { diagram: number; source: string; colors: DiagramColors };
/** `svg` is null when the source has no diagram pele can draw; `ready` comes once, when it has started. */
export type DiagramReply = { diagram: number; svg: string | null } | { ready: true };

type Job = { request: DiagramRequest; done: (svg: string | null) => void };

export class Diagrams {
	readonly #start: () => Worker;
	readonly #limitMs: number;
	#worker: Worker | undefined;
	#ready = false;
	#queue: Job[] = [];
	#current: { job: Job; timer?: ReturnType<typeof setTimeout> } | undefined;
	#ids = 0;
	/** Object URLs by colors and source; null for a source that cannot be drawn. */
	#urls = new Map<string, Promise<string | null>>();
	#generation = 0;

	constructor(start: () => Worker, limitMs = RENDER_MS) {
		this.#start = start;
		this.#limitMs = limitMs;
	}

	/** The picture of `source` in `colors`, as an object URL that lives until `drop()`; null if there is none. */
	url(source: string, colors: DiagramColors): Promise<string | null> {
		if (source.length > MAX_DIAGRAM_CHARS) return Promise.resolve(null);
		const key = JSON.stringify([colors, source]);
		let url = this.#urls.get(key);
		if (url === undefined) {
			const generation = this.#generation;
			url = this.#svg(source, colors).then((svg) =>
				svg === null || generation !== this.#generation
					? null
					: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })),
			);
			this.#urls.set(key, url);
			if (this.#urls.size > MAX_CACHED) {
				const [oldest, found] = this.#urls.entries().next().value!;
				this.#urls.delete(oldest);
				void found.then(revoke);
			}
		}
		return url;
	}

	/** Frees every picture, and drops queued renders, when the panel shows another chat. */
	drop(): void {
		this.#generation += 1;
		for (const url of this.#urls.values()) void url.then(revoke);
		this.#urls = new Map();
		for (const job of this.#queue.splice(0)) job.done(null);
	}

	#svg(source: string, colors: DiagramColors): Promise<string | null> {
		return new Promise((done) => {
			this.#queue.push({ request: { diagram: ++this.#ids, source, colors }, done });
			this.#next();
		});
	}

	#next(): void {
		if (this.#current !== undefined) return;
		const job = this.#queue.shift();
		if (job === undefined) return;
		this.#current = { job };
		try {
			if (this.#worker === undefined) {
				this.#ready = false;
				this.#worker = this.#open();
				this.#current.timer = setTimeout(() => this.#fail(), START_MS);
			} else this.#send();
		} catch {
			this.#fail();
		}
	}

	#send(): void {
		const current = this.#current!;
		clearTimeout(current.timer);
		current.timer = setTimeout(() => this.#fail(), this.#limitMs);
		this.#worker!.postMessage(current.job.request);
	}

	#open(): Worker {
		const worker = this.#start();
		worker.addEventListener("message", (event: MessageEvent<DiagramReply | null>) => {
			const reply = event.data;
			if (this.#worker !== worker || typeof reply !== "object" || reply === null) return;
			if ("ready" in reply) {
				if (this.#ready) return;
				this.#ready = true;
				if (this.#current !== undefined) this.#send();
			} else if (this.#ready && reply.diagram === this.#current?.job.request.diagram)
				this.#finish(typeof reply.svg === "string" ? reply.svg : null);
		});
		// The script failed to load, or the worker died.
		worker.addEventListener("error", () => this.#worker === worker && this.#fail());
		return worker;
	}

	/** The render ran too long or the worker broke: no picture, and the next render starts a new worker. */
	#fail(): void {
		this.#worker?.terminate();
		this.#worker = undefined;
		this.#finish(null);
	}

	#finish(svg: string | null): void {
		const current = this.#current;
		if (current === undefined) return;
		clearTimeout(current.timer);
		this.#current = undefined;
		current.job.done(svg);
		this.#next();
	}
}

function revoke(url: string | null): void {
	if (url !== null) URL.revokeObjectURL(url);
}
