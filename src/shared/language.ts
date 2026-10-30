import { interfaceLocale } from "./i18n.ts";
import type { AnswerLanguage, Language } from "./protocol.ts";

/** Resolve only for display or request construction; never write the result over a stored auto choice. */
export function effectiveAnswerLanguage(choice: AnswerLanguage): Language {
	return choice === "auto" ? (interfaceLocale() === "zh-CN" ? "Chinese" : "English") : choice;
}
