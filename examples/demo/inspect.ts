import type { Workspace } from "../../src/index.ts";
import { createSignatureController } from "../../src/browser/index.ts";
import type { SignatureSnapshot, TextEditor } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { HostHoverTools } from "../hosts/hover.ts";
import { mountHoverPanel } from "../hosts/hover-panel.ts";
import { mountSignaturePopup } from "../hosts/signature-panel.ts";
import type { DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";
import { canOpenDemoHelp } from "./diagnostics.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";

/** Reuses captured popup controllers; the host owns explicit external-help opening. */
export function mountDemoInspection(scope: CleanupScope, workspace: Workspace, file: DemoFile, editor: TextEditor, provider: LspWorkspace, language: DemoLanguage,
    valid: () => boolean, completionOpen: () => boolean, cancelCompletion: () => void, beforeInspect: () => void, onSignature: (state: SignatureSnapshot) => void) {
    const host = document.createElement("div"); scope.defer(() => host.remove());
    host.className = "demo-language-popups"; document.body.append(host);
    // Pending caret paint does not invalidate an already committed model selection.
    const canCapture = () => { const state = editor.activity(); return valid() && !state.composing && !state.pendingInput && !state.pendingCommand; };
    const hover = new HostHoverTools(kind => {
        if (kind === "pointer") return canCapture() && !completionOpen() && !signature.getSnapshot().anchor;
        signature.cancel(); cancelCompletion(); beforeInspect(); return canCapture();
    }, { canCapture, provider, diagnostics: { subscribe: language.state.subscribe, getSnapshot() {
        const state = language.state.getSnapshot(), doc = workspace.document(file.resource.documentId);
        return { diagnosticRevision: doc.revision, diagnosticsPending: state.checking,
            diagnostics: state.diagnostics.filter(item => item.documentId === doc.id && item.revision === doc.revision) };
    } } });
    const signature = createSignatureController(editor, provider, { canCapture: valid, beforeRequest: () => { hover.dismiss(); beforeInspect(); } });
    scope.defer(signature.dispose);
    const canOpenLink = (target: string) => valid() && canOpenDemoHelp(target);
    const links = { canOpenLink, openLink: (target: string) => { if (canOpenLink(target)) window.open(target, "_blank", "noopener,noreferrer"); } };
    scope.defer(mountHoverPanel(host, hover, links));
    scope.defer(mountSignaturePopup(host, signature, () => editor, true, links));
    scope.defer(hover.attach("source", file.tab, editor));
    scope.defer(signature.subscribe(() => onSignature(signature.getSnapshot())));
    return Object.freeze({
        dismiss: () => { hover.dismiss(); signature.cancel(); },
        inspect: () => { editor.focus(); editor.commands.run("hover.inspect"); },
    });
}
