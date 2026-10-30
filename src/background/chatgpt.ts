import type { Credential, CredentialStore, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { t } from "../shared/i18n.ts";
import { CHATGPT, PROVIDERS, SIGN_IN_ENDED_CODES } from "../shared/protocol.ts";
import { credentialChanges, stopMarkers } from "./credentials.ts";

// Sign in with ChatGPT (design 6.20). OpenAI redirects the browser to a loopback address that nothing listens on: a
// session rule, matching this sign-in's `state` only, sends that URL to the callback page before Chrome connects.

const AUTH_ORIGIN = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_ORIGIN}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${AUTH_ORIGIN}/.well-known/openid-configuration`;
const MODELS_URL = "https://api.openai.com/v1/models";
const RESOURCE = "https://api.openai.com/v1";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
/** As in pi-ai: a token counts as expired this long before OpenAI's expiry. */
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;
/** Clock difference allowed for the ID token's `exp`. */
const CLOCK_LEEWAY_S = 60;
const SIGN_IN_MS = 10 * 60 * 1000;
const RULE_ID = 1;
const PENDING_KEY = "chatgptSignIn";
const LATEST_KEY = "chatgptLatest";
const ACCOUNT_KEY = "chatgptAccount";
const INSTALL_KEY = "installId";
const WELCOMED_KEY = "chatgptWelcomed";

export const EXPIRE_ALARM = "chatgpt-expire";
export const CALLBACK_PAGE = "chatgpt-callback.html";

/**
 * The account pi-aside signs in to: OpenAI's registration of pi-aside with it. While a sign-in is stored, its fields
 * are the account; `chatgptAccount` keeps a copy, without tokens, for the sign-in after a sign-out.
 */
export type Account = { clientId: string; subject: string; email: string | null };

/**
 * The one sign-in in progress, in `storage.session`. `verifier` is the PKCE secret; it never leaves the worker.
 * `account`: the saved account it re-authorizes, or null for a new registration.
 */
type Pending = { state: string; nonce: string; verifier: string; startedAt: number; account: Account | null };

/**
 * The stored sign-in: pi-ai's OAuth credential, its account, and the plan's model IDs once a fetch succeeded. `ended`:
 * OpenAI ended the session; the tokens are cleared, and the ID token stays as the next sign-in's `id_token_hint`.
 */
export type PlanCredential = OAuthCredential & {
	clientId: string;
	subject: string;
	email: string | null;
	idToken: string;
	scopes: string[];
	planModels?: string[];
	ended?: true;
};

/**
 * A token endpoint refusal: the HTTP status and OpenAI's error code, never the body, which could echo a token. For a
 * refresh, the code tells an ended session from a failure that may pass (design 6.20).
 */
export class TokenError extends Error {
	readonly status: number;
	readonly code: string | null;

	constructor(status: number, code: string | null) {
		// pi-ai persists this technical cause in an OAuth error. Keep its format stable; the UI translates the explanation.
		super(`OpenAI sign-in failed (${status}${code === null ? "" : `: ${code}`})`);
		this.name = "TokenError";
		this.status = status;
		this.code = code;
	}

	/** Only a new sign-in helps. */
	get ended(): boolean {
		return this.code !== null && SIGN_IN_ENDED_CODES.includes(this.code);
	}
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(
		text
			.replaceAll("-", "+")
			.replaceAll("_", "/")
			.padEnd(Math.ceil(text.length / 4) * 4, "="),
	);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function readPending(): Promise<Pending | undefined> {
	const pending = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] as Pending | undefined;
	// The stored start decides: an alarm that comes late, or never, cannot extend a sign-in.
	return pending !== undefined && Date.now() < pending.startedAt + SIGN_IN_MS ? pending : undefined;
}

/** Whether a sign-in waits for its callback. */
export async function signInWaiting(): Promise<boolean> {
	return (await readPending()) !== undefined;
}

function accountOf(value: unknown): Account | null {
	const { clientId, subject, email } = record(value);
	if (typeof clientId !== "string" || typeof subject !== "string") return null;
	return { clientId, subject, email: typeof email === "string" ? email : null };
}

/** The stored sign-in's account, else the copy kept from the last one. */
export async function savedAccount(store: CredentialStore): Promise<Account | null> {
	const stored = await store.read("openai");
	return (
		(stored?.type === "oauth" ? accountOf(stored) : null) ??
		accountOf((await chrome.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY])
	);
}

/** Sign-out keeps the sign-in's account before it deletes the sign-in. */
export async function keepAccount(credential: Credential): Promise<void> {
	const account = accountOf(credential);
	if (account !== null) await chrome.storage.local.set({ [ACCOUNT_KEY]: account });
}

/** The ID OpenAI knows this installation by, made at the first sign-in. */
async function installId(): Promise<string> {
	const stored = (await chrome.storage.local.get(INSTALL_KEY))[INSTALL_KEY];
	if (typeof stored === "string") return stored;
	const id = crypto.randomUUID();
	await chrome.storage.local.set({ [INSTALL_KEY]: id });
	return id;
}

/**
 * A new registration names pi-aside; signing in to the saved account reuses its client ID, with its email as
 * `login_hint`, and with `id_token_hint` while its sign-in is still stored.
 */
export async function authorizeUrl(pending: Pending, hostId: string, idTokenHint: string | null): Promise<string> {
	const challenge = base64url(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier))),
	);
	const { account } = pending;
	const params = new URLSearchParams({
		client_id: account?.clientId ?? "dynamic_agent_client",
		...(account === null ? { agent_name_hint: "pi-aside" } : {}),
		ext_agent_host_id: `urn:uuid:${hostId}`,
		...(account?.email ? { login_hint: account.email } : {}),
		...(idTokenHint === null ? {} : { id_token_hint: idTokenHint }),
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
		scope: SCOPE,
		state: pending.state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		nonce: pending.nonce,
	});
	return `${AUTHORIZE_URL}?${params}`;
}

/**
 * Redirects this sign-in's callback to the extension page, query kept. Only its `state` matches, in its exact case,
 * so a CLI login that waits on port 1455 meanwhile still gets its own callback. `state` is base64url: no character
 * needs escaping.
 */
export function callbackRule(state: string): chrome.declarativeNetRequest.Rule {
	return {
		id: RULE_ID,
		priority: 1,
		condition: {
			regexFilter: `^${REDIRECT_URI.replaceAll(".", "\\.")}\\?(.*&)?state=${state}(&|$)`,
			isUrlFilterCaseSensitive: true,
			resourceTypes: ["main_frame"],
		},
		action: {
			type: "redirect",
			redirect: {
				transform: { scheme: "chrome-extension", host: chrome.runtime.id, port: "", path: `/${CALLBACK_PAGE}` },
			},
		},
	};
}

/**
 * Starts a sign-in in a new tab next to `openerTabId`: to the saved account, or with `another`, a new registration
 * that replaces the saved account once it succeeds. A sign-in still waiting, or still finishing, is replaced.
 */
export function startSignIn(openerTabId: number | undefined, store: CredentialStore, another: boolean): Promise<void> {
	return credentialChanges(async () => {
		const account = another ? null : await savedAccount(store);
		const stored = account === null ? undefined : await store.read("openai");
		const idTokenHint = stored?.type === "oauth" && typeof stored.idToken === "string" ? stored.idToken : null;
		const pending: Pending = { state: random(), nonce: random(), verifier: random(), startedAt: Date.now(), account };
		await chrome.storage.session.set({ [PENDING_KEY]: pending, [LATEST_KEY]: pending.state });
		await chrome.declarativeNetRequest.updateSessionRules({
			removeRuleIds: [RULE_ID],
			addRules: [callbackRule(pending.state)],
		});
		await chrome.alarms.create(EXPIRE_ALARM, { when: pending.startedAt + SIGN_IN_MS });
		const url = await authorizeUrl(pending, await installId(), idTokenHint);
		const opener = openerTabId === undefined ? undefined : await chrome.tabs.get(openerTabId).catch(() => undefined);
		await chrome.tabs.create(
			opener === undefined
				? { url }
				: { url, windowId: opener.windowId, index: opener.index + 1, openerTabId: opener.id },
		);
	});
}

/**
 * Removes the waiting sign-in's record, rule, and alarm, and the loopback permission, which only a sign-in needs.
 * Removing that fails where it was granted at install (the end-to-end build); it is not needed then.
 */
async function clear(): Promise<void> {
	await chrome.storage.session.remove(PENDING_KEY);
	await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
	await chrome.alarms.clear(EXPIRE_ALARM);
	await chrome.permissions.remove({ origins: [CHATGPT.loopback] }).catch(() => false);
}

/** Cancel, and sign-out: ends the waiting sign-in, and one that is finishing is not stored. */
export function cancelSignIn(): Promise<void> {
	return credentialChanges(async () => {
		await chrome.storage.session.remove(LATEST_KEY);
		await clear();
	});
}

/**
 * At worker start and at the expiry alarm: with no sign-in waiting, removes what an expired sign-in or a worker
 * stopped halfway left behind.
 */
export function tidySignIn(): Promise<void> {
	return credentialChanges(async () => {
		if ((await readPending()) === undefined) await clear();
	});
}

/** Takes the waiting sign-in for this callback, once, and ends it: one callback per sign-in, whatever its outcome. */
function claim(state: string | null): Promise<Pending> {
	return credentialChanges(async () => {
		const pending = await readPending();
		if (pending === undefined || state !== pending.state) throw new Error(t("authNotWaiting"));
		await clear();
		return pending;
	});
}

/** A JSON object from OpenAI, or an error that names the status only. */
async function fetchJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(t("authResponseStatus", [response.status]));
	}
	return record(await response.json());
}

/** OpenAI's discovery document. Its issuer, key set, and revocation endpoint must be on `auth.openai.com`. */
async function discovery(signal: AbortSignal): Promise<{ jwks: string; revocation: string }> {
	const { issuer, jwks_uri, revocation_endpoint } = await fetchJson(DISCOVERY_URL, signal);
	if (issuer !== AUTH_ORIGIN) throw new Error(t("authDiscoveryIssuer"));
	const onAuth = (value: unknown) => {
		if (typeof value !== "string" || new URL(value).origin !== AUTH_ORIGIN) {
			throw new Error(t("authDiscoveryEndpoint"));
		}
		return value;
	};
	return { jwks: onAuth(jwks_uri), revocation: onAuth(revocation_endpoint) };
}

/** OpenAI's key set, from the `jwks_uri` its discovery names. */
async function keySet(signal: AbortSignal): Promise<unknown> {
	return (await fetchJson((await discovery(signal)).jwks, signal)).keys;
}

/**
 * Validates an ID token as OpenAI asks: an RS256 signature (the only algorithm OpenAI's discovery lists) by the key of
 * OpenAI's key set that its `kid` names, the issuer, the client ID in its audience, its expiry, and a subject; with
 * `nonce`, the sign-in's nonce; with `subject`, the saved account. Returns the account it names.
 */
export async function verifyIdToken(
	token: string,
	expected: { clientId: string; nonce?: string; subject?: string },
	keys: unknown,
): Promise<{ subject: string; email: string | null }> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error(t("authNotJwt"));
	const [head = "", body = "", signature = ""] = parts;
	const json = (part: string) => record(JSON.parse(new TextDecoder().decode(fromBase64url(part))));
	const header = json(head);
	if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error(t("authNotRs256"));
	const jwk = (Array.isArray(keys) ? keys.map(record) : []).find(
		(key) => key.kid === header.kid && key.kty === "RSA" && (key.use === undefined || key.use === "sig"),
	);
	if (jwk === undefined || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
		throw new Error(t("authNoTokenKey"));
	}
	const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
	const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, algorithm, false, ["verify"]);
	const signed = new TextEncoder().encode(`${head}.${body}`);
	if (!(await crypto.subtle.verify(algorithm, key, fromBase64url(signature), signed))) {
		throw new Error(t("authInvalidSignature"));
	}
	const claims = json(body);
	const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (claims.iss !== AUTH_ORIGIN) throw new Error(t("authTokenIssuer"));
	if (!audience.includes(expected.clientId)) throw new Error(t("authTokenClient"));
	if (typeof claims.exp !== "number" || claims.exp + CLOCK_LEEWAY_S < Date.now() / 1000) {
		throw new Error(t("authTokenExpired"));
	}
	if (expected.nonce !== undefined && claims.nonce !== expected.nonce) {
		throw new Error(t("authTokenSignIn"));
	}
	if (typeof claims.sub !== "string" || claims.sub === "") throw new Error(t("authTokenAccount"));
	if (expected.subject !== undefined && claims.sub !== expected.subject) throw new Error(t("authOtherAccount"));
	return { subject: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}

type TokenResponse = Record<string, unknown>;

async function requestToken(body: Record<string, string>, signal: AbortSignal): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
		signal,
	});
	const data: unknown = await response.json().catch(() => undefined);
	const fields = record(data);
	if (!response.ok) {
		throw new TokenError(response.status, typeof fields.error === "string" ? fields.error.slice(0, 100) : null);
	}
	if (fields !== data) throw new Error(t("authTokenNotObject"));
	return fields;
}

function tokenString(token: TokenResponse, field: string): string {
	const value = token[field];
	if (typeof value !== "string" || value.trim() === "") throw new Error(t("authTokenFieldMissing", [field]));
	return value;
}

/** The token fields of a credential. A refresh without a new refresh token keeps the old one. */
function tokens(token: TokenResponse, refresh?: string) {
	const scopes = tokenString(token, "scope").trim().split(/\s+/);
	if (!scopes.includes(DIRECT_SCOPE)) throw new Error(t("authPlanNotGranted"));
	const expiresIn = token.expires_in;
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new Error(t("authInvalidExpiry"));
	}
	return {
		access: tokenString(token, "access_token"),
		refresh:
			refresh !== undefined && token.refresh_token === undefined ? refresh : tokenString(token, "refresh_token"),
		expires: Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS,
		scopes,
	};
}

/**
 * pi-ai's `openaiChatGPTOAuth` imports `node:http`, so the OpenAI provider gets this one instead. pi-ai calls `refresh`
 * inside the credential store's `modify()`, and wraps what it throws as the cause of a `ModelsError("oauth")`. A new
 * ID token must name the same account; without one, the stored one stays as the `id_token_hint`. So does it when
 * OpenAI's key set cannot be fetched: OpenAI has replaced the refresh token by then, so throwing would end the session.
 */
export const chatgptOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT plan)",
	isSubscription: true,
	loginLabel: "Continue with ChatGPT",
	login: () => Promise.reject(new Error(t("authUseSettings"))),
	async refresh(credential, signal) {
		const { clientId, subject } = credential;
		if (typeof clientId !== "string" || clientId === "") throw new Error(t("authNoClientId"));
		const token = await requestToken(
			{ grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh, resource: RESOURCE },
			signal,
		);
		const idToken = typeof token.id_token === "string" ? token.id_token : undefined;
		const keys = idToken === undefined ? undefined : await keySet(signal).catch(() => undefined);
		const checked = idToken !== undefined && keys !== undefined;
		if (checked)
			await verifyIdToken(idToken, { clientId, ...(typeof subject === "string" ? { subject } : {}) }, keys);
		return { ...credential, ...tokens(token, credential.refresh), ...(checked ? { idToken } : {}) };
	},
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

/**
 * The models the plan offers: `{models: [{slug, visibility}]}`, those with `visibility: "list"`. Null for an answer
 * of another shape: which models the plan offers is then unknown.
 */
export async function fetchPlanModels(access: string): Promise<{ status: number; models: string[] | null }> {
	const response = await fetch(MODELS_URL, {
		headers: { authorization: `Bearer ${access}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		return { status: response.status, models: null };
	}
	const list = record(await response.json().catch(() => undefined)).models;
	if (!Array.isArray(list)) return { status: response.status, models: null };
	const models = list.flatMap((model: unknown) => {
		const { slug, visibility } = record(model);
		return visibility === "list" && typeof slug === "string" ? [slug] : [];
	});
	return { status: response.status, models };
}

/**
 * Finishes the sign-in that waits for this callback, and stores it with its account. Throws with text for the callback
 * page. A grant that is not stored is revoked: its ID token failed, it is for another account, or a key, Cancel,
 * sign-out, or a newer sign-in came first.
 */
export async function finishSignIn(
	search: string,
	store: CredentialStore,
): Promise<{ welcome: boolean; credential: PlanCredential }> {
	const params = new URLSearchParams(search);
	const pending = await claim(params.get("state"));
	const error = params.get("error");
	if (error !== null) throw new Error(t("authDidNotConnect", [error.slice(0, 100)]));
	const code = params.get("code");
	// The callback to a saved account's sign-in may leave out the client ID; it must not name another one.
	const clientId = params.get("client_id")?.trim() || pending.account?.clientId;
	if (!code || !clientId || clientId === "dynamic_agent_client") throw new Error(t("authNotWaiting"));
	if (pending.account !== null && clientId !== pending.account.clientId) {
		throw new Error(t("authRegistrationMismatch"));
	}
	const signal = AbortSignal.timeout(30_000);
	const token = await requestToken(
		{
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			code_verifier: pending.verifier,
			redirect_uri: REDIRECT_URI,
			resource: RESOURCE,
		},
		signal,
	);
	let stored = false;
	try {
		const idToken = tokenString(token, "id_token");
		const { subject, email } = await verifyIdToken(
			idToken,
			{ clientId, nonce: pending.nonce, ...(pending.account === null ? {} : { subject: pending.account.subject }) },
			await keySet(signal),
		);
		let credential: PlanCredential = { type: "oauth", clientId, subject, email, idToken, ...tokens(token) };
		const plan = await fetchPlanModels(credential.access).catch(() => undefined);
		if (plan?.models) credential = { ...credential, planModels: plan.models };
		const signedIn = credential;
		// In the queue of Start and Cancel: a Cancel that finished first means this sign-in is not stored, and one that
		// comes later finds it stored.
		await credentialChanges(async () => {
			if ((await chrome.storage.session.get(LATEST_KEY))[LATEST_KEY] !== pending.state)
				throw new Error(t("authReplaced"));
			// A removal whose stop failed: work of the removed credential may still run.
			if (Object.hasOwn(await stopMarkers(), "openai")) throw new Error(t("authStopping"));
			// One write: the sign-in is its account too (`savedAccount()`).
			await store.modify("openai", async (current) => {
				if (current?.type === "api_key") throw new Error(t("authKeySaved"));
				return signedIn;
			});
			stored = true;
		});
		const welcomed = (await chrome.storage.local.get(WELCOMED_KEY))[WELCOMED_KEY] === true;
		if (!welcomed) await chrome.storage.local.set({ [WELCOMED_KEY]: true });
		return { welcome: !welcomed, credential };
	} finally {
		// Nothing to tell the user if this fails too: the grant is not stored either way.
		if (!stored && typeof token.refresh_token === "string") await revoke({ clientId, refresh: token.refresh_token });
	}
}

/**
 * Ends the session at OpenAI's revocation endpoint. A network failure or a 5xx is tried again, three tries within
 * 15 s. Whether OpenAI confirmed.
 */
export async function revoke({ clientId, refresh }: { clientId?: unknown; refresh: string }): Promise<boolean> {
	if (typeof clientId !== "string") return false;
	const signal = AbortSignal.timeout(15_000);
	try {
		const { revocation } = await discovery(signal);
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
			const response = await fetch(revocation, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ token: refresh, token_type_hint: "refresh_token", client_id: clientId }),
				signal,
			}).catch(() => undefined);
			await response?.body?.cancel();
			if (response?.ok) return true;
			if ((response !== undefined && response.status < 500) || signal.aborted) return false;
		}
	} catch {
		// No discovery, so no endpoint to send to.
	}
	return false;
}

/** Host access a sign-in needs for requests: the API, and the token endpoint for refreshes. */
export const PLAN_ORIGINS = [PROVIDERS.openai.origin, CHATGPT.auth];
