// What screenshot_page computes on its own (design 6.26): the crop of an element, its place in the image, the images a
// request carries, the capture queue, and the tab events that drop a capture.

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { Located } from "../src/background/page-agent.ts";
import {
	CaptureQueue,
	cropOf,
	dataBytes,
	imageRect,
	imagesIn,
	sameView,
	tabChangeCount,
	watchTab,
	watchTabs,
} from "../src/background/screenshot.ts";
import { base64 } from "../src/shared/images.ts";

const context = BACKGROUND_CONTEXT;

/** An element at `box` in a 1280 × 800 view whose vertical scrollbar takes 15 px. */
const at = (box: Located["box"], change: Partial<Located> = {}): Located => ({
	box,
	clip: { x: 0, y: 0, width: 1265, height: 800 },
	innerWidth: 1280,
	innerHeight: 800,
	scrollX: 0,
	scrollY: 0,
	scale: 1,
	role: "button",
	name: "Save",
	...change,
});

it("crops the element padded by 8 px, cut to where it can show; clipped says which part is outside, shown its rows", () => {
	expect(cropOf(at({ x: 100, y: 100, width: 200, height: 50 }))).toEqual({
		crop: { x: 92, y: 92, width: 216, height: 66, viewWidth: 1280, viewHeight: 800 },
		clipped: false,
		shown: { from: 0, to: 50, of: 50 },
	});
	// Within 8 px of an edge: the padding is cut, the element is whole.
	expect(cropOf(at({ x: 4, y: 4, width: 50, height: 20 }))).toMatchObject({
		crop: { x: 0, y: 0, width: 62, height: 32 },
		clipped: false,
	});
	const sides = [
		{ x: -20, y: 100, width: 100, height: 50 },
		{ x: 100, y: -20, width: 100, height: 50 },
		// Under the scrollbar on the right.
		{ x: 1200, y: 100, width: 100, height: 50 },
		{ x: 100, y: 780, width: 100, height: 50 },
	];
	const view = { viewWidth: 1280, viewHeight: 800 };
	expect(sides.map((box) => cropOf(at(box)))).toEqual([
		{ crop: { x: 0, y: 92, width: 88, height: 66, ...view }, clipped: true, shown: { from: 0, to: 50, of: 50 } },
		{ crop: { x: 92, y: 0, width: 116, height: 38, ...view }, clipped: true, shown: { from: 20, to: 50, of: 50 } },
		{ crop: { x: 1192, y: 92, width: 73, height: 66, ...view }, clipped: true, shown: { from: 0, to: 50, of: 50 } },
		{ crop: { x: 92, y: 772, width: 116, height: 28, ...view }, clipped: true, shown: { from: 0, to: 20, of: 50 } },
	]);
	// Larger than the view: all of the view, clipped; rows 10 to 810 of 3000.
	expect(cropOf(at({ x: -10, y: -10, width: 3000, height: 3000 }))).toMatchObject({
		crop: { x: 0, y: 0, width: 1265, height: 800 },
		clipped: true,
		shown: { from: 10, to: 810, of: 3000 },
	});
});

it("an element outside the view or its scrolled list, or under a pinch zoom, is not cropped", () => {
	expect(cropOf(at({ x: 100, y: 1800, width: 200, height: 50 }))).toBe("out of view");
	expect(cropOf(at({ x: 100, y: -60, width: 200, height: 50 }))).toBe("out of view");
	// Only the padding would show.
	expect(cropOf(at({ x: 100, y: 805, width: 200, height: 50 }))).toBe("out of view");
	// Below the visible part of a list that scrolls, though within the view.
	const list = { x: 0, y: 100, width: 600, height: 300 };
	expect(cropOf(at({ x: 10, y: 420, width: 200, height: 30 }, { clip: list }))).toBe("out of view");
	expect(cropOf(at({ x: 10, y: 380, width: 200, height: 30 }, { clip: list }))).toEqual({
		crop: { x: 2, y: 372, width: 216, height: 28, viewWidth: 1280, viewHeight: 800 },
		clipped: true,
		shown: { from: 0, to: 20, of: 30 },
	});
	expect(cropOf(at({ x: 100, y: 100, width: 200, height: 50 }, { scale: 2 }))).toBe("pinch");
});

it("maps a crop onto the image by its size against the view: page zoom and the pixel ratio, rounded outwards", () => {
	const crop = { x: 92, y: 92, width: 216, height: 66, viewWidth: 1280, viewHeight: 800 };
	expect(imageRect(crop, 1280, 800)).toEqual({ x: 92, y: 92, width: 216, height: 66 });
	// Device pixel ratio 2.
	expect(imageRect(crop, 2560, 1600)).toEqual({ x: 184, y: 184, width: 432, height: 132 });
	// Page zoom 150%: the view is 853 CSS px wide in an image of 1280.
	expect(
		imageRect({ x: 10.3, y: 20.6, width: 100, height: 50, viewWidth: 853.3333, viewHeight: 533.3333 }, 1280, 800),
	).toEqual({
		x: 15,
		y: 30,
		width: 151,
		height: 76,
	});
	// Never outside the image, never empty.
	expect(imageRect({ x: 1270, y: 790, width: 50, height: 50, viewWidth: 1280, viewHeight: 800 }, 1280, 800)).toEqual({
		x: 1270,
		y: 790,
		width: 10,
		height: 10,
	});
});

it("a change of the element's box, the clip, the view, the scroll position, or the scale is a move", () => {
	const before = at({ x: 100, y: 100, width: 200, height: 50 });
	expect(sameView(before, { ...before, role: "link" })).toBe(true);
	const moved: Partial<Located>[] = [
		{ box: { ...before.box, x: 700 } },
		{ clip: { ...before.clip, height: 400 } },
		{ innerWidth: 1000 },
		{ innerHeight: 600 },
		{ scrollX: 5 },
		{ scrollY: 300 },
		{ scale: 1.5 },
	];
	expect(moved.map((change) => sameView(before, { ...before, ...change }))).toEqual(moved.map(() => false));
});

it("counts the images of a request and their base64 characters", () => {
	const messages = [
		{ role: "user", content: "Hi", timestamp: 0 },
		{
			role: "user",
			content: [
				{ type: "text", text: "Look" },
				{ type: "image", data: "abcd", mimeType: "image/png" },
			],
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "screenshot_page",
			content: [
				{ type: "image", data: "abcdefgh", mimeType: "image/jpeg" },
				{ type: "text", text: "{}" },
			],
			isError: false,
			timestamp: 0,
		},
	] as Message[];
	expect(imagesIn(messages)).toEqual({ count: 2, bytes: 12 });
	expect(imagesIn([])).toEqual({ count: 0, bytes: 0 });
});

/** A clock whose waits pass at once, and the waits. */
function fakeClock() {
	const clock = { now: 0, sleeps: [] as number[] };
	const queue = new CaptureQueue({
		now: () => clock.now,
		async sleep(ms, signal) {
			signal?.throwIfAborted();
			clock.sleeps.push(ms);
			clock.now += ms;
		},
	});
	return { clock, queue };
}

it("the queue runs captures one at a time, each a gap after the previous one ended; a failure does not stop it", async () => {
	const { clock, queue } = fakeClock();
	const order: string[] = [];
	const held = Promise.withResolvers<void>();
	const first = queue.run(
		async () => {
			order.push("first");
			await held.promise;
			clock.now += 40;
			throw new Error("Chrome failed");
		},
		context,
		500,
	);
	const second = queue.run(async () => order.push("second"), context, 500);
	const third = queue.run(async () => order.push("third"), context, 1000);
	await Promise.resolve();
	expect(order).toEqual(["first"]);
	held.resolve();
	await expect(first).rejects.toThrow("Chrome failed");
	await second;
	await third;
	expect(order).toEqual(["first", "second", "third"]);
	// From the end of the previous capture.
	expect(clock.sleeps).toEqual([500, 1000]);
});

it("a call stopped while it waits leaves the queue at once, and its turn passes without a capture", async () => {
	const { queue } = fakeClock();
	const held = Promise.withResolvers<void>();
	const ran: string[] = [];
	const first = queue.run(
		async () => {
			ran.push("first");
			await held.promise;
		},
		context,
		500,
	);
	const stop = new AbortController();
	const scope = withAbortSignal(stop.signal, context);
	const stopped = queue.run(async () => ran.push("stopped"), scope, 500);
	const third = queue.run(async () => ran.push("third"), context, 500);
	stop.abort(new Error("Stopped"));
	await expect(stopped).rejects.toThrow("Stopped");
	held.resolve();
	await first;
	await third;
	expect(ran).toEqual(["first", "third"]);
});

it("counts tab activations, moves, and replacements, and navigations of a tab being captured only", () => {
	type Listener = (...args: unknown[]) => void;
	const listeners: Record<string, Listener[]> = {};
	const event = (name: string) => ({
		addListener: (listener: Listener) => {
			listeners[name] = [...(listeners[name] ?? []), listener];
		},
	});
	const fire = (name: string, ...args: unknown[]) => {
		for (const listener of listeners[name] ?? []) listener(...args);
	};
	const names = ["onActivated", "onAttached", "onDetached", "onReplaced", "onUpdated"];
	(globalThis as unknown as { chrome: unknown }).chrome = {
		tabs: Object.fromEntries(names.map((name) => [name, event(name)])),
	};
	try {
		watchTabs();
		const start = tabChangeCount();
		for (const name of ["onActivated", "onAttached", "onDetached", "onReplaced"]) fire(name, {});
		expect(tabChangeCount() - start).toBe(4);

		const counted = tabChangeCount();
		// No capture runs: updates do not count.
		fire("onUpdated", 1, { url: "https://a.test/2" });
		const unwatch = watchTab(1);
		const again = watchTab(1);
		// Another tab, or an update that is not a navigation.
		fire("onUpdated", 2, { url: "https://a.test/2" });
		fire("onUpdated", 1, { title: "New title" });
		fire("onUpdated", 1, { status: "complete" });
		expect(tabChangeCount()).toBe(counted);
		fire("onUpdated", 1, { status: "loading" });
		fire("onUpdated", 1, { url: "https://a.test/3" });
		expect(tabChangeCount()).toBe(counted + 2);
		// Counted while either capture of the tab runs.
		unwatch();
		unwatch();
		fire("onUpdated", 1, { status: "loading" });
		expect(tabChangeCount()).toBe(counted + 3);
		again();
		fire("onUpdated", 1, { status: "loading" });
		expect(tabChangeCount()).toBe(counted + 3);
	} finally {
		delete (globalThis as unknown as { chrome?: unknown }).chrome;
	}
});

it("decodes a data: URL and encodes bytes as base64, also past one chunk", () => {
	const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);
	const encoded = base64(bytes);
	expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
	expect(dataBytes(`data:image/png;base64,${encoded}`)).toEqual(bytes);
});
