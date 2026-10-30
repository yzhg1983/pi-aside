// Production session, ActiveWork and main.ts alarm handler with native IndexedDB and durable sleeps.
// Disposable profile, no credentials, no provider requests or network. Unpacked alarms do not prove the 30 s floor.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw Error("Set CHROME to a Chrome for Testing 140+ executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-wake-"));
const ext = join(dir, "ext");
const profile = join(dir, "profile");
console.log("Artifacts:", dir);
mkdirSync(ext);
cpSync(join(repo, "static"), ext, { recursive: true });
writeFileSync(join(ext, "wake.html"), "<!doctype html><title>Wake test</title>");
const entry = join(dir, "entry.mjs");
writeFileSync(
	entry,
	`
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineTask, defineDoc } from "@earendil-works/pi-durable";
import { session, currentSession, currentLog, activeWork, registry } from ${JSON.stringify(join(repo, "src/background/session.ts"))};
import ${JSON.stringify(join(repo, "src/background/main.ts"))};
globalThis.fetch = async () => { throw Error("Unexpected network request in wake test"); };
const errors = [];
const originalError = console.error.bind(console);
console.error = (...args) => { errors.push(args.map((value) => value instanceof Error ? value.stack : String(value)).join(" ")); originalError(...args); };
const Done = defineDoc({ kind: "test.wake", version: 1, scope: "session", initial: () => ({ items: [] }), checkpointWhen: () => false });
const Sleeper = defineTask({
  name: "test.sleeper", version: 1, initial: () => ({ phase: "wait" }),
  phases: {
    wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
    deliver: (task, runtime, context) => runtime.commit(async (tx) => {
      (await tx.doc(Done)).items.push({ key: task.input.key, at: Date.now() });
      return { status: "terminal", outcome: { status: "completed", result: null } };
    }, context)
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context)
});
// Initial definitions, before this worker opens its Harness. Runtime registry changes use ActiveWork.admit().
registry.install({ name: "wake-test", tasks: [Sleeper] });
let alarmEvents = 0;
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "recovery") alarmEvents += 1; });
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message === "wake-test") { reply("awake"); return false; }
});
globalThis.__piWake = {
  async state() {
    const opened = currentSession();
    return {
      boot: opened?.boot ?? null, wake: activeWork.latest ?? null, keepalive: activeWork.keepalive,
      alarm: await chrome.alarms.get("recovery") ?? null, alarmEvents, log: currentLog(), errors,
      done: opened ? (await opened.harness.snapshot(Done, context))?.items ?? [] : []
    };
  },
  async start(key, delay) {
    const { harness } = await session();
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const at = Date.now() + delay;
    await activeWork.admit(() => conversation.commit((tx) => tx.createTask(Sleeper, { key, at }, {
      ownership: { kind: "conversation" }, background: true
    }), context));
    return { at, boot: currentSession().boot };
  },
  async close() { await currentSession()?.harness.close(context); },
  async open() { await session(); },
  async switch(enabled) { await activeWork.setEnabled(enabled); }
};
`,
);
await build({
	absWorkingDir: repo,
	nodePaths: [join(repo, "node_modules")],
	entryPoints: [entry],
	outfile: join(ext, "background.js"),
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "chrome140",
	logLevel: "warning",
	plugins: [
		{
			name: "test-registry-export",
			setup(bundle) {
				bundle.onLoad({ filter: /src\/background\/session\.ts$/ }, ({ path }) => ({
					contents: `${readFileSync(path, "utf8")}\nexport { registry };`,
					loader: "ts",
				}));
			},
		},
	],
});
let browser;
let worker;
let checks = 0;
function check(name, condition) {
	assert(condition, name);
	checks += 1;
	console.log(`PASS ${name}`);
}
async function poll(test, name, timeout = 15_000) {
	const end = Date.now() + timeout;
	for (;;) {
		const result = await test();
		if (result) return result;
		if (Date.now() >= end) {
			console.error("Last state:", await state().catch((error) => String(error)));
			throw Error(`Timed out: ${name}`);
		}
		await sleep(25);
	}
}
const state = () => worker.evaluate(() => globalThis.__piWake.state());
try {
	browser = await chromium.launchPersistentContext(profile, {
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
	console.log("Chrome:", browser.browser().version());
	assert(Number.parseInt(browser.browser().version(), 10) >= 140, "Chrome 140+ is required");
	worker = await poll(() => browser.serviceWorkers().find((item) => item.url().endsWith("/background.js")), "worker");
	await poll(() => worker.evaluate(() => Boolean(globalThis.__piWake)).catch(() => false), "test hooks");
	await worker.evaluate(() => globalThis.__piWake.open());
	check("idle startup clears recovery and keepalive", !(await state()).alarm && !(await state()).keepalive);

	const short = await worker.evaluate(() => globalThis.__piWake.start("short", 1000));
	await poll(async () => (await state()).wake?.at === short.at, "short sleep checkpoint");
	const asleep = await state();
	check(
		"short sleep uses a one-shot alarm and keepalive",
		!asleep.wake.active &&
			asleep.keepalive &&
			asleep.alarm?.scheduledTime === short.at &&
			asleep.alarm.periodInMinutes === undefined,
	);
	const events = asleep.alarmEvents;
	// Remove only this test alarm to distinguish the local timer from the unpacked extension's fast alarm.
	await worker.evaluate(() => chrome.alarms.clear("recovery"));
	const done = await poll(async () => {
		const value = await state();
		return value.done.some((item) => item.key === "short") && value;
	}, "local deadline");
	check(
		"local timer resumes a one-second sleep without an alarm event",
		done.alarmEvents === events &&
			done.done.find((item) => item.key === "short").at >= short.at &&
			Date.now() - short.at < 3000,
	);
	await poll(async () => {
		const value = await state();
		return !value.keepalive && !value.alarm;
	}, "idle after short sleep");
	check("completion clears recovery and keepalive", true);

	await worker.evaluate(() => globalThis.__piWake.switch(false));
	const cold = await worker.evaluate(() => globalThis.__piWake.start("cold", 5000));
	await poll(async () => (await state()).alarm?.scheduledTime === cold.at, "stored cold deadline");
	check("keepalive off retains the durable deadline", !(await state()).keepalive);
	const id = new URL(worker.url()).host;
	const page = await browser.newPage();
	await page.goto(`chrome-extension://${id}/wake.html`);
	const cdp = await browser.newCDPSession(page);
	const target = (await cdp.send("Target.getTargets")).targetInfos.find(
		(item) => item.type === "service_worker" && item.url === worker.url(),
	);
	assert(target, "worker target exists");
	assert((await cdp.send("Target.closeTarget", { targetId: target.targetId })).success);
	await poll(
		async () =>
			!(await page.evaluate(() => navigator.locks.query())).held.some((lock) => lock.name === "pi-aside-indexeddb"),
		"worker termination",
	);
	check("terminated worker releases ownership before the sleep is due", Date.now() < cold.at);
	const restored = await poll(
		async () => {
			worker = browser.serviceWorkers().find((item) => item.url().endsWith("/background.js"));
			if (!worker) return false;
			return state()
				.then((value) => value.boot > cold.boot && value.done.some((item) => item.key === "cold") && value)
				.catch(() => false);
		},
		"alarm-only recovery",
		15_000,
	);
	check(
		"the real alarm handler opens a fresh Harness and resumes the stored sleep",
		restored.boot === cold.boot + 1 && restored.alarmEvents > 0,
	);
	check(
		"the stored sleep completes once, after its deadline",
		restored.done.filter((item) => item.key === "cold").length === 1 &&
			restored.done.find((item) => item.key === "cold").at >= cold.at,
	);

	const warm = await worker.evaluate(() => globalThis.__piWake.start("warm", 1000));
	await poll(async () => (await state()).wake?.at === warm.at, "warm sleep checkpoint");
	// Timers are stopped on a clean Harness close, but its alarm must survive to reopen the same worker's session.
	await worker.evaluate(async () => {
		await globalThis.__piWake.close();
		await globalThis.__piWake.open();
	});
	const warmBoot = (await state()).boot;
	const warmDone = await poll(async () => {
		const value = await state();
		return value.done.some((item) => item.key === "warm") && value;
	}, "warm reopened deadline");
	check("a reopened session re-arms sleeps without replacing its Harness again", warmDone.boot === warmBoot);
	check("the keepalive switch survives worker recovery", !warmDone.keepalive);
	await poll(async () => !(await state()).alarm, "final idle alarm");
	const local = await worker.evaluate(() => chrome.storage.local.get(null));
	check("no account or credential was needed", !local.credentials);
	await worker.evaluate(() => globalThis.__piWake.switch(true));
	const long = await worker.evaluate(() => globalThis.__piWake.start("long", 120_000));
	await poll(async () => (await state()).alarm?.scheduledTime === long.at, "long sleep deadline");
	check("a long sleep has a deadline alarm but no keepalive even with its switch on", !(await state()).keepalive);
	await worker.evaluate(() => globalThis.__piWake.close());
	const closed = await state();
	check(
		"closing detaches local scheduling without deleting stored work's recovery",
		closed.wake === null && !closed.keepalive && closed.alarm?.scheduledTime === long.at,
	);
	check("the production host reported no task or storage errors", closed.errors.length === 0);
	console.log(`\n${checks}/${checks} wake checks passed. Unpacked alarm timing is not production-floor evidence.`);
} finally {
	await browser?.close();
	rmSync(profile, { recursive: true, force: true });
}
