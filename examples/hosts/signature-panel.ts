import type { HostSignatureTools } from "./signature.ts";
import { mountDocumentation } from "../../src/browser/index.ts";
import type { DocumentationOptions } from "../../src/browser/index.ts";
import { positionPopup } from "./popup-position.ts";
export function signatureActions(tools: HostSignatureTools) {
    const s = tools.state.getSnapshot();
    return [
        { label: "Show signature help", invoke: tools.inspect, disabled: !s.available || s.disconnected },
        { label: "Previous signature", invoke: tools.previous, disabled: s.status !== "ready" || s.signatureCount < 2 },
        { label: "Next signature", invoke: tools.next, disabled: s.status !== "ready" || s.signatureCount < 2 },
        { label: "Dismiss signature help", invoke: tools.dismiss, disabled: !s.visible && !s.pending && s.status === "idle" },
        { label: "Disconnect signature provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect signature provider", invoke: tools.reconnect, disabled: !s.disconnected && s.status !== "failed" }
    ] as const;
}
export function mountSignaturePanel(host: HTMLElement, tools: HostSignatureTools): () => void {
    const owner = host.ownerDocument, section = owner.createElement("section"), heading = owner.createElement("h2"), status = owner.createElement("output"), controls = owner.createElement("div");
    section.className = "host-language"; section.setAttribute("aria-label", "Signature commands"); heading.textContent = "Signature help"; status.setAttribute("aria-label", "Signature help status");
    const buttons = signatureActions(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; button.onclick = action.invoke; button.onpointerdown = event => event.preventDefault(); controls.append(button); return button; });
    section.append(heading, status, controls); host.append(section);
    const stopPopup = mountSignaturePopup(host, tools);
    const render = () => { const s = tools.state.getSnapshot(); status.textContent = s.message;
        for (const [i, action] of signatureActions(tools).entries()) buttons[i]!.disabled = action.disabled;
    }; const stop = tools.state.subscribe(render); render(); return () => { stop(); stopPopup(); for (const button of buttons) { button.onclick = null; button.onpointerdown = null; } section.remove(); };
}

/** Contextual presentation shared by hosts that provide their own commands. */
export function mountSignaturePopup(host: HTMLElement, tools: HostSignatureTools, withControls = false, options: DocumentationOptions = {}): () => void {
    const owner = host.ownerDocument, popup = owner.createElement("div"), label = owner.createElement("pre"), before = owner.createTextNode(""), parameter = owner.createElement("mark"), after = owner.createTextNode(""), controls = owner.createElement("div");
    popup.className = "host-symbol-info host-signature"; popup.setAttribute("role", "tooltip"); popup.setAttribute("aria-label", "Signature help"); popup.onpointerdown = event => event.preventDefault();
    parameter.setAttribute("aria-label", "Active signature parameter"); label.append(before, parameter, after); popup.append(label);
    const documentation = mountDocumentation(popup, options), detail = mountDocumentation(popup, options);
    const buttons = ["Previous signature", "Next signature"].map((text, index) => { const button = owner.createElement("button"); button.textContent = text; button.type = "button"; button.onclick = index ? tools.next : tools.previous; controls.append(button); return button; });
    if (withControls) popup.append(controls); host.append(popup);
    const render = () => { const s = tools.state.getSnapshot(); popup.hidden = !s.visible;
        before.textContent = s.before || (s.status === "pending" ? s.message : ""); parameter.textContent = s.parameter; parameter.hidden = !s.parameter; after.textContent = s.after;
        documentation.setContent(s.visible ? s.content.length ? s.content : [{ kind: "plaintext", value: s.documentation }] : []);
        detail.setContent(s.visible ? s.parameterContent.length ? s.parameterContent : [{ kind: "plaintext", value: s.parameterDocumentation }] : []);
        controls.hidden = s.signatureCount < 2; buttons.forEach(button => { button.disabled = s.status !== "ready"; });
        if (s.visible) positionPopup(popup, s.left, s.top);
    };
    const stop = tools.state.subscribe(render); render();
    return () => { stop(); documentation.dispose(); detail.dispose(); popup.onpointerdown = null; buttons.forEach(button => { button.onclick = null; }); popup.remove(); };
}
