import type { HostSignatureTools, HostSignatureSnapshot } from "./signature.ts";

type SignatureCommandsTools = Pick<HostSignatureTools, "command" | "disconnect" | "reconnect">;
function signatureActions(tools: SignatureCommandsTools, s: HostSignatureSnapshot) {
    return [
        tools.command("signature.request"), tools.command("signature.previous"), tools.command("signature.next"), tools.command("signature.dismiss"),
        { label: "Disconnect signature provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect signature provider", invoke: tools.reconnect, disabled: s.connected && s.status !== "failed" }
    ] as const;
}
export function signatureCommandsModel(tools: SignatureCommandsTools, s: HostSignatureSnapshot) {
    return { label: "Signature commands", title: "Signature help", status: { label: "Signature help status", text: s.message }, actions: signatureActions(tools, s) } as const;
}
export function mountSignaturePanel(host: HTMLElement, tools: HostSignatureTools): () => void {
    const initial = signatureCommandsModel(tools, tools.state.getSnapshot());
    const owner = host.ownerDocument, section = owner.createElement("section"), heading = owner.createElement("h2"), status = owner.createElement("output"), controls = owner.createElement("div");
    section.className = "host-language"; section.setAttribute("aria-label", initial.label); heading.textContent = initial.title; status.setAttribute("aria-label", initial.status.label);
    const buttons = initial.actions.map(action => { const button = owner.createElement("button"); button.textContent = action.label; button.onclick = action.invoke; button.onpointerdown = event => event.preventDefault(); controls.append(button); return button; });
    section.append(heading, status, controls); host.append(section);
    const render = () => { const model = signatureCommandsModel(tools, tools.state.getSnapshot()); status.textContent = model.status.text;
        for (const [i, action] of model.actions.entries()) { buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
    }; const stop = tools.state.subscribe(render); render(); return () => { stop(); for (const button of buttons) { button.onclick = null; button.onpointerdown = null; } section.remove(); };
}
