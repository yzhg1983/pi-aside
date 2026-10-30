import {
	type Api,
	type AssistantMessageEventStream,
	type Credential,
	type CredentialStore,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";
import { createModels, ModelsError, type MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelRef } from "@earendil-works/pi-durable";
import { t } from "../shared/i18n.ts";
import { MAX_IMAGES } from "../shared/images.ts";
import {
	isProvider,
	PROVIDERS,
	type ProviderId,
	RECOMMENDED_MODELS,
	type SentThinking,
	subscriptionToken,
	THINKING_LEVELS,
	type Thinking,
} from "../shared/protocol.ts";
import { chatgptOAuth, fetchPlanModels, PLAN_ORIGINS, TokenError } from "./chatgpt.ts";
import { ChromeCredentialStore } from "./credentials.ts";
import { openaiSearch } from "./web-search.ts";

export const credentials = new ChromeCredentialStore();

/** A ChatGPT sign-in: stored for OpenAI only (design 6.20). */
function signedIn(providerId: string, credential: Credential | undefined): credential is OAuthCredential {
	return credential?.type === "oauth" && providerId === "openai";
}

/** A ChatGPT sign-in that OpenAI ended: its tokens are cleared, its account and ID token kept for the next one. */
export function signInEnded(credential: Credential | undefined): boolean {
	return credential?.type === "oauth" && credential.ended === true;
}

/**
 * Clears the tokens of a sign-in that OpenAI ended, if it is still the stored one. Not awaited by the refresh that
 * found it: pi-ai holds the store's lock during a refresh, and this change waits for it.
 */
function endSignIn(refresh: string): Promise<void> {
	return credentials
		.modify("openai", async (current) =>
			current?.type === "oauth" && current.refresh === refresh
				? { ...current, access: "", refresh: "", expires: 0, ended: true }
				: undefined,
		)
		.then(() => {});
}

/** Host access to the provider's API; a ChatGPT sign-in needs the token endpoint too, for refreshes (design 6.20). */
export function hasHostPermission(provider: string, credential?: Credential): Promise<boolean> {
	if (!isProvider(provider)) return Promise.resolve(false);
	return chrome.permissions.contains({
		origins: signedIn(provider, credential) ? PLAN_ORIGINS : [PROVIDERS[provider].origin],
	});
}

/**
 * A stored subscription token, which pi does not use: pi-ai would take it for a subscription sign-in by its value,
 * whatever its type (design 6.19). Saving refuses one; this covers a value stored any other way.
 */
function subscription(providerId: string, credential: Credential | undefined): boolean {
	return (
		credential?.type === "api_key" && isProvider(providerId) && subscriptionToken(providerId, credential.key ?? "")
	);
}

/**
 * pi-ai reads the key for every request, recovered ones included. Without the provider's host permission it gets no
 * key: the permission is the user's switch, and a request without it could still pass where the provider allows CORS.
 * It gets none for a subscription token stored as a key, for a sign-in of another provider than OpenAI, or for an ended
 * sign-in.
 */
const requestCredentials: CredentialStore = {
	read: async (providerId, options) => {
		const credential = await credentials.read(providerId, options);
		if (
			credential?.type === "oauth"
				? !signedIn(providerId, credential) || signInEnded(credential)
				: subscription(providerId, credential)
		) {
			return undefined;
		}
		return (await hasHostPermission(providerId, credential)) ? credential : undefined;
	},
	list: (options) => credentials.list(options),
	modify: (providerId, fn, options) => credentials.modify(providerId, fn, options),
	delete: (providerId, options) => credentials.delete(providerId, options),
};

/**
 * Models for the browser. The auth context replaces pi-ai's default one, which resolves environment variables and files
 * through a dynamic `import()` that service workers reject.
 */
export const models: MutableModels = createModels({
	credentials: requestCredentials,
	authContext: { env: async () => undefined, fileExists: async () => false },
});
models.setProvider(openrouterProvider());

const openai = openaiProvider();

/**
 * A ChatGPT plan's context windows, by model ID, from pi-ai's Codex catalog. pi-aside's sign-in reaches the plan
 * through api.openai.com (Sign in with ChatGPT), so pi-ai gives it the API's windows; pi's TUI reaches it through the
 * Codex backend, whose windows are the plan's defaults: GPT-6.1 Sol 272k against 500k. Each catalog is right for its
 * route; pi-aside applies the plan's default to its route. The window decides the context line and when pi-durable
 * compacts (design 6.21). Should the API route allow less, pi-durable's overflow recovery compacts and sends again.
 * Remove once pi-ai's OpenAI provider gives a sign-in the plan's windows.
 */
const PLAN_WINDOWS = new Map<string, number>(
	Object.values(OPENAI_CODEX_MODELS).map((model) => [model.id, model.contextWindow]),
);
/** Whether the OpenAI credential is a ChatGPT sign-in, as last read: set by `syncPlanWindows()`. */
let onPlanWindows = false;

/** The models with a plan's windows where they differ; the same objects otherwise (classifiers have no window). */
function withPlanWindows<T extends { readonly id: string }>(list: readonly T[]): T[] {
	return list.map((model) => {
		const window = PLAN_WINDOWS.get(model.id);
		if (window === undefined || !("contextWindow" in model) || model.contextWindow === window) return model;
		return { ...model, contextWindow: window };
	});
}
const planChatModels = withPlanWindows(openai.getModels());
const planAllModels = withPlanWindows(openai.getAllModels?.() ?? openai.getModels());

/**
 * Reads whether the OpenAI credential is a ChatGPT sign-in, so OpenAI's models carry a plan's windows or the API's:
 * at the worker's start before work resumes, when access is read again after a credential change, and before a send.
 */
export async function syncPlanWindows(): Promise<void> {
	onPlanWindows = (await credentials.read("openai"))?.type === "oauth";
}
/**
 * A ChatGPT plan does not bill per token (design 6.20): an answer made with a sign-in token has 0 as its cost's total,
 * and keeps the parts at list prices, an estimate that the usage line adds to the others (6.21).
 */
function onPlan(apiKey: string | undefined, source: AssistantMessageEventStream): AssistantMessageEventStream {
	if (apiKey === undefined || !subscriptionToken("openai", apiKey)) return source;
	const out = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of source) {
			if (event.type === "done") event.message.usage.cost.total = 0;
			else if (event.type === "error") event.error.usage.cost.total = 0;
			out.push(event);
		}
		out.end();
	})();
	return out;
}
const openaiWithPlan: Provider<"openai-responses"> = {
	...openai,
	getModels: () => (onPlanWindows ? planChatModels : openai.getModels()),
	getAllModels: () => (onPlanWindows ? planAllModels : (openai.getAllModels?.() ?? openai.getModels())),
	// pi-ai's own sign-in imports `node:http`; this one runs in the worker.
	auth: {
		...openai.auth,
		oauth: {
			...chatgptOAuth,
			async refresh(credential, signal) {
				try {
					return await chatgptOAuth.refresh(credential, signal);
				} catch (error) {
					if (error instanceof TokenError && error.ended) void endSignIn(credential.refresh).catch(() => {});
					throw error;
				}
			},
		},
	},
	stream: (model, context, options) => {
		const search = openaiSearch(options);
		return onPlan(options?.apiKey, search.wrap(openai.stream(model, context, search.options)));
	},
	streamSimple: (model, context, options) => {
		const search = openaiSearch(options);
		return onPlan(options?.apiKey, search.wrap(openai.streamSimple(model, context, search.options)));
	},
};
models.setProvider(openaiWithPlan);
models.setProvider(anthropicProvider());
models.setProvider(deepseekProvider());

/** Rejects, before admission, a send that could not reach the model. Saving a key never sends anything. */
export async function checkModel({ provider, modelId }: ModelRef): Promise<void> {
	if (!isProvider(provider) || models.getModel(provider, modelId) === undefined) {
		throw new Error(t("modelUnknown", [provider, modelId]));
	}
	const { name } = PROVIDERS[provider];
	const credential = await credentials.read(provider);
	if (provider === "openai") onPlanWindows = credential?.type === "oauth";
	if (signInEnded(credential)) throw new Error(t("signInEnded"));
	if (!signedIn(provider, credential)) {
		if (credential?.type !== "api_key" || !credential.key) throw new Error(t("providerKeyMissing", [name]));
		if (subscription(provider, credential)) throw new Error(t("providerSubscriptionRefused", [name]));
	}
	if (!(await hasHostPermission(provider, credential))) {
		throw new Error(t("providerPermissionMissing", [name]));
	}
}

/**
 * The model a provider starts with: the recommended one, unless the ChatGPT plan's list leaves it out; then the plan's
 * first model that pi-ai knows, or none (design 6.20).
 */
export function startingModel(provider: ProviderId, planModels: readonly string[] | null): string | null {
	const recommended = RECOMMENDED_MODELS[provider];
	if (planModels === null || planModels.includes(recommended)) return recommended;
	return models.getModels(provider).find((model) => planModels.includes(model.id))?.id ?? null;
}

/** pi-ai's thinking levels, lowest first. */
const MODEL_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The level a chat on `model` thinks at for the `level` setting (design 6.35): the level, else the nearest lower level
 * the model has, so a missing level never costs more; only when it has none lower, the nearest higher. A setting above
 * Off never becomes Off. A model without reasoning gets Off, which sends no level.
 */
export function chosenThinking(model: Model<Api>, level: Thinking): ModelThinkingLevel {
	if (level === "off") return "off";
	const has = getSupportedThinkingLevels(model);
	const lower = MODEL_LEVELS.slice(1, MODEL_LEVELS.indexOf(level) + 1)
		.reverse()
		.find((each) => has.includes(each));
	return lower ?? clampThinkingLevel(model, level);
}

/** `chosenThinking()` for a model by reference; a model not in the catalog gets the setting, for pi-ai to fit. */
export function thinkingFor(ref: ModelRef, level: Thinking): ModelThinkingLevel {
	const model = models.getModel(ref.provider, ref.modelId);
	return model === undefined ? level : chosenThinking(model, level);
}

/**
 * How many images a request of the model may carry: pi's own cap, or the model's lower one; null when the model cannot
 * read images or is not in the catalog (design 6.26, 6.42).
 */
export function imageLimit(ref: ModelRef): number | null {
	const model = models.getModel(ref.provider, ref.modelId);
	if (model === undefined || !model.input.includes("image")) return null;
	return Math.min(MAX_IMAGES, model.inputLimits?.images?.maxPerRequest ?? MAX_IMAGES);
}

/**
 * What `model` gets for each thinking level (design 6.35), as `chosenThinking()` picks it. Off sends no level, so on a
 * model that cannot turn thinking off the provider's default applies.
 */
export function sentThinking(model: Model<Api>): Record<Thinking, SentThinking> {
	const canTurnOff = getSupportedThinkingLevels(model).includes("off");
	return Object.fromEntries(
		THINKING_LEVELS.map((level) => [
			level,
			level === "off" ? (canTurnOff ? "off" : "default") : chosenThinking(model, level),
		]),
	) as Record<Thinking, SentThinking>;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/**
 * Cheap endpoints that answer only with a valid key, and the key's headers. They check access to that endpoint only: a
 * 2xx means "accepted here", not "every model usable"; a 403 may mean the key lacks permission for this endpoint, such
 * as an OpenAI key without `api.model.read`, while sends still work (design 6.19).
 */
const VERIFY: Record<ProviderId, { url: string; headers: (key: string) => Record<string, string> }> = {
	openrouter: { url: "https://openrouter.ai/api/v1/key", headers: bearer },
	openai: { url: "https://api.openai.com/v1/models", headers: bearer },
	anthropic: {
		url: "https://api.anthropic.com/v1/models",
		headers: (key) => ({
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		}),
	},
	deepseek: { url: "https://api.deepseek.com/models", headers: bearer },
};

export type KeyCheck =
	| "accepted"
	| "expired"
	| "rejected"
	| "forbidden"
	| "limited"
	| "no_key"
	| "no_permission"
	| "timeout"
	| "network_error";

const REFUSED: Record<number, KeyCheck> = { 401: "rejected", 403: "forbidden", 429: "limited" };

export async function verifyKey(provider: ProviderId): Promise<{ result: KeyCheck; status?: number }> {
	const credential = await credentials.read(provider);
	if (signedIn(provider, credential)) return verifyPlan(credential);
	// A subscription token is never sent, not even to check it.
	if (credential?.type !== "api_key" || !credential.key || subscription(provider, credential)) {
		return { result: "no_key" };
	}
	if (!(await hasHostPermission(provider))) return { result: "no_permission" };
	try {
		const { url, headers } = VERIFY[provider];
		const response = await fetch(url, { headers: headers(credential.key), signal: AbortSignal.timeout(10_000) });
		// The body may describe the account; it is not read or logged.
		await response.body?.cancel();
		if (response.ok) return { result: "accepted", status: response.status };
		return { result: REFUSED[response.status] ?? "network_error", status: response.status };
	} catch (error) {
		return { result: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network_error" };
	}
}

/**
 * What a failed refresh means. OpenAI's error code decides: `expired` only for an ended session (design 6.20). A
 * timeout, a network failure, or a 5xx may pass; the sign-in stays either way.
 */
function refreshFailure(cause: unknown): { result: KeyCheck; status?: number } {
	if (cause instanceof TokenError) {
		const result = cause.ended ? "expired" : cause.status >= 500 ? "network_error" : "rejected";
		return { result, status: cause.status };
	}
	return { result: cause instanceof DOMException && cause.name === "TimeoutError" ? "timeout" : "network_error" };
}

/**
 * A ChatGPT sign-in: the token as a request would get it, refreshed if due, then the plan's models, which the model
 * list shows. They are stored only for the same registration: a sign-in to another account may have replaced it.
 */
async function verifyPlan(credential: OAuthCredential): Promise<{ result: KeyCheck; status?: number }> {
	if (signInEnded(credential)) return { result: "expired" };
	let access: string | undefined;
	try {
		access = (await models.getAuth("openai"))?.auth.apiKey;
	} catch (error) {
		return refreshFailure(error instanceof ModelsError && error.code === "oauth" ? error.cause : error);
	}
	// A credential that passed `signedIn()` gives no token only without the host access it needs.
	if (access === undefined) return { result: "no_permission" };
	try {
		const { status, models: planModels } = await fetchPlanModels(access);
		if (status < 200 || status > 299) return { result: REFUSED[status] ?? "network_error", status };
		if (planModels !== null) {
			await credentials.modify("openai", async (current) =>
				current?.type === "oauth" && current.clientId === credential.clientId
					? { ...current, planModels }
					: undefined,
			);
		}
		return { result: "accepted", status };
	} catch (error) {
		return { result: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network_error" };
	}
}
