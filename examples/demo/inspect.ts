import type { HoverController, SignatureController, SignatureSnapshot, TextEditor } from "../../src/browser/index.ts";
import { HostHoverTools } from "../shared/hover.ts";
import { mountHoverPanel } from "../shared/hover-panel.ts";
import { mountSignaturePopup } from "../shared/signature-popup.ts";
import { canOpenDemoHelp } from "./diagnostics.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";

/** Reuses captured popup controllers; the host owns explicit external-help opening. */
export function mountDemoInspection(scope: CleanupScope, editor: TextEditor, tools: { hover: HoverController; signature: SignatureController },
    valid: () => boolean, completionOpen: () => boolean, cancelCompletion: () => void, beforeInspect: () => void, onSignature: (state: SignatureSnapshot) => void) {
    const host = document.createElement("div"); scope.defer(() => host.remove());
    const { signature } = tools;
    host.className = "demo-language-popups"; document.body.append(host);
    // Pending caret paint does not invalidate an already committed model selection.
    const canCapture = () => { const state = editor.activity(); return valid() && !state.composing && !state.pendingInput && !state.pendingCommand; };
    const hover = new HostHoverTools(kind => {
        if (kind === "pointer") return canCapture() && !completionOpen() && !signature.getSnapshot().anchor;
        signature.cancel(); cancelCompletion(); beforeInspect(); return canCapture();
    }, { canCapture });
    const canOpenLink = (target: string) => valid() && canOpenDemoHelp(target);
    const links = { canOpenLink, openLink: (target: string) => { if (canOpenLink(target)) window.open(target, "_blank", "noopener,noreferrer"); } };
    scope.defer(mountHoverPanel(host, hover, links));
    scope.defer(mountSignaturePopup(host, signature, () => editor, true, links));
    scope.defer(hover.bind("source", editor, tools.hover));
    scope.defer(signature.subscribe(() => onSignature(signature.getSnapshot())));
    return Object.freeze({
        dismissHover: hover.dismiss,
        dismiss: () => { hover.dismiss(); signature.cancel(); },
        inspect: () => { editor.focus(); editor.commands.run("hover.inspect"); },
    });
}
