import { resolveObjectURL } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { type DiagramRequest, Diagrams, MAX_DIAGRAM_CHARS, START_MS } from "../src/panel/diagram.ts";

/** A worker the test answers by hand. */
class FakeWorker extends EventTarget {
	posted: DiagramRequest[] = [];
	terminated = false;
	postMessage(request: DiagramRequest): void {
		this.posted.push(request);
	}
	terminate(): void {
		this.terminated = true;
	}
	reply(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
	ready(): void {
		this.reply({ ready: true });
	}
	/** Answers the last request. */
	draw(svg: string | null): void {
		this.reply({ diagram: this.posted.at(-1)!.diagram, svg });
	}
}

/** Workers start ready, unless `starting`: then the test says when. */
function setup(limitMs?: number, starting = false) {
	const workers: FakeWorker[] = [];
	const diagrams = new Diagrams(() => {
		const worker = new FakeWorker();
		workers.push(worker);
		if (!starting) queueMicrotask(() => worker.ready());
		return worker as unknown as Worker;
	}, limitMs);
	return { diagrams, workers, worker: () => workers.at(-1)! };
}

const light = { bg: "#fff", fg: "#000" };
const dark = { bg: "#000", fg: "#fff" };
const svgOf = async (url: string | null) => resolveObjectURL(url!)!.text();
const settle = () => new Promise((resolve) => setTimeout(resolve));

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("draws each source once per theme, as an SVG object URL", async () => {
	const { diagrams, worker } = setup();
	const first = diagrams.url("graph TD\nA-->B", light);
	await settle();
	expect(worker().posted).toEqual([{ diagram: 1, source: "graph TD\nA-->B", colors: light }]);
	worker().draw("<svg>light</svg>");
	const url = await first;
	expect(url).toMatch(/^blob:/);
	expect(await svgOf(url)).toBe("<svg>light</svg>");
	expect(resolveObjectURL(url!)!.type).toBe("image/svg+xml");

	expect(await diagrams.url("graph TD\nA-->B", light)).toBe(url);
	const other = diagrams.url("graph TD\nA-->B", dark);
	await settle();
	expect(worker().posted).toHaveLength(2);
	worker().draw("<svg>dark</svg>");
	expect(await svgOf(await other)).toBe("<svg>dark</svg>");
});

it("remembers a source that cannot be drawn, and does not send one that is too long", async () => {
	const { diagrams, workers, worker } = setup();
	const pie = diagrams.url("pie\n  a: 1", light);
	await settle();
	worker().draw(null);
	expect(await pie).toBeNull();
	expect(await diagrams.url("pie\n  a: 1", light)).toBeNull();
	expect(worker().posted).toHaveLength(1);

	expect(await diagrams.url("x".repeat(MAX_DIAGRAM_CHARS + 1), light)).toBeNull();
	expect(workers.flatMap((each) => each.posted)).toHaveLength(1);
});

it("renders one at a time, and ignores replies that are not the current render's", async () => {
	const { diagrams, worker } = setup();
	const a = diagrams.url("A", light);
	const b = diagrams.url("B", light);
	await settle();
	expect(worker().posted.map((request) => request.source)).toEqual(["A"]);
	// Foreign replies, and stale ones, carry no or another ID.
	worker().reply({ id: 0, error: "x" });
	worker().reply({ diagram: 2, svg: "<svg>wrong</svg>" });
	worker().reply(null);
	worker().ready();
	expect(worker().posted).toHaveLength(1);
	worker().draw("<svg>A</svg>");
	expect(await svgOf(await a)).toBe("<svg>A</svg>");
	expect(worker().posted.map((request) => request.source)).toEqual(["A", "B"]);
	worker().draw("<svg>B</svg>");
	expect(await svgOf(await b)).toBe("<svg>B</svg>");
});

it("ends a render that runs too long, and starts a new worker for the next", async () => {
	vi.useFakeTimers();
	const { diagrams, workers } = setup(3000, true);
	const slow = diagrams.url("slow", light);
	const next = diagrams.url("next", light);
	// Starting does not count: the limit runs from "ready".
	vi.advanceTimersByTime(START_MS - 1);
	expect(workers[0]!.posted).toEqual([]);
	workers[0]!.ready();
	expect(workers[0]!.posted.map((request) => request.source)).toEqual(["slow"]);
	vi.advanceTimersByTime(2999);
	expect(workers[0]!.terminated).toBe(false);
	vi.advanceTimersByTime(1);
	expect(await slow).toBeNull();
	expect(workers[0]!.terminated).toBe(true);
	// A late reply from the ended worker changes nothing.
	workers[0]!.reply({ diagram: 1, svg: "<svg>late</svg>" });
	workers[1]!.ready();
	expect(workers[1]!.posted.map((request) => request.source)).toEqual(["next"]);
	workers[1]!.draw("<svg>next</svg>");
	expect(await svgOf(await next)).toBe("<svg>next</svg>");
	expect(await diagrams.url("slow", light)).toBeNull();
});

it("ends a worker that does not start", async () => {
	vi.useFakeTimers();
	const { diagrams, workers } = setup(3000, true);
	const stuck = diagrams.url("A", light);
	vi.advanceTimersByTime(START_MS);
	expect(await stuck).toBeNull();
	expect(workers[0]!.terminated).toBe(true);
	const next = diagrams.url("B", light);
	workers[1]!.ready();
	workers[1]!.draw("<svg>B</svg>");
	expect(await svgOf(await next)).toBe("<svg>B</svg>");
});

it("gives no picture when the worker breaks or cannot start", async () => {
	const { diagrams, workers } = setup();
	const broken = diagrams.url("A", light);
	await settle();
	workers[0]!.dispatchEvent(new Event("error"));
	expect(await broken).toBeNull();
	expect(workers[0]!.terminated).toBe(true);

	const failing = new Diagrams(() => {
		throw new Error("blocked");
	});
	expect(await failing.url("A", light)).toBeNull();
	expect(await failing.url("B", light)).toBeNull();
});

it("frees every picture on drop, and makes none for renders started before it", async () => {
	const revoke = vi.spyOn(URL, "revokeObjectURL");
	const { diagrams, worker } = setup();
	const a = diagrams.url("A", light);
	await settle();
	worker().draw("<svg>A</svg>");
	const url = await a;
	const b = diagrams.url("B", light);
	const c = diagrams.url("C", light);
	diagrams.drop();
	expect(await c).toBeNull();
	worker().draw("<svg>B</svg>");
	expect(await b).toBeNull();
	await Promise.resolve();
	expect(revoke).toHaveBeenCalledWith(url);
	expect(resolveObjectURL(url!)).toBeUndefined();

	const again = diagrams.url("A", light);
	await settle();
	worker().draw("<svg>A2</svg>");
	expect(await svgOf(await again)).toBe("<svg>A2</svg>");
});

it("keeps at most 100 pictures, freeing the oldest", async () => {
	const revoke = vi.spyOn(URL, "revokeObjectURL");
	const { diagrams, worker } = setup();
	const urls: (string | null)[] = [];
	for (let n = 0; n <= 100; n++) {
		const url = diagrams.url(`D${n}`, light);
		await settle();
		worker().draw(`<svg>${n}</svg>`);
		urls.push(await url);
	}
	await Promise.resolve();
	expect(revoke.mock.calls).toEqual([[urls[0]]]);
	expect(await diagrams.url("D100", light)).toBe(urls[100]);
});
