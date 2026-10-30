// Slash commands in the production panel (design 6.33): the list under "/", completing with the keyboard and the
// pointer, what the model gets for a command with text and for the attached page, a slash that names no prompt, the
// error without a page, and Esc; a prompt switched off in Settings (6.41); menu.png and prompts-off.png in the
// artifacts folder show the list and the Settings rows. Only a loopback page and an
// in-process faux provider, in a disposable Chrome profile and temporary bundle. No installed dist/, accounts, or paid
// requests.
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
const dir = mkdtempSync(join(tmpdir(), "pi-slash-"));
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
const faux = fauxProvider({ provider: "openrouter", models: [{ id: "slash-test" }] });
models.setProvider(faux.provider);
globalThis.fetch = async () => { throw Error("Unexpected network request in slash test"); };
const sent = [];
const text = (content) => typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
globalThis.__piSlash = {
  saveSettings, sent,
  answer() {
    faux.setResponses([(transcript) => {
      sent.push(text(transcript.messages.findLast((message) => message.role === "user").content));
      return fauxAssistantMessage("Answered.");
    }]);
  },
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
					contents: `${readFileSync(path, "utf8")}\nglobalThis.__piSlashMain = { begin, addDraft, schedule };`,
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
	res.end("<!doctype html><title>Slash fixture</title><p>A page.</p>");
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
	await poll(() => worker.evaluate(() => Boolean(globalThis.__piSlash)).catch(() => false), "hooks");
	await worker.evaluate(async () => {
		await chrome.storage.local.set({ credentials: { openrouter: { type: "api_key", key: "not-a-real-key" } } });
		await globalThis.__piSlash.saveSettings({ model: { provider: "openrouter", modelId: "slash-test" } });
	});
	const page = await context.newPage();
	await page.goto(origin);
	const tabId = await worker.evaluate(
		async (origin) => (await chrome.tabs.query({})).find((tab) => tab.url === `${origin}/`).id,
		origin,
	);
	await worker.evaluate(async (tabId) => {
		const tab = await chrome.tabs.get(tabId);
		const started = globalThis.__piSlashMain.begin("action", tab, { frameId: 0, url: tab.url, top: tab.url });
		await Promise.all([started.captured, started.resolved]);
	}, tabId);

	const panel = await context.newPage();
	panel.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
	await panel.goto(`chrome-extension://${id}/panel.html?tab=${tabId}`);
	const composer = panel.locator("#composer");
	const menu = panel.locator("#slash-menu");
	await composer.waitFor({ state: "visible" });
	await poll(() => panel.locator("#page").isVisible(), "page attached");
	const names = () => menu.locator(".option .name").allTextContents();
	const sent = () => worker.evaluate(() => globalThis.__piSlash.sent.slice());
	const sendAndWait = async (count) => {
		await worker.evaluate(() => globalThis.__piSlash.answer());
		await composer.press("Enter");
		await poll(async () => (await sent()).length === count, `request ${count}`);
		await poll(async () => (await composer.inputValue()) === "", "composer cleared");
		await poll(() => panel.locator("#new-chat").isEnabled(), "answer done");
	};

	await composer.click();
	await composer.type("/");
	await menu.waitFor({ state: "visible" });
	check(
		"/ lists every prompt",
		JSON.stringify(await names()) ===
			JSON.stringify(["/explain", "/summarize", "/translate", "/proofread", "/reply"]),
	);
	await panel.screenshot({ path: join(dir, "menu.png") });
	await composer.type("su");
	check("typing narrows the list", JSON.stringify(await names()) === JSON.stringify(["/summarize"]));
	await composer.press("Enter");
	check(
		"Enter completes the name and closes the list",
		(await composer.inputValue()) === "/summarize " && !(await menu.isVisible()),
	);
	await sendAndWait(1);
	const [summary] = await sent();
	check(
		"/summarize alone runs the prompt for the attached page",
		summary.startsWith('Summarize this text from "Slash fixture"') &&
			summary.includes("(the attached page)") &&
			summary.includes("Answer in English."),
	);

	await composer.fill("/");
	await composer.press("ArrowDown");
	await composer.press("ArrowUp");
	await composer.press("ArrowUp");
	check(
		"arrows move and wrap",
		(await menu.locator('.option[aria-selected="true"] .name').textContent()) === "/reply" &&
			(await composer.getAttribute("aria-activedescendant")) === "slash-4",
	);
	await composer.fill("/draft");
	check(
		"the shown name finds a prompt",
		JSON.stringify(await names()) === JSON.stringify(["/reply"]) &&
			(await menu.locator(".option .id").textContent()) === "Draft a reply",
	);
	await composer.fill("/");
	await menu.locator(".option", { hasText: "/explain" }).click();
	check("a click completes the name", (await composer.inputValue()) === "/explain ");
	await composer.type("WAL mode");
	await sendAndWait(2);
	check(
		"/explain text fills the selection with the text",
		(await sent())[1].includes(":\n\nWAL mode\n\nAnswer in English."),
	);

	await composer.fill("/etc/hosts?");
	check("no list for a slash that names no prompt", !(await menu.isVisible()));
	await sendAndWait(3);
	// With the attached page's note after it, as any typed message.
	check("a slash that names no prompt is sent as typed", (await sent())[2].startsWith("/etc/hosts?\n"));

	await composer.fill("/pro");
	await menu.waitFor({ state: "visible" });
	await composer.press("Escape");
	check(
		"Esc closes the list and keeps the message",
		!(await menu.isVisible()) && (await composer.inputValue()) === "/pro",
	);
	await composer.type("o");
	check("typing again brings the list back", await menu.isVisible());
	await composer.fill("/proofread");
	await panel.locator("#detach-page").click();
	await composer.press("Escape");
	await composer.press("Enter");
	await poll(() => panel.locator("#composer-status").isVisible(), "error shown");
	check(
		"/proofread alone without a page says to type text, and sends nothing",
		(await panel.locator("#composer-status").textContent()).includes("Type text after /proofread") &&
			(await sent()).length === 3 &&
			(await composer.inputValue()) === "/proofread",
	);
	await composer.fill("/proofread teh text");
	await sendAndWait(4);
	check(
		"without a page, the prompt leaves out the empty source",
		(await sent())[3].startsWith("Proofread this text. Reply with the corrected text"),
	);

	// "Add to message" while the list is open: the list follows the new message, so Enter sends it, not a completion.
	const draft = { selection: null, page: null, prompt: null, key: null, note: null };
	await composer.fill("/");
	await menu.waitFor({ state: "visible" });
	await worker.evaluate(
		([tabId, draft]) =>
			globalThis.__piSlashMain
				.addDraft({ ...draft, tabId, text: "Selected words", insert: true })
				.then(globalThis.__piSlashMain.schedule),
		[tabId, draft],
	);
	await poll(async () => (await composer.inputValue()).includes("Selected words"), "selection added");
	check("Add to message closes a list for the message before it", !(await menu.isVisible()));
	await sendAndWait(5);
	check("and Enter sends the message with the selection", (await sent())[4].includes("Selected words"));

	// A page prompt's draft holds the filled prompt: an empty box takes it, and sent unchanged, a slash at its start is
	// text, not a command.
	await worker.evaluate(
		([tabId, draft]) =>
			globalThis.__piSlashMain.addDraft({
				...draft,
				tabId,
				text: "/explain the text",
				prompt: "Custom",
				insert: false,
			}),
		[tabId, draft],
	);
	await poll(async () => (await composer.inputValue()) === "/explain the text", "draft in the box");
	await sendAndWait(6);
	check(
		"a page prompt's draft sent unchanged is not expanded again",
		(await sent())[5].startsWith("/explain the text"),
	);
	// A prompt switched off in Settings leaves the list, and its name is sent as typed (design 6.41).
	await panel.locator("#open-settings").click();
	const row = (name) => panel.locator("#prompts > li", { has: panel.locator(".name", { hasText: name }) });
	const summarizeSwitch = row("Summarize").locator(".switch");
	check(
		"each prompt has a switch, on, and the default's cannot be turned off",
		(await panel.locator("#prompts .switch[aria-checked='true']").count()) === 5 &&
			(await row("Explain").locator(".switch").isDisabled()) &&
			(await summarizeSwitch.getAttribute("aria-label")) === "Summarize in the pi menu",
	);
	await summarizeSwitch.click();
	await poll(async () => (await summarizeSwitch.getAttribute("aria-checked")) === "false", "switched off");
	check(
		"a prompt switched off is muted, keeps its row, and cannot be the default",
		(await row("Summarize").getAttribute("class")) === "off" &&
			(await row("Summarize").locator(".star").isDisabled()) &&
			(await summarizeSwitch.evaluate((el) => el === document.activeElement)) &&
			(await panel.locator("#prompts-saved").textContent()) === "Saved",
	);
	await panel.screenshot({ path: join(dir, "prompts-off.png") });
	const menus = await worker.evaluate(async () =>
		(await chrome.storage.local.get("menus")).menus.map((item) => item.id),
	);
	check("the pi menu leaves it out", !menus.some((menuId) => menuId.endsWith("summarize")) && menus.length === 11);
	await panel.locator("#close-settings").click();
	await composer.fill("/");
	await menu.waitFor({ state: "visible" });
	check(
		"/ lists only the prompts that are on",
		JSON.stringify(await names()) === JSON.stringify(["/explain", "/translate", "/proofread", "/reply"]),
	);
	await composer.fill("/summarize this");
	check("no list for a prompt that is off", !(await menu.isVisible()));
	await sendAndWait(7);
	check("its name is sent as typed", (await sent())[6].startsWith("/summarize this"));
	await panel.locator("#open-settings").click();
	await summarizeSwitch.click();
	await poll(async () => (await summarizeSwitch.getAttribute("aria-checked")) === "true", "switched on");
	await panel.locator("#close-settings").click();
	await composer.fill("/su");
	await menu.waitFor({ state: "visible" });
	check("switched on again, it is back in the list", JSON.stringify(await names()) === JSON.stringify(["/summarize"]));
	await composer.fill("");
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
