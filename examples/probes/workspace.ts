import { Workspace } from "../../src/index.ts";
import { mountTextEditor } from "../../src/browser/index.ts";
import { corpus, workspaceWorkload } from "../../tests/fixtures/workloads.ts";

// M0 stress recipe for the native baseline. Annotations are host overlays, not editor decorations.
export function mountWorkspaceProbe(host: HTMLElement) {
    const workspace = new Workspace();
    const source = workspace.createDocument({ scope: "probe", resource: "source", variant: "working" }, "Workspace source", corpus("normal"));
    const background = workspace.createDocument({ scope: "probe", resource: "progress", variant: "working" }, "Background progress", "0");
    for (let index = 2; index < workspaceWorkload.resources.at(-1)!; index++) {
        const id = workspace.createDocument({ scope: "probe", resource: `inactive-${index}`, variant: "working" }, "Inactive source", "inactive");
        workspace.open({ kind: "text", documentId: id }, "inactive");
    }
    const tabs = [workspace.open({ kind: "text", documentId: source }, "left"), workspace.open({ kind: "text", documentId: source }, "right")];
    const panes = tabs.map(() => { const pane = document.createElement("div"); host.append(pane); return pane; });
    const views = tabs.map((tab, index) => mountTextEditor(panes[index]!, workspace, tab));
    const annotations = Object.freeze(Array.from({ length: workspaceWorkload.annotations }, (_, index) =>
        Object.freeze({ from: index % corpus("normal").length, message: "Synthetic annotation", revision: 0 })));
    let ticks = 0, notifications = 0, disposed = false;
    const unsubscribe = workspace.subscribe(() => notifications++);
    const timer = setInterval(() => {
        const current = workspace.document(background);
        workspace.edit({ documentId: background, expectedRevision: current.revision, origin: "host",
            history: { kind: "live" }, edits: [{ from: 0, to: current.buffer.length, insert: String(++ticks) }] });
    }, 1_000 / workspaceWorkload.backgroundUpdatesPerSecond);
    const snapshot = () => ({ resources: workspace.getSnapshot().documents.length, tabs: workspace.getSnapshot().tabs.length,
        activeViews: disposed ? 0 : views.length, annotations: annotations.length, ticks, notifications,
        sourceRevision: workspace.document(source).revision, sourceLength: workspace.document(source).buffer.length,
        sourceUndoDepth: workspace.observeHistory(source).getSnapshot().undoDepth, disposed });
    const dispose = () => {
        if (disposed) return;
        disposed = true; clearInterval(timer); unsubscribe(); views.forEach(view => view.destroy());
        panes.forEach(pane => pane.remove());
    };
    return { snapshot, dispose, move: () => {
        const view = views[0]!, state = view.captureView();
        panes[1]!.append(view.element); workspace.move(tabs[0]!, "right"); view.restoreView(state);
    } };
}
