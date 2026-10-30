// Sign in with ChatGPT (design 6.20): the authorize request and the callback rule, each refused callback, the token
// exchange and the ID token check, the saved account, sign-ins that finish late, refresh and its errors, revocation,
// the plan's models, and how requests use a sign-in. Fabricated values and a test-made RSA key only; `fetch` is
// stubbed, so nothing reaches OpenAI.
import { createHash } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	cancelSignIn,
	chatgptOAuth,
	EXPIRE_ALARM,
	fetchPlanModels,
	finishSignIn,
	keepAccount,
	revoke,
	savedAccount,
	signInWaiting,
	startSignIn,
	TokenError,
	tidySignIn,
} from "../src/background/chatgpt.ts";
import {
	checkModel,
	credentials,
	models,
	startingModel,
	syncPlanWindows,
	verifyKey,
} from "../src/background/models.ts";
import { t } from "../src/shared/i18n.ts";
import { CHATGPT, PROVIDERS, RECOMMENDED_MODELS } from "../src/shared/protocol.ts";

const API = PROVIDERS.openai.origin;
const ALL = [API, CHATGPT.auth, CHATGPT.loopback];
const AUTH = "https://auth.openai.com";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const ACCOUNT = { clientId: "oaiapp_1", subject: "user-1", email: "someone@example.com" };

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const area = (map: Map<string, unknown>) => ({
	setAccessLevel: async () => {},
	get: async (key: string) => (map.has(key) ? { [key]: structuredClone(map.get(key)) } : {}),
	set: async (items: Record<string, unknown>) => {
		for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
	},
	remove: async (key: string) => {
		map.delete(key);
	},
});
const granted = new Set<string>();
let rules: chrome.declarativeNetRequest.Rule[] = [];
const alarms = new Map<string, number>();
const created: chrome.tabs.CreateProperties[] = [];
(globalThis as { chrome?: unknown }).chrome = {
	runtime: { id: "extension-id" },
	i18n: { getUILanguage: () => "en" },
	storage: { local: area(local), session: area(session) },
	declarativeNetRequest: {
		updateSessionRules: async ({
			removeRuleIds = [],
			addRules = [],
		}: chrome.declarativeNetRequest.UpdateRuleOptions) => {
			rules = [...rules.filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
		},
	},
	alarms: {
		create: async (name: string, { when }: { when: number }) => {
			alarms.set(name, when);
		},
		clear: async (name: string) => alarms.delete(name),
	},
	permissions: {
		contains: async ({ origins = [] }: { origins?: string[] }) => origins.every((origin) => granted.has(origin)),
		remove: async ({ origins = [] }: { origins?: string[] }) => origins.every((origin) => granted.delete(origin)),
	},
	tabs: {
		get: async (id: number) => ({ id, windowId: 7, index: 2 }),
		create: async (properties: chrome.tabs.CreateProperties) => {
			created.push(properties);
			return { id: 99 };
		},
	},
};

// OpenAI's signing key, made for the tests, and another one that OpenAI does not list.
const RSA = {
	name: "RSASSA-PKCS1-v1_5",
	modulusLength: 2048,
	publicExponent: new Uint8Array([1, 0, 1]),
	hash: "SHA-256",
};
let openaiKey: CryptoKeyPair;
let otherKey: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
beforeAll(async () => {
	openaiKey = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
	otherKey = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
	jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", openaiKey.publicKey)), kid: "k1", use: "sig" }] };
});

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A JWT signed with OpenAI's test key, or `key`. */
async function jwt(
	claims: Record<string, unknown>,
	header: Record<string, unknown> = { alg: "RS256", kid: "k1" },
	key = openaiKey.privateKey,
): Promise<string> {
	const signed = `${part(header)}.${part(claims)}`;
	const signature = await crypto.subtle.sign(RSA.name, key, new TextEncoder().encode(signed));
	return `${signed}.${Buffer.from(signature).toString("base64url")}`;
}

const pending = () =>
	session.get("chatgptSignIn") as { state: string; nonce: string; verifier: string; startedAt: number };
/** The ID token OpenAI issues to the waiting sign-in, or to a refresh. */
const claims = (overrides: Record<string, unknown> = {}) => ({
	iss: AUTH,
	aud: ACCOUNT.clientId,
	sub: ACCOUNT.subject,
	email: ACCOUNT.email,
	exp: Math.floor(Date.now() / 1000) + 3600,
	nonce: (session.get("chatgptSignIn") as { nonce?: string } | undefined)?.nonce,
	...overrides,
});
const TOKEN = { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: SCOPE };
/** The waiting sign-in's token response, with an ID token for it. */
const grant = async (overrides: Record<string, unknown> = {}) => ({
	...TOKEN,
	id_token: await jwt(claims()),
	...overrides,
});

type Call = { url: string; init: RequestInit | undefined };
let calls: Call[] = [];
/** Stubs `fetch` with `route`, recording every request. */
function serve(route: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): void {
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push({ url, init });
		return route(url, init);
	});
}
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const form = (call: Call | undefined) => Object.fromEntries(new URLSearchParams(String(call?.init?.body)));
const header = (call: Call | undefined, name: string) => new Headers(call?.init?.headers).get(name);
const urls = () => calls.map((call) => call.url);
const revocations = () => calls.filter((call) => call.url === `${AUTH}/oauth/revoke`).map(form);

const PLAN = {
	models: [
		{ slug: "gpt-5.4-mini", display_name: "GPT-5.4 mini", visibility: "list" },
		{ slug: "gpt-hidden", visibility: "hide" },
		{ slug: "gpt-5.5", visibility: "list" },
	],
};
const DISCOVERY = {
	issuer: AUTH,
	jwks_uri: `${AUTH}/.well-known/jwks.json`,
	revocation_endpoint: `${AUTH}/oauth/revoke`,
};
/** OpenAI as the sign-in sees it: the token endpoint answers `token`, or what `token` returns. */
function openai(token: unknown = TOKEN, tokenStatus = 200, discovery: unknown = DISCOVERY): void {
	serve(async (url) => {
		if (url === `${AUTH}/api/accounts/oauth/token`) {
			return typeof token === "function" ? (token as () => Promise<Response>)() : json(token, tokenStatus);
		}
		if (url === "https://api.openai.com/v1/models") return json(PLAN);
		if (url === `${AUTH}/.well-known/openid-configuration`) return json(discovery);
		if (url === `${AUTH}/.well-known/jwks.json`) return json(jwks);
		if (url === `${AUTH}/oauth/revoke`) return new Response(null, { status: 200 });
		return new Response(null, { status: 404 });
	});
}

const callback = (fields: Record<string, string>) => `?${new URLSearchParams(fields)}`;
const finish = (fields: Record<string, string> = {}) =>
	finishSignIn(callback({ code: "c-1", state: pending().state, client_id: ACCOUNT.clientId, ...fields }), credentials);
const signedIn = (overrides: Partial<OAuthCredential> = {}) =>
	credentials.modify("openai", async () => ({
		type: "oauth",
		access: "at-1",
		refresh: "rt-1",
		expires: Date.now() + 3_600_000,
		...ACCOUNT,
		idToken: "id-old",
		scopes: SCOPE.split(" "),
		...overrides,
	}));

beforeEach(() => {
	local.clear();
	session.clear();
	granted.clear();
	for (const origin of ALL) granted.add(origin);
	rules = [];
	alarms.clear();
	created.length = 0;
	calls = [];
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("starts a first sign-in as a new registration, with a rule for this state only, an alarm, and a tab next to the panel's", async () => {
	await startSignIn(5, credentials, false);
	const { state, nonce, verifier, startedAt } = pending();
	const url = new URL(String(created[0]?.url));
	expect(url.origin + url.pathname).toBe(`${AUTH}/api/accounts/authorize`);
	expect(Object.fromEntries(url.searchParams)).toEqual({
		client_id: "dynamic_agent_client",
		agent_name_hint: "pi-aside",
		ext_agent_host_id: `urn:uuid:${local.get("installId")}`,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		resource: "https://api.openai.com/v1",
		scope: SCOPE,
		state,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		nonce,
	});
	expect(created[0]).toMatchObject({ windowId: 7, index: 3, openerTabId: 5 });
	expect(alarms.get(EXPIRE_ALARM)).toBe(startedAt + 10 * 60 * 1000);
	expect(await signInWaiting()).toBe(true);

	expect(rules).toHaveLength(1);
	const [rule] = rules;
	expect(rule?.action.redirect?.transform).toEqual({
		scheme: "chrome-extension",
		host: "extension-id",
		port: "",
		path: "/chatgpt-callback.html",
	});
	expect(rule?.condition).toMatchObject({ resourceTypes: ["main_frame"], isUrlFilterCaseSensitive: true });
	const matches = (url: string) => new RegExp(String(rule?.condition.regexFilter)).test(url);
	expect(matches(`${REDIRECT_URI}?code=c&state=${state}&client_id=x`)).toBe(true);
	expect(matches(`${REDIRECT_URI}?state=${state}&code=c`)).toBe(true);
	// Another program's login on port 1455 keeps its callback.
	expect(matches(`${REDIRECT_URI}?code=c&state=other`)).toBe(false);
	expect(matches(`${REDIRECT_URI}?code=c&state=${state}x`)).toBe(false);
	expect(matches(`${REDIRECT_URI}?code=c&xstate=${state}`)).toBe(false);
	expect(matches(`http://127.0.0.1:1456/auth/callback?state=${state}`)).toBe(false);
	expect(matches(`http://127.0.0.1:1455/auth/callbackx?state=${state}`)).toBe(false);

	// A second sign-in replaces the first: one rule, the same install ID, and the first one's callback is refused.
	const installId = local.get("installId");
	await startSignIn(undefined, credentials, false);
	expect(created[1]).toEqual({ url: created[1]?.url });
	expect(local.get("installId")).toBe(installId);
	expect(rules).toHaveLength(1);
	expect(pending().state).not.toBe(state);
	openai();
	await expect(finishSignIn(callback({ code: "c", state, client_id: "x" }), credentials)).rejects.toThrow(
		t("authNotWaiting"),
	);
	expect(calls).toEqual([]);
});

it("signs in to the saved account with its client ID and email, and its ID token while its sign-in is stored", async () => {
	local.set("chatgptAccount", ACCOUNT);
	const params = () => Object.fromEntries(new URL(String(created.at(-1)?.url)).searchParams);

	await startSignIn(undefined, credentials, false);
	expect(params()).toMatchObject({ client_id: "oaiapp_1", login_hint: ACCOUNT.email });
	expect(params()).not.toHaveProperty("agent_name_hint");
	// Signed out: no ID token to hint with.
	expect(params()).not.toHaveProperty("id_token_hint");

	await signedIn({ ended: true, access: "", refresh: "" });
	await startSignIn(undefined, credentials, false);
	expect(params()).toMatchObject({ client_id: "oaiapp_1", id_token_hint: "id-old" });

	// Another account: a new registration, with nothing of the saved one.
	await credentials.delete("openai");
	await startSignIn(undefined, credentials, true);
	expect(params()).toMatchObject({ client_id: "dynamic_agent_client", agent_name_hint: "pi-aside" });
	expect(params()).not.toHaveProperty("login_hint");
});

it("takes the account from the stored sign-in, whatever the kept copy says, so one write publishes both", async () => {
	const params = () => Object.fromEntries(new URL(String(created.at(-1)?.url)).searchParams);
	// A first sign-in writes no copy; the next start still reuses its registration.
	await startSignIn(undefined, credentials, false);
	openai(await grant());
	await finish();
	expect(local.has("chatgptAccount")).toBe(false);
	await startSignIn(undefined, credentials, false);
	expect(params()).toMatchObject({
		client_id: "oaiapp_1",
		login_hint: ACCOUNT.email,
		id_token_hint: expect.any(String),
	});

	// Use another account, while the copy still names the old one.
	local.set("chatgptAccount", ACCOUNT);
	await credentials.delete("openai");
	await startSignIn(undefined, credentials, true);
	openai(await grant({ id_token: await jwt(claims({ sub: "user-2", email: "other@example.com", aud: "oaiapp_2" })) }));
	await finish({ client_id: "oaiapp_2" });
	const switched = { clientId: "oaiapp_2", subject: "user-2", email: "other@example.com" };
	expect(await savedAccount(credentials)).toEqual(switched);
	await startSignIn(undefined, credentials, false);
	expect(params()).toMatchObject({ client_id: "oaiapp_2", login_hint: "other@example.com" });

	// Sign-out keeps the copy; then it is the account.
	const stored = await credentials.read("openai");
	await keepAccount(stored!);
	await credentials.delete("openai");
	expect(await savedAccount(credentials)).toEqual(switched);
});

it.each([
	["no sign-in waits", "none", {}],
	["another state", "other", { code: "c", client_id: "x" }],
	["an expired sign-in", "expired", { code: "c", client_id: "x" }],
] as const)("refuses a callback for %s, and a waiting sign-in still waits", async (_, kind, fields) => {
	openai();
	if (kind !== "none") await startSignIn(undefined, credentials, false);
	if (kind === "expired") session.set("chatgptSignIn", { ...pending(), startedAt: Date.now() - 11 * 60 * 1000 });
	const state = kind === "none" ? "s" : kind === "other" ? `${pending().state}x` : pending().state;
	await expect(finishSignIn(callback({ ...fields, state }), credentials)).rejects.toThrow(t("authNotWaiting"));
	expect(calls).toEqual([]);
	if (kind === "other") expect(await signInWaiting()).toBe(true);
	expect(await credentials.read("openai")).toBeUndefined();
});

it.each([
	["an error", false, { error: "access_denied" }, "ChatGPT did not connect (access_denied). Start again in pi."],
	["no code", false, { code: "" }, t("authNotWaiting")],
	["no client ID to a new registration", false, { client_id: "" }, t("authNotWaiting")],
	["another client ID than the saved account's", true, { client_id: "oaiapp_2" }, "another registration of pi"],
] as const)("refuses a callback with %s, and ends the sign-in", async (_, saved, fields, message) => {
	if (saved) local.set("chatgptAccount", ACCOUNT);
	openai();
	await startSignIn(undefined, credentials, false);
	await expect(finish(fields)).rejects.toThrow(message);
	expect(calls).toEqual([]);
	expect(await signInWaiting()).toBe(false);
	expect(rules).toEqual([]);
	expect(alarms.has(EXPIRE_ALARM)).toBe(false);
	expect(granted.has(CHATGPT.loopback)).toBe(false);
});

it("exchanges the code with the verifier, checks the ID token, and stores the sign-in, its account, and its plan's models", async () => {
	await startSignIn(undefined, credentials, false);
	const { verifier } = pending();
	const token = await grant();
	openai(token);
	const before = Date.now();
	const first = await finish();
	expect(first.welcome).toBe(true);
	expect(urls()).toEqual([
		`${AUTH}/api/accounts/oauth/token`,
		`${AUTH}/.well-known/openid-configuration`,
		`${AUTH}/.well-known/jwks.json`,
		"https://api.openai.com/v1/models",
	]);
	expect(header(calls[0], "content-type")).toBe("application/x-www-form-urlencoded");
	expect(form(calls[0])).toEqual({
		grant_type: "authorization_code",
		client_id: "oaiapp_1",
		code: "c-1",
		code_verifier: verifier,
		redirect_uri: REDIRECT_URI,
		resource: "https://api.openai.com/v1",
	});
	expect(header(calls[3], "authorization")).toBe("Bearer at-1");
	const stored = await credentials.read("openai");
	expect(stored).toEqual({
		type: "oauth",
		...ACCOUNT,
		idToken: token.id_token,
		access: "at-1",
		refresh: "rt-1",
		expires: expect.any(Number),
		scopes: SCOPE.split(" "),
		planModels: ["gpt-5.4-mini", "gpt-5.5"],
	});
	expect(await savedAccount(credentials)).toEqual(ACCOUNT);
	// As pi-ai: three minutes before OpenAI's expiry.
	expect(stored?.type === "oauth" && stored.expires).toBeGreaterThanOrEqual(before + 3_420_000);
	expect(stored?.type === "oauth" && stored.expires).toBeLessThanOrEqual(Date.now() + 3_420_000);
	// The sign-in ended; only the loopback permission went with it.
	expect(await signInWaiting()).toBe(false);
	expect(rules).toEqual([]);
	expect(alarms.has(EXPIRE_ALARM)).toBe(false);
	expect([...granted]).toEqual([API, CHATGPT.auth]);

	// OpenAI's welcome shows on the first sign-in only. The saved account's callback may leave out the client ID. A plan
	// list that fails leaves the models unknown.
	await startSignIn(undefined, credentials, false);
	const again = await grant({ access_token: "at-2" });
	serve(async (url) => {
		if (url.endsWith("/oauth/token")) return json(again);
		if (url.endsWith("openid-configuration")) return json(DISCOVERY);
		if (url.endsWith("jwks.json")) return json(jwks);
		return new Response(null, { status: 500 });
	});
	const second = await finish({ client_id: "" });
	expect(second.welcome).toBe(false);
	expect(await credentials.read("openai")).toMatchObject({ access: "at-2", clientId: "oaiapp_1" });
	expect(await credentials.read("openai")).not.toHaveProperty("planModels");
});

it.each<[string, () => Promise<string>]>([
	["signed with a key OpenAI does not list", async () => jwt(claims(), undefined, otherKey.privateKey)],
	["with a key ID OpenAI does not list", async () => jwt(claims(), { alg: "RS256", kid: "k2" })],
	["not RS256", async () => jwt(claims(), { alg: "none", kid: "k1" })],
	["from another issuer", async () => jwt(claims({ iss: "https://elsewhere.example" }))],
	["for another client", async () => jwt(claims({ aud: "oaiapp_2" }))],
	["expired", async () => jwt(claims({ exp: Math.floor(Date.now() / 1000) - 120 }))],
	["for another sign-in", async () => jwt(claims({ nonce: "other" }))],
	["without a subject", async () => jwt(claims({ sub: undefined }))],
	["that is not a JWT", async () => "id-1"],
])("refuses an ID token %s, and revokes the grant", async (_, idToken) => {
	await startSignIn(undefined, credentials, false);
	openai({ ...TOKEN, id_token: await idToken() });
	await expect(finish()).rejects.toThrow(/ID token/);
	expect(await credentials.read("openai")).toBeUndefined();
	expect(await savedAccount(credentials)).toBeNull();
	expect(revocations()).toEqual([{ token: "rt-1", token_type_hint: "refresh_token", client_id: "oaiapp_1" }]);
});

it("accepts an audience list with the client ID, and refuses a discovery that names another issuer", async () => {
	await startSignIn(undefined, credentials, false);
	openai({ ...TOKEN, id_token: await jwt(claims({ aud: ["other", ACCOUNT.clientId] })) });
	await expect(finish()).resolves.toMatchObject({ credential: { subject: ACCOUNT.subject } });

	await credentials.delete("openai");
	await startSignIn(undefined, credentials, false);
	openai(await grant(), 200, { ...DISCOVERY, issuer: "https://elsewhere.example" });
	await expect(finish()).rejects.toThrow("OpenAI's discovery names another issuer");
	await startSignIn(undefined, credentials, false);
	openai(await grant(), 200, { ...DISCOVERY, jwks_uri: "https://elsewhere.example/jwks.json" });
	await expect(finish()).rejects.toThrow("OpenAI's discovery names an endpoint off auth.openai.com");
	expect(await credentials.read("openai")).toBeUndefined();
});

it("refuses a sign-in to another account than the saved one, keeps the stored one, and revokes the grant", async () => {
	local.set("chatgptAccount", ACCOUNT);
	await signedIn({ ended: true, access: "", refresh: "" });
	await startSignIn(undefined, credentials, false);
	openai({ ...TOKEN, id_token: await jwt(claims({ sub: "user-2" })) });
	await expect(finish()).rejects.toThrow(t("authOtherAccount"));
	expect(await credentials.read("openai")).toMatchObject({ subject: "user-1", ended: true });
	expect(revocations()).toHaveLength(1);
});

it.each([
	["without plan access", { scope: "openid profile email" }, 200, "ChatGPT plan access was not granted", true],
	["without an ID token", { id_token: undefined }, 200, "OpenAI's token response has no id_token", true],
	["without a refresh token", { refresh_token: undefined }, 200, "has no refresh_token", false],
	["without an expiry", { expires_in: "soon" }, 200, "has no valid expires_in", true],
	// The error code only: OpenAI's description could echo a token.
	[
		"refused",
		{ error: "invalid_grant", error_description: "code at-secret" },
		400,
		/^OpenAI sign-in failed \(400: invalid_grant\)$/,
		false,
	],
	["refused by a 5xx", { error: "server_error" }, 503, /^OpenAI sign-in failed \(503: server_error\)$/, false],
] as const)(
	"stores nothing for a grant %s, and revokes a refresh token it holds",
	async (_, fields, status, message, revoked) => {
		await startSignIn(undefined, credentials, false);
		openai(status === 200 ? await grant(fields) : fields, status);
		const failure = finish();
		await expect(failure).rejects.toThrow(message);
		await expect(failure).rejects.not.toThrow("secret");
		expect(await credentials.read("openai")).toBeUndefined();
		expect(await signInWaiting()).toBe(false);
		expect(revocations()).toHaveLength(revoked ? 1 : 0);
	},
);

it("keeps a key saved meanwhile, and revokes the new session", async () => {
	await startSignIn(undefined, credentials, false);
	openai(await grant());
	await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-proj-fake" }));
	await expect(finish()).rejects.toThrow(t("authKeySaved"));
	expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "sk-proj-fake" });
	expect(revocations()).toEqual([{ token: "rt-1", token_type_hint: "refresh_token", client_id: "oaiapp_1" }]);
});

it("a sign-in that finishes after a newer one started, or after Cancel, is revoked, and leaves the newer one waiting", async () => {
	await startSignIn(undefined, credentials, false);
	const token = await grant();
	const exchange = Promise.withResolvers<void>();
	openai(async () => {
		await exchange.promise;
		return json(token);
	});
	// A's callback claims its sign-in; its token request waits.
	const a = finish();
	await vi.waitFor(() => expect(urls()).toEqual([`${AUTH}/api/accounts/oauth/token`]));
	await startSignIn(undefined, credentials, false);
	const b = pending();
	exchange.resolve();
	await expect(a).rejects.toThrow(t("authReplaced"));
	expect(await credentials.read("openai")).toBeUndefined();
	expect(revocations()).toHaveLength(1);
	// A ended nothing of B's.
	expect(pending()).toEqual(b);
	expect(rules.map((rule) => rule.condition.regexFilter)).toEqual([expect.stringContaining(b.state)]);
	expect(alarms.get(EXPIRE_ALARM)).toBe(b.startedAt + 10 * 60 * 1000);

	// Cancel while B's exchange runs.
	calls = [];
	const later = Promise.withResolvers<void>();
	const tokenB = await grant();
	openai(async () => {
		await later.promise;
		return json(tokenB);
	});
	const finishing = finish();
	await vi.waitFor(() => expect(urls()).toContain(`${AUTH}/api/accounts/oauth/token`));
	await cancelSignIn();
	later.resolve();
	await expect(finishing).rejects.toThrow(t("authReplaced"));
	expect(await credentials.read("openai")).toBeUndefined();
});

it("a Cancel or a newer start while the sign-in's save is paused waits for the save, and finds the sign-in stored", async () => {
	await startSignIn(undefined, credentials, false);
	openai(await grant());
	const storageLocal = chrome.storage.local as unknown as { set(items: Record<string, unknown>): Promise<void> };
	const set = storageLocal.set;
	const writing = Promise.withResolvers<void>();
	const write = Promise.withResolvers<void>();
	storageLocal.set = async (items) => {
		if ("credentials" in items) {
			writing.resolve();
			await write.promise;
		}
		return set(items);
	};
	try {
		const finishing = finish();
		await writing.promise;
		const done: string[] = [];
		const cancel = cancelSignIn().then(() => done.push("cancel"));
		const start = startSignIn(undefined, credentials, false).then(() => done.push("start"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(done).toEqual([]);
		write.resolve();
		await finishing;
		await Promise.all([cancel, start]);
		expect(done).toEqual(["cancel", "start"]);
	} finally {
		storageLocal.set = set;
	}
	expect(await credentials.read("openai")).toMatchObject({ type: "oauth", clientId: ACCOUNT.clientId });
	expect(await savedAccount(credentials)).toMatchObject({ clientId: ACCOUNT.clientId });
	expect(revocations()).toEqual([]);
	// The start queued after Cancel waits for its own callback.
	expect(await signInWaiting()).toBe(true);
});

it("stores no sign-in while a removal has not stopped the work of the removed credential, and revokes it", async () => {
	local.set("stoppingProviders", { openai: "removal-1" });
	await startSignIn(undefined, credentials, false);
	openai(await grant());
	await expect(finish()).rejects.toThrow(t("authStopping"));
	expect(await credentials.read("openai")).toBeUndefined();
	expect(await savedAccount(credentials)).toBeNull();
	expect(revocations()).toHaveLength(1);
});

it("tidies what an expired sign-in or a stopped worker left, and leaves a waiting sign-in alone", async () => {
	await startSignIn(undefined, credentials, false);
	await tidySignIn();
	expect(await signInWaiting()).toBe(true);
	expect(rules).toHaveLength(1);

	// The alarm did not come: the stored start decides.
	session.set("chatgptSignIn", { ...pending(), startedAt: Date.now() - 11 * 60 * 1000 });
	await tidySignIn();
	expect(session.has("chatgptSignIn")).toBe(false);
	expect(rules).toEqual([]);
	expect(alarms.has(EXPIRE_ALARM)).toBe(false);
	expect(granted.has(CHATGPT.loopback)).toBe(false);
});

it("refreshes as pi-ai does, keeping the other fields, the old refresh token, and the old ID token when none comes back", async () => {
	const credential: OAuthCredential = {
		type: "oauth",
		access: "at-1",
		refresh: "rt-1",
		expires: 0,
		...ACCOUNT,
		idToken: "id-old",
		scopes: SCOPE.split(" "),
		planModels: ["gpt-5.5"],
	};
	openai({ access_token: "at-2", expires_in: 3600, scope: SCOPE });
	const refreshed = await chatgptOAuth.refresh(credential, AbortSignal.timeout(1000));
	expect(form(calls[0])).toEqual({
		grant_type: "refresh_token",
		client_id: "oaiapp_1",
		refresh_token: "rt-1",
		resource: "https://api.openai.com/v1",
	});
	expect(refreshed).toMatchObject({ access: "at-2", refresh: "rt-1", idToken: "id-old", planModels: ["gpt-5.5"] });
	expect(refreshed.expires).toBeGreaterThan(Date.now());

	// A new ID token must name the same account; a refresh has no nonce.
	const idToken = await jwt(claims());
	openai({ access_token: "at-3", refresh_token: "rt-3", id_token: idToken, expires_in: 3600, scope: SCOPE });
	expect(await chatgptOAuth.refresh(refreshed, AbortSignal.timeout(1000))).toMatchObject({
		access: "at-3",
		refresh: "rt-3",
		idToken,
	});
	openai({ ...TOKEN, id_token: await jwt(claims({ sub: "user-2" })) });
	await expect(chatgptOAuth.refresh(refreshed, AbortSignal.timeout(1000))).rejects.toThrow(t("authOtherAccount"));
	// OpenAI already replaced the refresh token: without its key set, the new tokens are kept with the old ID token.
	openai({ ...TOKEN, access_token: "at-4", refresh_token: "rt-4", id_token: await jwt(claims()) }, 200, null);
	expect(await chatgptOAuth.refresh(refreshed, AbortSignal.timeout(1000))).toMatchObject({
		access: "at-4",
		refresh: "rt-4",
		idToken: "id-old",
	});

	expect(await chatgptOAuth.toAuth(refreshed)).toEqual({ apiKey: "at-2" });
	await expect(
		chatgptOAuth.refresh({ ...credential, clientId: undefined }, AbortSignal.timeout(1000)),
	).rejects.toThrow("The ChatGPT sign-in has no client ID");
});

it("names OpenAI's refresh error code, and which ones end the session", async () => {
	const credential: OAuthCredential = { type: "oauth", access: "a", refresh: "r", expires: 0, ...ACCOUNT };
	for (const [code, status, ended] of [
		["invalid_grant", 400, true],
		["refresh_token_reused", 400, true],
		["invalid_client", 401, false],
		["temporarily_unavailable", 503, false],
	] as const) {
		openai({ error: code, error_description: "rt-secret" }, status);
		const error = await chatgptOAuth
			.refresh(credential, AbortSignal.timeout(1000))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TokenError);
		expect(error).toMatchObject({ code, status, ended });
		expect(String(error)).not.toContain("secret");
	}
});

it("revokes only at auth.openai.com's revocation endpoint, with three tries for a network failure or a 5xx", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout"] });
	const credential = { clientId: "oaiapp_1", refresh: "rt" };
	openai();
	expect(await revoke(credential)).toBe(true);
	expect(urls()).toEqual([`${AUTH}/.well-known/openid-configuration`, `${AUTH}/oauth/revoke`]);

	calls = [];
	serve(() => json({ ...DISCOVERY, revocation_endpoint: "https://elsewhere.example/revoke" }));
	expect(await revoke(credential)).toBe(false);
	expect(calls).toHaveLength(1);

	let failures = 0;
	const flaky = (failure: () => Response | Promise<Response>, times: number) => {
		calls = [];
		failures = 0;
		serve((url) => {
			if (url.endsWith("openid-configuration")) return json(DISCOVERY);
			failures += 1;
			return failures <= times ? failure() : new Response(null, { status: 200 });
		});
	};
	const settled = async (promise: Promise<boolean>) => {
		await vi.runAllTimersAsync();
		return promise;
	};
	flaky(() => new Response(null, { status: 503 }), 2);
	expect(await settled(revoke(credential))).toBe(true);
	expect(revocations()).toHaveLength(3);
	flaky(() => Promise.reject(new TypeError("Failed to fetch")), 3);
	expect(await settled(revoke(credential))).toBe(false);
	expect(revocations()).toHaveLength(3);
	// A 4xx is OpenAI's answer: no other try.
	flaky(() => new Response(null, { status: 400 }), 1);
	expect(await settled(revoke(credential))).toBe(false);
	expect(revocations()).toHaveLength(1);
});

it("reads the plan's listed models, and nothing from an answer of another shape", async () => {
	openai();
	expect(await fetchPlanModels("at-1")).toEqual({ status: 200, models: ["gpt-5.4-mini", "gpt-5.5"] });
	serve(() => json({ data: [{ id: "gpt-5.5" }] }));
	expect(await fetchPlanModels("at-1")).toEqual({ status: 200, models: null });
	serve(() => json({ error: { message: "no" } }, 401));
	expect(await fetchPlanModels("at-1")).toEqual({ status: 401, models: null });
});

it("starts a sign-in on the recommended model, or on the plan's first known one, or on none", () => {
	expect(startingModel("openai", null)).toBe(RECOMMENDED_MODELS.openai);
	expect(startingModel("openai", ["gpt-5.5", RECOMMENDED_MODELS.openai])).toBe(RECOMMENDED_MODELS.openai);
	const known = models.getModels("openai").map((model) => model.id);
	const [first, second] = known.filter((id) => id !== RECOMMENDED_MODELS.openai);
	expect(startingModel("openai", [String(second), String(first), "unknown"])).toBe(
		known.indexOf(String(first)) < known.indexOf(String(second)) ? first : second,
	);
	expect(startingModel("openai", ["unknown"])).toBeNull();
});

it("sends with a sign-in only with access to the API and the token endpoint, never once it ended, nor for another provider", async () => {
	openai();
	await signedIn();
	const model = { provider: "openai", modelId: RECOMMENDED_MODELS.openai };
	await expect(checkModel(model)).resolves.toBeUndefined();
	expect((await models.getAuth("openai"))?.auth.apiKey).toBe("at-1");

	granted.delete(CHATGPT.auth);
	await expect(checkModel(model)).rejects.toThrow("No permission to reach OpenAI: grant it to send");
	expect(await models.getAuth("openai")).toBeUndefined();
	granted.add(CHATGPT.auth);

	await signedIn({ ended: true, access: "", refresh: "" });
	await expect(checkModel(model)).rejects.toThrow(t("signInEnded"));
	expect(await models.getAuth("openai")).toBeUndefined();

	await credentials.modify("anthropic", async () => ({
		type: "oauth",
		access: "a",
		refresh: "r",
		expires: Date.now() + 3_600_000,
	}));
	granted.add(PROVIDERS.anthropic.origin);
	await expect(checkModel({ provider: "anthropic", modelId: RECOMMENDED_MODELS.anthropic })).rejects.toThrow(
		"No Anthropic key: add one to send",
	);
	expect(await models.getAuth("anthropic")).toBeUndefined();
	expect(calls).toEqual([]);
});

/** A Responses stream that reports 20 input and 12 output tokens. */
const responses = () =>
	new Response(
		[
			{ type: "response.created", response: { id: "resp-1" } },
			{
				type: "response.completed",
				response: {
					id: "resp-1",
					status: "completed",
					output: [],
					usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 },
				},
			},
		]
			.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);

it("an answer made with a sign-in costs nothing and keeps its estimate at list prices; one made with a key costs those", async () => {
	serve(() => responses());
	const model = models.getModel("openai", RECOMMENDED_MODELS.openai);
	if (model === undefined) throw new Error("no recommended OpenAI model");
	const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

	await signedIn();
	const plan = await models.completeSimple(model, context);
	expect(plan.errorMessage).toBeUndefined();
	expect(header(calls[0], "authorization")).toBe("Bearer at-1");
	expect(plan.usage.totalTokens).toBe(32);
	expect(plan.usage.cost.total).toBe(0);

	await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-proj-fake" }));
	const keyed = await models.completeSimple(model, context);
	expect(header(calls[1], "authorization")).toBe("Bearer sk-proj-fake");
	expect(keyed.usage.cost.total).toBeGreaterThan(0);
	expect(plan.usage.cost).toEqual({ ...keyed.usage.cost, total: 0 });
});

it("verifies a sign-in: the plan's models, and what a failed refresh means", async () => {
	openai();
	await signedIn();
	expect(await verifyKey("openai")).toEqual({ result: "accepted", status: 200 });
	expect(await credentials.read("openai")).toMatchObject({ planModels: ["gpt-5.4-mini", "gpt-5.5"] });

	serve(() => json({ error: { message: "bad token" } }, 401));
	expect(await verifyKey("openai")).toEqual({ result: "rejected", status: 401 });

	// Due for a refresh that fails for a while: the sign-in stays as it is.
	for (const [answer, result] of [
		[() => json({ error: "temporarily_unavailable" }, 503), { result: "network_error", status: 503 }],
		[() => json({ error: "invalid_client" }, 401), { result: "rejected", status: 401 }],
		[() => Promise.reject(new TypeError("Failed to fetch")), { result: "network_error" }],
		[() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")), { result: "timeout" }],
	] as const) {
		await signedIn({ expires: Date.now() - 1000 });
		serve(answer);
		expect(await verifyKey("openai")).toEqual(result);
		expect(await credentials.read("openai")).toMatchObject({ refresh: "rt-1", access: "at-1" });
		expect(await credentials.read("openai")).not.toHaveProperty("ended");
	}

	// A refresh that OpenAI ends: the tokens are cleared, the account and ID token stay, and nothing is sent again.
	await signedIn({ expires: Date.now() - 1000 });
	openai({ error: "invalid_grant" }, 400);
	expect(await verifyKey("openai")).toEqual({ result: "expired", status: 400 });
	await vi.waitFor(async () =>
		expect(await credentials.read("openai")).toMatchObject({
			ended: true,
			access: "",
			refresh: "",
			idToken: "id-old",
		}),
	);
	calls = [];
	expect(await verifyKey("openai")).toEqual({ result: "expired" });
	expect(calls).toEqual([]);

	await signedIn();
	granted.delete(CHATGPT.auth);
	expect(await verifyKey("openai")).toEqual({ result: "no_permission" });
});

it("Verify keeps the plan's models only for the registration it checked", async () => {
	await signedIn();
	const answer = Promise.withResolvers<void>();
	serve(async () => {
		await answer.promise;
		return json(PLAN);
	});
	const verified = verifyKey("openai");
	await vi.waitFor(() => expect(calls).toHaveLength(1));
	// Another account's sign-in replaced it meanwhile.
	await signedIn({ clientId: "oaiapp_2", subject: "user-2" });
	answer.resolve();
	expect(await verified).toEqual({ result: "accepted", status: 200 });
	expect(await credentials.read("openai")).not.toHaveProperty("planModels");
});

it("a ChatGPT sign-in gives OpenAI's models the plan's context windows; an API key keeps the API's (design 6.21)", async () => {
	const sol = () => models.getModel("openai", "gpt-6.1-sol")!.contextWindow;
	const mini = () => models.getModel("openai", "gpt-5.4-mini")!.contextWindow;
	const apiMini = mini();

	await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-proj-fake" }));
	await syncPlanWindows();
	expect(sol()).toBe(272_000);

	await signedIn();
	await syncPlanWindows();
	expect(sol()).toBe(500_000);
	// A model whose window is the same on a plan keeps it.
	expect(mini()).toBe(apiMini);
	// The model list the panel shows carries it too.
	expect(models.getModels("openai").find((model) => model.id === "gpt-6.1-sol")?.contextWindow).toBe(500_000);

	// A send reads the credential again: back on an API key, the API's window.
	await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-proj-fake" }));
	await checkModel({ provider: "openai", modelId: "gpt-6.1-sol" }).catch(() => {});
	expect(sol()).toBe(272_000);
});
