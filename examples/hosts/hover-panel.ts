import type { HostHoverTools } from "./hover.ts";
import { mountDocumentation } from "../../src/browser/index.ts";
import type { DocumentationOptions } from "../../src/browser/index.ts";
import { bindPopup } from "./popup-position.ts";
export function mountHoverPanel(host: HTMLElement, tools: HostHoverTools, options: DocumentationOptions = {}): () => void {
    const owner = host.ownerDocument, popup = owner.createElement("div"), hint = owner.createElement("span"), listeners = new AbortController();
    const content = mountDocumentation(popup, options);
    popup.className = "host-symbol-info"; popup.tabIndex = -1; popup.setAttribute("role", "tooltip"); hint.textContent = "Esc to close"; popup.append(hint); host.append(popup);
    const placement = bindPopup(popup, "below");
    const detach = tools.bindPopup(popup);
    let previousFocus: HTMLElement | undefined;
    popup.addEventListener("focusin", event => {
        if (!(event.relatedTarget instanceof Node && popup.contains(event.relatedTarget)))
            previousFocus = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : undefined;
    }, { signal: listeners.signal });
    popup.addEventListener("focusout", event => {
        const anchor = tools.popupAnchor();
        if (!anchor || !(event.relatedTarget instanceof Node) || popup.contains(event.relatedTarget) || event.relatedTarget === previousFocus) return;
        const shown = tools.state.getSnapshot();
        // The destination receives focus after focusout. It may be this editor inside a shadow root.
        queueMicrotask(() => {
            if (!listeners.signal.aborted && tools.state.getSnapshot() === shown && !anchor.editor.getSnapshot().focused
                && !popup.matches(":focus-within")) tools.dismiss();
        });
    }, { signal: listeners.signal });
    popup.addEventListener("keydown", event => {
        const anchor = tools.popupAnchor(), origin = previousFocus;
        if (anchor?.editor.keymap.handle(event) && !tools.popupAnchor() && origin?.isConnected
            && (owner.activeElement === owner.body || popup.contains(owner.activeElement))) origin.focus({ preventScroll: true });
    }, { signal: listeners.signal });
    popup.addEventListener("pointerenter", tools.enterPopup, { signal: listeners.signal }); popup.addEventListener("pointerleave", tools.leavePopup, { signal: listeners.signal });
    popup.addEventListener("pointerdown", event => {
        if (event.target instanceof Element && event.target.closest("button")) event.preventDefault();
    }, { signal: listeners.signal });
    popup.addEventListener("click", event => {
        if (!event.detail || !popup.matches(":focus-within") || event.target instanceof Element && event.target.closest("button")) return;
        const text = owner.getSelection();
        if (text && !text.isCollapsed && popup.contains(text.anchorNode)) return;
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }, { signal: listeners.signal });
    const render = () => { const state = tools.state.getSnapshot();
        if (!state.visible) previousFocus = undefined;
        content.setContent(state.visible ? state.content ?? [{ kind: "plaintext", value: state.text || state.message }] : []);
        placement.update(tools.popupAnchor()); };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); detach(); placement.dispose(); listeners.abort(); content.dispose(); popup.remove(); };
}
