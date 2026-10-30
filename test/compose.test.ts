import { expect, it } from "vitest";
import { attachedPage } from "../src/panel/compose.ts";
import type { AttachedPage, SelectionData } from "../src/shared/protocol.ts";

const page = (capturedAt: number): AttachedPage => ({
	tabId: 1,
	frameId: 0,
	documentId: "d",
	url: "https://b/",
	title: "B",
	capturedAt,
	key: "https://b/",
});

const quote = { selection: { text: "q", preset: "Explain", page: page(5) } satisfies SelectionData, page: null };

it("a message attaches the tab's page unless a quote names its own or the page was detached", () => {
	expect(attachedPage(page(10), undefined, null)).toEqual(page(10));
	expect(attachedPage(page(10), undefined, quote)).toBeNull();
	expect(attachedPage({ ...page(10), documentId: null }, undefined, null)).toBeNull();
	expect(attachedPage(page(10), 20, null)).toBeNull();
	// A newer gesture attaches again.
	expect(attachedPage(page(30), 20, null)).toEqual(page(30));
});

it("a page prompt's draft attaches its own page, not the tab's newer one, also after a detach", () => {
	const own = { ...page(5), documentId: "a", url: "https://a/" };
	expect(attachedPage(page(30), undefined, { selection: null, page: own })).toEqual(own);
	expect(attachedPage(page(30), 20, { selection: null, page: own })).toEqual(own);
	expect(attachedPage(null, undefined, { selection: null, page: own })).toEqual(own);
});

it("Send as plain text also covers a saved page that loads after the click", () => {
	// Draft A is shown while the window pages still load: no page yet. The user sends it as plain text at 100.
	const detachedAt = 100;
	expect(attachedPage(null, detachedAt, null)).toBeNull();
	// Page B, captured at 50 by an earlier gesture, finishes loading: it stays detached.
	expect(attachedPage(page(50), detachedAt, null)).toBeNull();
});
