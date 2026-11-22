import { Workspace } from "../../src/index.ts";
import { mountTextEditor } from "../../src/browser/index.ts";
import { linePrompt } from "../shared/line-prompt.ts";

/** Compiler output has its own selection, scroll position and read-only document. */
export function mountDemoOutput(host: HTMLElement, text: string, settings: Readonly<{ minimap: boolean; fontLigatures: boolean }>) {
    const workspace = new Workspace();
    const resource = workspace.createTextResource({ scope: "demo-output", resource: "javascript", variant: "generated" }, "JavaScript output",
        { value: text }, { edit: [], save: false });
    const editor = mountTextEditor(host, workspace, resource.documentId,
        { ariaLabel: "JavaScript output", readOnly: true, requestLine: linePrompt(host.ownerDocument), settings });
    editor.element.classList.add("demo-output");
    let disposed = false;
    return Object.freeze({ editor, update: (next: string) => {
        if (disposed || next === text) return;
        if (workspace.adoptSaved(resource.id, { text: next, serverVersion: null, history: "reset" }).applied) text = next;
    }, dispose: () => {
        if (disposed) return;
        disposed = true; editor.dispose(); workspace.releaseResource(resource.id);
    } });
}
