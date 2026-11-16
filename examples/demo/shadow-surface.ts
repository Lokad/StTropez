let css: string | undefined, pending: Promise<void> | undefined;

export class DemoStylesUnavailable extends Error {}

/** Retain the original CSS: CSSOM serialization can lose variable-based shorthand declarations. */
export function prepareDemoShadowStyles(owner: Document, signal: AbortSignal): Promise<void> {
    if (css !== undefined) return Promise.resolve();
    const link = owner.querySelector<HTMLLinkElement>("#demo-styles");
    if (!link) throw new Error("Missing demo stylesheet link.");
    pending ??= (async () => {
        try {
            const response = await fetch(link.href, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            css = await response.text();
        } catch (cause) { throw new DemoStylesUnavailable("Host styles could not load. Select the host example again to retry.", { cause }); }
    })().finally(() => { pending = undefined; });
    return pending;
}

/** The demo owns its same-origin, bundled stylesheet and the surrounding surface lifecycle. */
export function demoSurface(container: HTMLElement, shadow: boolean): HTMLElement {
    if (!shadow) return container;
    if (css === undefined) throw new Error("Prepare demo shadow styles before mounting.");
    const owner = container.ownerDocument;
    const host = owner.createElement("div"), style = owner.createElement("style"), content = owner.createElement("div");
    host.className = "demo-shadow-surface"; content.className = "demo-shadow-content";
    style.textContent = css + "\n:host { display: block; height: 100%; min-width: 0; min-height: 0; } .demo-shadow-content { height: 100%; min-width: 0; min-height: 0; }";
    host.attachShadow({ mode: "open" }).append(style, content); container.append(host);
    return content;
}
