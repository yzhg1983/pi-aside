import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { serial } from "./chats.ts";

export const STORAGE_KEY = "credentials";
const STOPPING_KEY = "stoppingProviders";

/**
 * Changes of a provider's credential, one at a time: saving and removing a key, a ChatGPT sign-in's start, claim,
 * Cancel, and save, and sign-out. A removal holds the queue until the provider's work has stopped, so no other
 * credential is saved while work of the removed one still runs (design 6.20).
 */
export const credentialChanges = serial();

/** The markers' read-modify-writes, one at a time: the worker start removes markers outside `credentialChanges`. */
const markerChanges = serial();

/**
 * Providers whose credential a removal deleted before their work had stopped, each with its removal's token. In
 * `storage.local`, so the next worker start stops that work before anything resumes, if a worker stop cut the removal
 * short.
 */
export async function stopMarkers(): Promise<Record<string, string>> {
	const stored: unknown = (await chrome.storage.local.get(STOPPING_KEY))[STOPPING_KEY];
	const markers = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {};
	return Object.fromEntries(Object.entries(markers).filter(([, token]) => typeof token === "string"));
}

/** Marks `provider` as stopping. The token removes this marker only, not one that a later removal set. */
export function markStopping(provider: string): Promise<string> {
	return markerChanges(async () => {
		const token = crypto.randomUUID();
		await chrome.storage.local.set({ [STOPPING_KEY]: { ...(await stopMarkers()), [provider]: token } });
		return token;
	});
}

export function unmarkStopping(provider: string, token: string): Promise<void> {
	return markerChanges(async () => {
		const { [provider]: current, ...others } = await stopMarkers();
		if (current === token) await chrome.storage.local.set({ [STOPPING_KEY]: others });
	});
}

type StoredCredentials = Record<string, Credential>;

/**
 * pi-ai credentials in `chrome.storage.local`, plaintext in the browser profile. Only the service worker writes them;
 * mutations run one at a time so two `modify()` calls cannot overwrite each other.
 */
export class ChromeCredentialStore implements CredentialStore {
	#tail: Promise<unknown> = Promise.resolve();
	#restricted: Promise<void> | undefined;

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return (await this.#load())[providerId];
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(await this.#load()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#serial(async () => {
			const stored = await this.#load();
			const current = stored[providerId];
			const next = await fn(current);
			options?.signal?.throwIfAborted();
			// Like pi-ai's in-memory store: undefined keeps the current credential; delete() removes it.
			if (next === undefined) return current;
			await chrome.storage.local.set({ [STORAGE_KEY]: { ...stored, [providerId]: next } });
			return next;
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.take(providerId);
	}

	/** Deletes the credential, and returns it as it was then: after what a `modify()` before it, a refresh, wrote. */
	take(providerId: string): Promise<Credential | undefined> {
		return this.#serial(async () => {
			const { [providerId]: removed, ...rest } = await this.#load();
			await chrome.storage.local.set({ [STORAGE_KEY]: rest });
			return removed;
		});
	}

	async #load(): Promise<StoredCredentials> {
		await this.#restrict();
		const stored = await chrome.storage.local.get(STORAGE_KEY);
		return (stored[STORAGE_KEY] as StoredCredentials | undefined) ?? {};
	}

	/**
	 * By default `storage.local` is readable from content scripts, which run inside web pages. Every read and write waits
	 * for this, and fails while it fails: keys are never used from storage that pages can reach.
	 */
	#restrict(): Promise<void> {
		this.#restricted ??= chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch((error) => {
			this.#restricted = undefined;
			throw new Error(
				`Cannot restrict key storage to the extension: ${error instanceof Error ? error.message : error}`,
			);
		});
		return this.#restricted;
	}

	#serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
