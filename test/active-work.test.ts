import type { Wake } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActiveWork, RECOVERY_ALARM } from "../src/background/active-work.ts";

const alarms = new Map<string, Pick<chrome.alarms.Alarm, "name" | "scheduledTime" | "periodInMinutes">>();
let failAlarms = false;
let savedEnabled = true;
const create = vi.fn(async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
	if (failAlarms) throw Error("alarms unavailable");
	alarms.set(name, {
		name,
		scheduledTime: info.when ?? Date.now() + (info.periodInMinutes ?? 1) * 60_000,
		...(info.periodInMinutes === undefined ? {} : { periodInMinutes: info.periodInMinutes }),
	});
});
const getPlatformInfo = vi.fn(async () => ({}));
let current: Wake;
const host = {
	wake: () => current,
	resume: vi.fn(() => {
		current = { active: true };
	}),
};
let work: ActiveWork;
const tick = () => vi.advanceTimersByTimeAsync(0);
function publish(value: Wake): void {
	current = value;
	work.wake(value);
}
async function start(value: Wake = { active: false }): Promise<void> {
	current = value;
	await work.attach(host);
	await work.start();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
	alarms.clear();
	failAlarms = false;
	savedEnabled = true;
	current = { active: false };
	create.mockClear();
	host.resume.mockClear();
	getPlatformInfo.mockClear();
	vi.stubGlobal("chrome", {
		storage: { local: { get: async () => ({ keepaliveEnabled: savedEnabled }), set: async () => {} } },
		alarms: {
			get: async (name: string) => alarms.get(name),
			create,
			clear: async (name: string) => alarms.delete(name),
		},
		runtime: { getPlatformInfo },
	});
	work = new ActiveWork(() => {});
});
afterEach(async () => {
	work.detach();
	await tick();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("starts periodic recovery and a 20 s keepalive for active work, then clears both when idle", async () => {
	await start({ active: true });
	expect(work.latest).toEqual({ active: true });
	expect(work.keepalive).toBe(true);
	expect(alarms.get(RECOVERY_ALARM)?.periodInMinutes).toBe(1);
	await vi.advanceTimersByTimeAsync(20_000);
	expect(getPlatformInfo).toHaveBeenCalledTimes(1);
	publish({ active: false });
	await tick();
	expect(work.keepalive).toBe(false);
	expect(alarms.has(RECOVERY_ALARM)).toBe(false);
});

it("uses a one-shot alarm for a long sleep and enters the short-sleep keepalive window while still running", async () => {
	const at = Date.now() + 120_000;
	await start({ active: false, at });
	expect(work.keepalive).toBe(false);
	expect(alarms.get(RECOVERY_ALARM)).toEqual({ name: RECOVERY_ALARM, scheduledTime: at });
	await vi.advanceTimersByTimeAsync(60_000);
	expect(work.keepalive).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(work.keepalive).toBe(true);
	expect(host.resume).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(59_999);
	expect(host.resume).toHaveBeenCalledTimes(1);
	expect(alarms.get(RECOVERY_ALARM)?.periodInMinutes).toBe(1);
});

it("does not postpone a one-shot alarm that Chrome moved to its 30 s floor", async () => {
	// A packed extension's short alarm may report the floor as its scheduled time; unpacked e2e builds cannot show it.
	create.mockImplementationOnce(async (name, info) => {
		alarms.set(name, { name, scheduledTime: Math.max(info.when ?? 0, Date.now() + 30_000) });
	});
	const floor = Date.now() + 30_000;
	const at = Date.now() + 5000;
	await start({ active: false, at });
	await vi.advanceTimersByTimeAsync(1000);
	publish({ active: false, at });
	await tick();
	publish({ active: false, at });
	await tick();
	expect(create).toHaveBeenCalledTimes(1);
	expect(alarms.get(RECOVERY_ALARM)?.scheduledTime).toBe(floor);
});

it("resumes a one-second sleep without waiting for Chrome's alarm floor", async () => {
	await start({ active: false, at: Date.now() + 1000 });
	expect(work.keepalive).toBe(true);
	await vi.advanceTimersByTimeAsync(999);
	expect(host.resume).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(host.resume).toHaveBeenCalledTimes(1);
	expect(work.latest).toEqual({ active: true });
});

it("does not resume from a timer until startup policy and binding hydration have finished", async () => {
	current = { active: false, at: Date.now() + 1000 };
	await work.attach(host);
	await vi.advanceTimersByTimeAsync(2000);
	expect(host.resume).not.toHaveBeenCalled();
	await work.start();
	await tick();
	expect(host.resume).toHaveBeenCalledTimes(1);
});

it("keeps local resumes disabled if the final startup alarm check fails", async () => {
	current = { active: false, at: Date.now() + 1000 };
	await work.attach(host);
	alarms.clear();
	failAlarms = true;
	await expect(work.start()).rejects.toThrow("alarms unavailable");
	await vi.advanceTimersByTimeAsync(2000);
	expect(host.resume).not.toHaveBeenCalled();
});

it("keeps active recovery periodic while also resuming a sleeping sibling on time", async () => {
	await start({ active: true, at: Date.now() + 1000 });
	expect(alarms.get(RECOVERY_ALARM)?.periodInMinutes).toBe(1);
	await vi.advanceTimersByTimeAsync(1000);
	expect(host.resume).toHaveBeenCalledTimes(1);
});

it("replaces alarm modes without postponing an existing periodic heartbeat", async () => {
	await start({ active: true });
	const heartbeat = alarms.get(RECOVERY_ALARM)?.scheduledTime;
	publish({ active: true, at: Date.now() + 10_000 });
	await tick();
	expect(alarms.get(RECOVERY_ALARM)?.scheduledTime).toBe(heartbeat);
	expect(create).toHaveBeenCalledTimes(1);
	const at = Date.now() + 90_000;
	publish({ active: false, at });
	await tick();
	expect(alarms.get(RECOVERY_ALARM)).toEqual({ name: RECOVERY_ALARM, scheduledTime: at });
	publish({ active: true });
	await tick();
	expect(alarms.get(RECOVERY_ALARM)?.periodInMinutes).toBe(1);
	publish({ active: false });
	await tick();
	expect(alarms.has(RECOVERY_ALARM)).toBe(false);
});

it("cancels superseded deadlines and cancels the timer when the Wake becomes idle", async () => {
	await start({ active: false, at: Date.now() + 1000 });
	publish({ active: false, at: Date.now() + 3000 });
	await vi.advanceTimersByTimeAsync(1000);
	expect(host.resume).not.toHaveBeenCalled();
	publish({ active: false });
	await vi.advanceTimersByTimeAsync(3000);
	expect(host.resume).not.toHaveBeenCalled();
});

it("the saved switch and switch changes affect only keepalive, not deadline timers or alarms", async () => {
	savedEnabled = false;
	await start({ active: false, at: Date.now() + 1000 });
	expect(work.enabled).toBe(false);
	expect(work.keepalive).toBe(false);
	expect(alarms.has(RECOVERY_ALARM)).toBe(true);
	await vi.advanceTimersByTimeAsync(1000);
	expect(host.resume).toHaveBeenCalledTimes(1);
	await work.setEnabled(true);
	expect(work.keepalive).toBe(true);
	await work.setEnabled(false);
	await vi.advanceTimersByTimeAsync(20_000);
	expect(getPlatformInfo).not.toHaveBeenCalled();
	expect(alarms.get(RECOVERY_ALARM)?.periodInMinutes).toBe(1);
});

it("arms before a mutation and refreshes wake synchronously afterward, without depending on callback delivery", async () => {
	await start();
	await work.admit(async () => {
		expect(alarms.get(RECOVERY_ALARM)?.periodInMinutes).toBe(1);
		current = { active: true }; // The commit succeeded; its onWake callback has not arrived yet.
	});
	await tick();
	expect(work.latest).toEqual({ active: true });
	expect(alarms.get(RECOVERY_ALARM)?.periodInMinutes).toBe(1);
	current = { active: false };
	await work.admit(async () => {});
	await tick();
	expect(alarms.has(RECOVERY_ALARM)).toBe(false);
});

it("overlapping admissions retain fallback recovery until all mutations have returned", async () => {
	await start();
	const gate = Promise.withResolvers<void>();
	const first = work.admit(() => gate.promise);
	await tick();
	await work.admit(async () => {});
	await tick();
	expect(alarms.get(RECOVERY_ALARM)?.periodInMinutes).toBe(1);
	gate.resolve();
	await first;
	await tick();
	expect(alarms.has(RECOVERY_ALARM)).toBe(false);
});

it("rejects a mutation without executing it if fallback recovery cannot be armed; later writes still work", async () => {
	await start();
	failAlarms = true;
	const operation = vi.fn(async () => "admitted");
	await expect(work.admit(operation)).rejects.toThrow("alarms unavailable");
	expect(operation).not.toHaveBeenCalled();
	failAlarms = false;
	await expect(work.admit(operation)).resolves.toBe("admitted");
});

it("fails startup if its current Wake cannot get an alarm", async () => {
	current = { active: true };
	failAlarms = true;
	await expect(work.attach(host)).rejects.toThrow("alarms unavailable");
	expect(host.resume).not.toHaveBeenCalled();
});

it("onWake does not block on alarm I/O and the queue uses the latest state", async () => {
	await start();
	const gate = Promise.withResolvers<void>();
	create.mockImplementationOnce(async (name, info) => {
		await gate.promise;
		alarms.set(name, { name, scheduledTime: Date.now() + 60_000, periodInMinutes: info.periodInMinutes });
	});
	expect(work.wake({ active: true })).toBeUndefined();
	await tick();
	publish({ active: false });
	gate.resolve();
	await tick();
	expect(alarms.has(RECOVERY_ALARM)).toBe(false);
});

it("reports asynchronous alarm failures without rejecting onWake or poisoning the write queue", async () => {
	await start();
	const report = vi.spyOn(console, "error").mockImplementation(() => {});
	failAlarms = true;
	publish({ active: true });
	await tick();
	expect(report).toHaveBeenCalled();
	failAlarms = false;
	publish({ active: true });
	await tick();
	expect(alarms.get(RECOVERY_ALARM)?.periodInMinutes).toBe(1);
});

it("detach stops local timers but leaves recovery for stored work and does not resume the closed Harness", async () => {
	await start({ active: false, at: Date.now() + 1000 });
	work.detach();
	await tick();
	expect(work.latest).toBeUndefined();
	expect(work.keepalive).toBe(false);
	expect(alarms.has(RECOVERY_ALARM)).toBe(true);
	await vi.advanceTimersByTimeAsync(20_000);
	expect(host.resume).not.toHaveBeenCalled();
	expect(getPlatformInfo).not.toHaveBeenCalled();
});

it("does not mask a mutation's error or clear recovery when the Harness fails before closed settles", async () => {
	await start({ active: true });
	const broken = {
		wake: () => {
			throw Error("Session failed");
		},
		resume: vi.fn(),
	};
	// Model the already-bound host failing inside a commit, before its closed notification.
	const wake = vi.spyOn(host, "wake").mockImplementation(broken.wake);
	await expect(
		work.admit(async () => {
			throw Error("original failure");
		}),
	).rejects.toThrow("original failure");
	await tick();
	expect(work.latest).toBeUndefined();
	expect(work.keepalive).toBe(false);
	expect(alarms.has(RECOVERY_ALARM)).toBe(true);
	wake.mockRestore();
});
