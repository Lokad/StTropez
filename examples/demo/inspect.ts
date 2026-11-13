import type { Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { createLspHoverClient } from "../editing/lsp-hover-client.ts";
import { createHoverController } from "../editing/hover-controller.ts";
import { lspSignatureBackend } from "../editing/lsp-language-clients.ts";
import { HostHoverTools } from "../hosts/hover.ts";
import { mountHoverPanel } from "../hosts/hover-panel.ts";
import { HostSignatureTools } from "../hosts/signature.ts";
import { mountSignaturePopup } from "../hosts/signature-panel.ts";
import type { DemoFile } from "./project.ts";
import { canOpenDemoHelp } from "./diagnostics.ts";

/** Reuses captured popup controllers; the host owns explicit external-help opening. */
export function mountDemoInspection(workspace: Workspace, file: DemoFile, editor: EditingCandidate, provider: LspWorkspace,
    valid: () => boolean, completionOpen: () => boolean, cancelCompletion: () => void, beforeInspect: () => void = () => {}) {
    const host = document.createElement("div"); host.className = "demo-language-popups"; document.body.append(host);
    // Pending caret paint does not invalidate an already committed model selection.
    const canCapture = () => { const state = editor.snapshot(); return valid() && !state.composing && !state.pendingInput && !state.pendingCommand; };
    const hover = new HostHoverTools(workspace, kind => {
        if (kind === "pointer") return canCapture() && !completionOpen() && !signature.state.getSnapshot().visible;
        signature.dismiss(); cancelCompletion(); beforeInspect(); return canCapture();
    }, { canCapture, createController: (workspace, tab, editor, canCapture) => createHoverController(workspace, tab, editor,
        { canCapture, backend: createLspHoverClient({ provider }) }) });
    const signature = new HostSignatureTools(workspace, canCapture, () => { hover.dismiss(); beforeInspect(); },
        (_clock, changed) => lspSignatureBackend(workspace, provider, changed), completionOpen);
    const canOpenLink = (target: string) => valid() && canOpenDemoHelp(target);
    const links = { canOpenLink, openLink: (target: string) => { if (canOpenLink(target)) window.open(target, "_blank", "noopener,noreferrer"); } };
    const stopHover = mountHoverPanel(host, hover, links);
    const stopSignature = mountSignaturePopup(host, signature, true, links);
    const detachHover = hover.attach("source", file.tab, editor), detachSignature = signature.attach("source", file.tab, editor);
    return Object.freeze({
        dismiss: () => { hover.dismiss(); signature.dismiss(); },
        inspect: () => { editor.focus(); hover.inspectCaret("source"); },
        signature: () => { cancelCompletion(); editor.focus(); signature.inspect(); },
        destroy: () => { detachHover(); detachSignature(); signature.dispose(); stopHover(); stopSignature(); host.remove(); },
    });
}
