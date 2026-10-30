// Real IndexedDB conformance and production-session storage checks. Uses a disposable Chrome profile and pi-ai's
// in-process faux provider. No accounts or network.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw new Error("Set CHROME to a Chrome for Testing 140+ executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-storage-"));
const ext = join(dir, "ext");
const profile = join(dir, "profile");
console.log("Artifacts:", dir);
mkdirSync(ext);
cpSync(join(repo, "static"), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
assert(!manifest.content_security_policy.extension_pages.includes("wasm-unsafe-eval"));
// Only this test extension has a fixed provider grant. All fetches are refused, including that provider's.
manifest.host_permissions = ["https://openrouter.ai/*"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, "\t"));
writeFileSync(join(ext, "lock.html"), "<!doctype html><title>Storage lock test</title>");
const entry = join(dir, "entry.mjs");
writeFileSync(
	entry,
	`import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { models } from ${JSON.stringify(join(repo, "src/background/models.ts"))};
import { session, currentSession, tabs } from ${JSON.stringify(join(repo, "src/background/session.ts"))};
import { ChatsDoc } from ${JSON.stringify(join(repo, "src/background/chats.ts"))};
import { PageReadsDoc } from ${JSON.stringify(join(repo, "src/background/page.ts"))};
import { loadSettings } from ${JSON.stringify(join(repo, "src/background/settings.ts"))};
import { runConformance } from ${JSON.stringify(join(repo, "src/background/conformance.ts"))};
const faux = fauxProvider({ provider: "openrouter", models: [{ id: "storage-test" }] });
models.setProvider(faux.provider);
globalThis.fetch = async () => { throw Error("Unexpected network request in storage test"); };
globalThis.__piStorageTest = {
  session, currentSession, loadSettings, conformance: runConformance,
  async open() {
    const { harness, boot } = await session();
    return { boot, tabs: [...tabs.entries()], history: (await harness.snapshot(ChatsDoc, context))?.chats ?? [] };
  },
  async close() { await currentSession()?.harness.close(context); },
  async send(tabId) {
    const { harness, chats } = await session();
    faux.setResponses([fauxAssistantMessage("persisted answer")]);
    await chats.send(tabId, 0, null, { requestId: "storage-smoke", content: "persisted question" }, null);
    const id = tabs.get(tabId).chat;
    await (await harness.conversation(id, context)).waitForIdle(context);
    await chats.attach(id);
    return { id, view: chats.view(id), calls: faux.state.callCount };
  },
  async ownership(id, tabId) {
    const { harness } = await session();
    const { browserSession } = await chrome.storage.session.get("browserSession");
    if (tabId !== undefined) await harness.commit(async tx => {
      const state = await tx.doc(PageReadsDoc, id);
      state.tabs = [tabId];
      state.tabsSession = browserSession;
    }, context);
    const state = await harness.snapshot(PageReadsDoc, id, context);
    return { ...state, browserSession, owned: state?.tabsSession === browserSession ? state.tabs : [] };
  },
  async view(id) {
    const { chats } = await session();
    await chats.attach(id);
    return { view: chats.view(id), calls: faux.state.callCount };
  }
};
chrome.runtime.onMessage.addListener((_message, _sender, reply) => { reply("awake"); });
`,
);
await build({
	absWorkingDir: repo,
	nodePaths: [join(repo, "node_modules")],
	entryPoints: [entry],
	outfile: join(dir, "native-background.js"),
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "chrome140",
	logLevel: "warning",
});
// The entry exposes session() but never calls it at startup: seed saved settings before the first open.
cpSync(join(dir, "native-background.js"), join(ext, "background.js"));

const saved = {
	credentials: { openrouter: { type: "api_key", key: "test-only-not-a-real-key" } },
	settings: {
		model: { provider: "openrouter", modelId: "storage-test" },
		language: "English",
		selectionAction: "compose",
		defaultPreset: "saved-prompt",
		prompts: [{ id: "saved-prompt", name: "Saved prompt", template: "Keep {{selection}} unchanged." }],
		tools: { read: "off", observe: "off", act: "off", script: "off", screenshot: "off" },
	},
};
let context;
let worker;
let id;
let checks = 0;
function check(name, condition) {
	assert(condition, name);
	checks += 1;
	console.log(`PASS ${name}`);
}
async function poll(test, name) {
	const end = Date.now() + 15_000;
	for (;;) {
		const result = await test();
		if (result) return result;
		if (Date.now() >= end) throw Error(`Timed out: ${name}`);
		await sleep(50);
	}
}
async function findWorker() {
	worker = await poll(
		() => context.serviceWorkers().find((candidate) => candidate.url().endsWith("/background.js")),
		"service worker",
	);
	id = new URL(worker.url()).host;
}
async function launch() {
	context = await chromium.launchPersistentContext(profile, {
		executablePath: process.env.CHROME,
		headless: false,
		args: [
			"--headless=new",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			"--host-resolver-rules=MAP * ~NOTFOUND",
			"--no-proxy-server",
		],
	});
	if (id !== undefined) {
		const page = await context.newPage();
		await page.goto(`chrome-extension://${id}/lock.html`);
		await page.evaluate(() => chrome.runtime.sendMessage("wake"));
		await page.close();
	}
	await findWorker();
}
async function open() {
	await poll(
		() => worker.evaluate(() => Boolean(globalThis.__piStorageTest)).catch(() => false),
		"storage test hooks",
	);
	return Promise.race([
		worker.evaluate(() => globalThis.__piStorageTest.open()),
		sleep(15_000, undefined, { ref: false }).then(() => {
			throw Error("Timed out: storage open");
		}),
	]);
}
const names = () => worker.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name));
const lockState = () => worker.evaluate(() => navigator.locks.query());
const ownsNative = (locks) => locks.held.filter(({ name }) => name === "pi-aside-indexeddb").length === 1;
const content = (view) => view.entries.map(({ text }) => text).join("\n");

try {
	await launch();
	const version = context.browser().version();
	console.log("Chrome:", version);
	assert(Number.parseInt(version, 10) >= 140, "Chrome 140+ is required.");
	await worker.evaluate(async (saved) => {
		await chrome.storage.local.set(saved);
		await chrome.storage.session.set({ tabs: { 99: { chat: 123, rev: 4 } } });
	}, saved);
	const permissions = await worker.evaluate(() => chrome.permissions.getAll());
	check("native storage has not opened before the first session", !(await names()).includes("pi-aside-indexeddb"));
	await context.close();
	context = undefined;
	await launch();
	const initial = await open();
	check("the first session opens a fresh native history", initial.boot === 1 && initial.history.length === 0);
	check("browser restart removes stale session bindings", initial.tabs.length === 0);
	check("the native database exists", (await names()).includes("pi-aside-indexeddb"));
	assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get(null)), saved);
	check("credentials, settings and prompts are unchanged", true);
	const settings = await worker.evaluate(() => globalThis.__piStorageTest.loadSettings());
	assert.deepEqual(settings.prompts, saved.settings.prompts);
	check("saved prompts remain usable", settings.selectionAction === "compose");
	assert.deepEqual(await worker.evaluate(() => chrome.permissions.getAll()), permissions);
	check("Chrome grants are unchanged", true);
	check("the Harness owns the native database lock", ownsNative(await lockState()));

	const cases = await worker.evaluate(() => globalThis.__piStorageTest.conformance());
	for (const result of cases)
		check(`conformance: ${result.name}${result.error ? `: ${result.error}` : ""}`, result.ok);
	check(
		"conformance ran and deleted all test databases",
		cases.length > 0 && !(await names()).some((name) => name.startsWith("conformance-")),
	);
	const tabId = await worker.evaluate(
		async () => (await chrome.tabs.create({ url: "about:blank", active: false })).id,
	);
	const sent = await worker.evaluate((tabId) => globalThis.__piStorageTest.send(tabId), tabId);
	check(
		"production Chats sends through the faux provider",
		sent.calls === 1 && content(sent.view).includes("persisted answer"),
	);

	// Seed ownership directly: this checks storage/session identity, not action attribution or close eligibility.
	const ownedTabId = await worker.evaluate(
		async () => (await chrome.tabs.create({ url: "about:blank", active: false })).id,
	);
	const ownership = await worker.evaluate(
		([id, tabId]) => globalThis.__piStorageTest.ownership(id, tabId),
		[sent.id, ownedTabId],
	);
	check(
		"opening ownership is stamped with a nonempty browser-session ID",
		typeof ownership.browserSession === "string" &&
			ownership.browserSession.length > 0 &&
			ownership.owned[0] === ownedTabId,
	);

	const page = await context.newPage();
	await page.goto(`chrome-extension://${id}/lock.html`);
	check(
		"a competing owner cannot take the lock",
		!(await page.evaluate(() =>
			navigator.locks.request("pi-aside-indexeddb", { ifAvailable: true }, (lock) => lock !== null),
		)),
	);
	await page.evaluate(() => {
		globalThis.lockRequest = navigator.locks.request("pi-aside-indexeddb", async () => {
			globalThis.gotLock = true;
			await new Promise((resolve) => {
				globalThis.releaseLock = resolve;
			});
		});
	});
	await poll(
		async () => (await lockState()).pending.some(({ name }) => name === "pi-aside-indexeddb"),
		"queued owner",
	);
	await worker.evaluate(() => globalThis.__piStorageTest.close());
	await poll(() => page.evaluate(() => globalThis.gotLock), "lock released after close");
	check("Harness close releases ownership to a waiting context", true);
	await worker.evaluate(() => {
		globalThis.reopening = globalThis.__piStorageTest.open();
	});
	await poll(
		() =>
			page.evaluate(async () =>
				(await navigator.locks.query()).pending.some(({ name }) => name === "pi-aside-indexeddb"),
			),
		"Harness waiting for ownership",
	);
	check(
		"reopen waits for ownership before publishing a Harness",
		await worker.evaluate(() => globalThis.__piStorageTest.currentSession() === undefined),
	);
	await page.evaluate(async () => {
		globalThis.releaseLock();
		await globalThis.lockRequest;
	});
	check(
		"reopen succeeds after the competing owner releases",
		(await worker.evaluate(() => globalThis.reopening)).boot === 2,
	);

	await worker.evaluate(() => globalThis.__piStorageTest.close());
	check("a closed session opens again in the same worker", (await open()).boot === 3);

	const oldWorker = worker;
	const cdp = await context.newCDPSession(page);
	const { targetInfos } = await cdp.send("Target.getTargets");
	const target = targetInfos.find(({ type, url }) => type === "service_worker" && url === oldWorker.url());
	assert(target, "service worker target exists");
	assert((await cdp.send("Target.closeTarget", { targetId: target.targetId })).success, "worker termination accepted");
	// Chrome may retain the DevTools target while replacing its execution context; test ownership and fresh heap.
	await poll(
		async () =>
			!(await page.evaluate(() => navigator.locks.query())).held.some(({ name }) => name === "pi-aside-indexeddb"),
		"worker lock released",
	);
	check("worker termination releases the database lock", true);
	await page.evaluate(() => chrome.runtime.sendMessage("wake"));
	await findWorker();
	check(
		"the restarted worker has no in-memory Harness",
		await worker.evaluate(() => globalThis.__piStorageTest.currentSession() === undefined),
	);
	const restarted = await open();
	check(
		"a new worker reacquires ownership and persisted boot state",
		restarted.boot === 4 && ownsNative(await lockState()),
	);
	const restored = await worker.evaluate((id) => globalThis.__piStorageTest.view(id), sent.id);
	check(
		"worker restart retains history without replaying inference",
		content(restored.view).includes("persisted question") &&
			content(restored.view).includes("persisted answer") &&
			restored.calls === 0,
	);
	const recoveredOwnership = await worker.evaluate((id) => globalThis.__piStorageTest.ownership(id), sent.id);
	check(
		"worker restart retains the ownership stamp and owned IDs",
		recoveredOwnership.browserSession === ownership.browserSession &&
			recoveredOwnership.tabsSession === ownership.tabsSession &&
			recoveredOwnership.owned[0] === ownedTabId,
	);
	await context.close();
	context = undefined;
	await launch();
	const browserRestarted = await open();
	const history = await worker.evaluate((id) => globalThis.__piStorageTest.view(id), sent.id);
	check(
		"browser restart retains the chat index and transcript",
		browserRestarted.boot === 5 &&
			browserRestarted.history.some(({ id }) => id === sent.id) &&
			content(history.view).includes("persisted answer") &&
			history.calls === 0,
	);
	const expiredOwnership = await worker.evaluate((id) => globalThis.__piStorageTest.ownership(id), sent.id);
	check(
		"browser restart changes the session ID without rewriting old ownership",
		expiredOwnership.browserSession !== ownership.browserSession &&
			expiredOwnership.tabsSession === ownership.tabsSession &&
			expiredOwnership.tabs[0] === ownedTabId,
	);
	check("old tab IDs confer no ownership in the new browser session", expiredOwnership.owned.length === 0);
	assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get(null)), saved);
	assert.deepEqual(await worker.evaluate(() => chrome.permissions.getAll()), permissions);
	check("later starts preserve credentials, settings, prompts and grants", true);
	console.log(`\n${checks}/${checks} storage checks passed (${cases.length} conformance cases).`);
} finally {
	await context?.close();
	rmSync(profile, { recursive: true, force: true });
}
