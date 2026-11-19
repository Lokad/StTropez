import { Workspace } from "sttropez";
import { mountTextEditor } from "sttropez/browser";

const workspace = new Workspace();
const resource = workspace.createTextResource({ scope: "package", resource: "transition", variant: "working" }, "Staged source", { value: "staged source\r\n" });
const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "transition");
const editor = mountTextEditor(document.getElementById("editor")!, workspace, tab, { ariaLabel: "Staged source" });
let disposed = false;
const fixture = {
    snapshot: () => ({ text: workspace.document(resource.documentId).buffer.slice(0, workspace.document(resource.documentId).buffer.length),
        selections: editor.view.getSnapshot().selectionSet, history: workspace.observeHistory(resource.documentId).getSnapshot() }),
    ready: () => { const input = editor.snapshot(), viewport = editor.viewport.snapshot(); return !input.pendingInput && !input.pendingCommand && !input.pendingCaret
        && !viewport.pending && viewport.revision === workspace.document(resource.documentId).revision && viewport.selectionSet === editor.view.getSnapshot().selectionSet; },
    dispose: () => { if (!disposed) { disposed = true; editor.dispose(); workspace.close(tab); workspace.releaseResource(resource.id, true); } return workspace.diagnostics(); },
};
declare global { interface Window { transitionFixture: typeof fixture } }
window.transitionFixture = fixture;
