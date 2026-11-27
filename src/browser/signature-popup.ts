import { emptyList } from "../core/empty-list.ts";
import type { Observable } from "../core/observable.ts";
import { mountAnchoredOverlay } from "./anchored-overlay.ts";
import { mountDocumentation, type DocumentationOptions } from "./documentation.ts";
import { editorElement } from "./editor-element.ts";
import type { SignatureSnapshot } from "./signature-controller.ts";
import type { TextEditor } from "./text-editor.ts";

export type SignaturePopupOptions = Readonly<{
    overloadControls?: boolean;
}>;

export function mountSignaturePopup(editor: TextEditor, source: Observable<SignatureSnapshot>,
    options: SignaturePopupOptions & DocumentationOptions) {
    const owner = editor.element.ownerDocument;
    const popup = editorElement(owner, "div", "signature");
    const label = owner.createElement("pre");
    const before = owner.createTextNode("");
    const parameter = owner.createElement("mark");
    const after = owner.createTextNode("");
    label.append(before, parameter, after);
    popup.append(label);
    popup.setAttribute("role", "tooltip");
    popup.setAttribute("aria-label", editor.strings.text("Signature help"));
    parameter.setAttribute("aria-label", editor.strings.text("Active signature parameter"));
    popup.onpointerdown = event => event.preventDefault();
    const documentation = mountDocumentation(popup, options);
    const detail = mountDocumentation(popup, options);
    const controls = owner.createElement("div");
    popup.append(controls);
    const missing = [{ kind: "plaintext", value: editor.strings.text("No declared parameter for this argument in this overload.") }] as const;
    const overlay = mountAnchoredOverlay(editor, popup, { prefer: "above" });
    const stop = source.subscribe(() => {
        const state = source.getSnapshot();
        const sig = state.signature;
        const text = sig?.label ?? state.message;
        const arg = sig?.activeParameter == null ? undefined : sig.parameters[sig.activeParameter];
        before.data = arg ? text.slice(0, arg.from) : text;
        parameter.textContent = arg ? text.slice(arg.from, arg.to) : "";
        parameter.hidden = !arg;
        after.data = arg ? text.slice(arg.to) : "";
        documentation.setContent(sig?.content ?? emptyList);
        detail.setContent(arg?.content ?? (sig && state.status === "ready" ? missing : emptyList));
        controls.replaceChildren();
        if (options.overloadControls !== false && state.signatureCount > 1) {
            for (const direction of ["previous", "next"] as const) {
                const id = "signature." + direction;
                const command = editor.commands.get(id)!;
                const button = owner.createElement("button");
                button.type = "button";
                button.textContent = command.label;
                button.title = editor.keymap.getShortcuts(id).join(", ").replace(/arrowup/gi, "↑").replace(/arrowdown/gi, "↓");
                button.disabled = !command.enabled;
                button.onclick = () => { if (source.getSnapshot() === state) editor.commands.run(id); };
                controls.append(button);
            }
        }
        if (state.anchor) overlay.show(state.anchor);
        else overlay.hide();
    });
    return () => {
        stop();
        overlay.dispose();
        documentation.dispose();
        detail.dispose();
    };
}
