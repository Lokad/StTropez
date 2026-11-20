import { Workspace } from "../../src/index.ts";
import { mountTextViewport } from "../../src/browser/index.ts";

/** Generated output uses the same bounded public view as source; it owns no editing history. */
export function mountDemoOutput(host: HTMLElement, text: string, settings: Readonly<{ minimap: boolean; fontLigatures: boolean }>) {
    const workspace = new Workspace();
    const resource = workspace.createTextResource({ scope: "demo-output", resource: "javascript", variant: "generated" }, "JavaScript output",
        { value: text }, { edit: [], save: false, run: false });
    const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "output");
    const viewport = mountTextViewport(host, workspace, tab, { ariaLabel: "JavaScript output", ...settings });
    viewport.element.classList.add("demo-output");
    let disposed = false;
    return Object.freeze({ snapshot: viewport.snapshot, configureMinimap: viewport.configureMinimap,
        configureFontLigatures: viewport.configureFontLigatures, update: (next: string) => {
        if (disposed || next === text) return;
        const state = viewport.captureView(), anchor = state.verticalAnchor;
        const line = anchor ? workspace.document(resource.documentId).buffer.lineAt(anchor.offset) : 0;
        workspace.beginLoad(resource).accept({ value: next }); text = next;
        const current = workspace.document(resource.documentId);
        viewport.restoreView({ anchor: 0, head: 0, scrollTop: state.scrollTop, scrollLeft: state.scrollLeft,
            ...(anchor ? { verticalAnchor: { revision: current.revision,
                offset: current.buffer.offsetAt(Math.min(line, current.buffer.lineCount - 1)), topRemainder: anchor.topRemainder } } : {}) });
    }, dispose: () => {
        if (disposed) return;
        disposed = true; viewport.dispose(); workspace.close(tab); workspace.releaseResource(resource.id);
    } });
}
