// wait_on_page (design 6.40) on a fake tab: what ends a wait, a timeout that is not an error, the checks before each
// poll (Off, a changed page, a medium that left), Stop, and a rerun after a restart that keeps the first run's page and
// deadline.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, it, vi } from "vitest";
import { ChatsDoc, type Input } from "../src/background/chats.ts";
import { WAIT_ON_PAGE } from "../src/background/page.ts";
import { pageExtension } from "../src/background/page-tools.ts";
import { MESSAGE_KIND } from "../src/background/projection.ts";
import type { PageRef } from "../src/shared/protocol.ts";
import { ALL_ON, pageDeps } from "./fixtures/page-deps.ts";
import { memoryStore, openChats, panel } from "./fixtures/tabs.ts";
import { waitPage } from "./fixtures/wait-page.ts";

const context = BACKGROUND_CONTEXT;

const open: Harness[] = [];
afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context).catch(() => {});
});

const attached: PageRef = {
	tabId: 1,
	frameId: 0,
	documentId: "doc1",
	url: "https://video.test/watch?v=one",
	title: "Video",
	capturedAt: 0,
};

const input = (requestId: string): Input => ({
	requestId,
	content: `Wait\n\n[Attached page: "Video" (${attached.url})]`,
	entry: { kind: MESSAGE_KIND, data: { text: "Wait", page: attached } },
});

type Seen = { isError: boolean; text: string };

async function setup(options: { path?: string; resume?: false; start?: number } = {}) {
	const fake = waitPage(options.start ?? 1_000_000);
	const config = { current: ALL_ON };
	const { deps, attach } = pageDeps(fake.access, config);
	const registry = createRegistry();
	registry.install(pageExtension(deps, config.current));
	const faux = fauxProvider({ provider: "openrouter", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const path = options.path ?? join(mkdtempSync(join(tmpdir(), "pi-aside-wait-")), "session.sqlite");
	const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
	open.push(harness);
	attach(harness);
	const { chats, tabs } = await openChats(
		harness,
		{ store: memoryStore().store, open: new Set([1]) },
		{
			admit: (operation) => operation(),
			check: async () => {},
			imageLimit: async () => 20,
			defaultModel: async () => ({ provider: "openrouter", modelId: "one" }),
			setDefaultModel: async () => {},
			thinking: async () => "off",
			changed: () => {},
		},
	);
	if (options.resume !== false) harness.resume();
	await tabs.load();
	const tab = panel(chats, tabs, 1);
	const seen: Seen[] = [];
	const step =
		(message: AssistantMessage) =>
		(transcript: TranscriptContext): AssistantMessage => {
			const last = transcript.messages.at(-1);
			if (last?.role === "toolResult") {
				const text = last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
				seen.push({ isError: last.isError, text });
			}
			return message;
		};
	const wait = (args: JsonObject) =>
		step(fauxAssistantMessage(fauxToolCall(WAIT_ON_PAGE, args), { stopReason: "toolUse" }));
	const answer = () => step(fauxAssistantMessage("done"));
	const idle = () => vi.waitFor(() => expect(tab.chat.busy).toBe(false), 5000);
	/** Runs one wait to its result. */
	const run = async (args: JsonObject, requestId = `r${seen.length}`) => {
		faux.setResponses([wait(args), answer()]);
		await tab.send(input(requestId));
		await idle();
		return seen.at(-1)!;
	};
	return { ...fake, harness, tab, faux, config, seen, wait, answer, idle, run };
}

const json = (seen: Seen) => JSON.parse(seen.text) as Record<string, unknown>;

it("returns when the position leaves the range, when the medium ends, or after a long pause; a timeout is no error", async () => {
	const { page, calls, run } = await setup();
	const positions = [100, 120, 130, 200];
	page.media = () => ({
		position: positions.shift() ?? 200,
		duration: 600,
		paused: false,
		ended: false,
		pausedSec: 0,
	});
	let seen = await run({ until: { media: { from: 90, to: 150 } } });
	expect(seen.isError).toBe(false);
	expect(json(seen)).toMatchObject({ met: true, reason: "after", position: 200, paused: false, pausedSec: 0 });
	expect(calls.media).toHaveLength(4);

	page.media = () => ({ position: 50, duration: 600, paused: false, ended: false, pausedSec: 0 });
	expect(json(await run({ until: { media: { from: 90, to: 150 } } }))).toMatchObject({ met: true, reason: "before" });

	page.media = () => ({ position: 120, duration: 120, paused: true, ended: true, pausedSec: 0 });
	expect(json(await run({ until: { media: { from: 0, to: 600 } } }))).toMatchObject({ met: true, reason: "ended" });

	const paused = [1700, 1799, 1800];
	page.media = () => ({ position: 120, duration: 600, paused: true, ended: false, pausedSec: paused.shift() ?? 1800 });
	expect(json(await run({ until: { media: { from: 0, to: 600, pausedSec: 1800 } } }))).toMatchObject({
		met: true,
		reason: "paused",
		pausedSec: 1800,
	});

	// Each check moves the clock on by 1 s: a 5 s wait ends after about five checks, and the result says so.
	page.media = () => ({ position: 120, duration: 600, paused: false, ended: false, pausedSec: 0 });
	seen = await run({ until: { media: { from: 0, to: 600 } }, timeoutSec: 5 });
	expect(seen.isError).toBe(false);
	expect(json(seen)).toMatchObject({ met: false, reason: "timeout", position: 120 });
	expect(json(seen).waitedSec).toBeGreaterThanOrEqual(5);
});

it("waits for a text to show or to go, as the page's readable text has it", async () => {
	const { page, calls, run } = await setup();
	// The third check finds it, with other case and spacing.
	Object.defineProperty(page, "text", {
		get: () => (calls.text >= 3 ? "Export   COMPLETE: 3 files" : "Exporting…"),
		configurable: true,
	});
	expect(json(await run({ until: { text: "export complete" } }))).toMatchObject({ met: true, reason: "present" });
	expect(calls.text).toBe(3);
	expect(json(await run({ until: { text: "Exporting", present: false } }))).toMatchObject({
		met: true,
		reason: "absent",
	});
});

it("a read cut short never proves a text gone, but a text it found still shows", async () => {
	const { page, calls, run } = await setup();
	page.cut = true;
	const seen = await run({ until: { text: "Exporting", present: false }, timeoutSec: 5 });
	expect(seen.isError).toBe(false);
	expect(json(seen)).toMatchObject({ met: false, reason: "timeout" });
	expect(calls.text).toBeGreaterThanOrEqual(5);
	page.cut = false;
	expect(json(await run({ until: { text: "Exporting" } }))).toMatchObject({ met: true, reason: "present" });
});

it("refuses a wait with both conditions or none, or a range that ends before it starts", async () => {
	const { calls, run } = await setup();
	expect((await run({ until: {} })).text).toBe("Give exactly one of until.media and until.text.");
	expect((await run({ until: { text: "x", media: { from: 0, to: 1 } } })).isError).toBe(true);
	expect((await run({ until: { media: { from: 9, to: 1 } } })).text).toBe(
		"until.media.from must not be after until.media.to.",
	);
	expect(calls.media).toEqual([]);
});

it("ends with an error when the page reloads or moves, its medium leaves, or Read page is turned off", async () => {
	const { page, config, run } = await setup();
	const moving = (change: () => void) => {
		let checks = 0;
		page.media = () => {
			if (++checks === 2) change();
			return { position: 100, duration: 600, paused: false, ended: false, pausedSec: 0 };
		};
	};

	// A reload: the document is gone at the next check.
	moving(() => {
		page.documentId = "doc2";
	});
	let seen = await run({ until: { media: { from: 0, to: 600 } } });
	expect(seen).toEqual({
		isError: true,
		text: "The page changed during the wait: the tab now shows https://video.test/watch?v=one. Check the page and decide again.",
	});

	// Another video in the same document, as a single-page app moves on.
	page.documentId = "doc1";
	moving(() => {
		page.url = "https://video.test/watch?v=two";
	});
	seen = await run({ until: { media: { from: 0, to: 600 } } });
	expect(seen.text).toContain("the tab now shows https://video.test/watch?v=two");

	page.url = attached.url;
	moving(() => {
		page.mediumGone = true;
	});
	seen = await run({ until: { media: { from: 0, to: 600 } } });
	expect(seen.text).toBe("The video or audio the wait followed left the page; check the page and decide again.");

	page.mediumGone = false;
	page.media = null;
	expect((await run({ until: { media: { from: 0, to: 600 } } })).text).toBe(
		"The page has no video or audio to wait for.",
	);

	// Off during the wait: the next check is not sent.
	moving(() => {
		config.current = { ...ALL_ON, tools: { ...ALL_ON.tools, read: "off" } };
	});
	seen = await run({ until: { media: { from: 0, to: 600 } } });
	expect(seen).toEqual({ isError: true, text: "wait_on_page is turned off in pi's settings; do not call it." });
});

it("Stop ends a wait at once", async () => {
	const { page, calls, faux, tab, wait, idle } = await setup();
	page.media = () => ({ position: 100, duration: 600, paused: false, ended: false, pausedSec: 0 });
	faux.setResponses([wait({ until: { media: { from: 0, to: 600 } }, timeoutSec: 900 })]);
	await tab.send(input("r1"));
	await vi.waitFor(() => expect(calls.media.length).toBeGreaterThan(2));
	await tab.abort();
	await idle();
	expect(tab.chat.entries.at(-1)).toMatchObject({ role: "notice", error: expect.stringMatching(/aborted/) });
	const checks = calls.media.length;
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(calls.media.length).toBe(checks);
});

it("a wait that a restart cut off waits again for the same medium and page, until the first run's deadline", async () => {
	const fixture = fileURLToPath(new URL("fixtures/interrupted-wait.ts", import.meta.url));
	const restarted = async (change: (fake: Awaited<ReturnType<typeof setup>>) => void) => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-aside-wait-")), "session.sqlite");
		const child = spawnSync(process.execPath, [fixture, path, JSON.stringify(input("r1"))], { encoding: "utf8" });
		expect(child.status, child.stderr).toBe(0);
		// 400 s later: past the first run's 300 s deadline, which a fresh start would have set again.
		const fake = await setup({ path, resume: false, start: 1_400_000 });
		change(fake);
		fake.faux.setResponses([fake.answer()]);
		await fake.tab.openChat((await fake.harness.snapshot(ChatsDoc, context))!.chats[0]!.id);
		fake.harness.resume();
		await vi.waitFor(() => expect(fake.seen).toHaveLength(1));
		await fake.idle();
		return fake;
	};

	const same = await restarted(() => {});
	expect(same.seen[0]!.isError).toBe(false);
	expect(json(same.seen[0]!)).toMatchObject({ met: false, reason: "timeout" });
	expect(json(same.seen[0]!).waitedSec).toBeGreaterThanOrEqual(400);
	// The same wait, so the same medium in the page: its key is the call's.
	expect(new Set(same.calls.media).size).toBe(1);

	const reloaded = await restarted((fake) => {
		fake.page.documentId = "doc2";
	});
	expect(reloaded.seen[0]).toEqual({
		isError: true,
		text: "The page changed during the wait: the tab now shows https://video.test/watch?v=one. Check the page and decide again.",
	});
	expect(reloaded.calls.media).toEqual([]);
});
