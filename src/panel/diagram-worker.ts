// Draws Mermaid diagrams for the panel (design 6.32), off its thread: the panel ends a render that runs too long by
// ending this worker. Replies carry `diagram`, the request's ID, so a reply to a request the panel gave up on is not
// taken for a later one's.

import { render } from "pele";
import type { DiagramColors, DiagramReply, DiagramRequest } from "./diagram.ts";

// Typed as a Worker: it has the same postMessage and message events as this worker's global, which DOM types lack.
const scope = globalThis as unknown as Worker;

/** A longer SVG is not drawn: a short source can lay out to megabytes (a packet diagram of 100 million bits). */
const MAX_SVG_CHARS = 1_000_000;

scope.postMessage({ ready: true } satisfies DiagramReply);

scope.addEventListener("message", (event: MessageEvent<DiagramRequest>) => {
	const { diagram, source, colors } = event.data ?? {};
	if (typeof diagram !== "number" || typeof source !== "string") return;
	let svg: string | null = null;
	try {
		// An image loads no fonts, so the system's; it follows no links and loads no images either.
		const options = { fontFamily: "system-ui, sans-serif", links: false, images: false, outputLimit: MAX_SVG_CHARS };
		svg = colored(render(source, options).svg, colors);
	} catch {}
	scope.postMessage({ diagram, svg } satisfies DiagramReply);
});

/**
 * The SVG with `colors` as pele's variables on its root, and its background drawn, so the picture reads alone in the
 * viewer: an image sees none of the panel's CSS. A value that is not a plain color is left out.
 */
function colored(svg: string, colors: DiagramColors): string {
	const declarations = Object.entries(colors ?? {})
		.filter(([name, value]) => /^\w+$/.test(name) && typeof value === "string" && /^[#\w\s(),.%-]+$/.test(value))
		.map(([name, value]) => `--pele-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value};`)
		.join("");
	return svg.replace(/^<svg\b[^>]*?\sstyle="/, (start) => `${start}${declarations}background:var(--_bg);`);
}
