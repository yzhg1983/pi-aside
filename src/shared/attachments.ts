// Images and text files attached to a message (design 6.42): the limits, the checks the panel makes when a file is
// added and the worker makes again at a send, the content blocks the model gets, and how a stored input's entry data
// names those blocks.

import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { t } from "./i18n.ts";
import { MAX_IMAGE_CHARS } from "./images.ts";
import type { AttachmentInfo, MessageAttachment } from "./protocol.ts";

export const MAX_ATTACHMENTS = 10;
/** Characters of one text file; a longer one is refused, not cut: a cut table gives wrong totals. */
export const MAX_FILE_CHARS = 100_000;
/** Characters of all the text files of a message. A resource bound, not a token count: see design 6.42. */
export const MAX_FILES_CHARS = 200_000;
/** A text file's bytes, checked before it is read: 4 per character at most in UTF-8. */
export const MAX_TEXT_FILE_BYTES = 4 * MAX_FILE_CHARS;
/** An image file's bytes, checked before it is decoded. */
export const MAX_IMAGE_FILE_BYTES = 50_000_000;
/** The long side of an attached image, in pixels; never enlarged. */
export const IMAGE_LONG_SIDE = 1280;
/** Characters of a file's name as pi keeps it. */
const MAX_NAME_CHARS = 200;

export type AttachmentBlock = TextContent | ImageContent;

/** The start of documents that are not text, though their bytes may be: PDF, ZIP (docx, xlsx), and old Office. */
const SIGNATURES: readonly (readonly number[])[] = [
	[0x25, 0x50, 0x44, 0x46, 0x2d],
	[0x50, 0x4b, 0x03, 0x04],
	[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
];

/** Whether `start`, a file's first bytes, is that of a document that is not text. Eight bytes are enough. */
export function isDocument(start: Uint8Array): boolean {
	return SIGNATURES.some((signature) => signature.every((byte, at) => start[at] === byte));
}

/** A file's name as pi keeps it: one line, bounded, well-formed; "file" for none. */
export function fileName(name: string): string {
	const line = name.replace(/\s+/g, " ").trim().toWellFormed();
	return line === "" ? "file" : line.slice(0, MAX_NAME_CHARS);
}

/**
 * The text of a file's `bytes`, or why it is not a text file pi attaches. A document is known by its first bytes, not
 * by its type: Windows labels a CSV file `application/vnd.ms-excel`. Text is UTF-8 without a NUL character.
 */
export function textOf(name: string, bytes: Uint8Array): { text: string } | { error: string } {
	if (isDocument(bytes)) return { error: t("attachNotText", [name]) };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { error: t("attachNotText", [name]) };
	}
	if (text.includes("\0")) return { error: t("attachNotText", [name]) };
	if (text.length > MAX_FILE_CHARS) return { error: t("attachFileTooLong", [name, MAX_FILE_CHARS.toLocaleString()]) };
	return { text };
}

/** What the model gets of a file: its name and length, its text, and where it ends. The name cannot end the line. */
export function fileBlock(name: string, text: string): string {
	const quoted = JSON.stringify(name);
	return `[Attached file: ${quoted}, ${text.length} characters]\n${text}\n[End of file ${quoted}]`;
}

/**
 * The attachments of a send, checked again in the worker: their number, each one's shape and size, and the files'
 * characters in all. Throws the reason, in the interface language.
 */
export function checkAttachments(attachments: unknown): MessageAttachment[] {
	if (!Array.isArray(attachments)) throw new Error(t("attachInvalid"));
	if (attachments.length > MAX_ATTACHMENTS) throw new Error(t("attachTooMany", [MAX_ATTACHMENTS]));
	let chars = 0;
	return attachments.map((attachment: unknown) => {
		const item = (typeof attachment === "object" && attachment !== null ? attachment : {}) as Record<string, unknown>;
		if (item.kind === "file") {
			const { name, text } = item;
			if (typeof name !== "string" || typeof text !== "string" || text.includes("\0"))
				throw new Error(t("attachInvalid"));
			if (text.length > MAX_FILE_CHARS)
				throw new Error(t("attachFileTooLong", [name, MAX_FILE_CHARS.toLocaleString()]));
			chars += text.length;
			if (chars > MAX_FILES_CHARS) throw new Error(t("attachFilesTooLong", [MAX_FILES_CHARS.toLocaleString()]));
			return { kind: "file", name: fileName(name), text };
		}
		const { width, height, image } = item;
		const { mimeType, data } = (typeof image === "object" && image !== null ? image : {}) as Record<string, unknown>;
		if (
			item.kind !== "image" ||
			!isSide(width) ||
			!isSide(height) ||
			(mimeType !== "image/png" && mimeType !== "image/jpeg") ||
			typeof data !== "string" ||
			data.length === 0 ||
			data.length > MAX_IMAGE_CHARS ||
			!/^[A-Za-z0-9+/]+={0,2}$/.test(data)
		)
			throw new Error(t("attachInvalid"));
		return { kind: "image", width, height, image: { mimeType, data } };
	});
}

function isSide(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= IMAGE_LONG_SIDE;
}

/** How an entry names an attachment, and its content block. */
export function attached(attachments: readonly MessageAttachment[]): {
	infos: AttachmentInfo[];
	blocks: AttachmentBlock[];
} {
	return {
		infos: attachments.map((attachment) =>
			attachment.kind === "file"
				? { kind: "file", name: attachment.name, chars: attachment.text.length }
				: {
						kind: "image",
						width: attachment.width,
						height: attachment.height,
						chars: attachment.image.data.length,
					},
		),
		blocks: attachments.map((attachment) =>
			attachment.kind === "file"
				? { type: "text", text: fileBlock(attachment.name, attachment.text) }
				: { type: "image", mimeType: attachment.image.mimeType, data: attachment.image.data },
		),
	};
}

/**
 * An input's content: `lead`, the text the model reads first (what the user typed, with the page note of a page
 * message), then one block per attachment. Without attachments, the text as before; an empty lead has no block.
 */
export function withAttachments(lead: string, blocks: readonly AttachmentBlock[]): UserMessage["content"] {
	if (blocks.length === 0) return lead;
	return [...(lead === "" ? [] : [{ type: "text" as const, text: lead }]), ...blocks];
}

/**
 * The attachments an input's entry `data` names, checked against its `content`: zero or one leading text block, then
 * exactly one block per attachment, of its type. `lead`: that text block's, "" without one. Undefined for an input
 * without attachments, or with data that does not match its content: it then shows as its plain text.
 */
export function storedAttachments(
	data: unknown,
	content: UserMessage["content"] | undefined,
): { lead: string; attachments: AttachmentInfo[]; blocks: AttachmentBlock[] } | undefined {
	if (typeof data !== "object" || data === null || !Array.isArray(content)) return undefined;
	const list = (data as { attachments?: unknown }).attachments;
	if (!Array.isArray(list) || list.length === 0 || !list.every(isInfo)) return undefined;
	const leading = content.length - list.length;
	if (leading !== 0 && leading !== 1) return undefined;
	const first = content[0];
	if (leading === 1 && first?.type !== "text") return undefined;
	const blocks = content.slice(leading);
	if (!blocks.every((block, at) => block.type === (list[at]!.kind === "file" ? "text" : "image"))) return undefined;
	return { lead: leading === 1 && first?.type === "text" ? first.text : "", attachments: list, blocks };
}

function isInfo(value: unknown): value is AttachmentInfo {
	if (typeof value !== "object" || value === null) return false;
	const info = value as Record<string, unknown>;
	if (typeof info.chars !== "number") return false;
	if (info.kind === "file") return typeof info.name === "string";
	return info.kind === "image" && typeof info.width === "number" && typeof info.height === "number";
}
