// A file the user adds to the message box, as the attachment a send carries (design 6.42): an image decoded, scaled, and
// encoded, PNG while it fits so that text and diagrams stay sharp, else JPEG as screenshots are; a text file read and
// checked. The worker checks both again.

import {
	fileName,
	IMAGE_LONG_SIDE,
	isDocument,
	MAX_FILE_CHARS,
	MAX_IMAGE_FILE_BYTES,
	MAX_TEXT_FILE_BYTES,
	textOf,
} from "../shared/attachments.ts";
import { t } from "../shared/i18n.ts";
import { base64, ENCODINGS, fitSize, MAX_IMAGE_CHARS } from "../shared/images.ts";
import type { MessageAttachment } from "../shared/protocol.ts";

/** Whether `file` is attached as an image: by its type, which Chrome sets from its extension. */
export function isImage(file: File): boolean {
	return file.type.startsWith("image/");
}

/** `file` as an attachment; rejects with the reason, in the interface language, naming the file. */
export async function prepare(file: File): Promise<MessageAttachment> {
	const name = fileName(file.name);
	if (isImage(file)) {
		if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error(t("attachFileTooBig", [name]));
		let bitmap: ImageBitmap;
		try {
			// Turned upright by its EXIF orientation, as Chrome shows it; an animated image gives its first frame.
			bitmap = await createImageBitmap(file);
		} catch {
			throw new Error(t("attachImageUnreadable", [name]));
		}
		try {
			const encoded = await encode(bitmap, name);
			if (encoded === null) throw new Error(t("attachImageTooDetailed", [name]));
			return { kind: "image", ...encoded };
		} finally {
			bitmap.close();
		}
	}
	// The start first: a large PDF is not a text file, rather than too long.
	if (isDocument(new Uint8Array(await file.slice(0, 8).arrayBuffer()))) throw new Error(t("attachNotText", [name]));
	if (file.size > MAX_TEXT_FILE_BYTES)
		throw new Error(t("attachFileTooLong", [name, MAX_FILE_CHARS.toLocaleString()]));
	const read = textOf(name, new Uint8Array(await file.arrayBuffer()));
	if ("error" in read) throw new Error(read.error);
	return { kind: "file", name, text: read.text };
}

/**
 * The image as PNG if its base64 fits `MAX_IMAGE_CHARS`, else as the first JPEG of `ENCODINGS` that does, on white:
 * JPEG has no transparency, which would turn black. Null when none fits.
 */
async function encode(
	bitmap: ImageBitmap,
	name: string,
): Promise<{ width: number; height: number; image: StoredImageData } | null> {
	const tries: [number, "image/png" | "image/jpeg", number | undefined][] = [
		[IMAGE_LONG_SIDE, "image/png", undefined],
		...ENCODINGS.map(([longSide, quality]): [number, "image/jpeg", number] => [longSide, "image/jpeg", quality]),
	];
	for (const [longSide, type, quality] of tries) {
		const { width, height } = fitSize(bitmap.width, bitmap.height, longSide);
		const canvas = new OffscreenCanvas(width, height);
		const drawing = canvas.getContext("2d");
		if (drawing === null) throw new Error(t("attachImageUnreadable", [name]));
		if (type === "image/jpeg") {
			drawing.fillStyle = "#fff";
			drawing.fillRect(0, 0, width, height);
		}
		drawing.imageSmoothingQuality = "high";
		drawing.drawImage(bitmap, 0, 0, width, height);
		const blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
		const data = base64(new Uint8Array(await blob.arrayBuffer()));
		if (data.length <= MAX_IMAGE_CHARS) return { width, height, image: { mimeType: type, data } };
	}
	return null;
}

type StoredImageData = { mimeType: "image/png" | "image/jpeg"; data: string };
