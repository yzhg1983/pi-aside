import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import { createStorageConformance, type StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";

export type CaseResult = { name: string; ok: boolean; ms: number; error?: string };

/** pi-durable's storage conformance suite against the IndexedDB backend, inside the service worker. */
export async function runConformance(): Promise<CaseResult[]> {
	const cases = createStorageConformance({
		assertions,
		withStorage: async (use) => {
			const name = `conformance-${crypto.randomUUID()}`;
			try {
				const storage = await IndexedDbStorage.open(name);
				try {
					await use(storage);
				} finally {
					await storage.close(BACKGROUND_CONTEXT);
				}
			} finally {
				await IndexedDbStorage.delete(name);
			}
		},
	});
	const results: CaseResult[] = [];
	for (const testCase of cases) {
		const started = performance.now();
		try {
			await testCase.run();
			results.push({ name: testCase.name, ok: true, ms: Math.round(performance.now() - started) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results.push({ name: testCase.name, ok: false, ms: Math.round(performance.now() - started), error: message });
		}
	}
	return results;
}

/** Vitest `toEqual`/`toMatchObject` semantics, enough for the suite: undefined properties count as absent. */
const assertions: StorageConformanceAssertions = {
	ok(value, message) {
		if (!value) throw new Error(message ?? `expected truthy, got ${describe(value)}`);
	},
	strictEqual(actual, expected) {
		if (!Object.is(actual, expected)) throw new Error(`expected ${describe(expected)}, got ${describe(actual)}`);
	},
	deepEqual(actual, expected) {
		if (!equal(actual, expected, false)) throw new Error(`expected ${describe(expected)}, got ${describe(actual)}`);
	},
	partialDeepEqual(actual, expected) {
		if (!equal(actual, expected, true))
			throw new Error(`expected to contain ${describe(expected)}, got ${describe(actual)}`);
	},
	greaterThan(actual, expected) {
		if (!(actual > expected)) throw new Error(`expected ${actual} > ${expected}`);
	},
	async rejects(operation, messageIncludes) {
		try {
			await operation;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes(messageIncludes)) return;
			throw new Error(`expected rejection containing "${messageIncludes}", got "${message}"`);
		}
		throw new Error(`expected rejection containing "${messageIncludes}", but it resolved`);
	},
};

function equal(actual: unknown, expected: unknown, partial: boolean): boolean {
	if (Object.is(actual, expected)) return true;
	if (typeof actual !== "object" || typeof expected !== "object" || actual === null || expected === null) return false;
	if (ArrayBuffer.isView(actual) || ArrayBuffer.isView(expected)) {
		if (!ArrayBuffer.isView(actual) || !ArrayBuffer.isView(expected)) return false;
		const a = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
		const b = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
		return a.length === b.length && a.every((byte, i) => byte === b[i]);
	}
	if (Array.isArray(actual) !== Array.isArray(expected)) return false;
	if (Array.isArray(actual) && Array.isArray(expected)) {
		return actual.length === expected.length && expected.every((item, i) => equal(actual[i], item, partial));
	}
	const a = actual as Record<string, unknown>;
	const b = expected as Record<string, unknown>;
	const keys = (value: Record<string, unknown>) => Object.keys(value).filter((key) => value[key] !== undefined);
	if (!partial && keys(a).length !== keys(b).length) return false;
	return keys(b).every((key) => equal(a[key], b[key], partial));
}

function describe(value: unknown): string {
	try {
		return (
			JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item))?.slice(0, 300) ??
			"undefined"
		);
	} catch {
		return String(value);
	}
}
