// A fake tab for wait_on_page (design 6.40): one document whose URL, text, and medium a test changes, on a clock that
// each check moves on. Used by test/wait-on-page.test.ts and its child process, fixtures/interrupted-wait.ts.

import type { MediaState } from "../../src/background/media.ts";
import type { PageAccess } from "../../src/background/page.ts";
import { NO_AGENT } from "./page-deps.ts";

export type WaitPage = {
	documentId: string;
	url: string;
	text: string;
	/** The reader ran out of time, as on a very large page: it returns what it read so far. */
	cut: boolean;
	/** What the page's medium is like at each check; null: it has none. */
	media: (() => Omit<Extract<MediaState, { found: true }>, "url" | "found">) | null;
	/** The medium the wait followed left the page. */
	mediumGone: boolean;
};

export function waitPage(start: number) {
	const page: WaitPage = {
		documentId: "doc1",
		url: "https://video.test/watch?v=one",
		text: "Exporting…",
		cut: false,
		media: () => ({ position: 100, duration: 600, paused: false, ended: false, pausedSec: 0 }),
		mediumGone: false,
	};
	/** The clock: each check moves it on by `step` ms. */
	const time = { now: start, step: 1000 };
	const calls = { media: [] as string[], text: 0 };
	const gone = (documentId: string) => {
		if (documentId !== page.documentId) throw new Error(`No document with id ${documentId} in tab with id 1.`);
	};
	const access: PageAccess = {
		...NO_AGENT,
		async frames() {
			return [
				{ frameId: 0, documentId: page.documentId, url: page.url, origin: new URL(page.url).origin, shown: true },
			];
		},
		async text(_tabId, documentId) {
			gone(documentId);
			calls.text += 1;
			time.now += time.step;
			const text = page.cut ? "" : page.text;
			return { url: page.url, title: "Video", text, length: text.length, complete: !page.cut };
		},
		current: async (_tabId, documentId) => (documentId === page.documentId ? page.url : null),
		top: async () => ({
			documentId: page.documentId,
			url: page.url,
			origin: new URL(page.url).origin,
			title: "Video",
		}),
		async media(_tabId, documentId, key) {
			gone(documentId);
			calls.media.push(key);
			time.now += time.step;
			if (page.media === null || page.mediumGone) return { url: page.url, found: false, gone: page.mediumGone };
			return { url: page.url, found: true, ...page.media() };
		},
		now: () => time.now,
		pollMs: 1,
	};
	return { page, time, calls, access };
}
