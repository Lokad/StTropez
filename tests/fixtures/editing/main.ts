import { graphemeBoundaries } from "../../../src/core/graphemes.ts";
import { Workspace } from "../../../src/index.ts";
import type { FoldRange, Selection, TextEdit } from "../../../src/index.ts";
import { inputConflictEvent, mountAnchoredOverlay, mountFindBar, mountTextEditor, observePointerDwell, createFoldingController } from "../../../src/browser/index.ts";
import type { TextEditorCommand, TextEditorEditTransform, FoldDiscovery, FoldingController, InputConflictDetail, AnchoredOverlayOptions, PointerDwellPosition } from "../../../src/browser/index.ts";
import { corpus, corpusIds } from "../workloads.ts";
import { EditingPresentation } from "../language/presentation.ts";
import { editorSettled } from "../readiness.ts";
import type { CorpusId } from "../workloads.ts";
import "./style.css";

const workspace = new Workspace(), source = workspace.createTextResource({ scope: "editing", resource: "source", variant: "working" }, "Source", { value: corpus("lines-10000") });
const pane = (id: string) => document.getElementById(id)!;
const presentation = { primary: new EditingPresentation(), secondary: new EditingPresentation() };
let failDecoration = false;
const params = new URLSearchParams(location.search);
const editors = { primary: mountTextEditor(pane("primary"), workspace, source.id, { ariaLabel: "Primary source", readOnly: params.has("readonly"), settings: { pasteLineEndings: params.get("pasteLineEndings") === "preserve" ? "preserve" : "local" } }),
    secondary: mountTextEditor(pane("secondary"), workspace, source.id, { ariaLabel: "Secondary source" }) };
const primarySyntax = editors.primary.decorations.addProvider({ order: 0, provide: slice => {
    if (failDecoration) { failDecoration = false; throw new Error("Fixture decoration failure"); }
    return presentation.primary.decorate(slice);
} });
editors.secondary.decorations.addProvider({ order: 0, provide: presentation.secondary.decorate });
const find = mountFindBar(pane("find"), { createWorker: () => new Worker("/regex-worker.js", { type: "module" }) });
find.attach(editors.primary);
const listeners = new AbortController(); let disposed = false;
let foldingController: FoldingController | undefined;
const conflicts: InputConflictDetail[] = [];
pane("primary").addEventListener(inputConflictEvent, event => { conflicts.push((event as CustomEvent<InputConflictDetail>).detail); }, { signal: listeners.signal });
function edit(edits: readonly TextEdit[]) { return workspace.edit({ documentId: source.id, expectedRevision: workspace.document(source.id).revision, edits, origin: "host", history: { kind: "live" } }); }
function setText(text: string) {
    const current = workspace.document(source.id); edit([{ from: 0, to: current.buffer.length, insert: text }]);
    for (const editor of Object.values(editors)) { editor.view.setSelection(workspace.document(source.id).revision, { anchor: 0, head: 0 }); editor.viewport.scrollTo({ top: 0, left: 0 }); }
}
function select(which: "primary" | "secondary", selection: Selection) {
    editors[which].view.setSelection(workspace.document(source.id).revision, selection); editors[which].viewport.revealOffset(selection.head);
}
const history = (direction: "undo" | "redo") => workspace[direction]({ documentId: source.id, expectedRevision: workspace.document(source.id).revision });
pane("workload").addEventListener("change", event => { const id = (event.target as HTMLSelectElement).value as CorpusId; if (corpusIds.includes(id)) setText(corpus(id)); }, { signal: listeners.signal });
pane("end").addEventListener("click", () => { const length = workspace.document(source.id).buffer.length; select("primary", { anchor: length, head: length }); editors.primary.focus(); }, { signal: listeners.signal });
pane("undo").addEventListener("click", () => history("undo"), { signal: listeners.signal }); pane("redo").addEventListener("click", () => history("redo"), { signal: listeners.signal });
const status = () => { const current = workspace.document(source.id); pane("status").textContent = `${current.buffer.lineCount.toLocaleString()} lines · Revision ${current.revision}`; };
const unsubscribe = workspace.observeDocument(source.id).subscribe(status); status();
const fixture = { ready: true, graphemeBoundaries, setText, edit, select, history,
    get settled() { return !disposed && editorSettled(editors.primary) && editorSettled(editors.secondary); },
    failNextDecoration: () => { failDecoration = true; primarySyntax.invalidate(); },
    captureInsertion: () => editors.primary.captureInsertion(),
    onEditIntent: editors.primary.onEditIntent,
    registerEditTransform: (transform: TextEditorEditTransform) => editors.primary.registerEditTransform(transform),
    discoverFolds: (discover: FoldDiscovery, initiallyCollapseGroup?: string) => {
        foldingController?.dispose();
        foldingController = createFoldingController(editors.primary, discover, {
            delayMs: 0, ...(initiallyCollapseGroup && { initiallyCollapseGroup }),
        });
    },
    stopFoldDiscovery: () => { foldingController?.dispose(); foldingController = undefined; },
    refreshFolds: () => foldingController?.refresh(), foldStatus: () => foldingController?.getSnapshot(),
    setGroupCollapsed: (collapsed: boolean, group: string) => foldingController?.setCollapsed(collapsed, group),
    pointerDwell: (listener: (point: PointerDwellPosition) => void, delayMs: number) => observePointerDwell(editors.primary, listener, { delayMs }),
    overlay: (element: HTMLElement, options?: AnchoredOverlayOptions) => mountAnchoredOverlay(editors.primary, element, options),
    configure: editors.primary.configure,
    commands: editors.primary.commands, keymap: editors.primary.keymap,
    command: (command: TextEditorCommand) => editors.primary.commands.run(command),
    selectionSet: () => editors.primary.view.getSnapshot().selectionSet,
    selections: (ranges: readonly Selection[], primary = 0) => editors.primary.view.setSelections(workspace.document(source.id).revision, ranges, primary),
    folds: (ranges: readonly FoldRange[], which: "primary" | "secondary" = "primary") => { const f = editors[which].view.folding; return f.setRanges(f.getSnapshot(), ranges); },
    folding: (which: "primary" | "secondary" = "primary") => editors[which].view.folding.getSnapshot(),
    conflictText: (index = conflicts.length - 1) => conflicts[index]?.attemptedText,
    focus: (which: "primary" | "secondary") => editors[which].focus(),
    onRender: (which: "primary" | "secondary", listener: () => void) => editors[which].viewport.onRender(listener),
    load: (id: CorpusId) => { if (!corpusIds.includes(id)) throw new RangeError("Unknown workload."); setText(corpus(id)); },
    range: (from: number, to: number) => workspace.document(source.id).buffer.slice(from, to),
    coords: (offset: number, affinity: "before" | "after" = "after") => editors.primary.viewport.coordsAt(offset, affinity),
    hit: (x: number, y: number) => editors.primary.viewport.hitTest(x, y),
    readOnly: (value: boolean) => workspace.setCapabilities(source.id, { edit: value ? ["host"] : ["human", "host", "agent"], save: true }),
    closePrimary: editors.primary.dispose,
    snapshot: () => {
        const current = workspace.getSnapshot().documents.find(document => document.id === source.id);
        const search = find.getSnapshot();
        return { document: current ? { revision: current.revision, length: current.buffer.length } : null,
            primary: { ...editors.primary.getDiagnostics(), viewport: editors.primary.viewport.getDiagnostics(), selection: editors.primary.view.getSnapshot().selection },
            secondary: { ...editors.secondary.getDiagnostics(), viewport: editors.secondary.viewport.getDiagnostics(), selection: editors.secondary.view.getSnapshot().selection },
            history: current ? workspace.observeHistory(source.id).getSnapshot() : null,
            find: search && { count: search.count, status: search.status },
            presentation: { primary: presentation.primary.snapshot(), secondary: presentation.secondary.snapshot() },
            conflicts: conflicts.map(item => ({ reason: item.reason, expectedRevision: item.expectedRevision, attemptedUnits: item.attemptedText.length,
                ...(item.cause instanceof Error ? { error: item.cause.message } : {}) })), diagnostics: workspace.diagnostics(), disposed };
    },
    dispose: () => {
        if (disposed) return; disposed = true; foldingController?.dispose(); listeners.abort(); unsubscribe(); find.dispose();
        Object.values(editors).forEach(editor => editor.dispose()); Object.values(presentation).forEach(value => value.clear());
        workspace.releaseResource(source.id, true);
    } };
window.editingFixture = fixture;
window.addEventListener("pagehide", event => { if (!event.persisted) fixture.dispose(); }, { signal: listeners.signal });
declare global { interface Window { editingFixture: typeof fixture } }
