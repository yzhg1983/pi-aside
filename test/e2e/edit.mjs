// Copy and Edit of a sent message in the production panel (design 6.34): Copy and Edit under each question, Esc and
// Cancel, what the model gets after an edit, the note over the new chat and Open original, History, and Edit
// waiting while an answer runs; Stop giving back the messages it took off the queue as drafts; removing the tab's own
// chat from History, which stays open with its Undo. editor.png, edited.png,
// and stopped.png in the artifacts folder show them. Only a loopback page and
// an in-process faux provider, in a disposable Chrome profile and temporary bundle. No installed dist/, accounts, or
// paid requests.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw Error("Set CHROME to a Chrome for Testing 140+ executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-edit-"));
const ext = join(dir, "ext");
const profile = join(dir, "profile");
console.log("Artifacts:", dir);
mkdirSync(ext);
cpSync(join(repo, "static"), ext, { recursive: true });
// English labels; localization.mjs covers both catalogs.
rmSync(join(ext, "_locales/zh_CN"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*", "https://openrouter.ai/*"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

const entry = join(dir, "entry.mjs");
writeFileSync(
	entry,
	`
import ${JSON.stringify(join(repo, "src/background/main.ts"))};
import { models } from ${JSON.stringify(join(repo, "src/background/models.ts"))};
import { saveSettings } from ${JSON.stringify(join(repo, "src/background/settings.ts"))};
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
// It thinks, so the thinking picker is offered.
const faux = fauxProvider({ provider: "openrouter", models: [{ id: "edit-test", reasoning: true }] });
models.setProvider(faux.provider);
globalThis.fetch = async () => { throw Error("Unexpected network request in edit test"); };
const requests = [];
const text = (content) => typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
let release;
let requestSignal;
globalThis.__piEdit = {
  saveSettings, requests,
  /** The next answer; held until release() when held. */
  answer(reply, held = false) {
    const gate = held ? new Promise((resolve) => { release = resolve; }) : undefined;
    faux.setResponses([async (transcript, options) => {
      requestSignal = options?.signal;
      requests.push(transcript.messages.map((message) => message.role + ": " + text(message.content).split("\\n")[0]));
      await gate;
      return fauxAssistantMessage(reply);
    }]);
  },
  release() { release?.(); },
  get aborted() { return requestSignal?.aborted === true; },
};
`,
);
const common = {
	absWorkingDir: repo,
	nodePaths: [join(repo, "node_modules")],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "chrome140",
	logLevel: "warning",
};
await build({
	...common,
	entryPoints: [entry],
	outfile: join(ext, "background.js"),
	plugins: [
		{
			name: "test-only-main-hooks",
			setup(builder) {
				builder.onLoad({ filter: /\/background\/main\.ts$/ }, ({ path }) => ({
					contents: `${readFileSync(path, "utf8")}\nglobalThis.__piEditMain = { begin };`,
					loader: "ts",
					resolveDir: join(repo, "src/background"),
				}));
			},
		},
	],
});
await build({ ...common, entryPoints: { panel: "src/panel/panel.ts" }, outdir: ext });

const site = createServer((_, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.end("<!doctype html><title>Edit fixture</title><p>A page.</p>");
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${site.address().port}`;
let context;
let checks = 0;
const problems = [];
function check(name, ok) {
	assert(ok, name);
	console.log(`PASS ${name}`);
	checks++;
}
async function poll(test, name, ms = 20_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await test();
		if (value) return value;
		await sleep(50);
	}
	throw Error(`Timed out: ${name}`);
}
try {
	context = await chromium.launchPersistentContext(profile, {
		executablePath: process.env.CHROME,
		headless: false,
		viewport: { width: 400, height: 800 },
		args: [
			"--headless=new",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			"--no-proxy-server",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
		],
	});
	await context.route("**/*", (route) => {
		const url = new URL(route.request().url());
		return url.protocol === "chrome-extension:" || url.hostname === "127.0.0.1" ? route.continue() : route.abort();
	});
	const worker = await poll(() => context.serviceWorkers().find((w) => w.url().endsWith("/background.js")), "worker");
	const id = new URL(worker.url()).host;
	console.log("Chrome:", context.browser().version());
	await poll(() => worker.evaluate(() => Boolean(globalThis.__piEdit)).catch(() => false), "hooks");
	await worker.evaluate(async () => {
		await chrome.storage.local.set({ credentials: { openrouter: { type: "api_key", key: "not-a-real-key" } } });
		await globalThis.__piEdit.saveSettings({ model: { provider: "openrouter", modelId: "edit-test" } });
	});
	const page = await context.newPage();
	await page.goto(origin);
	const tabId = await worker.evaluate(
		async (origin) => (await chrome.tabs.query({})).find((tab) => tab.url === `${origin}/`).id,
		origin,
	);
	await worker.evaluate(async (tabId) => {
		const tab = await chrome.tabs.get(tabId);
		const started = globalThis.__piEditMain.begin("action", tab, { frameId: 0, url: tab.url, top: tab.url });
		await Promise.all([started.captured, started.resolved]);
	}, tabId);

	const panel = await context.newPage();
	panel.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
	await panel.goto(`chrome-extension://${id}/panel.html?tab=${tabId}`);
	const composer = panel.locator("#composer");
	await composer.waitFor({ state: "visible" });
	await poll(() => panel.locator("#page").isVisible(), "page attached");
	// A change of the panel's width refits the message box, and Chrome lists no "ResizeObserver loop" error for it.
	await panel.evaluate(() => {
		globalThis.__windowErrors = [];
		addEventListener("error", (event) => globalThis.__windowErrors.push(event.message));
	});
	await composer.fill("one\ntwo\na third line long enough to wrap onto more lines in a narrower panel");
	const heights = [];
	for (const width of [300, 400, 280, 400]) {
		await panel.setViewportSize({ width, height: 800 });
		await sleep(300);
		heights.push(await composer.evaluate((box) => box.offsetHeight));
	}
	check("the message box refits to the panel's width", heights[0] > heights[1] && heights[2] > heights[3]);
	check("no ResizeObserver loop error", (await panel.evaluate(() => globalThis.__windowErrors)).length === 0);
	await composer.fill("");
	// The thinking levels' list opens above the picker with every level shown (design 6.37).
	const thinking = panel.locator("#thinking");
	await thinking.click();
	const list = await thinking.evaluate((select) => ({
		open: select.matches(":open"),
		top: select.getBoundingClientRect().top,
		levels: [...select.options].map((option) => {
			const box = option.getBoundingClientRect();
			return { bottom: box.bottom, shown: box.height > 0 && box.top >= 0 };
		}),
	}));
	check(
		"the thinking list opens above the picker with every level",
		list.open && list.levels.length === 6 && list.levels.every((level) => level.shown && level.bottom <= list.top),
	);
	await panel.keyboard.press("Escape");
	// Chrome grants no clipboard permission to an extension page here: what Copy writes is recorded instead.
	await panel.evaluate(() => {
		Object.defineProperty(navigator.clipboard, "writeText", {
			value: async (text) => {
				globalThis.__copied = text;
			},
		});
	});
	const requests = () => worker.evaluate(() => globalThis.__piEdit.requests.slice());
	const transcript = () => panel.locator(".stream > .entries > *").allTextContents();
	const turns = panel.locator(".turn");
	const send = async (text, reply) => {
		const count = (await requests()).length;
		await worker.evaluate((reply) => globalThis.__piEdit.answer(reply), reply);
		await composer.fill(text);
		await composer.press("Enter");
		await poll(async () => (await requests()).length === count + 1, `request for ${text}`);
		await poll(async () => (await transcript()).some((line) => line.includes(reply)), `answer ${reply}`);
		await poll(() => panel.locator("#new-chat").isEnabled(), "answer done");
	};

	await send("first question", "Answer one.");
	await send("second question", "Answer two.");
	const second = turns.nth(1);
	const actions = second.locator(".turn-actions");
	check(
		"Copy and Edit are hidden until the question is hovered",
		(await actions.evaluate((n) => getComputedStyle(n).opacity)) === "0",
	);
	await second.hover();
	check("hovering shows them", (await actions.evaluate((n) => getComputedStyle(n).opacity)) === "1");
	await actions.getByRole("button", { name: "Copy message" }).click();
	check(
		"Copy copies the question as typed, without the page note",
		(await panel.evaluate(() => globalThis.__copied)) === "second question",
	);

	const edit = actions.getByRole("button", { name: "Edit message" });
	await edit.click();
	const box = second.locator("textarea.edit-box");
	check(
		"Edit puts the question in a box in its place, with a note",
		(await box.inputValue()) === "second question" &&
			(await box.evaluate((n) => n === document.activeElement)) &&
			!(await second.locator(".msg.user:not(.editor)").isVisible()) &&
			(await second.locator(".edit-note").textContent()).includes("This chat stays in History"),
	);
	await box.press("Escape");
	check(
		"Esc closes it, keeps the question, and stops nothing",
		(await box.count()) === 0 &&
			(await second.locator(".msg.user").textContent()).includes("second question") &&
			(await edit.evaluate((n) => n === document.activeElement)),
	);
	await edit.click();
	await second.getByRole("button", { name: "Cancel" }).click();
	check("Cancel closes it too", (await box.count()) === 0);

	await edit.click();
	await box.fill("   ");
	check("Send waits for text", await second.getByRole("button", { name: "Send" }).isDisabled());
	await box.fill("second question, edited");
	await panel.screenshot({ path: join(dir, "editor.png") });
	await worker.evaluate(() => globalThis.__piEdit.answer("Answer three."));
	await box.press("Enter");
	await poll(async () => (await requests()).length === 3, "request after the edit");
	await poll(async () => (await transcript()).some((line) => line.includes("Answer three.")), "edited answer");
	await poll(() => panel.locator("#new-chat").isEnabled(), "answer done");
	check(
		"the model gets the chat up to the question, then the edited one, and not the answer it replaces",
		JSON.stringify((await requests())[2].filter((line) => !line.startsWith("system:"))) ===
			JSON.stringify(["user: first question", "assistant: Answer one.", "user: second question, edited"]),
	);
	const lines = await transcript();
	check(
		"the tab shows the new chat",
		lines.length === 4 &&
			lines[0].includes("first question") &&
			lines[2].includes("second question, edited") &&
			lines[3].includes("Answer three.") &&
			!lines.some((line) => line.includes("Answer two.")),
	);
	const note = panel.locator(".msg.notice.origin");
	check("a note over it says where it came from", (await note.textContent()).includes("Edited from an earlier chat."));
	await panel.screenshot({ path: join(dir, "edited.png") });

	await panel.locator("#open-history").click();
	const rows = panel.locator(".history-row");
	await poll(async () => (await rows.count()) === 2, "two chats in History");
	check(
		"History lists both, the new one marked Edited",
		(await rows.nth(0).locator(".pill", { hasText: "Edited" }).count()) === 1 &&
			(await rows.nth(1).locator(".title .pill").count()) === 0 &&
			(await rows.nth(1).textContent()).includes("first question"),
	);
	await panel.locator("#open-history").click();

	await note.getByRole("button", { name: "Open original" }).click();
	await poll(async () => (await transcript()).some((line) => line.includes("Answer two.")), "original shown");
	const original = await transcript();
	check(
		"Open original shows the chat as it was",
		original.length === 4 &&
			original[2].includes("second question") &&
			!original[2].includes("edited") &&
			(await panel.locator(".msg.notice.origin").count()) === 0,
	);

	await worker.evaluate(() => globalThis.__piEdit.answer("Answer four.", true));
	await composer.fill("third question");
	await composer.press("Enter");
	await poll(async () => (await requests()).length === 4, "held request");
	const busyEdit = turns.first().locator(".edit-input");
	// The worker has the request before the panel gets the state that says the answer runs.
	await poll(() => busyEdit.isDisabled(), "Edit disabled while the answer runs");
	check(
		"Edit waits while an answer runs",
		(await busyEdit.isDisabled()) && (await busyEdit.getAttribute("title")) === "Stop the answer first",
	);
	// Esc on the thinking levels' list, which Chrome draws in the page, closes the list; it does not stop the answer.
	await thinking.click();
	await poll(() => thinking.evaluate((select) => select.matches(":open")), "thinking levels shown");
	await panel.keyboard.press("Escape");
	await poll(() => thinking.evaluate((select) => !select.matches(":open")), "thinking levels closed");
	await sleep(300);
	check(
		"Esc closes the thinking levels' list and does not stop the answer",
		!(await worker.evaluate(() => globalThis.__piEdit.aborted)) && (await busyEdit.isDisabled()),
	);
	await worker.evaluate(() => globalThis.__piEdit.release());
	await poll(async () => (await transcript()).some((line) => line.includes("Answer four.")), "held answer");
	await poll(() => busyEdit.isEnabled(), "Edit enabled again");
	check("and is offered again after it", (await busyEdit.getAttribute("title")) === "Edit message");

	await worker.evaluate(() => globalThis.__piEdit.answer("Never shown.", true));
	await composer.fill("fourth question");
	await composer.press("Enter");
	await poll(async () => (await requests()).length === 5, "held request to stop");
	for (const text of ["queued one", "queued two"]) {
		await composer.fill(text);
		await composer.press("Enter");
	}
	await poll(async () => (await panel.locator(".msg.user.queued").count()) === 2, "two queued messages");
	await panel.locator("#stop").click();
	// The click sends a command; keep the answer held until the worker actually aborts the request.
	await poll(() => worker.evaluate(() => globalThis.__piEdit.aborted), "held request aborted");
	await worker.evaluate(() => globalThis.__piEdit.release());
	await poll(async () => (await composer.inputValue()) === "queued one", "first queued message back in the box");
	const drafts = panel.locator(".draft");
	check(
		"Stop gives back the queued messages: the first in the message box, the next as a draft",
		(await panel.locator(".msg.user.queued").count()) === 0 &&
			(await drafts.count()) === 1 &&
			(await drafts.textContent()).includes("queued two"),
	);
	check("and sends neither", (await requests()).length === 5);
	await panel.screenshot({ path: join(dir, "stopped.png") });

	// Removing the chat the tab shows: the tab starts fresh, and History stays with its Undo (design 6.30).
	await panel.locator("#open-history").click();
	const current = panel.locator(".history-item").filter({ has: panel.locator('.history-row[aria-current="true"]') });
	await current.waitFor({ state: "visible" });
	const shown = await panel.evaluate(() => document.querySelector("#history-list").children.length);
	await current.locator(".chat-more").click();
	await current.getByRole("menuitem", { name: "Remove from History", exact: true }).click();
	const undo = panel.locator("#history-note").getByRole("button", { name: "Undo", exact: true });
	await undo.waitFor({ state: "visible" });
	await poll(async () => (await transcript()).length === 0, "the tab starts fresh");
	check(
		"removing the tab's chat keeps History open, with Undo",
		(await panel.locator("#history").isVisible()) && !(await panel.locator("#chat-view").isVisible()),
	);
	await undo.click();
	await poll(
		async () => (await panel.evaluate(() => document.querySelector("#history-list").children.length)) === shown,
		"the chat back in History",
	);
	check("Undo brings it back", (await current.count()) === 0);
	await panel.locator("#close-history").click();
	check("no panel errors", problems.length === 0);
	console.log(`${checks} checks passed.`);
} catch (error) {
	console.error("Problems:", problems);
	for (const page of context?.pages() ?? [])
		if (page.url().startsWith("chrome-extension:"))
			console.error(
				"Panel on failure:",
				await page
					.locator("body")
					.textContent()
					.catch(() => "unavailable"),
			);
	throw error;
} finally {
	await context?.close();
	await new Promise((resolve) => site.close(resolve));
	rmSync(profile, { recursive: true, force: true });
}
