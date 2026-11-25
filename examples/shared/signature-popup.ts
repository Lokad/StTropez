import { mountDocumentation } from "../../src/browser/index.ts";
import type { DocumentationOptions, SignatureSnapshot, TextEditor } from "../../src/browser/index.ts";
import type { Observable } from "../../src/index.ts";
import { bindPopup } from "./popup-position.ts";
import { shortcutHint } from "./shortcut-hint.ts";

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
    const placement = bindPopup(popup, { prefer: "above" });
    const render = () => { const s = source.getSnapshot(), editor = activeEditor();
        const sig = s.signature, label = sig?.label ?? "", arg = sig?.activeParameter == null ? undefined : sig.parameters[sig.activeParameter];
        before.textContent = arg ? label.slice(0, arg.from) : sig ? label : s.message;
        parameter.textContent = arg ? label.slice(arg.from, arg.to) : ""; parameter.hidden = !parameter.textContent;
        after.textContent = arg ? label.slice(arg.to) : "";
        documentation.setContent(sig?.content ?? []);
        detail.setContent(arg?.content ?? (sig && s.status === "ready" ? [{ kind: "plaintext", value: "No declared parameter for this argument in this overload." }] : []));
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
