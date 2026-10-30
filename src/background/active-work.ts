import type { Harness, Wake } from "@earendil-works/pi-durable";

const KEEPALIVE_INTERVAL_MS = 20_000;
const SHORT_SLEEP_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const KEEPALIVE_KEY = "keepaliveEnabled";
export const RECOVERY_ALARM = "recovery";

const report = (error: unknown) => console.error("[pi-aside] recovery alarm", error);

/** Host scheduling for pi-durable's Wake: keep active/near-deadline work alive and recover evicted workers. */
export class ActiveWork {
	readonly #changed: () => void;
	#host: Pick<Harness, "wake" | "resume"> | undefined;
	#latest: Wake | undefined;
	/** Local resumes stay disabled until the breaker, bindings, and registry initialization have finished. */
	#ready = false;
	#loaded = false;
	#interval: ReturnType<typeof setInterval> | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#admitting = 0;
	#alarm: Promise<void> = Promise.resolve();
	/** The `when` of the one-shot alarm this worker created last; Chrome may report a later `scheduledTime` for it. */
	#armedAt: number | undefined;
	/** Probe switch, persisted: off lets Chrome stop the worker during a long request. */
	enabled = true;

	constructor(changed: () => void) {
		this.#changed = changed;
	}

	get latest(): Wake | undefined {
		return this.#latest;
	}

	get keepalive(): boolean {
		return this.#interval !== undefined;
	}

	/** Harness callback: never awaits Chrome I/O. Each queued alarm write uses the state current when it runs. */
	wake(wake: Wake): void {
		this.#latest = { ...wake };
		void this.#update().catch(report);
	}

	/** Binds a paused Harness and arms recovery, but cannot resume it from a timer yet. */
	async attach(host: Pick<Harness, "wake" | "resume">): Promise<void> {
		this.#host = host;
		this.#ready = false;
		if (!this.#loaded) {
			const saved = await chrome.storage.local.get(KEEPALIVE_KEY);
			// A switch change during the read wins over the older saved value.
			if (!this.#loaded) {
				this.enabled = saved[KEEPALIVE_KEY] !== false;
				this.#loaded = true;
			}
		}
		this.#latest = host.wake();
		await this.#update();
	}

	/** Call after startup policy, immediately before the initial resume(). */
	async start(): Promise<void> {
		if (this.#host === undefined) throw new Error("The Harness is not attached");
		this.#latest = this.#host.wake();
		await this.#update();
		this.#ready = true;
		this.wake(this.#host.wake());
	}

	/** Stop local scheduling for a closed/failed Harness; leave its durable recovery alarm intact. */
	detach(): void {
		this.#host = undefined;
		this.#latest = undefined;
		this.#ready = false;
		void this.#update().catch(report);
	}

	/** Arm fallback recovery before any operation that can start work, including aborts and registry changes. */
	async admit<T>(operation: () => Promise<T>): Promise<T> {
		this.#admitting += 1;
		try {
			await this.#update();
			return await operation();
		} finally {
			this.#admitting -= 1;
			// onWake runs after a commit. Read synchronously too, so a delayed callback cannot clear recovery in between.
			try {
				if (this.#host !== undefined) this.#latest = this.#host.wake();
			} catch {
				// Storage failure can seal the Harness before its closed promise settles. Preserve the original error.
				this.detach();
			}
			void this.#update().catch(report);
		}
	}

	async setEnabled(enabled: boolean): Promise<void> {
		await chrome.storage.local.set({ [KEEPALIVE_KEY]: enabled });
		this.enabled = enabled;
		this.#loaded = true;
		await this.#update();
	}

	#update(): Promise<void> {
		const wake = this.#latest;
		const now = Date.now();
		const near = wake?.at !== undefined && wake.at - now < SHORT_SLEEP_MS;
		const keepalive = this.#loaded && this.enabled && (wake?.active === true || near);
		if (keepalive && this.#interval === undefined) {
			this.#interval = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEPALIVE_INTERVAL_MS);
		} else if (!keepalive && this.#interval !== undefined) {
			clearInterval(this.#interval);
			this.#interval = undefined;
		}

		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		const host = this.#host;
		if (this.#ready && host !== undefined && wake?.at !== undefined) {
			const at = wake.at;
			// If the worker stays alive during a long sleep, enter the <60 s keepalive window without another onWake.
			const next = this.enabled && !wake.active && !near ? at - SHORT_SLEEP_MS + 1 : at;
			this.#timer = setTimeout(
				() => {
					this.#timer = undefined;
					if (this.#host !== host || !this.#ready) return;
					try {
						// The sleep was already admitted and has a recovery alarm. A local timer avoids Chrome's alarm floor.
						if (Date.now() >= at) host.resume();
						this.wake(host.wake());
					} catch (error) {
						this.detach();
						report(error);
					}
				},
				Math.min(MAX_TIMEOUT_MS, Math.max(0, next - now)),
			);
		}
		this.#changed();

		const result = this.#alarm.then(async () => {
			const current = this.#latest;
			const active = current?.active === true || this.#admitting > 0;
			// Detached/unknown: stored work may still need the alarm. Do not cancel it on close or failed open.
			if (!active && current === undefined) return;
			if (!active && current?.at === undefined) {
				await chrome.alarms.clear(RECOVERY_ALARM);
				return;
			}
			const alarm = await chrome.alarms.get(RECOVERY_ALARM);
			if (active) {
				// Recreating an unchanged periodic alarm on every update would postpone recovery indefinitely.
				if (alarm?.periodInMinutes !== 1) await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
			} else {
				const at = current?.at;
				// A packed extension's alarm fires 30 s out at the earliest. Recreating one Chrome moved later on every update
				// would postpone it each time, so an alarm this worker created for `at` counts as armed.
				const armed =
					alarm !== undefined &&
					alarm.periodInMinutes === undefined &&
					(alarm.scheduledTime === at || this.#armedAt === at);
				if (at !== undefined && !armed) {
					await chrome.alarms.create(RECOVERY_ALARM, { when: at });
					this.#armedAt = at;
				}
			}
		});
		this.#alarm = result.catch(() => {});
		return result;
	}
}
