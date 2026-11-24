import { discoverIndentationFolds } from "../../src/index.ts";
import { createFoldingController } from "../../src/browser/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";
import type { DemoProject, DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";

export const outlineFolds = (tabSize: number) => ({ tabSize, group: "blocks", markers: [{ start: "#region", end: "#endregion", group: "regions" }] });
/** Sample anchors describe only fresh sample text; retained views and saved/edited text own their choices. */
export function initializeDemoFolds(project: DemoProject, file: DemoFile): void {
    const ranges = project.sample.initialFolds?.[file.name], state = file.view.folding.getSnapshot();
    if (ranges && state.revision === 0 && state.generation === 0 && project.baseline(file).version === "sample") file.view.folding.setRanges(state, ranges);
}
export function mountDemoFolding(project: DemoProject, editor: TextEditor, tabSize: () => number) {
    if (project.sample.id === "outline" || project.sample.id === "host") {
        return createFoldingController(editor, document => discoverIndentationFolds(document.buffer, outlineFolds(tabSize())));
    }
    const language = project.language;
    return createFoldingController(editor, async (document, signal) => {
        // The source view starts the connection after its controllers mount. Fold discovery joins it.
        const client = language.foldingClient ?? await new Promise<NonNullable<DemoLanguage["foldingClient"]>>((resolve, reject) => {
            const stop = language.state.subscribe(check);
            function check() {
                const ready = language.foldingClient;
                if (!signal.aborted && !ready && language.state.getSnapshot().status !== "failed") return;
                stop(); signal.removeEventListener("abort", check);
                if (signal.aborted) reject(new Error("Folding discovery cancelled."));
                else if (ready) resolve(ready);
                else reject(new Error("Folding is unavailable until the language service is retried."));
            }
            signal.addEventListener("abort", check, { once: true }); check();
        });
        if (signal.aborted || client !== language.foldingClient) throw new Error("Folding discovery cancelled.");
        // Startup assigns the language URI after the editor can already request folds.
        const bound = project.workspace.document(document.id);
        if (bound.resourceId !== document.resourceId || bound.buffer !== document.buffer
            || bound.revision !== document.revision || (document.language !== null && bound.language !== document.language)) {
            throw new Error("Folding discovery target changed.");
        }
        const call = client.run({ document: bound });
        const cancel = () => call.cancel();
        signal.addEventListener("abort", cancel, { once: true });
        try { return await call.result; } finally { signal.removeEventListener("abort", cancel); }
    });
}
