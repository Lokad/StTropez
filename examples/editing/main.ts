import { Workspace } from "../../src/index.ts";
import type { EditingCommand, LanguageConfiguration, FoldRange, Selection, TextEdit } from "../../src/index.ts";
import { inputConflictEvent, mountEditingCandidate, createFoldingController } from "../../src/browser/index.ts";
import type { CandidateEditTransform, FoldDiscovery, FoldCommand, FoldingController, InputConflictDetail } from "../../src/browser/index.ts";
import { corpus, corpusIds } from "../../fixtures/workloads.ts";
import { EditingPresentation } from "../shared/language/presentation.ts";
import { editorSettled } from "../shared/readiness.ts";
import { mountFindUI } from "./find-ui.ts";
import { mountProviderUI } from "./provider-ui.ts";
import { mountParagraphUI } from "./paragraph-ui.ts";
import type { CorpusId } from "../../fixtures/workloads.ts";
import "./style.css";

const workspace = new Workspace(), source = workspace.createTextResource({ scope: "editing", resource: "source", variant: "working" }, "Source", { value: corpus("lines-100000") });
const primaryTab = workspace.open({ kind: "text", documentId: source.documentId }, "left"), secondaryTab = workspace.open({ kind: "text", documentId: source.documentId }, "right");
const pane = (id: string) => document.getElementById(id)!;
const presentation = { primary: new EditingPresentation(), secondary: new EditingPresentation() };
let failDecoration = false;
const editors = { primary: mountEditingCandidate(pane("primary"), workspace, primaryTab, { ariaLabel: "Primary source", readOnly: new URLSearchParams(location.search).has("readonly"), decorate: slice => {
    if (failDecoration) { failDecoration = false; throw new Error("Fixture decoration failure"); }
    return presentation.primary.decorate(slice);
} }),
    secondary: mountEditingCandidate(pane("secondary"), workspace, secondaryTab, { ariaLabel: "Secondary source", decorate: presentation.secondary.decorate }) };
const findUI = mountFindUI(workspace, primaryTab, editors.primary, presentation.primary), provider = mountProviderUI(workspace, primaryTab, editors.primary, presentation.primary);
const paragraph = mountParagraphUI(workspace, primaryTab, editors.primary);
const listeners = new AbortController(); let disposed = false;
let foldingController: FoldingController | undefined;
const conflicts: InputConflictDetail[] = [];
pane("primary").addEventListener(inputConflictEvent, event => { conflicts.push((event as CustomEvent<InputConflictDetail>).detail); }, { signal: listeners.signal });
function edit(edits: readonly TextEdit[]) { return workspace.edit({ documentId: source.documentId, expectedRevision: workspace.document(source.documentId).revision, edits, origin: "host", history: { kind: "live" } }); }
function setText(text: string) {
    const current = workspace.document(source.documentId); edit([{ from: 0, to: current.buffer.length, insert: text }]);
    for (const editor of Object.values(editors)) { editor.view.setSelection(workspace.document(source.documentId).revision, { anchor: 0, head: 0 }); editor.viewport.scrollTo({ top: 0, left: 0 }); }
}
function select(which: "primary" | "secondary", selection: Selection) {
    editors[which].view.setSelection(workspace.document(source.documentId).revision, selection); editors[which].viewport.revealOffset(selection.head);
}
const history = (direction: "undo" | "redo") => workspace[direction]({ documentId: source.documentId, expectedRevision: workspace.document(source.documentId).revision });
pane("workload").addEventListener("change", event => { const id = (event.target as HTMLSelectElement).value as CorpusId; if (corpusIds.includes(id)) setText(corpus(id)); }, { signal: listeners.signal });
pane("end").addEventListener("click", () => { const length = workspace.document(source.documentId).buffer.length; select("primary", { anchor: length, head: length }); editors.primary.focus(); }, { signal: listeners.signal });
pane("undo").addEventListener("click", () => history("undo"), { signal: listeners.signal }); pane("redo").addEventListener("click", () => history("redo"), { signal: listeners.signal });
const status = () => { const current = workspace.document(source.documentId); pane("status").textContent = `${current.buffer.lineCount.toLocaleString()} lines · Revision ${current.revision}`; };
const unsubscribe = workspace.observeDocument(source.documentId).subscribe(status); status();
const fixture = { ready: true, setText, edit, select, history,
    get settled() { return !disposed && editorSettled(editors.primary) && editorSettled(editors.secondary); },
    failNextDecoration: () => { failDecoration = true; editors.primary.viewport.invalidate(); },
    captureInsertion: () => editors.primary.captureInsertion(),
    registerEditTransform: (transform: CandidateEditTransform) => editors.primary.registerEditTransform(transform),
    discoverFolds: (discover: FoldDiscovery) => { foldingController?.dispose(); foldingController = createFoldingController(workspace, primaryTab, editors.primary, discover, { delayMs: 0 }); },
    foldCommand: (command: FoldCommand, group?: string) => foldingController?.runCommand(command, group),
    refreshFolds: () => foldingController?.refresh(), foldStatus: () => foldingController?.state.getSnapshot(),
    configureLanguage: (value: LanguageConfiguration) => editors.primary.configureLanguage(value),
    command: (command: EditingCommand) => editors.primary.runCommand(command),
    selections: (ranges: readonly Selection[], primary = 0) => editors.primary.view.setSelections(workspace.document(source.documentId).revision, ranges, primary),
    folds: (ranges: readonly FoldRange[], which: "primary" | "secondary" = "primary") => { const f = editors[which].view.folding; return f.setRanges(f.getSnapshot(), ranges); },
    folding: (which: "primary" | "secondary" = "primary") => editors[which].view.folding.getSnapshot(),
    analyzeParagraph: paragraph.start, analyzeCurrentLine: paragraph.currentLine, cancelParagraph: paragraph.cancel, paragraphLevel: paragraph.levelAt, paragraphOffset: paragraph.offsetAt,
    setProviderDelay: provider.setDelay, faultProviderNext: provider.faultNext,
    requestProvider: provider.request, cancelProvider: provider.cancel,
    find: (query: string) => findUI.find.setQuery(query), findNext: () => findUI.find.next(), replaceCurrent: (text: string) => findUI.find.replaceCurrent(text), replaceAll: (text: string) => findUI.find.replaceAll(text), cancelFind: findUI.find.cancel,
    conflictText: (index = conflicts.length - 1) => conflicts[index]?.attemptedText,
    focus: (which: "primary" | "secondary") => editors[which].focus(),
    load: (id: CorpusId) => { if (!corpusIds.includes(id)) throw new RangeError("Unknown workload."); setText(corpus(id)); },
    range: (from: number, to: number) => workspace.document(source.documentId).buffer.slice(from, to),
    coords: (offset: number, affinity: "before" | "after" = "after") => editors.primary.viewport.coordsAt(offset, affinity),
    hit: (x: number, y: number) => editors.primary.viewport.hitTest(x, y),
    readOnly: (value: boolean) => workspace.setCapabilities(source.id, { edit: value ? ["host"] : ["human", "host", "agent"], save: true, run: true }),
    replacePrimary: () => workspace.replace(primaryTab, { kind: "text", documentId: source.documentId }),
    snapshot: () => {
        const current = workspace.getSnapshot().documents.find(document => document.id === source.documentId);
        return { document: current ? { revision: current.revision, length: current.buffer.length, exports: current.buffer.readMetrics().textExports } : null,
            primary: { ...editors.primary.snapshot(), viewport: editors.primary.viewport.snapshot(), selection: editors.primary.view.getSnapshot().selection },
            secondary: { ...editors.secondary.snapshot(), viewport: editors.secondary.viewport.snapshot(), selection: editors.secondary.view.getSnapshot().selection },
            history: current ? workspace.observeHistory(source.documentId).getSnapshot() : null,
            find: (() => { const state = findUI.find.state.getSnapshot(); return { wholeWord: state.wholeWord, matchCase: state.matchCase, regularExpression: state.regularExpression, revision: state.revision, status: state.status, count: state.count, scanned: state.scanned, current: state.current, matchesVersion: state.matchesVersion, reason: state.reason, message: state.message, maxScanStepMs: state.maxScanStepMs, replaceTransactionMs: state.replaceTransactionMs }; })(),
            presentation: { primary: presentation.primary.snapshot(), secondary: presentation.secondary.snapshot() }, provider: provider.snapshot(), paragraph: paragraph.snapshot(),
            conflicts: conflicts.map(item => ({ reason: item.reason, expectedRevision: item.expectedRevision, attemptedUnits: item.attemptedText.length,
                ...(item.cause instanceof Error ? { error: item.cause.message } : {}) })), diagnostics: workspace.diagnostics(), disposed };
    },
    dispose: () => {
        if (disposed) return; disposed = true; foldingController?.dispose(); listeners.abort(); unsubscribe(); findUI.destroy(); provider.destroy(); paragraph.destroy();
        Object.values(editors).forEach(editor => editor.destroy()); Object.values(presentation).forEach(value => value.clear());
        for (const tab of workspace.tabState.getSnapshot()) workspace.close(tab.id); workspace.releaseResource(source.id, true);
    } };
window.editingFixture = fixture;
window.addEventListener("pagehide", event => { if (!event.persisted) fixture.dispose(); }, { signal: listeners.signal });
declare global { interface Window { editingFixture: typeof fixture } }
