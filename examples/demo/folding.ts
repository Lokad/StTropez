import { discoverIndentationFolds } from "../../src/index.ts";
import { createFoldingController } from "../../src/browser/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import { createLspFoldingClient } from "../../src/protocol/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import type { DemoProject, DemoFile } from "./project.ts";

export const outlineFolds = (tabSize: number) => ({ tabSize, group: "blocks", markers: [{ start: "#region", end: "#endregion", group: "regions" }] });
export function mountDemoFolding(project: DemoProject, file: DemoFile, editor: EditingCandidate, tabSize: () => number) {
    let owner: LspWorkspace | undefined, client: ReturnType<typeof createLspFoldingClient> | undefined, disposed = false;
    const controller = createFoldingController(project.workspace, file.tab, editor, async (document, signal) => {
        if (project.sample.id === "outline" || project.sample.id === "host") return discoverIndentationFolds(document.buffer, outlineFolds(tabSize()));
        if (project.language.state.getSnapshot().status === "failed") throw new Error("Folding is unavailable until the language service is retried.");
        const next = await project.language.connect();
        if (disposed || signal.aborted) throw new Error("Folding discovery cancelled.");
        if (owner !== next) { client?.dispose(); owner = next; client = createLspFoldingClient(next); }
        const call = client!.run(document), cancel = () => call.cancel();
        signal.addEventListener("abort", cancel, { once: true });
        try { return await call.result; } finally { signal.removeEventListener("abort", cancel); }
    });
    return Object.freeze({ ...controller, dispose: () => { if (disposed) return; disposed = true; controller.dispose(); client?.dispose(); } });
}
