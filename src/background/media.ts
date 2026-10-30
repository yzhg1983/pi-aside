// Plays a link to a time in the tab's own page (design 6.38): the panel's click on `…&t=754s` moves the tab's video.
// Also what wait_on_page reads of the page's media (design 6.40). Both choose the medium the same way: keep them in step.

import { timeInPage } from "../shared/media-link.ts";

/**
 * Moves the media of tab `tabId` to the time of `href`, if `href` links to the page the tab shows. Returns false when
 * it does not, when pi cannot reach the page (no access to its site: the tab has no `url` then), or when the page has
 * no video or audio; the panel then opens the link in a new tab.
 */
export async function playAt(tabId: number, href: string): Promise<boolean> {
	const tab = await chrome.tabs.get(tabId);
	const seconds = tab.url === undefined ? null : timeInPage(href, tab.url);
	if (seconds === null) return false;
	try {
		const [injection] = await chrome.scripting.executeScript({
			target: { tabId, frameIds: [0] },
			func: seekMedia,
			args: [seconds, tab.url!],
		});
		return injection?.result === true;
	} catch {
		return false;
	}
}

/**
 * In the page, in pi's isolated world: the playing medium, else the largest video, else the first audio (as
 * `mediaState`), to `seconds`, then plays it. Nothing if the page is no longer `pageUrl`. Self-contained, since Chrome serializes it.
 */
function seekMedia(seconds: number, pageUrl: string): boolean {
	if (location.href !== pageUrl) return false;
	const media = [...document.querySelectorAll<HTMLMediaElement>("video, audio")];
	const area = (medium: HTMLMediaElement) =>
		medium instanceof HTMLVideoElement ? medium.clientWidth * medium.clientHeight : 0;
	const medium = media.find((each) => !each.paused) ?? media.sort((a, b) => area(b) - area(a))[0];
	if (medium === undefined) return false;
	medium.currentTime = seconds;
	// A page the user has not interacted with may refuse to play; the time is set either way.
	medium.play().catch(() => {});
	return true;
}

/** The medium a wait follows, as the page reports it; `found` false when it has none, or the one it had is gone. */
export type MediaState =
	| { url: string; found: false; gone: boolean }
	| {
			url: string;
			found: true;
			position: number;
			/** Null while unknown, and for a live stream. */
			duration: number | null;
			paused: boolean;
			ended: boolean;
			/** How long it has been paused without a break, in seconds; 0 while it plays. */
			pausedSec: number;
	  };

/**
 * In the page, in pi's isolated world, whose globals last as long as the document and the extension: the medium of wait
 * `key`, chosen at its first check as `seekMedia` chooses one and kept by reference, so a wait never moves to another
 * medium; `gone` once that one leaves the page. Its pause is timed from its own `pause` and `play` events, which pi
 * listens to from the first check on, so a pause that spans several waits, or a restart of pi's worker, counts whole.
 * Self-contained, since Chrome serializes it.
 */
export function mediaState(key: string, maxUrl: number): MediaState {
	const url = location.href.slice(0, maxUrl);
	type Pause = { since: number | null };
	type Store = { waits: Map<string, WeakRef<HTMLMediaElement> | null>; pauses: WeakMap<HTMLMediaElement, Pause> };
	const holder = globalThis as { piMedia?: Store };
	holder.piMedia ??= { waits: new Map(), pauses: new WeakMap() };
	const store = holder.piMedia;
	if (!store.waits.has(key)) {
		const media = [...document.querySelectorAll<HTMLMediaElement>("video, audio")];
		const area = (medium: HTMLMediaElement) =>
			medium instanceof HTMLVideoElement ? medium.clientWidth * medium.clientHeight : 0;
		const chosen = media.find((each) => !each.paused) ?? media.sort((a, b) => area(b) - area(a))[0];
		store.waits.set(key, chosen === undefined ? null : new WeakRef(chosen));
	}
	const kept = store.waits.get(key);
	const medium = kept?.deref();
	if (medium === undefined || !medium.isConnected) return { url, found: false, gone: kept !== null };
	let pause = store.pauses.get(medium);
	if (pause === undefined) {
		const noted: Pause = { since: medium.paused ? Date.now() : null };
		medium.addEventListener("pause", () => {
			noted.since = Date.now();
		});
		medium.addEventListener("play", () => {
			noted.since = null;
		});
		store.pauses.set(medium, noted);
		pause = noted;
	}
	return {
		url,
		found: true,
		position: medium.currentTime,
		duration: Number.isFinite(medium.duration) ? medium.duration : null,
		paused: medium.paused,
		ended: medium.ended,
		pausedSec: medium.paused && pause.since !== null ? (Date.now() - pause.since) / 1000 : 0,
	};
}
