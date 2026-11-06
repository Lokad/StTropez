import { applyTextEdits, exportText, PositionMap, textDifference } from "../index.ts";
import type { DocumentSnapshot, DocumentView, EditKind, PositionMapping, Selection, TextBuffer, Workspace, TabId } from "../index.ts";
export { mountTextViewport } from "./viewport.ts";
export type { InlineDecoration, LineClass, LineDecorator, PresentedLine, RevealOptions, TextViewport, ViewportSnapshot } from "./viewport.ts";
export { mountEditingCandidate } from "./editing-candidate.ts";
export type { EditingCandidate } from "./editing-candidate.ts";
export { createFindController } from "./find.ts";
export type { FindController, FindSnapshot } from "./find.ts";
export { mountTextComparison } from "./comparison.ts";
export type { TextComparison } from "./comparison.ts";

export type ViewState = Selection & Readonly<{ scrollTop: number; scrollLeft: number }>;
export type MountedEditor = Readonly<{ element: HTMLTextAreaElement; view: DocumentView;
    captureView: () => ViewState; restoreView: (state: ViewState) => void; destroy: () => void }>;
type Projection = Readonly<{ text: string; mapping: PositionMapping; hasCR: boolean }>;
const projections = new WeakMap<TextBuffer, WeakRef<Projection>>();
let nextMount = 0;
function project(text: string): Projection {
    const hasCR = text.includes("\r");
    return hasCR ? { ...exportText(text, "lf"), hasCR } : { text, mapping: new PositionMap(text.length, []), hasCR };
}
function projection(document: DocumentSnapshot): Projection {
    let value = projections.get(document.buffer)?.deref();
    if (!value) { value = project(document.text); projections.set(document.buffer, new WeakRef(value)); } return value;
}

/** Native input baseline. Document history/selection are shared; whole-value rendering remains unbounded. */
export function mountTextEditor(host: HTMLElement, workspace: Workspace, tabId: TabId,
    options: Readonly<{ ariaLabel?: string; view?: DocumentView }> = {}): MountedEditor {
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text") throw new Error("Expected a text surface.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId);
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to a different document or workspace.");
    const view = options.view ?? workspace.createDocumentView(documentId);
    const groupScope = ++nextMount;
    const input = host.ownerDocument.createElement("textarea");
    input.className = "st-editor"; input.setAttribute("aria-label", options.ariaLabel ?? workspace.document(documentId).title);
    input.spellcheck = false; input.wrap = "off"; host.append(input);
    const listeners = new AbortController();
    let revision = workspace.document(documentId).revision, rendered = projection(workspace.document(documentId));
    let composing = false, destroyed = false, committing = false, selecting = false;
    let pending: Readonly<{ revision: number; value: Projection }> | undefined;
    let serial = 0, group: Readonly<{ type: string; edge: number; time: number; key: string }> | undefined;
    const readSelection = (map: PositionMapping): Selection => {
        const inverse = map.invert(), backward = input.selectionDirection === "backward";
        return { anchor: inverse.map(backward ? input.selectionEnd : input.selectionStart, "before").offset,
            head: inverse.map(backward ? input.selectionStart : input.selectionEnd, "before").offset };
    };
    const syncSelection = () => {
        if (destroyed || composing || committing || resource.getSnapshot().state !== "ready" || input.value !== rendered.text) return;
        // In particular, beforeinput must retain the browser's pending native replacement range.
        selecting = true;
        try { view.setSelection(revision, readSelection(rendered.mapping)); } finally { selecting = false; }
    };
    const refresh = () => {
        if (destroyed || selecting) return;
        if (!workspace.resolveTab(target)) { input.disabled = true; return; }
        const state = resource.getSnapshot(); input.disabled = state.state !== "ready";
        input.setAttribute("aria-busy", String(state.state === "loading"));
        input.readOnly = !state.metadata.capabilities.edit.includes("human") || state.metadata.editLock !== null;
        if (state.state !== "ready" || composing) return;
        const document = workspace.document(documentId);
        if (pending?.revision === document.revision) projections.set(document.buffer, new WeakRef(pending.value));
        rendered = projection(document);
        const scrollTop = input.scrollTop, scrollLeft = input.scrollLeft;
        if (input.value !== rendered.text) input.value = rendered.text;
        const selected = view.getSnapshot().selection;
        const anchor = rendered.mapping.map(selected.anchor, "before").offset, head = rendered.mapping.map(selected.head, "before").offset;
        if (input.selectionStart !== Math.min(anchor, head) || input.selectionEnd !== Math.max(anchor, head)
            || (input.selectionDirection === "backward") !== (anchor > head)) {
            input.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward");
        }
        input.scrollTop = scrollTop; input.scrollLeft = scrollLeft; revision = document.revision;
    };
    const conflict = (reason: string) => input.dispatchEvent(new CustomEvent("sttropez-conflict", { bubbles: true,
        detail: Object.freeze({ documentId, expectedRevision: revision, reason, attemptedText: input.value }) }));
    const history = (direction: "undo" | "redo") => {
        if (!workspace.resolveTab(target)) { conflict("expired-view"); refresh(); return; }
        group = undefined; syncSelection();
        const result = workspace[direction]({ documentId, expectedRevision: revision });
        if (!result.applied && result.reason !== "history-empty") conflict(result.reason); refresh();
    };
    const commit = (type = "insertReplacementText") => {
        if (composing) return;
        if (type === "historyUndo" || type === "historyRedo") { refresh(); history(type === "historyUndo" ? "undo" : "redo"); return; }
        if (!workspace.resolveTab(target)) { conflict("expired-view"); refresh(); return; }
        if (resource.getSnapshot().state !== "ready") { conflict("not-ready"); refresh(); return; }
        const document = workspace.document(documentId);
        if (document.revision !== revision) { conflict("stale-revision"); refresh(); return; }
        const nativeEdit = textDifference(rendered.text, input.value); if (!nativeEdit) { refresh(); return; }
        const inverse = rendered.mapping.invert(), from = inverse.map(nativeEdit.from, "before").offset;
        const edit = { from, to: nativeEdit.from === nativeEdit.to ? from : inverse.map(nativeEdit.to, "before").offset, insert: nativeEdit.insert };
        const next = rendered.hasCR ? project(applyTextEdits(document.text, [edit])) : project(input.value);
        const after = readSelection(next.mapping), now = performance.now();
        const typing = type === "insertText" && edit.from === edit.to && !edit.insert.includes("\n");
        const deleting = type === "deleteContentBackward" || type === "deleteContentForward";
        const kind: EditKind = typing ? "typing" : deleting ? "delete" : type === "insertFromPaste" ? "paste" : type === "insertCompositionText" ? "composition" : "replace";
        let key: string | undefined;
        if (typing || deleting) {
            const adjacent = group?.type === type && now - group.time < 1_000 && (type === "deleteContentBackward" ? edit.to === group.edge : edit.from === group.edge);
            key = adjacent ? group!.key : `${view.id}:${groupScope}:${++serial}`;
            group = { type, edge: edit.from + edit.insert.length, time: now, key };
        } else group = undefined;
        pending = { revision: revision + 1, value: next }; committing = true;
        try {
            const result = workspace.edit({ documentId, expectedRevision: revision, origin: "human", edits: [edit], view, selection: after,
                history: { kind, ...(key ? { group: key } : {}) } });
            if (!result.applied) conflict(result.reason);
        } finally { pending = undefined; committing = false; refresh(); }
    };
    input.addEventListener("beforeinput", event => {
        if ((event.inputType === "historyUndo" || event.inputType === "historyRedo") && event.cancelable && !composing) {
            event.preventDefault(); history(event.inputType === "historyUndo" ? "undo" : "redo");
        } else syncSelection();
    }, { signal: listeners.signal });
    input.addEventListener("keydown", event => {
        if (!composing && (event.ctrlKey || event.metaKey) && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === "z" || (event.ctrlKey && key === "y")) { event.preventDefault(); history(event.shiftKey || key === "y" ? "redo" : "undo"); }
        }
    }, { signal: listeners.signal });
    for (const type of ["select", "keyup", "pointerup"] as const) input.addEventListener(type, syncSelection, { signal: listeners.signal });
    input.addEventListener("blur", () => { syncSelection(); group = undefined; }, { signal: listeners.signal });
    input.addEventListener("compositionstart", () => { syncSelection(); composing = true; group = undefined; }, { signal: listeners.signal });
    input.addEventListener("compositionend", () => { composing = false; commit("insertCompositionText"); }, { signal: listeners.signal });
    input.addEventListener("input", event => commit((event as InputEvent).inputType), { signal: listeners.signal });
    const unsubscribers = [workspace.observeDocument(documentId).subscribe(refresh), view.subscribe(refresh),
        resource.metadata.subscribe(refresh), workspace.tabState.subscribe(refresh)];
    refresh();
    return Object.freeze({ element: input, view,
        captureView: () => { syncSelection(); return Object.freeze({ ...view.getSnapshot().selection, scrollTop: input.scrollTop, scrollLeft: input.scrollLeft }); },
        restoreView: (state: ViewState) => {
            view.setSelection(revision, state); refresh(); input.scrollTop = state.scrollTop; input.scrollLeft = state.scrollLeft;
        }, destroy: () => {
            if (destroyed) return; syncSelection(); destroyed = true;
            if (composing && input.value !== rendered.text) conflict("composition-detached");
            composing = false; unsubscribers.forEach(unsubscribe => unsubscribe()); listeners.abort(); input.remove();
            if (!options.view) view.dispose();
        } });
}
export { createFontAssetController } from "./font-asset.ts";
export type { FontAssetController, FontAssetSnapshot, FontAssetVersion, FontLoadOperation, FontLoadResult } from "./font-asset.ts";
