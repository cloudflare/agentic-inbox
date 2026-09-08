import { parse, type DefaultTreeAdapterMap } from "parse5";

export type FooterChoice = { enabled: boolean; text: string };
type Node = DefaultTreeAdapterMap["node"];
const META_PREFIX = "agentic-footer:";

function children(node: Node): Node[] {
	return "childNodes" in node ? node.childNodes : [];
}

function attr(node: Node, name: string): string | undefined {
	return "attrs" in node ? node.attrs.find((a) => a.name === name)?.value : undefined;
}

function textContent(node: Node): string {
	if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
	if (node.nodeName === "br") return "\n";
	if (["style", "script", "#comment"].includes(node.nodeName)) return "";
	const text = children(node).map(textContent).join("");
	return ["div", "p", "li"].includes(node.nodeName) ? `${text}\n` : text;
}

function normalize(text: string): string {
	return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function isQuote(node: Node): boolean {
	return node.nodeName === "blockquote" || /(?:gmail_quote|yahoo_quoted|agentic-quote)/.test(attr(node, "class") || "");
}

function containsQuote(node: Node): boolean {
	return isQuote(node) || children(node).some(containsQuote);
}

/** Only detach signatures from the authored portion; quoted correspondence stays byte-for-byte intact. */
export function detachFooter(html: string, defaultText = "") {
	const doc = parse(html, { sourceCodeLocationInfo: true });
	const ranges: { start: number; end: number }[] = [];
	let extracted: string | undefined;
	let saved: FooterChoice | undefined;
	const defaultNormalized = normalize(defaultText);
	function remove(node: Node) {
		const loc = node.sourceCodeLocation;
		if (loc) ranges.push({ start: loc.startOffset, end: loc.endOffset });
	}
	function visit(node: Node) {
		if (isQuote(node)) return;
		if (node.nodeName === "#comment") {
			const data = (node as DefaultTreeAdapterMap["commentNode"]).data;
			if (data.startsWith(META_PREFIX)) {
				try {
					const value = JSON.parse(decodeURIComponent(data.slice(META_PREFIX.length)));
					if (typeof value.enabled === "boolean" && typeof value.text === "string") {
						saved = { enabled: value.enabled, text: value.text };
						remove(node);
					}
				} catch { /* Preserve unrelated or malformed comments. */ }
			}
			return;
		}
		const content = textContent(node).trim();
		const style = attr(node, "style") || "";
		const marked = attr(node, "data-agentic-signature") === "true";
		const legacy = node.nodeName === "div" && /border-top\s*:/.test(style) && /padding-top\s*:\s*12px/.test(style);
		const exact = ["div", "p"].includes(node.nodeName) && !containsQuote(node) && defaultNormalized && normalize(content) === defaultNormalized;
		if (marked || legacy || exact) {
			extracted ??= content;
			remove(node);
			return;
		}
		const nodes = children(node);
		// Tiptap can flatten the old signature div into consecutive paragraphs.
		if (defaultNormalized) {
			for (let start = 0; start < nodes.length; start++) {
				if (nodes[start].nodeName !== "p") continue;
				let content = "";
				for (let end = start; end < nodes.length; end++) {
					const part = nodes[end];
					if (!["p", "br", "#text"].includes(part.nodeName)) break;
					content += textContent(part);
					const normalized = normalize(content);
					if (normalized === defaultNormalized) {
						extracted ??= defaultText;
						for (let i = start; i <= end; i++) remove(nodes[i]);
						start = end;
						break;
					}
					if (!defaultNormalized.startsWith(normalized)) break;
				}
			}
		}
		for (const child of nodes) visit(child);
	}
	visit(doc);
	const sorted = ranges.sort((a, b) => a.start - b.start || b.end - a.end);
	let body = "";
	let cursor = 0;
	for (const range of sorted) {
		if (range.start < cursor) continue;
		body += html.slice(cursor, range.start);
		cursor = range.end;
	}
	body += html.slice(cursor);
	return { body, choice: saved ?? (extracted !== undefined ? { enabled: true, text: extracted } : undefined) };
}

export function renderFooter(text: string): string {
	const escaped = text.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\r?\n/g, "<br>");
	return escaped ? `<div data-agentic-signature="true" style="border-top:1px solid #ccc;margin-top:16px;padding-top:12px;color:#555;font-style:italic"><i>${escaped}</i></div>` : "";
}

export function attachFooter(body: string, choice: FooterChoice, draft = false): string {
	const footer = choice.enabled ? renderFooter(choice.text) : "";
	// Draft-local choice is stored in the existing body, requiring no database migration.
	const metadata = draft ? `<!--${META_PREFIX}${encodeURIComponent(JSON.stringify(choice)).replace(/-/g, "%2D")}-->` : "";
	if (!footer && !metadata) return body;
	const doc = parse(body, { sourceCodeLocationInfo: true });
	let position = body.length;
	function find(node: Node) {
		if (isQuote(node) && node.sourceCodeLocation) {
			position = Math.min(position, node.sourceCodeLocation.startOffset);
			return;
		}
		if (node.nodeName === "body" && node.sourceCodeLocation && "endTag" in node.sourceCodeLocation && node.sourceCodeLocation.endTag) {
			position = Math.min(position, node.sourceCodeLocation.endTag.startOffset);
		}
		children(node).forEach(find);
	}
	find(doc);
	return body.slice(0, position) + metadata + footer + body.slice(position);
}

export function signatureTextFromHtml(html: string): string {
	return textContent(parse(html)).trim();
}
