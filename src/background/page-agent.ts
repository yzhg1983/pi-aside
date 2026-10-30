// The part of observe_page, act_on_page, and screenshot_page that runs in the page (design 6.23, 6.26): the ref map, the
// outline, the actions, and where an element is. `pageAgent` is self-contained, since Chrome serializes it; it runs in pi's isolated world, whose globals stay
// between calls in one document, so the ref map lives there.

/** An element named by a ref: element `number` of the map with ID `mapId`, which the chat calls `letter`. */
export type AgentTarget = { letter: string; mapId: string; number: number };

export type ObserveRequest = {
	op: "observe";
	/** The letters the chat gave this document's maps; a map not among them is `letter`. */
	known: { letter: string; mapId: string }[];
	letter: string;
	/** Words that each listed element's role and name must contain; null lists everything. */
	find: string | null;
	/** List only this element's subtree. */
	within: AgentTarget | null;
	/** UTF-8 bytes of the outline as a JSON string. */
	maxBytes: number;
	budgetMs: number;
	maxElements: number;
	maxMatches: number;
	maxUrl: number;
};

export type ObserveResult =
	| { ok: true; mapId: string; letter: string; url: string; title: string; outline: string; omitted: string | null }
	| { ok: false; error: string };

export type ActAction = "click" | "type" | "press" | "scroll" | "select_option";

/** Up or down by most of a view, or to the top or the bottom. */
export type ScrollDirection = "up" | "down" | "top" | "bottom";

export type ActRequest = {
	op: "act";
	action: ActAction;
	target: AgentTarget | null;
	/** The chat's maps of this document: messages name other elements by refs of the current one, if the chat has it. */
	known: { letter: string; mapId: string }[];
	text: string | null;
	submit: boolean;
	key: string | null;
	option: string | null;
	direction: ScrollDirection | null;
	summary: string | null;
	quietMs: number;
	maxWaitMs: number;
	outlineMs: number;
	maxUrl: number;
};

/**
 * `sent`: of a failure, whether events had reached the page by then. `userInput`: the user pressed a pointer or a key
 * on the page, or focus was in a frame, while pi acted, so a tab it opened may be the user's (design 6.29).
 */
export type ActResult =
	| { ok: true; step: Step; url: string; title: string; timedOut: boolean; userInput: boolean }
	| { ok: false; error: string; sent: boolean; userInput: boolean };

/** Where an element is, for a screenshot of it (design 6.26). It does not scroll. */
export type LocateRequest = { op: "locate"; target: AgentTarget };

/**
 * A scroll before a screenshot (design 6.26), as act_on_page scrolls: `direction` scrolls the target's nearest
 * scrollable box, or the page without a target; a target alone is scrolled to the middle of the view.
 */
export type ScrollRequest = { op: "scroll"; target: AgentTarget | null; direction: ScrollDirection | null };

/** `step` says what moved and where it stopped. */
export type ScrollResult = { ok: true; step: Step } | { ok: false; error: string };

/**
 * What an action or a scroll did (design 6.23): `stepText` says it in English for the model, and the chat says it in
 * the interface language. `target` names an element as messages do, such as `button "Save" (a12)`; null is the page.
 */
export type Step =
	| { kind: "click"; target: string }
	| { kind: "type"; text: string; target: string; submitted: boolean }
	| { kind: "press"; key: string; target: string | null }
	| { kind: "choose"; option: string; target: string }
	| { kind: "scroll"; target: string | null; direction: ScrollDirection; end: "top" | "bottom" | null }
	| { kind: "reveal"; target: string }
	| { kind: "switchTab"; tab: number }
	| { kind: "closeTab"; tab: number; closed: boolean; back: number | null };

export function stepText(step: Step): string {
	switch (step.kind) {
		case "click":
			return `Clicked ${step.target}`;
		case "type":
			return `Typed ${JSON.stringify(step.text)} into ${step.target}${step.submitted ? " and submitted its form" : ""}`;
		case "press":
			return `Pressed ${step.key}${step.target === null ? "" : ` in ${step.target}`}`;
		case "choose":
			return `Chose ${JSON.stringify(step.option)} in ${step.target}`;
		case "scroll":
			return `Scrolled ${step.target ?? "the page"} ${step.direction}${step.end === null ? "" : ` (at the ${step.end})`}`;
		case "reveal":
			return `Scrolled ${step.target} into view`;
		case "switchTab":
			return `Switched to tab ${step.tab}`;
		case "closeTab":
			return `${step.closed ? `Closed tab ${step.tab}` : `Tab ${step.tab} was already closed`}${step.back === null ? "" : `; the page tools now work on tab ${step.back}`}`;
	}
}

/** A rectangle in CSS pixels from the top left of the view. */
export type Rect = { x: number; y: number; width: number; height: number };

export type Located = {
	/** The element's border box. */
	box: Rect;
	/**
	 * Where the element can show: the view without its scrollbars, cut by each element above it that clips its content,
	 * such as a scrolled list.
	 */
	clip: Rect;
	innerWidth: number;
	innerHeight: number;
	scrollX: number;
	scrollY: number;
	/** `visualViewport.scale`: not 1 when the page is zoomed with a pinch. */
	scale: number;
	/** As the outline shows the element. */
	role: string;
	name: string;
};

export type LocateResult = ({ ok: true } & Located) | { ok: false; error: string };

/** Runs in the page; Chrome serializes it, so it uses nothing outside itself. */
export async function pageAgent(
	input: ObserveRequest | ActRequest | LocateRequest | ScrollRequest,
): Promise<ObserveResult | ActResult | LocateResult | ScrollResult> {
	// Chrome leaves out the null properties of an argument object (Chrome 140 and 147): a missing one is null.
	const request: ObserveRequest | ActRequest | LocateRequest | ScrollRequest =
		input.op === "observe"
			? { ...input, find: input.find ?? null, within: input.within ?? null }
			: input.op === "locate"
				? input
				: input.op === "scroll"
					? { ...input, target: input.target ?? null, direction: input.direction ?? null }
					: {
							...input,
							target: input.target ?? null,
							text: input.text ?? null,
							key: input.key ?? null,
							option: input.option ?? null,
							direction: input.direction ?? null,
							summary: input.summary ?? null,
						};
	type Refs = {
		id: string;
		next: number;
		byNumber: Map<number, WeakRef<Element>>;
		byElement: WeakMap<Element, number>;
	};
	const MAX_NUMBERS = 10_000;
	const MAX_NAME = 80;
	const holder = globalThis as unknown as { piasideRefs?: Refs };

	// The ref map: numbers for elements, from both directions, as long as this document and this extension both live.
	const refs = (): Refs => {
		if (holder.piasideRefs === undefined) {
			const bytes = crypto.getRandomValues(new Uint8Array(8));
			holder.piasideRefs = {
				id: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
				next: 1,
				byNumber: new Map(),
				byElement: new WeakMap(),
			};
		}
		return holder.piasideRefs;
	};
	const numberOf = (element: Element): number => {
		const map = refs();
		const found = map.byElement.get(element);
		if (found !== undefined && map.byNumber.get(found)?.deref() === element) return found;
		const number = map.next++;
		map.byNumber.set(number, new WeakRef(element));
		map.byElement.set(element, number);
		// The oldest numbers go, from both directions.
		for (const [oldest, ref] of map.byNumber) {
			if (map.byNumber.size <= MAX_NUMBERS) break;
			map.byNumber.delete(oldest);
			const gone = ref.deref();
			if (gone !== undefined) map.byElement.delete(gone);
		}
		return number;
	};
	const elementOf = (target: AgentTarget): Element | undefined => {
		const map = holder.piasideRefs;
		if (map === undefined || map.id !== target.mapId) return undefined;
		const element = map.byNumber.get(target.number)?.deref();
		// A node the page moved into a frame's document is gone from this page.
		return element?.isConnected && element.ownerDocument === document ? element : undefined;
	};
	const gone = (ref: string) => `${ref} is gone (the page changed): observe again`;

	// The flat tree: shadow roots, open and closed, and what slots show.
	const shadowOf = (element: Element): ShadowRoot | null =>
		element.shadowRoot ??
		(element instanceof HTMLElement ? (globalThis.chrome?.dom?.openOrClosedShadowRoot(element) ?? null) : null);
	const childrenOf = (element: Element): Node[] => {
		const shadow = shadowOf(element);
		if (shadow !== null) return [...shadow.childNodes];
		if (element instanceof HTMLSlotElement && element.getRootNode() instanceof ShadowRoot)
			return element.assignedNodes({ flatten: true });
		return [...element.childNodes];
	};
	/** The element above in the flat tree: the slot that shows the node, else its parent or shadow host. */
	const parentOf = (node: Node): Element | null => {
		const parent = node.parentNode;
		if (node instanceof Element || node instanceof Text) {
			if (node.assignedSlot !== null) return node.assignedSlot;
			// A closed root's slot is not in assignedSlot.
			const shadow = parent instanceof Element ? shadowOf(parent) : null;
			if (shadow !== null)
				for (const slot of shadow.querySelectorAll("slot")) if (slot.assignedNodes().includes(node)) return slot;
		}
		if (parent instanceof ShadowRoot) return parent.host;
		return parent instanceof Element ? parent : null;
	};
	const clean = (text: string) => text.replace(/\s+/g, " ").trim();
	const short = (text: string, max: number) => {
		if (text.length <= max) return text;
		const high = text.charCodeAt(max - 2);
		return `${text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 2 : max - 1)}…`;
	};
	const attribute = (element: Element, name: string) => clean(element.getAttribute(name) ?? "");

	// What an element is.
	const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
	const WIDGETS = new Set([
		"button",
		"link",
		"checkbox",
		"radio",
		"switch",
		"tab",
		"menuitem",
		"menuitemcheckbox",
		"menuitemradio",
		"option",
		"textbox",
		"searchbox",
		"combobox",
		"slider",
		"spinbutton",
		"treeitem",
		"listbox",
	]);
	/** Roles named by their text, as the accessibility rules do; containers are named only by their author. */
	const NAMED_BY_TEXT = new Set([
		...WIDGETS,
		"heading",
		"row",
		"cell",
		"gridcell",
		"columnheader",
		"rowheader",
		"tooltip",
		"clickable",
		"focusable",
		"file",
	]);
	const editingHost = (element: Element): boolean =>
		element instanceof HTMLElement && element.isContentEditable && !element.parentElement?.isContentEditable;
	/** A field: its content is never shown. */
	const isField = (element: Element): boolean =>
		element instanceof HTMLInputElement ||
		element instanceof HTMLTextAreaElement ||
		element instanceof HTMLSelectElement ||
		editingHost(element);
	/** Inside a field: part of its content. */
	const inField = (element: Element): boolean => {
		for (let at = parentOf(element); at !== null; at = parentOf(at)) if (isField(at)) return true;
		return false;
	};
	const explicitRole = (element: Element): string | null => {
		const role = (element.getAttribute("role") ?? "").trim().split(/\s+/)[0]!.toLowerCase();
		return role === "" || role === "none" || role === "presentation" || role === "generic" ? null : role;
	};
	const inputRole = (input: HTMLInputElement): string => {
		switch (input.type) {
			case "checkbox":
			case "radio":
				return input.type;
			case "button":
			case "submit":
			case "reset":
			case "image":
			case "color":
				return "button";
			case "range":
				return "slider";
			case "number":
				return "spinbutton";
			case "search":
				return "searchbox";
			case "file":
				return "file";
			default:
				return "textbox";
		}
	};
	/** Inside an article, an aside, the main content, a navigation, or a section. */
	const sectioned = (element: Element): boolean => {
		for (let at = parentOf(element); at !== null; at = parentOf(at)) {
			if (["ARTICLE", "ASIDE", "MAIN", "NAV", "SECTION"].includes(at.tagName)) return true;
			if (/^(article|complementary|main|navigation|region)$/.test(explicitRole(at) ?? "")) return true;
		}
		return false;
	};
	const implicitRole = (element: Element): string | null => {
		switch (element.tagName) {
			case "A":
			case "AREA":
				return element.hasAttribute("href") ? "link" : null;
			case "BUTTON":
			case "SUMMARY":
				return "button";
			case "SELECT": {
				const select = element as HTMLSelectElement;
				return select.multiple || select.size > 1 ? "listbox" : "combobox";
			}
			case "TEXTAREA":
				return "textbox";
			case "INPUT":
				return (element as HTMLInputElement).type === "hidden" ? null : inputRole(element as HTMLInputElement);
			case "H1":
			case "H2":
			case "H3":
			case "H4":
			case "H5":
			case "H6":
				return "heading";
			case "MAIN":
				return "main";
			case "NAV":
				return "navigation";
			// The page's own header and footer only: one inside an article or a section is not a landmark (HTML-AAM).
			case "HEADER":
				return sectioned(element) ? null : "banner";
			case "FOOTER":
				return sectioned(element) ? null : "contentinfo";
			case "ARTICLE":
				return "article";
			case "ASIDE":
				return "complementary";
			case "FORM":
				return "form";
			case "DIALOG":
				return "dialog";
			default:
				return editingHost(element) ? "textbox" : null;
		}
	};
	const interactive = (element: Element): boolean => {
		const role = explicitRole(element) ?? implicitRole(element);
		if (role !== null && WIDGETS.has(role)) return true;
		if (role === "file" || editingHost(element)) return true;
		return element.hasAttribute("tabindex") && (element as HTMLElement).tabIndex >= 0;
	};
	/**
	 * What the text does not show: an image (`<img>` or `role="img"`), a diagram (an outer `<svg>`), a canvas, or a
	 * video. Null for anything else.
	 */
	const mediaOf = (element: Element): "image" | "graphic" | "canvas" | "video" | null => {
		if (element.tagName === "IMG" || explicitRole(element) === "img") return "image";
		if (element instanceof SVGSVGElement && element.ownerSVGElement === null) return "graphic";
		if (element.tagName === "CANVAS") return "canvas";
		if (element.tagName === "VIDEO") return "video";
		return null;
	};
	/** Media smaller than this on a side are icons, rules, or spacers: not listed by their own role. */
	const MIN_MEDIA = 48;
	/** Media the page marks as not content: `role="presentation"` or `"none"`, or under `aria-hidden="true"`. */
	const decorative = (element: Element): boolean =>
		/^(presentation|none)$/i.test(attribute(element, "role")) || element.closest('[aria-hidden="true"]') !== null;
	/** The caption of the `<figure>` a medium is in; empty without one. */
	const captionOf = (element: Element): string => {
		for (let at = parentOf(element); at !== null; at = parentOf(at)) {
			if (at.tagName !== "FIGURE") continue;
			const caption = [...at.children].find((child) => child.tagName === "FIGCAPTION");
			// A caption the page hides is no drawn text; textOf() only leaves out what is hidden below it.
			return caption === undefined || !caption.checkVisibility({ visibilityProperty: true })
				? ""
				: textOf(caption, 200);
		}
		return "";
	};
	/** `400×360`: an element's size in CSS px. */
	const sizeOf = (element: Element): string => {
		const box = element.getBoundingClientRect();
		return `${Math.round(box.width)}×${Math.round(box.height)}`;
	};
	/** The role a line shows; null for an element that is not listed. `clickable`: a pointer that its parent lacks. */
	const roleOf = (element: Element, clickable: boolean): string | null => {
		const role = explicitRole(element) ?? implicitRole(element);
		if (role === "img") return "image";
		if (role !== null) return role;
		if (interactive(element)) return "focusable";
		if (clickable) return "clickable";
		// Media are listed by what they are, so a page's figures can be found and captured by ref (design 6.23).
		const media = mediaOf(element);
		if (media === null || decorative(element)) return null;
		const box = element.getBoundingClientRect();
		return box.width >= MIN_MEDIA && box.height >= MIN_MEDIA ? media : null;
	};

	/** Drawn text below `root`, without field content; at most about `limit` characters, from at most 500 elements. */
	const textOf = (root: Element, limit: number): string => {
		let out = "";
		let elements = 0;
		const visit = (node: Node, shown: boolean) => {
			if (out.length >= limit || elements > 500) return;
			if (node.nodeType === Node.TEXT_NODE) {
				if (shown) out += (node as Text).data;
				return;
			}
			if (!(node instanceof Element)) return;
			elements += 1;
			if (isField(node) || ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "OPTION"].includes(node.tagName)) return;
			const style = getComputedStyle(node);
			if (style.display === "none") return;
			if (node.tagName === "IMG") {
				if (style.visibility === "visible") out += ` ${attribute(node, "alt")} `;
				return;
			}
			const block = style.display !== "contents" && !style.display.startsWith("inline");
			if (block) out += " ";
			for (const child of childrenOf(node)) visit(child, style.visibility === "visible");
			if (block) out += " ";
		};
		const style = getComputedStyle(root);
		for (const child of childrenOf(root)) visit(child, style.visibility === "visible");
		return clean(out);
	};
	const nameOf = (element: Element, role: string): string => {
		if (inField(element)) return "";
		const label = attribute(element, "aria-label");
		if (label !== "") return label;
		const ids = attribute(element, "aria-labelledby");
		if (ids !== "") {
			const root = element.getRootNode() as Document | ShadowRoot;
			const text = clean(
				ids
					.split(" ")
					.map((id) => {
						const by = root.getElementById(id);
						return by === null || isField(by) || inField(by) ? "" : textOf(by, 200);
					})
					.join(" "),
			);
			if (text !== "") return text;
		}
		const labels = (element as HTMLInputElement).labels;
		if (labels !== undefined && labels !== null && labels.length > 0) {
			const text = clean(
				[...labels]
					.filter((one) => !inField(one))
					.map((one) => textOf(one, 200))
					.join(" "),
			);
			if (text !== "") return text;
		}
		const alt = attribute(element, "alt");
		if (alt !== "") return alt;
		if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
			const placeholder = attribute(element, "placeholder");
			if (placeholder !== "") return placeholder;
		}
		if (editingHost(element)) {
			const placeholder = attribute(element, "aria-placeholder");
			if (placeholder !== "") return placeholder;
		}
		if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) {
			const value = clean(element.value);
			if (value !== "") return value;
			if (element.type !== "button") return element.type === "submit" ? "Submit" : "Reset";
		} else if (!isField(element) && NAMED_BY_TEXT.has(role)) {
			const text = textOf(element, 200);
			if (text !== "") return text;
		}
		// A diagram's own title, as its first `<title>` child.
		if (element instanceof SVGSVGElement) {
			const title = [...element.children].find((child) => child.tagName.toLowerCase() === "title");
			const text = clean(title?.textContent ?? "");
			if (text !== "") return text;
		}
		return attribute(element, "title");
	};
	const statesOf = (element: Element, role: string): string[] => {
		const states: string[] = [];
		if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
			if (element.checked) states.push("checked");
		} else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
			if (!(element instanceof HTMLInputElement && ["button", "submit", "reset", "image"].includes(element.type)))
				states.push(element.value === "" ? "(empty)" : "(filled)");
		} else if (element instanceof HTMLSelectElement) {
			states.push(element.value === "" ? "(empty)" : "(filled)");
		} else if (editingHost(element)) {
			states.push((element.textContent ?? "").trim() === "" ? "(empty)" : "(filled)");
		}
		const marker = markerOf(element);
		if (marker !== null) states.push(marker.state);
		if (element.getAttribute("aria-checked") === "true") states.push("checked");
		const expanded = element.getAttribute("aria-expanded");
		if (expanded === "true") states.push("expanded");
		else if (expanded === "false") states.push("collapsed");
		else if (element.tagName === "SUMMARY" && element.parentElement instanceof HTMLDetailsElement)
			states.push(element.parentElement.open ? "expanded" : "collapsed");
		if (element.getAttribute("aria-selected") === "true") states.push("selected");
		if (disabled(element)) states.push("disabled");
		if (role === "heading") {
			const level = /^H([1-6])$/.exec(element.tagName)?.[1] ?? attribute(element, "aria-level");
			if (level !== "") states.push(`level=${level}`);
		}
		if (mediaOf(element) !== null) {
			states.push(sizeOf(element));
			const caption = captionOf(element);
			if (caption !== "") states.push(`caption ${JSON.stringify(short(caption, MAX_NAME))}`);
		}
		return states;
	};
	/** A field that refuses typing: a password field, or one marked as a payment card's or a one-time code's. */
	const markerOf = (element: Element): { state: string; text: string } | null => {
		if (element instanceof HTMLInputElement && element.type === "password")
			return { state: "password", text: "a password field" };
		if (!isField(element)) return null;
		const tokens = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
		if (tokens.some((token) => token.startsWith("cc-"))) return { state: "card field", text: "a payment card field" };
		if (tokens.includes("one-time-code")) return { state: "one-time code", text: "a one-time-code field" };
		return null;
	};
	const disabled = (element: Element): boolean =>
		element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
	const pointer = (element: Element) => getComputedStyle(element).cursor === "pointer";
	/** Clickable by its look, as observe lists it: a pointer cursor that its parent lacks. */
	const clickable = (element: Element): boolean => {
		if (!pointer(element)) return false;
		const parent = parentOf(element);
		return parent === null || !pointer(parent);
	};
	/** `role "name" a12` for messages; an element that is not listed by its tag. A page sets the role, so it is cut. */
	const describe = (element: Element, letter: string | null): string => {
		const role = roleOf(element, clickable(element)) ?? element.tagName.toLowerCase();
		const name = short(nameOf(element, role), MAX_NAME);
		return `${short(role, MAX_NAME)}${name === "" ? "" : ` "${name}"`}${letter === null ? "" : ` (${letter}${numberOf(element)})`}`;
	};
	/** `element`'s nearest box that scrolls up and down, itself included; null for the page. */
	const scrollBoxOf = (element: Element): Element | null => {
		let box: Element | null = element;
		// The root and the page's scrolling element scroll the page.
		while (box !== null && box !== document.documentElement && box !== document.scrollingElement) {
			const { overflowY } = getComputedStyle(box);
			if (/auto|scroll|overlay/.test(overflowY) && box.scrollHeight > box.clientHeight + 1) return box;
			box = parentOf(box);
		}
		return null;
	};
	/** `box`'s scrollport as drawn, in CSS px of the view, and its scale: its drawn height against its layout height. */
	const portOf = (box: Element): { top: number; bottom: number; scale: number } => {
		const rect = box.getBoundingClientRect();
		const scale = box instanceof HTMLElement && box.offsetHeight > 0 ? rect.height / box.offsetHeight : 1;
		const top = rect.top + box.clientTop * scale;
		return { top, bottom: top + box.clientHeight * scale, scale };
	};
	/** A rectangle in CSS px of the view, and whether it cuts off what is in it across (x) and up and down (y). */
	type Clip = { left: number; top: number; right: number; bottom: number; x: boolean; y: boolean };
	/**
	 * What cuts `element` off, as the capture crops it: the view first, then each ancestor that holds its box and clips
	 * it, nearest first; or why pi cannot tell.
	 */
	const clipsOf = (element: Element): Clip[] | string => {
		// The root's size without scrollbars; in quirks mode the body's.
		const root = (document.compatMode === "BackCompat" ? document.body : null) ?? document.documentElement;
		const clips: Clip[] = [{ left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight, x: true, y: true }];
		// The root's overflow is the view's; so is the body's while the root's is visible (CSS Overflow 3.3) and neither has
		// containment, also from container-type or content-visibility.
		const contained = (style: CSSStyleDeclaration) =>
			style.contain !== "none" || style.containerType !== "normal" || style.contentVisibility !== "visible";
		const rootStyle = getComputedStyle(document.documentElement);
		const bodyIsView =
			rootStyle.overflowX === "visible" &&
			rootStyle.overflowY === "visible" &&
			!contained(rootStyle) &&
			document.body !== null &&
			!contained(getComputedStyle(document.body));
		// Paint containment, also from content-visibility: auto.
		const paints = (style: CSSStyleDeclaration) =>
			/paint|strict|content/.test(style.contain) || style.contentVisibility === "auto";
		// Transforms and containment do not apply to an HTML inline box; they do to an inline <svg>.
		const boxed = (at: Element, style: CSSStyleDeclaration) =>
			!(at instanceof HTMLElement && style.display === "inline");
		// Ancestors that place a fixed box: a transform, a filter, or layout or paint containment (content-visibility: auto
		// applies both).
		const holdsFixed = (at: Element, style: CSSStyleDeclaration) =>
			style.filter !== "none" ||
			style.backdropFilter !== "none" ||
			/filter/.test(style.willChange) ||
			(boxed(at, style) &&
				([style.transform, style.translate, style.rotate, style.scale, style.perspective].some(
					(value) => value !== "none",
				) ||
					/layout/.test(style.contain) ||
					paints(style) ||
					/transform|translate|rotate|scale|perspective/.test(style.willChange)));
		// Rotated, skewed, or mirrored: a clip is then not a rectangle of the view with its scrollbars where they were.
		const turned = (style: CSSStyleDeclaration) => {
			if (style.rotate !== "none" || style.scale.includes("-")) return true;
			if (style.transform === "none") return false;
			const matrix = new DOMMatrixReadOnly(style.transform);
			return !matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a < 0 || matrix.d < 0;
		};
		// An ancestor clips the element only if it holds the element's box: a fixed box is placed by the view or by an
		// ancestor above, an absolute one also by a positioned ancestor; the ancestors in between do not clip it.
		let placed = getComputedStyle(element).position;
		let cut = false;
		for (let at = parentOf(element); at !== null; at = parentOf(at)) {
			const style = getComputedStyle(at);
			if (style.display === "contents") continue;
			if (
				placed === "fixed"
					? !holdsFixed(at, style)
					: placed === "absolute" && style.position === "static" && !holdsFixed(at, style)
			)
				continue;
			placed = style.position;
			// Paint containment clips both ways, also with its overflow visible. The root's overflow is the view's, and so is
			// the body's while bodyIsView; paint containment still clips them.
			const painted = boxed(at, style) && paints(style);
			const ownOverflow =
				boxed(at, style) && at !== document.documentElement && !(at === document.body && bodyIsView);
			const [clipsX, clipsY] = [
				painted || (ownOverflow && style.overflowX !== "visible"),
				painted || (ownOverflow && style.overflowY !== "visible"),
			];
			if (turned(style) && (cut || clipsX || clipsY))
				return "The element is in a rotated, skewed, or mirrored part of the page; pi can only capture the whole view.";
			if (!clipsX && !clipsY) continue;
			// An inner <svg> reports the bounds of its drawing, not of the viewport it clips at; a quirks-mode body that
			// scrolls on its own reports the view's size, not its own, so its scrollbars cannot be told apart.
			if (
				(at instanceof SVGSVGElement && at.ownerSVGElement !== null) ||
				(at === root && ownOverflow && (style.overflowX !== "visible" || style.overflowY !== "visible"))
			)
				return "pi cannot measure where the page cuts this element off; pi can only capture the whole view.";
			cut = true;
			// Inside its borders and scrollbars, scaled as it is drawn. In CSS pixels from its border box's corner: where the
			// clip starts, its size, and the border box's size.
			const edge = at.getBoundingClientRect();
			let inner = { left: edge.left, top: edge.top, right: edge.right, bottom: edge.bottom };
			const px = (value: string) => Number.parseFloat(value) || 0;
			const metrics: [number, number, number, number, number, number] | null =
				at === root
					? // Its client size is the view's; it has no scrollbars of its own here.
						[
							root.clientLeft,
							root.clientTop,
							root.offsetWidth - root.clientLeft - px(style.borderRightWidth),
							root.offsetHeight - root.clientTop - px(style.borderBottomWidth),
							root.offsetWidth,
							root.offsetHeight,
						]
					: at instanceof HTMLElement
						? [at.clientLeft, at.clientTop, at.clientWidth, at.clientHeight, at.offsetWidth, at.offsetHeight]
						: at instanceof SVGSVGElement
							? // An outer <svg> clips at its content box, its viewport; it has no scrollbars.
								[
									at.clientLeft + px(style.paddingLeft),
									at.clientTop + px(style.paddingTop),
									at.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
									at.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
									at.clientLeft + at.clientWidth + px(style.borderRightWidth),
									at.clientTop + at.clientHeight + px(style.borderBottomWidth),
								]
							: null;
			if (metrics !== null && metrics[4] > 0 && metrics[5] > 0) {
				const [clipLeft, clipTop, width, height, outerWidth, outerHeight] = metrics;
				const [sx, sy] = [edge.width / outerWidth, edge.height / outerHeight];
				const [x, y] = [edge.left + clipLeft * sx, edge.top + clipTop * sy];
				inner = { left: x, top: y, right: x + width * sx, bottom: y + height * sy };
			}
			clips.push({ ...inner, x: clipsX, y: clipsY });
		}
		return clips;
	};
	/**
	 * How much of `box`'s scrollport shows, in CSS px of the view: cut off as the capture cuts off what is in it (by the
	 * view without clips pi cannot tell); and its scale.
	 */
	const shownOf = (box: Element): { height: number; scale: number } => {
		const { top, bottom, scale } = portOf(box);
		const clips = clipsOf(box);
		let [from, to] = [Math.max(top, 0), Math.min(bottom, innerHeight)];
		if (typeof clips !== "string")
			for (const clip of clips) if (clip.y) [from, to] = [Math.max(from, clip.top), Math.min(to, clip.bottom)];
		return { height: Math.max(0, to - from), scale };
	};
	/**
	 * Scrolls by `direction`, as a mouse wheel does: the nearest box that can still move that way, from `element` itself
	 * outwards, or the page. Up or down by 0.8 of the part of that box the view shows, so that each step overlaps the
	 * last; or to its top or bottom. Says what moved and where it stopped; `box` is what moved, null for the page.
	 */
	const scrollIn = (element: Element | undefined, direction: ScrollDirection, letter: string | null) => {
		const back = direction === "up" || direction === "top";
		let box = element === undefined ? null : scrollBoxOf(element);
		while (box !== null && (back ? box.scrollTop <= 0 : box.scrollTop + box.clientHeight >= box.scrollHeight - 1)) {
			const parent = parentOf(box);
			box = parent === null ? null : scrollBoxOf(parent);
		}
		const scroller = box ?? document.scrollingElement ?? document.documentElement;
		let height = innerHeight;
		if (box !== null) {
			const shown = shownOf(box);
			// A box out of the view steps by at most a view.
			height =
				shown.height > 0 && shown.scale > 0
					? Math.min(box.clientHeight, shown.height / shown.scale)
					: Math.min(box.clientHeight, innerHeight / (shown.scale > 0 ? shown.scale : 1));
		}
		if (direction === "top") scroller.scrollTo({ top: 0, behavior: "instant" });
		else if (direction === "bottom") scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
		else scroller.scrollBy({ top: (direction === "up" ? -0.8 : 0.8) * height, behavior: "instant" });
		const end =
			scroller.scrollTop <= 0
				? ("top" as const)
				: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
					? ("bottom" as const)
					: null;
		const step: Step = { kind: "scroll", target: box === null ? null : describe(box, letter), direction, end };
		return { box, step };
	};

	if (request.op === "scroll") {
		let element: Element | undefined;
		if (request.target !== null) {
			const ref = `${request.target.letter}${request.target.number}`;
			element = elementOf(request.target);
			if (element === undefined) return { ok: false, error: gone(ref) };
			const box = element.getBoundingClientRect();
			if (!element.checkVisibility({ visibilityProperty: true }) || box.width === 0 || box.height === 0)
				return { ok: false, error: `${ref} is not drawn (hidden, collapsed, or empty): observe again` };
		}
		let step: Step;
		if (request.direction !== null) step = scrollIn(element, request.direction, request.target?.letter ?? null).step;
		else if (element !== undefined) {
			// An element taller than the view, or than any box around it that cuts it off, starts at the top, so that
			// scrolling down shows the rest of it in order; one wider than the view starts at the left; a smaller one goes to
			// the middle. All heights are as drawn, in CSS px of the view.
			const box = element.getBoundingClientRect();
			const clips = clipsOf(element);
			const room = Math.min(
				innerHeight,
				...(typeof clips === "string" ? [] : clips.filter((clip) => clip.y).map((clip) => clip.bottom - clip.top)),
			);
			element.scrollIntoView({
				block: box.height > room ? "start" : "center",
				inline: box.width > innerWidth ? "start" : "center",
				behavior: "instant",
			});
			step = { kind: "reveal", target: describe(element, request.target?.letter ?? null) };
		} else return { ok: false, error: "scroll needs a ref, a direction, or both" };
		// Two frames, so that the page draws what scrolled in; a page that draws no frame goes on after 200 ms.
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 200);
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					clearTimeout(timer);
					resolve();
				}),
			);
		});
		return { ok: true, step };
	}

	if (request.op === "observe") {
		const map = refs();
		// Each observe deletes the numbers of elements that are gone.
		for (const [number, ref] of map.byNumber) {
			const element = ref.deref();
			if (element?.isConnected) continue;
			map.byNumber.delete(number);
			if (element !== undefined) map.byElement.delete(element);
		}
		const letter = request.known.find((known) => known.mapId === map.id)?.letter ?? request.letter;
		let start: Element | null = document.body ?? document.documentElement;
		if (request.within !== null) {
			const ref = `${request.within.letter}${request.within.number}`;
			start = elementOf(request.within) ?? null;
			if (start === null) return { ok: false, error: gone(ref) };
			if (inField(start)) return { ok: false, error: `${ref} is inside a field: its content is not shown` };
		}

		type Item = {
			element: Element;
			role: string;
			name: string;
			states: string[];
			widget: boolean;
			media: boolean;
			children: Item[];
		};
		const end = performance.now() + request.budgetMs;
		let visited = 0;
		let stopped: "time" | "elements" | null = null;
		const walk = (node: Node, parentCursor: string, into: Item[]) => {
			if (stopped !== null || !(node instanceof Element)) return;
			visited += 1;
			if (visited > request.maxElements) stopped = "elements";
			else if (visited % 256 === 0 && performance.now() > end) stopped = "time";
			if (stopped !== null) return;
			const style = getComputedStyle(node);
			if (style.display === "none") return;
			const boxless = style.display === "contents";
			if (!boxless && !node.checkVisibility()) return;
			let into2 = into;
			if (!boxless && style.visibility === "visible") {
				const role = roleOf(node, style.cursor === "pointer" && parentCursor !== "pointer");
				if (role !== null) {
					const media = mediaOf(node);
					const name = short(nameOf(node, role), MAX_NAME);
					const item: Item = {
						element: node,
						role,
						name: name === "" && media === "image" ? "(no alt)" : name,
						states: statesOf(node, role),
						widget: interactive(node) || role === "clickable",
						media: media !== null,
						children: [],
					};
					into.push(item);
					into2 = item.children;
				}
			}
			// A field's content is never listed: a select's options, a contenteditable's elements.
			if (isField(node)) return;
			for (const child of childrenOf(node)) walk(child, boxless ? parentCursor : style.cursor, into2);
		};
		const top: Item[] = [];
		const parent = parentOf(start);
		walk(start, parent === null ? "auto" : getComputedStyle(parent).cursor, top);

		// An interactive element that holds exactly one interactive element of the same name is not listed; the inner
		// one is, where a click at the center lands.
		const widgets = (items: Item[]): Item[] =>
			items.flatMap((item) => [...(item.widget ? [item] : []), ...widgets(item.children)]);
		const collapse = (items: Item[]): Item[] =>
			items.flatMap((item) => {
				item.children = collapse(item.children);
				if (item.widget) {
					const inner = widgets(item.children);
					if (inner.length === 1 && inner[0]!.name === item.name) return item.children;
				}
				return [item];
			});
		let items = collapse(top);

		let matched = 0;
		let unmatched = 0;
		if (request.find !== null) {
			const words = request.find
				.toLowerCase()
				.split(/\s+/)
				.filter((word) => word !== "");
			const prune = (list: Item[]): Item[] => {
				const kept: Item[] = [];
				for (const item of list) {
					// find "image" lists every medium, also a clickable image or a diagram.
					const text = `${item.role} ${item.name}${item.media ? " image" : ""}`.toLowerCase();
					let hit = words.every((word) => text.includes(word));
					if (hit && ++matched > request.maxMatches) {
						hit = false;
						unmatched += 1;
					}
					const children = prune(item.children);
					if (hit || children.length > 0) kept.push({ ...item, children });
				}
				return kept;
			};
			items = prune(items);
		}

		// Lines until the outline would pass `maxBytes` as a JSON string; the rest are counted.
		const encoder = new TextEncoder();
		const lines: string[] = [];
		let bytes = 2;
		let left = 0;
		const render = (list: Item[], depth: number) => {
			for (const item of list) {
				if (left > 0) {
					left += 1;
				} else {
					const name = item.name === "" ? "" : ` ${JSON.stringify(item.name)}`;
					const states = item.states.length === 0 ? "" : ` ${item.states.join(" ")}`;
					const line = `${"  ".repeat(depth)}- ${item.role}${name} ${letter}${numberOf(item.element)}${states}`;
					const size = encoder.encode(JSON.stringify(line)).length;
					if (bytes + size > request.maxBytes) left = 1;
					else {
						lines.push(line);
						bytes += size;
					}
				}
				render(item.children, depth + 1);
			}
		};
		render(items, 0);
		const omitted = [
			...(left > 0 ? [`${left} more elements past the size limit`] : []),
			...(unmatched > 0 ? [`${unmatched} more matches`] : []),
			...(stopped === "time" ? [`the elements after ${visited} (out of time)`] : []),
			...(stopped === "elements" ? [`the elements after ${request.maxElements}`] : []),
		];
		return {
			ok: true,
			mapId: map.id,
			letter,
			url: location.href.slice(0, request.maxUrl),
			title: document.title.slice(0, 300),
			outline:
				lines.length > 0 ? lines.join("\n") : request.find !== null ? "No element matches." : "Nothing is listed.",
			omitted: omitted.length === 0 ? null : `${omitted.join("; ")}; narrow with find or within`,
		};
	}

	if (request.op === "locate") {
		const ref = `${request.target.letter}${request.target.number}`;
		const element = elementOf(request.target);
		if (element === undefined) return { ok: false, error: gone(ref) };
		const box = element.getBoundingClientRect();
		if (!element.checkVisibility({ visibilityProperty: true }) || box.width === 0 || box.height === 0)
			return { ok: false, error: `${ref} is not drawn (hidden, collapsed, or empty): observe again` };
		const clips = clipsOf(element);
		if (typeof clips === "string") return { ok: false, error: clips };
		let [left, top, right, bottom] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Infinity, Infinity];
		for (const clip of clips) {
			if (clip.x) [left, right] = [Math.max(left, clip.left), Math.min(right, clip.right)];
			if (clip.y) [top, bottom] = [Math.max(top, clip.top), Math.min(bottom, clip.bottom)];
		}
		const role = roleOf(element, clickable(element)) ?? element.tagName.toLowerCase();
		return {
			ok: true,
			box: { x: box.x, y: box.y, width: box.width, height: box.height },
			clip: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
			innerWidth,
			innerHeight,
			scrollX,
			scrollY,
			scale: visualViewport?.scale ?? 1,
			role: short(role, MAX_NAME),
			name: short(nameOf(element, role), MAX_NAME),
		};
	}

	// act_on_page.
	const act = {
		...request,
		letter: request.known.find((known) => known.mapId === holder.piasideRefs?.id)?.letter ?? null,
	};
	let sent = false;
	// pi's events are not trusted ones: a trusted one is the user's. Input in a frame stays in the frame's document,
	// unseen here, but moves focus into the frame; pi acts in this document only, so focus in a frame is the user's
	// too: when the window loses it to one, and when pi answers.
	let userInput = false;
	const noteInput = (event: Event) => {
		if (event.isTrusted) userInput = true;
	};
	const inFrame = () => {
		let active = document.activeElement;
		while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
		return (
			active instanceof HTMLIFrameElement ||
			active instanceof HTMLFrameElement ||
			active instanceof HTMLObjectElement ||
			active instanceof HTMLEmbedElement
		);
	};
	const noteBlur = (event: Event) => {
		if (event.isTrusted && event.target === window && inFrame()) userInput = true;
	};
	addEventListener("pointerdown", noteInput, true);
	addEventListener("keydown", noteInput, true);
	addEventListener("blur", noteBlur, true);
	const stopInput = () => {
		removeEventListener("pointerdown", noteInput, true);
		removeEventListener("keydown", noteInput, true);
		removeEventListener("blur", noteBlur, true);
		if (inFrame()) userInput = true;
	};
	const refused = (error: string): ActResult => {
		stopInput();
		return { ok: false, error, sent, userInput };
	};
	const ref = act.target === null ? "" : `${act.target.letter}${act.target.number}`;
	let element: Element | undefined;
	if (act.target !== null) {
		element = elementOf(act.target);
		if (element === undefined) return refused(gone(ref));
		const box = element.getBoundingClientRect();
		if (!element.checkVisibility({ visibilityProperty: true }) || box.width === 0 || box.height === 0)
			return refused(`${ref} is not drawn (hidden, collapsed, or empty): observe again`);
		if (disabled(element)) return refused(`${ref} is disabled`);
	}
	const center = (target: Element) => {
		target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const box = target.getBoundingClientRect();
		return {
			x: Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2)),
			y: Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2)),
		};
	};
	/** The deepest element at a point, through shadow roots. */
	const hitAt = (x: number, y: number): Element | null => {
		let hit = document.elementFromPoint(x, y);
		for (;;) {
			const shadow = hit === null ? null : shadowOf(hit);
			const inner = shadow?.elementFromPoint(x, y) ?? null;
			if (inner === null || inner === hit) return hit;
			hit = inner;
		}
	};
	/** The focused element, through shadow roots. */
	const focused = (): Element | null => {
		let active = document.activeElement;
		for (;;) {
			const inner = active === null ? null : (shadowOf(active)?.activeElement ?? null);
			if (inner === null) return active;
			active = inner;
		}
	};
	const focusText = (target: Element): string | null => {
		const now = focused();
		return now === target
			? null
			: now === null || now === document.body
				? `The focus did not go to ${ref}`
				: `Focus went to ${describe(now, act.letter)}, not ${ref}`;
	};
	const outline = (target: Element) => {
		const box = target.getBoundingClientRect();
		const host = document.createElement("div");
		host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
		const shadow = host.attachShadow({ mode: "closed" });
		const frame = document.createElement("div");
		frame.style.cssText = `position: fixed; left: ${box.left - 3}px; top: ${box.top - 3}px; width: ${box.width + 2}px; height: ${box.height + 2}px; border: 2px solid #0a66c2; border-radius: 4px; pointer-events: none;`;
		shadow.append(frame);
		if (act.summary !== null && act.summary !== "") {
			const label = document.createElement("div");
			label.textContent = act.summary;
			const top = box.top > 26 ? box.top - 26 : box.bottom + 5;
			label.style.cssText = `position: fixed; left: ${Math.max(0, box.left - 3)}px; top: ${top}px; max-width: 320px; padding: 2px 6px; border-radius: 4px; background: #0a66c2; color: #fff; font: 12px/1.5 system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;`;
			shadow.append(label);
		}
		document.documentElement.append(host);
		setTimeout(() => host.remove(), act.outlineMs);
		return host;
	};
	/**
	 * Waits until nothing in the document or its shadow roots changes for `quietMs`, at most `maxWaitMs`. True when pi
	 * cannot tell that the page is quiet: the wait reached `maxWaitMs`, or the last look for shadow roots stopped at its
	 * bound of 50,000 elements.
	 */
	const settle = (ignore: Element | null): Promise<boolean> =>
		new Promise((resolve) => {
			const own = ignore === null ? null : shadowOf(ignore);
			const observer = new MutationObserver((records) => {
				let changed = false;
				for (const record of records) {
					const nodes = [...record.addedNodes, ...record.removedNodes];
					// The outline's host coming and going, and what is inside it, are not the page's changes.
					if (
						ignore !== null &&
						(record.target === ignore ||
							(own?.contains(record.target) ?? false) ||
							(record.type === "childList" && nodes.length > 0 && nodes.every((node) => node === ignore)))
					)
						continue;
					changed = true;
					for (const node of record.addedNodes) if (node instanceof Element) watch(node, { left: 50_000 });
				}
				if (!changed) return;
				clearTimeout(quiet);
				quiet = setTimeout(quieted, act.quietMs);
			});
			const options = { subtree: true, childList: true, attributes: true, characterData: true };
			const roots = new Set<ShadowRoot>();
			/** Observes the shadow roots under `root` that are not observed yet, nested ones too, while `scan` lasts; how many. */
			const watch = (root: Node, scan: { left: number }): number => {
				let found = 0;
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
				for (let node: Node | null = walker.currentNode; node !== null && scan.left > 0; node = walker.nextNode()) {
					scan.left -= 1;
					const shadow = node instanceof Element ? shadowOf(node) : null;
					if (shadow === null) continue;
					if (!roots.has(shadow)) {
						roots.add(shadow);
						observer.observe(shadow, options);
						found += 1;
					}
					found += watch(shadow, scan);
				}
				return found;
			};
			/** Nothing changed for `quietMs`. A root attached to an element already there makes no record: look again first. */
			const quieted = () => {
				const scan = { left: 50_000 };
				if (watch(document, scan) > 0) quiet = setTimeout(quieted, act.quietMs);
				else done(scan.left <= 0);
			};
			observer.observe(document, options);
			watch(document, { left: 50_000 });
			let quiet = setTimeout(quieted, act.quietMs);
			const limit = setTimeout(() => done(true), act.maxWaitMs);
			const done = (timedOut: boolean) => {
				observer.disconnect();
				clearTimeout(quiet);
				clearTimeout(limit);
				resolve(timedOut);
			};
		});
	const finish = async (step: Step, shown: Element | null): Promise<ActResult> => {
		const timedOut = await settle(shown);
		stopInput();
		return {
			ok: true,
			step,
			timedOut,
			url: location.href.slice(0, act.maxUrl),
			title: document.title.slice(0, 300),
			userInput,
		};
	};

	try {
		switch (act.action) {
			case "click": {
				if (element === undefined) return refused("click needs a ref");
				const { x, y } = center(element);
				const hit = hitAt(x, y);
				if (hit === null) return refused(`The center of ${ref} is outside the window`);
				// From the element hit up to the target: no other interactive element between them.
				let between: Element | null = null;
				let at: Element | null = hit;
				while (at !== null && at !== element) {
					if (between === null && (interactive(at) || roleOf(at, false) === "link" || clickable(at))) between = at;
					at = parentOf(at);
				}
				if (at === null) {
					// Covered: name the nearest listed element over it.
					let cover: Element | null = hit;
					while (cover !== null && roleOf(cover, false) === null) cover = parentOf(cover);
					return refused(`${ref} is covered by ${describe(cover ?? hit, act.letter)}`);
				}
				if (between !== null)
					return refused(`The center of ${ref} is ${describe(between, act.letter)}; act on that ref instead`);
				// The site a link leads to, sent before the click: a site card names it if Chrome does not let pi follow it
				// there (design 6.28). The worker notes it by the tab Chrome says the message came from.
				for (let at: Element | null = element; at !== null; at = parentOf(at))
					if ((at instanceof HTMLAnchorElement || at instanceof HTMLAreaElement) && at.hasAttribute("href")) {
						if (typeof chrome !== "undefined")
							void chrome.runtime.sendMessage({ type: "pi-link", url: at.href }).catch(() => {});
						break;
					}
				const shown = outline(element);
				const pointer = {
					bubbles: true,
					cancelable: true,
					composed: true,
					clientX: x,
					clientY: y,
					button: 0,
					view: window,
				};
				const touch = { ...pointer, pointerId: 1, pointerType: "mouse", isPrimary: true };
				sent = true;
				hit.dispatchEvent(new PointerEvent("pointerdown", { ...touch, buttons: 1 }));
				const down = hit.dispatchEvent(new MouseEvent("mousedown", { ...pointer, buttons: 1 }));
				// As a real click: the focusable element under the pointer takes the focus.
				if (down) {
					let focusable: Element | null = hit;
					while (
						focusable !== null &&
						!(focusable instanceof HTMLElement && (focusable.tabIndex >= 0 || isField(focusable)))
					)
						focusable = parentOf(focusable);
					if (focusable instanceof HTMLElement) focusable.focus({ preventScroll: true });
				}
				hit.dispatchEvent(new PointerEvent("pointerup", { ...touch, buttons: 0 }));
				hit.dispatchEvent(new MouseEvent("mouseup", { ...pointer, buttons: 0 }));
				hit.dispatchEvent(new MouseEvent("click", { ...pointer, buttons: 0, detail: 1 }));
				return await finish({ kind: "click", target: describe(element, act.letter) }, shown);
			}
			case "type": {
				if (element === undefined) return refused("type needs a ref");
				const text = act.text ?? "";
				const kindOf = (target: Element) =>
					target instanceof HTMLTextAreaElement ||
					(target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type))
						? "field"
						: editingHost(target)
							? "content"
							: null;
				const kind = kindOf(element);
				const form = kind === "field" ? (element as HTMLInputElement).form : null;
				/** Why typing into the element is refused now, or null: page code may change it when it gets the focus. */
				const blocked = (): string | null => {
					if (!element!.isConnected || element!.ownerDocument !== document) return gone(ref);
					const now = kindOf(element!);
					if (now === null) return `${ref} is not a text field`;
					if (now !== kind) return `${ref} changed when it got the focus: observe again`;
					if (act.submit && (element as HTMLInputElement).form !== form)
						return `${ref} moved to another form when it got the focus: observe again`;
					if (disabled(element!)) return `${ref} is disabled`;
					if ((element as HTMLInputElement).readOnly === true) return `${ref} is read-only`;
					for (let at: Element | null = element!; at !== null; at = parentOf(at))
						if (at.hasAttribute("inert")) return `${ref} is inert`;
					const marker = markerOf(element!);
					return marker === null ? null : `pi does not type into ${marker.text} (${ref})`;
				};
				let problem = blocked();
				if (problem !== null) return refused(problem);
				if (act.submit && form === null)
					return refused(`${ref} is not in a form: type without submit, then click the form's button`);
				center(element);
				const shown = outline(element);
				(element as HTMLElement).focus({ preventScroll: true });
				if (kind === "field") (element as HTMLInputElement).select();
				else document.getSelection()?.selectAllChildren(element);
				/** The focus and, in a contenteditable, the text cursor are in the element. */
				const cursorText = (): string | null => {
					const focus = focusText(element!);
					if (focus !== null || kind === "field") return focus;
					const root = element!.getRootNode() as unknown as { getSelection?: () => Selection | null };
					const anchor = (root.getSelection?.() ?? document.getSelection())?.anchorNode ?? null;
					let host: Element | null = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
					while (host !== null && !editingHost(host)) host = host.parentElement;
					return host === element ? null : `The text cursor is not in ${ref}`;
				};
				// A focus handler may have moved the focus, or changed the field.
				problem = cursorText() ?? blocked();
				if (problem !== null) return refused(problem);
				sent = true;
				const typed =
					text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
				if (!typed) {
					if (kind === "content") return refused(`Typing into ${ref} failed`);
					problem = cursorText() ?? blocked();
					if (problem !== null) return refused(problem);
					const prototype =
						element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
					Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, text);
					element.dispatchEvent(
						new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }),
					);
				}
				if (kind === "field") element.dispatchEvent(new Event("change", { bubbles: true }));
				if (act.submit) {
					problem = blocked();
					if (problem !== null) return refused(problem);
					form?.requestSubmit();
				}
				return await finish(
					{ kind: "type", text: short(text, 60), target: describe(element, act.letter), submitted: act.submit },
					shown,
				);
			}
			case "press": {
				const parts = (act.key ?? "").split("+");
				// "+" itself, as in "Control++".
				if (parts.length > 1 && parts.at(-1) === "") parts.splice(-2, 2, "+");
				const named = parts.pop() ?? "";
				const modifiers = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
				for (const part of parts) {
					const lower = part.toLowerCase();
					if (lower === "shift") modifiers.shiftKey = true;
					else if (lower === "control" || lower === "ctrl") modifiers.ctrlKey = true;
					else if (lower === "alt" || lower === "option") modifiers.altKey = true;
					else if (lower === "meta" || lower === "cmd" || lower === "command") modifiers.metaKey = true;
					else return refused(`Unknown modifier "${part}" in "${act.key}"`);
				}
				if (named === "") return refused("press needs a key");
				const key =
					named === "Space" ? " " : named.length === 1 && modifiers.shiftKey ? named.toUpperCase() : named;
				const code = /^[a-z]$/i.test(key)
					? `Key${key.toUpperCase()}`
					: /^[0-9]$/.test(key)
						? `Digit${key}`
						: key === " "
							? "Space"
							: key.length > 1
								? key
								: "";
				let target: Element | null = element ?? null;
				let shown: Element | null = null;
				if (element !== undefined) {
					center(element);
					shown = outline(element);
					(element as HTMLElement).focus({ preventScroll: true });
					const problem = focusText(element);
					if (problem !== null) return refused(problem);
				} else target = focused() ?? document.body;
				if (target === null) return refused("The page has no element to press the key in");
				const init = { key, code, bubbles: true, cancelable: true, composed: true, view: window, ...modifiers };
				sent = true;
				target.dispatchEvent(new KeyboardEvent("keydown", init));
				if (key.length === 1 && !modifiers.ctrlKey && !modifiers.metaKey)
					target.dispatchEvent(new KeyboardEvent("keypress", init));
				target.dispatchEvent(new KeyboardEvent("keyup", init));
				return await finish(
					{
						kind: "press",
						key: act.key ?? "",
						target: element === undefined ? null : describe(element, act.letter),
					},
					shown,
				);
			}
			case "scroll": {
				if (element === undefined && act.direction === null)
					return refused("scroll needs a ref, a direction, or both");
				if (act.direction === null) {
					center(element!);
					sent = true;
					return await finish({ kind: "reveal", target: describe(element!, act.letter) }, outline(element!));
				}
				sent = true;
				const { box, step } = scrollIn(element, act.direction, act.letter);
				return await finish(step, box === null ? null : outline(box));
			}
			case "select_option": {
				if (element === undefined) return refused("select_option needs a ref");
				if (!(element instanceof HTMLSelectElement))
					return refused(`${ref} is not a <select>: click it, then click the option`);
				const marker = markerOf(element);
				if (marker !== null) return refused(`pi does not choose in ${marker.text} (${ref})`);
				const wanted = clean(act.option ?? "");
				const options = [...element.options];
				const option =
					options.find((one) => clean(one.label) === wanted || one.value === act.option) ??
					options.find((one) => clean(one.label).toLowerCase() === wanted.toLowerCase());
				if (option === undefined) {
					const labels = options.slice(0, 30).map((one) => JSON.stringify(short(clean(one.label), 40)));
					return refused(`${ref} has no option "${wanted}"; its options: ${labels.join(", ")}`);
				}
				// Also an option in a disabled optgroup.
				if (option.matches(":disabled"))
					return refused(`The option "${clean(option.label)}" of ${ref} is disabled`);
				center(element);
				const shown = outline(element);
				sent = true;
				// By index: two options may have the same value.
				element.selectedIndex = option.index;
				element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
				element.dispatchEvent(new Event("change", { bubbles: true }));
				return await finish(
					{ kind: "choose", option: short(clean(option.label), 60), target: describe(element, act.letter) },
					shown,
				);
			}
		}
	} catch (error) {
		return refused(`${error instanceof Error ? error.message : String(error)}`);
	}
}
