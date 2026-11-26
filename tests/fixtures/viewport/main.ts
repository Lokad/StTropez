import { Workspace } from "../../../src/index.ts";
import type { Selection, TextEdit } from "../../../src/index.ts";
import { mountTextViewport } from "../../../src/browser/viewport.ts";
import type { ViewState } from "../../../src/browser/index.ts";
import { corpus, corpusIds } from "../workloads.ts";
import type { CorpusId } from "../workloads.ts";
import { viewportSettled } from "../readiness.ts";
import "./style.css";

const workspace = new Workspace(), source = workspace.createTextResource({ scope: "viewport", resource: "source", variant: "working" }, "Source", { value: corpus("lines-10000") });
const progress = workspace.createResource({ scope: "viewport", resource: "progress", variant: "working" }, "Progress", { value: 0 });
const primaryTab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "left"), secondaryTab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "right");
const pane = (name: string) => document.getElementById(name)!;
const views = { primary: mountTextViewport(pane("primary"), workspace, primaryTab, { ariaLabel: "Primary text viewport" }),
    secondary: mountTextViewport(pane("secondary"), workspace, secondaryTab, { ariaLabel: "Secondary text viewport" }) };
let ticks = 0, timer: ReturnType<typeof setInterval> | undefined, disposed = false;
const listeners = new AbortController();
function edit(expectedRevision: number, edits: readonly TextEdit[]) {
    return workspace.edit({ documentId: source.documentId, expectedRevision, edits, origin: "host", history: { kind: "live" } });
}
function load(id: CorpusId) {
    if (!corpusIds.includes(id)) throw new RangeError("Unknown workload.");
    const current = workspace.document(source.documentId); edit(current.revision, [{ from: 0, to: current.buffer.length, insert: corpus(id) }]);
    Object.values(views).forEach(view => { view.view.setSelection(workspace.document(source.documentId).revision, { anchor: 0, head: 0 }); view.scrollTo({ top: 0, left: 0 }); });
}
function background(active: boolean) {
    if (timer !== undefined) clearInterval(timer); timer = undefined;
    if (active) timer = setInterval(() => { const state = progress.getSnapshot(); workspace.updateResource(progress, { expectedRevision: state.revision, value: ++ticks, origin: "host" }); }, 50);
}
const on = (id: string, action: () => void) => pane(id).addEventListener("click", action, { signal: listeners.signal });
on("start", () => views.primary.scrollTo({ top: 0, left: 0 }));
on("middle", () => views.primary.revealOffset(Math.floor(workspace.document(source.documentId).buffer.length / 2)));
on("end", () => views.primary.revealOffset(workspace.document(source.documentId).buffer.length));
on("prepend", () => edit(workspace.document(source.documentId).revision, [{ from: 0, to: 0, insert: "new first line\n" }]));
on("undo", () => workspace.undo({ documentId: source.documentId, expectedRevision: workspace.document(source.documentId).revision }));
on("redo", () => workspace.redo({ documentId: source.documentId, expectedRevision: workspace.document(source.documentId).revision }));
pane("workload").addEventListener("change", event => load((event.currentTarget as HTMLSelectElement).value as CorpusId), { signal: listeners.signal });
const documentState = workspace.observeDocument(source.documentId);
const status = () => {
    const current = documentState.getSnapshot();
    pane("status").textContent = current ? `${current.buffer.lineCount.toLocaleString()} lines · Revision ${current.revision}` : "Loading";
};
const unsubscribe = documentState.subscribe(status); status();
const fixture = { ready: true, load, edit, background,
    bindLanguage: (uri: string) => workspace.setDocumentLanguage(source.documentId, { uri, languageId: "typescript" }),
    get settled() { return !disposed && viewportSettled(views.primary) && viewportSettled(views.secondary); },
    reload: (value: string) => workspace.beginLoad(source).accept({ value }),
    select: (which: "primary" | "secondary", ranges: readonly Selection[], primary = 0) => views[which].view.setSelections(workspace.document(source.documentId).revision, ranges, primary),
    capture: (which: "primary" | "secondary") => views[which].captureView(),
    restore: (which: "primary" | "secondary", state: ViewState) => views[which].restoreView(state),
    replacePrimary: () => workspace.tabs.replace(primaryTab, { kind: "panel", resourceId: progress.id, panelType: "progress" }),
    scroll: (which: "primary" | "secondary", top: number, left: number) => views[which].scrollTo({ top, left }),
    reveal: (which: "primary" | "secondary", offset: number) => views[which].revealOffset(offset),
    resize: (width: number, height: number, lineHeight = "1.6") => {
        pane("primary").style.width = `${width}px`; pane("primary").style.height = `${height}px`; views.primary.element.style.setProperty("--st-line-height", lineHeight);
    },
    range: (from: number, to: number) => workspace.document(source.documentId).buffer.slice(from, to),
    snapshot: () => {
        const current = workspace.getSnapshot().documents.find(document => document.id === source.documentId);
        return { document: current ? { revision: current.revision, length: current.buffer.length, lines: current.buffer.lineCount,
            longest: current.buffer.longestLineLength } : null,
            primary: views.primary.getDiagnostics(), secondary: views.secondary.getDiagnostics(), diagnostics: workspace.diagnostics(), ticks, disposed };
    },
    dispose: () => {
        if (disposed) return; disposed = true; background(false); unsubscribe(); listeners.abort();
        Object.values(views).forEach(view => view.dispose());
        for (const tab of workspace.tabs.getSnapshot()) workspace.tabs.close(tab.id);
        workspace.releaseResource(source.id, true); workspace.releaseResource(progress.id, true);
    } };
window.viewportFixture = fixture;
window.addEventListener("pagehide", event => { if (!event.persisted) fixture.dispose(); }, { signal: listeners.signal });
declare global { interface Window { viewportFixture: typeof fixture } }
