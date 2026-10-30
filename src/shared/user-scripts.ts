// Chrome's Allow User Scripts switch for pi, which run_script needs (design 6.23).

/**
 * Whether Chrome lets pi run user scripts now. A context that starts while the switch is off has no
 * `chrome.userScripts`; one that was running when the switch went off keeps it, and its methods throw at once. So, as
 * Chrome's documentation does, this calls one.
 */
export function userScriptsAllowed(): boolean {
	try {
		chrome.userScripts.getScripts().catch(() => {});
		return true;
	} catch {
		return false;
	}
}

/** Whether this build has Run script: the store fallback (`build.mjs --no-run-script`) leaves out the permission. */
export function runScriptBuilt(): boolean {
	return chrome.runtime.getManifest().permissions?.includes("userScripts") === true;
}
