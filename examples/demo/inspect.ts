import type { Workspace } from "../../src/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { createLspHoverClient } from "../shared/language/lsp-hover-client.ts";
import { createHoverController } from "../shared/language/hover-controller.ts";
import { lspSignatureBackend } from "../shared/language/lsp-language-clients.ts";
import { HostHoverTools } from "../hosts/hover.ts";
import { mountHoverPanel } from "../hosts/hover-panel.ts";
import { HostSignatureTools } from "../hosts/signature.ts";
import { mountSignaturePopup } from "../hosts/signature-panel.ts";
import type { DemoFile } from "./project.ts";
import { canOpenDemoHelp } from "./diagnostics.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";

/** Reuses captured popup controllers; the host owns explicit external-help opening. */
export function mountDemoInspection(scope: CleanupScope, workspace: Workspace, file: DemoFile, editor: TextEditor, provider: LspWorkspace,
    valid: () => boolean, completionOpen: () => boolean, cancelCompletion: () => void, beforeInspect: () => void = () => {}) {
    const host = document.createElement("div"); scope.defer(() => host.remove());
    host.className = "demo-language-popups"; document.body.append(host);
    // Pending caret paint does not invalidate an already committed model selection.
    const canCapture = () => { const state = editor.activity(); return valid() && !state.composing && !state.pendingInput && !state.pendingCommand; };
    const hover = new HostHoverTools(workspace, kind => {
        if (kind === "pointer") return canCapture() && !completionOpen() && !signature.state.getSnapshot().visible;
        signature.dismiss(); cancelCompletion(); beforeInspect(); return canCapture();
    }, { canCapture, createController: (workspace, tab, editor, canCapture) => createHoverController(workspace, tab, editor,
        { canCapture, backend: createLspHoverClient({ provider }) }) });
    const signature = new HostSignatureTools(workspace, canCapture, () => { hover.dismiss(); beforeInspect(); },
        (_clock, changed) => lspSignatureBackend(workspace, provider, changed), completionOpen);
    scope.defer(() => signature.dispose());
    const canOpenLink = (target: string) => valid() && canOpenDemoHelp(target);
    const links = { canOpenLink, openLink: (target: string) => { if (canOpenLink(target)) window.open(target, "_blank", "noopener,noreferrer"); } };
    scope.defer(mountHoverPanel(host, hover, links));
    scope.defer(mountSignaturePopup(host, signature, true, links));
    scope.defer(hover.attach("source", file.tab, editor));
    scope.defer(signature.attach("source", file.tab, editor));
    return Object.freeze({
        dismiss: () => { hover.dismiss(); signature.dismiss(); },
        inspect: () => { editor.focus(); hover.inspectCaret("source"); },
        signature: () => { cancelCompletion(); editor.focus(); signature.inspect(); },
    });
}
