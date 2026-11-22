import type { HostSignatureTools, HostSignatureSnapshot } from "./signature.ts";
import { mountDocumentation } from "../../src/browser/index.ts";
import type { DocumentationOptions, SignatureSnapshot, TextEditor } from "../../src/browser/index.ts";
import type { Observable } from "../../src/index.ts";
import { bindPopup } from "./popup-position.ts";
import { shortcutHint } from "../shared/shortcut-hint.ts";
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
    const stopPopup = mountSignaturePopup(host, tools.state, tools.activeEditor);
    const render = () => { const model = signatureCommandsModel(tools, tools.state.getSnapshot()); status.textContent = model.status.text;
        for (const [i, action] of model.actions.entries()) { buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
    }; const stop = tools.state.subscribe(render); render(); return () => { stop(); stopPopup(); for (const button of buttons) { button.onclick = null; button.onpointerdown = null; } section.remove(); };
}

/** Contextual presentation shared by hosts that provide their own commands. */
export function mountSignaturePopup(host: HTMLElement, source: Observable<SignatureSnapshot>, activeEditor: () => TextEditor | undefined,
    withControls = false, options: DocumentationOptions = {}): () => void {
    const owner = host.ownerDocument, popup = owner.createElement("div"), label = owner.createElement("pre"), before = owner.createTextNode(""), parameter = owner.createElement("mark"), after = owner.createTextNode(""), controls = owner.createElement("div");
    popup.className = "host-symbol-info host-signature"; popup.setAttribute("role", "tooltip"); popup.setAttribute("aria-label", "Signature help"); popup.onpointerdown = event => event.preventDefault();
    parameter.setAttribute("aria-label", "Active signature parameter"); label.append(before, parameter, after); popup.append(label);
    const documentation = mountDocumentation(popup, options), detail = mountDocumentation(popup, options);
    const buttons = (["signature.previous", "signature.next"] as const).map(id => {
        const button = owner.createElement("button"); button.type = "button"; controls.append(button);
        return { button, id };
    });
    if (withControls) popup.append(controls); host.append(popup);
    const placement = bindPopup(popup, "above");
    const render = () => { const s = source.getSnapshot(), editor = activeEditor();
        const sig = s.signature, label = sig?.label ?? "", arg = sig?.activeParameter == null ? undefined : sig.parameters[sig.activeParameter];
        before.textContent = arg ? label.slice(0, arg.from) : s.status === "pending" ? s.message : label;
        parameter.textContent = arg ? label.slice(arg.from, arg.to) : ""; parameter.hidden = !parameter.textContent;
        after.textContent = arg ? label.slice(arg.to) : "";
        documentation.setContent(sig?.content ?? []);
        detail.setContent(arg?.content ?? (sig ? [{ kind: "plaintext", value: "No declared parameter for this argument in this overload." }] : []));
        controls.hidden = s.signatureCount < 2;
        if (withControls && !controls.hidden) for (const { button, id } of buttons) {
            const command = editor?.commands.get(id); button.textContent = command?.label ?? "";
            button.title = editor && command ? shortcutHint(editor.keymap.getShortcuts(id)) : "";
            button.disabled = !command?.enabled; button.onclick = () => { if (activeEditor() === editor && source.getSnapshot() === s) editor?.commands.run(id); };
        }
        placement.update(editor && s.anchor ? { editor, ...s.anchor } : undefined);
    };
    const stop = source.subscribe(render); render();
    return () => { stop(); placement.dispose(); documentation.dispose(); detail.dispose(); popup.onpointerdown = null; buttons.forEach(({ button }) => { button.onclick = null; }); popup.remove(); };
}
