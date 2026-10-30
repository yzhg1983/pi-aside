import { afterEach, expect, it, vi } from "vitest";
import { runScriptBuilt, userScriptsAllowed } from "../src/shared/user-scripts.ts";
import manifest from "../static/manifest.json" with { type: "json" };

afterEach(() => vi.unstubAllGlobals());

it("has Run script in the normal build while Chrome's switch is on", () => {
	vi.stubGlobal("chrome", {
		runtime: { getManifest: () => manifest },
		userScripts: { getScripts: () => Promise.resolve([]) },
	});
	expect(runScriptBuilt()).toBe(true);
	expect(userScriptsAllowed()).toBe(true);
});

it("offers no scripts in the build without Run script, which Chrome gives no chrome.userScripts", () => {
	const permissions = manifest.permissions.filter((permission) => permission !== "userScripts");
	vi.stubGlobal("chrome", { runtime: { getManifest: () => ({ ...manifest, permissions }) } });
	expect(runScriptBuilt()).toBe(false);
	expect(userScriptsAllowed()).toBe(false);
});

it("offers no scripts once the switch went off in a running context", () => {
	vi.stubGlobal("chrome", {
		runtime: { getManifest: () => manifest },
		userScripts: {
			getScripts: () => {
				throw new Error("Allow User Scripts is off");
			},
		},
	});
	expect(runScriptBuilt()).toBe(true);
	expect(userScriptsAllowed()).toBe(false);
});
