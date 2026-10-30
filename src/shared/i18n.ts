import english from "../../static/_locales/en/messages.json" with { type: "json" };

export type MessageKey = keyof typeof english;

/** Native catalogs select the interface language; tests and incomplete environments use English. */
export function t(key: MessageKey, substitutions: readonly (string | number)[] = []): string {
	const definition = english[key];
	if (definition === undefined) throw new Error(`Missing English message: ${key}`);
	const values = substitutions.map(String);
	const native = globalThis.chrome?.i18n?.getMessage?.(key, values);
	if (typeof native === "string" && native !== "") return native;
	return definition.message.replace(/\$\$|\$([1-9])/g, (_match, index: string | undefined) =>
		index === undefined ? "$" : (values[Number(index) - 1] ?? ""),
	);
}

export function interfaceLocale(): "en" | "zh-CN" {
	return t("localeCode") === "zh-CN" ? "zh-CN" : "en";
}

/** Translate explicit text and attribute markers without replacing inputs or icons. */
export function localizeDocument(root: Document): void {
	root.documentElement.lang = interfaceLocale();
	for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]"))
		element.textContent = t(element.dataset.i18n as MessageKey);
	for (const attribute of ["title", "placeholder", "aria-label", "alt"] as const) {
		for (const element of root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`))
			element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`) as MessageKey));
	}
}
