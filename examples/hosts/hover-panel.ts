import type { HostHoverTools } from "./hover.ts";
export function mountHoverPanel(host: HTMLElement, tools: HostHoverTools, display: (text: string) => string = text => text): () => void {
    const owner = host.ownerDocument, popup = owner.createElement("div"), text = owner.createElement("pre"), hint = owner.createElement("span"), listeners = new AbortController();
    popup.className = "host-symbol-info"; popup.setAttribute("role", "tooltip"); hint.textContent = "Escape dismisses symbol information."; popup.append(text, hint); host.append(popup);
    popup.addEventListener("pointerenter", tools.enterPopup, { signal: listeners.signal }); popup.addEventListener("pointerleave", tools.leavePopup, { signal: listeners.signal });
    popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
    const render = () => { const state = tools.state.getSnapshot(); popup.hidden = !state.visible; popup.style.left = `${state.left}px`; popup.style.top = `${state.top}px`; text.textContent = display(state.text || state.message); };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); listeners.abort(); popup.remove(); };
}
