import type { HostHoverTools } from "./hover.ts";
import { mountDocumentation } from "../../src/browser/index.ts";
import type { DocumentationOptions } from "../../src/browser/index.ts";
import { bindPopup } from "./popup-position.ts";
export function mountHoverPanel(host: HTMLElement, tools: HostHoverTools, options: DocumentationOptions = {}): () => void {
    const owner = host.ownerDocument, popup = owner.createElement("div"), hint = owner.createElement("span"), listeners = new AbortController();
    const content = mountDocumentation(popup, options);
    popup.className = "host-symbol-info"; popup.setAttribute("role", "tooltip"); hint.textContent = "Escape dismisses symbol information."; popup.append(hint); host.append(popup);
    const placement = bindPopup(popup, "below");
    popup.addEventListener("pointerenter", tools.enterPopup, { signal: listeners.signal }); popup.addEventListener("pointerleave", tools.leavePopup, { signal: listeners.signal });
    popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
    const render = () => { const state = tools.state.getSnapshot();
        content.setContent(state.visible ? state.content ?? [{ kind: "plaintext", value: state.text || state.message }] : []);
        placement.update(tools.popupAnchor()); };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); placement.dispose(); listeners.abort(); content.dispose(); popup.remove(); };
}
