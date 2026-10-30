// The size of the images a chat sends (design 6.26, 6.42): screenshots, which the worker encodes, and the user's
// attachments, which the panel encodes.

/**
 * pi's own limit of images per request, below the lowest of pi-ai's catalog (100); a model's lower limit wins. A soft
 * cap on what a request carries, not a provider's limit: a capture checked while a send is admitted can pass it by the
 * images in flight (design 6.42).
 */
export const MAX_IMAGES = 20;
/** Base64 characters of all images of a request; soft, as `MAX_IMAGES`. */
export const MAX_IMAGE_BYTES = 10_000_000;
/** Base64 characters of one image. */
export const MAX_IMAGE_CHARS = 500_000;
/** The encodings tried in turn, until one fits `MAX_IMAGE_CHARS`: the long side in pixels, and the JPEG quality. */
export const ENCODINGS: readonly (readonly [number, number])[] = [
	[1280, 0.8],
	[1280, 0.55],
	[960, 0.55],
];

/** `width` by `height` scaled so that the long side is at most `longSide`, never enlarged; at least 1 by 1. */
export function fitSize(width: number, height: number, longSide: number): { width: number; height: number } {
	const scale = Math.min(1, longSide / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(binary);
}
