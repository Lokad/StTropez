import { parseDocumentation } from "../core/documentation.ts";
import type { DocumentationContent, DocumentationInline } from "../core/documentation.ts";

export type DocumentationOptions = Readonly<{
    /** Opaque destinations are inert unless the host explicitly supplies an opening policy. */
    canOpenLink?: (target: string) => boolean;
    openLink?: (target: string) => void;
}>;

export type DocumentationView = Readonly<{ element: HTMLDivElement; setContent: (content: DocumentationContent) => void; dispose: () => void }>;

/** Small documentation presentation, not a general Markdown engine. No HTML or automatic URLs. */
export function mountDocumentation(host: HTMLElement, options: DocumentationOptions = {}): DocumentationView {
    const owner = host.ownerDocument, element = owner.createElement("div"), events = new AbortController();
    element.className = "st-documentation"; host.append(element);
    let disposed = false, current: DocumentationContent | undefined, links = new WeakMap<HTMLButtonElement, string>();
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: Node, text?: string): HTMLElementTagNameMap[K] => {
        const child = owner.createElement(tag); if (text !== undefined) child.textContent = text; parent.appendChild(child); return child;
    };
    const code = (parent: Node, value: string, language: string) => {
        const body = node("code", node("pre", parent), value); if (language) body.dataset.language = language;
    };
    const inline = (parent: Node, content: readonly DocumentationInline[]) => {
        for (const part of content) {
            if (part.kind === "text") parent.appendChild(owner.createTextNode(part.value));
            else if (part.kind === "code") node("code", parent, part.value);
            else if (part.kind === "link") {
                const active = !!options.openLink && (options.canOpenLink?.(part.target) ?? true);
                const link = node(active ? "button" : "span", parent); link.className = "st-documentation-link"; link.title = part.title;
                if (link instanceof owner.defaultView!.HTMLButtonElement) { link.type = "button"; links.set(link, part.target); }
                inline(link, part.children);
            } else inline(node(part.kind, parent), part.children);
        }
    };
    element.addEventListener("click", event => {
        const target = (event.target as Element).closest("button"), destination = target ? links.get(target) : undefined;
        if (disposed || destination === undefined || !element.contains(target) || options.canOpenLink && !options.canOpenLink(destination)) return;
        event.preventDefault(); options.openLink?.(destination);
    }, { signal: events.signal });
    return Object.freeze({ element,
        setContent: (content: DocumentationContent) => {
            if (disposed || content === current) return;
            const fragment = owner.createDocumentFragment(); links = new WeakMap();
            for (const part of parseDocumentation(content)) {
                if (part.kind === "code") code(fragment, part.value, part.language);
                else if (part.kind === "paragraph") inline(node("p", fragment), part.children);
                else if (part.kind === "list") {
                    const list = node(part.start === null ? "ul" : "ol", fragment);
                    if (part.start !== null) (list as HTMLOListElement).start = part.start;
                    for (const item of part.items) inline(node("li", list), item);
                } else { const plain = node("p", fragment, part.value); plain.className = "st-documentation-plain"; }
            }
            current = content; element.replaceChildren(fragment);
        },
        dispose: () => { if (disposed) return; disposed = true; events.abort(); links = new WeakMap(); current = undefined; element.remove(); } });
}
