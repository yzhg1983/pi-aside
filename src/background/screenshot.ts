// What screenshot_page needs besides the page tools' own checks (design 6.26): the crop of an element, the images a
// chat already sends, the worker-wide queue of captures, and the count of tab changes that guards each capture.

import type { Context } from "@earendil-works/chord/context";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { InboxState, UserInput } from "@earendil-works/pi-durable";
import type { Located, Rect } from "./page-agent.ts";

/** Around the element, in CSS pixels. */
const PAD = 8;
/** Chrome allows 2 captures a second: one starts at least this long after the previous one ended. */
export const CAPTURE_GAP_MS = 500;
/** After Chrome's quota error, the one retry waits this long. */
export const RETRY_GAP_MS = 1_000;

/** What to cut from the view, in CSS pixels, and the view's size, which the image's size is mapped from. */
export type Crop = Rect & { viewWidth: number; viewHeight: number };

/** The element's rows in the image, in CSS pixels from its top: `from` to `to` of its height `of`. */
export type Rows = { from: number; to: number; of: number };

/**
 * The part of the view to capture for the element at `at`: its box padded by `PAD`, cut to where it can show. `clipped`:
 * part of the element is outside that, on any side; `shown`: its rows in it. A string when there is nothing to capture.
 */
export function cropOf(at: Located): { crop: Crop; clipped: boolean; shown: Rows } | "pinch" | "out of view" {
	if (at.scale !== 1) return "pinch";
	const { box, clip } = at;
	const [right, bottom] = [clip.x + clip.width, clip.y + clip.height];
	const shown = {
		left: Math.max(box.x, clip.x),
		top: Math.max(box.y, clip.y),
		right: Math.min(box.x + box.width, right),
		bottom: Math.min(box.y + box.height, bottom),
	};
	if (shown.right <= shown.left || shown.bottom <= shown.top) return "out of view";
	const x = Math.max(box.x - PAD, clip.x);
	const y = Math.max(box.y - PAD, clip.y);
	return {
		crop: {
			x,
			y,
			width: Math.min(box.x + box.width + PAD, right) - x,
			height: Math.min(box.y + box.height + PAD, bottom) - y,
			viewWidth: at.innerWidth,
			viewHeight: at.innerHeight,
		},
		clipped: box.x < clip.x || box.y < clip.y || box.x + box.width > right || box.y + box.height > bottom,
		shown: {
			from: Math.round(shown.top - box.y),
			to: Math.round(shown.bottom - box.y),
			of: Math.round(box.height),
		},
	};
}

/**
 * `crop` in the pixels of an image of the view `width` by `height`: page zoom and the device's pixel ratio both show in
 * the image's size against the view's. Rounded outwards, within the image.
 */
export function imageRect(crop: Crop, width: number, height: number): Rect {
	const [sx, sy] = [width / crop.viewWidth, height / crop.viewHeight];
	const left = Math.max(0, Math.floor(crop.x * sx));
	const top = Math.max(0, Math.floor(crop.y * sy));
	const right = Math.min(width, Math.ceil((crop.x + crop.width) * sx));
	const bottom = Math.min(height, Math.ceil((crop.y + crop.height) * sy));
	return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Whether the element, the view, and its scroll position are where they were. */
export function sameView(a: Located, b: Located): boolean {
	const rects = (["box", "clip"] as const).every((key) =>
		(["x", "y", "width", "height"] as const).every((side) => a[key][side] === b[key][side]),
	);
	return (
		rects && (["innerWidth", "innerHeight", "scrollX", "scrollY", "scale"] as const).every((key) => a[key] === b[key])
	);
}

/** The images of a message's content and their base64 characters. */
function contentImages(content: Message["content"] | string, into: { count: number; bytes: number }): void {
	if (typeof content === "string") return;
	for (const block of content)
		if (block.type === "image") {
			into.count += 1;
			into.bytes += block.data.length;
		}
}

/** The images of a request and their base64 characters. */
export function imagesIn(messages: readonly Message[]): { count: number; bytes: number } {
	const found = { count: 0, bytes: 0 };
	for (const message of messages) contentImages(message.content, found);
	return found;
}

/**
 * The images a chat's requests carry once its queued inputs are in: those of its inputs in `inbox`, read first, then
 * those of its context, `messages`. An input that moves from the inbox into the context between the two reads counts
 * twice, never not at all (design 6.42).
 */
export function chatImages(
	inbox: InboxState | undefined,
	messages: readonly Message[],
): { count: number; bytes: number } {
	const found = imagesIn(messages);
	for (const item of inbox?.items ?? []) if (item.mode !== "write") contentImages(item.content as UserInput, found);
	return found;
}

export type Clock = { now(): number; sleep(ms: number, signal: AbortSignal | undefined): Promise<void> };

const realClock: Clock = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise((resolve, reject) => {
			signal?.throwIfAborted();
			const stop = () => {
				clearTimeout(timer);
				reject(signal?.reason);
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", stop);
				resolve();
			}, ms);
			signal?.addEventListener("abort", stop, { once: true });
		}),
};

/**
 * The worker's captures, from any chat, one at a time (design 6.26): each starts at least a gap after the previous one
 * ended. A call stopped while it waits leaves at once, and its turn passes; one that fails does not stop the next.
 */
export class CaptureQueue {
	#chain: Promise<unknown> = Promise.resolve();
	#last = Number.NEGATIVE_INFINITY;
	readonly #clock: Clock;

	constructor(clock: Clock = realClock) {
		this.#clock = clock;
	}

	run<T>(attempt: () => Promise<T>, context: Context, gapMs: number): Promise<T> {
		const signal = context.abortSignal;
		const turn = this.#chain.then(async () => {
			signal?.throwIfAborted();
			const wait = this.#last + gapMs - this.#clock.now();
			if (wait > 0) await this.#clock.sleep(wait, signal);
			signal?.throwIfAborted();
			try {
				return await attempt();
			} finally {
				this.#last = this.#clock.now();
			}
		});
		this.#chain = turn.catch(() => {});
		return awaitWithContext(turn, context);
	}
}

/** Tab events counted from the worker's start (design 6.26); a capture is dropped if the count changed during it. */
let tabChanges = 0;
/** The tabs being captured, and how many captures of each run. */
const capturing = new Map<number, number>();

/**
 * Counts the events that can change what a window shows: a tab activated, moved between windows, or replaced, and a
 * navigation of a tab being captured. Called once, at the worker's start; these need no permission.
 */
export function watchTabs(): void {
	const count = () => {
		tabChanges += 1;
	};
	chrome.tabs.onActivated.addListener(count);
	chrome.tabs.onAttached.addListener(count);
	chrome.tabs.onDetached.addListener(count);
	chrome.tabs.onReplaced.addListener(count);
	// A tab in the background is not in the image: other tabs' updates do not count.
	chrome.tabs.onUpdated.addListener((tabId, change) => {
		if (capturing.has(tabId) && (change.url !== undefined || change.status === "loading")) count();
	});
}

export const tabChangeCount = () => tabChanges;

/** Counts the navigations of `tabId` too, until the function it returns is called. */
export function watchTab(tabId: number): () => void {
	capturing.set(tabId, (capturing.get(tabId) ?? 0) + 1);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		const left = (capturing.get(tabId) ?? 1) - 1;
		if (left > 0) capturing.set(tabId, left);
		else capturing.delete(tabId);
	};
}

/** The bytes of a `data:` URL's base64. */
export function dataBytes(url: string): Uint8Array<ArrayBuffer> {
	const binary = atob(url.slice(url.indexOf(",") + 1));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
