import { browser, connect, fire, workerSession } from "./fixtures/worker.ts";
import "../src/background/main.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";

vi.mock("../src/background/session.ts", () => workerSession);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
	await workerSession.currentSession()?.harness.close(BACKGROUND_CONTEXT);
});

it("a cold recovery alarm opens the session and rearms before resuming it", async () => {
	expect(workerSession.currentSession()).toBeUndefined();
	const admit = vi.spyOn(workerSession.activeWork, "admit");
	fire("alarms.onAlarm", { name: "recovery" });
	await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(1));
	expect(workerSession.currentSession()).toBeDefined();
});

it("recovery alarms resume an already-open Harness too, rather than only reopening storage", async () => {
	const { harness } = await workerSession.session();
	const resume = vi.spyOn(harness, "resume");
	vi.spyOn(workerSession.activeWork, "admit").mockImplementation(async (operation) => {
		expect(resume).not.toHaveBeenCalled();
		return operation();
	});
	fire("alarms.onAlarm", { name: "recovery" });
	await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
	expect(workerSession.currentSession()?.harness).toBe(harness);
});

it("a failed recovery pre-arm does not resume and is reported without an unhandled rejection", async () => {
	const { harness } = await workerSession.session();
	const resume = vi.spyOn(harness, "resume");
	vi.spyOn(workerSession.activeWork, "admit").mockRejectedValueOnce(Error("cannot arm recovery"));
	const report = vi.spyOn(console, "error").mockImplementation(() => {});
	fire("alarms.onAlarm", { name: "recovery" });
	await vi.waitFor(() =>
		expect(report).toHaveBeenCalledWith(
			"[pi-aside] recovery alarm",
			expect.objectContaining({ message: "cannot arm recovery" }),
		),
	);
	expect(resume).not.toHaveBeenCalled();
});

it("publishes the latest Wake as JSON, not an invented task count, and rejects the old protocol", async () => {
	browser.open.add(1);
	await workerSession.tabs.set(1, (entry) => ({ ...entry, chat: null }));
	const at = Date.now() + 60_000;
	workerSession.activeWork.latest = { active: false, at };
	const panel = connect(1);
	const old = connect(1);
	try {
		panel.send({ type: "hello", version: PROTOCOL_VERSION, tabId: 1, log: true });
		await vi.waitFor(() => expect(panel.received.some((message) => message.type === "snapshot")).toBe(true));
		const snapshot = panel.received.find((message) => message.type === "snapshot")!;
		expect(snapshot.state.status.wake).toEqual({ active: false, at });
		expect(snapshot.state.status).not.toHaveProperty("activeTasks");
		expect(JSON.parse(JSON.stringify(snapshot)).state.status.wake).toEqual({ active: false, at });
		old.send({ type: "hello", version: 22, tabId: 1, log: false });
		await vi.waitFor(() => expect(old.received).toEqual([{ type: "incompatible", version: PROTOCOL_VERSION }]));
	} finally {
		panel.disconnect();
		old.disconnect();
	}
});
