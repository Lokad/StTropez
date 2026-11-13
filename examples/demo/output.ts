import { Workspace } from "../../src/index.ts";
import { mountTextViewport } from "../../src/browser/index.ts";

/** Generated output uses the same bounded public view as source; it owns no editing history. */
export function mountDemoOutput(host: HTMLElement, text: string): Readonly<{ destroy: () => void }> {
    const workspace = new Workspace();
    const resource = workspace.createTextResource({ scope: "demo-output", resource: "javascript", variant: "generated" }, "JavaScript output",
        { value: text }, { edit: [], save: false, run: false });
    const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "output");
    const viewport = mountTextViewport(host, workspace, tab, { ariaLabel: "JavaScript output" });
    viewport.element.classList.add("demo-output");
    let disposed = false;
    return Object.freeze({ destroy: () => {
        if (disposed) return;
        disposed = true; viewport.destroy(); workspace.close(tab); workspace.releaseResource(resource.id);
    } });
}
