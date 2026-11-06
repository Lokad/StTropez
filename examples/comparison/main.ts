import { TextBuffer, Workspace } from "../../src/index.ts";
import type { ComparisonTicket, Selection } from "../../src/index.ts";
import { mountTextComparison } from "../../src/browser/index.ts";
import "../../src/browser/editor.css";
import "./style.css";

const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "fixture", resource: "working", variant: "source" }, "Working source",
    { value: "const title = 'Working';\r\n// shared separator\r\nconst count = 2;\r\n// shared boundary\r\n\treturn title;\r\n// working note\r\n", serverVersion: "saved-1" });
const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "main");
const comparison = mountTextComparison(document.querySelector<HTMLElement>("#comparison")!, workspace, tab,
    { buffer: TextBuffer.from("const title = 'Baseline';\r\n// shared separator\r\nconst count = 1;\r\n// shared boundary\r\n  return title;\r\n"), version: "reference-1" });
const refreshes: ComparisonTicket[] = [], acceptances: ComparisonTicket[] = []; let serial = 1, result = "Ready", disposed = false;
function status() { document.querySelector("#host-status")!.textContent = `${result} · ${refreshes.length} refreshes · ${acceptances.length} acceptances`; }
function begin(kind: "refresh" | "accept") { const ticket = kind === "refresh" ? comparison.controller.beginRefresh() : comparison.controller.beginAcceptance(); (kind === "refresh" ? refreshes : acceptances).push(ticket); result = `Captured ${kind} at revision ${ticket.capture.working.revision}`; status(); }
function finish(kind: "refresh" | "accept", newest = false) {
    const queue = kind === "refresh" ? refreshes : acceptances, ticket = newest ? queue.pop() : queue.shift(); if (!ticket) return false;
    const reference = { buffer: kind === "refresh" ? TextBuffer.from(`// refreshed reference ${++serial}\r\nconst count = 9;\r\n`) : ticket.capture.working.buffer, version: `reference-${++serial}` };
    const applied = ticket.complete(reference); result = `${kind} ${applied ? "applied" : "stale"}`; status(); return applied;
}
function history(direction: "undo" | "redo") { const current = workspace.document(resource.documentId); workspace[direction]({ documentId: current.id, expectedRevision: current.revision }); }
function dispose() {
    if (disposed) return; comparison.destroy(); disposed = true;
    refreshes.length = acceptances.length = 0;
    for (const button of document.querySelectorAll<HTMLButtonElement>("nav button")) button.disabled = true;
    result = "Disposed"; status();
}
document.querySelector("#refresh")!.addEventListener("click", () => begin("refresh"));
document.querySelector("#finish-refresh")!.addEventListener("click", () => finish("refresh"));
document.querySelector("#finish-newest-refresh")!.addEventListener("click", () => finish("refresh", true));
document.querySelector("#accept")!.addEventListener("click", () => begin("accept"));
document.querySelector("#finish-accept")!.addEventListener("click", () => finish("accept"));
document.querySelector("#undo")!.addEventListener("click", () => history("undo")); document.querySelector("#redo")!.addEventListener("click", () => history("redo"));
document.querySelector("#dispose")!.addEventListener("click", dispose);
function setText(value: string) { const current = workspace.document(resource.documentId); return workspace.edit({ documentId: current.id, expectedRevision: current.revision, origin: "host", history: { kind: "replace" }, edits: [{ from: 0, to: current.buffer.length, insert: value }] }); }
function snapshot() {
    const state = comparison.controller.getSnapshot(), current = workspace.document(resource.documentId);
    return { status: state.status, generation: state.generation, baseline: state.baseline && { epoch: state.baseline.epoch, version: state.baseline.version, length: state.baseline.buffer.length, exports: state.baseline.buffer.readMetrics().textExports },
        working: { id: current.id, resourceId: current.resourceId, revision: current.revision, length: current.buffer.length, exports: current.buffer.readMetrics().textExports, metadata: resource.metadata.getSnapshot() },
        hunks: state.hunks, history: workspace.observeHistory(current.id).getSnapshot(), viewId: comparison.working.view.id, editor: { ...comparison.working.snapshot(), viewport: comparison.working.viewport.snapshot() }, reference: comparison.referenceViewport()?.snapshot() ?? null,
        pending: { refreshes: refreshes.length, acceptances: acceptances.length }, comparison: comparison.snapshot(), diagnostics: workspace.diagnostics(), result, disposed };
}
const fixture = Object.freeze({ snapshot, setText, begin, finish, dispose, focus: () => comparison.working.focus(),
    select: (selection: Selection) => comparison.controller.view.setSelection(workspace.document(resource.documentId).revision, selection),
    selectHunk: (generation: number, index: number) => comparison.selectHunk(generation, index), revert: (generation: number, index: number) => comparison.controller.revert(generation, index),
    range: (from: number, to: number) => workspace.document(resource.documentId).buffer.slice(from, to),
    baselineRange: (from: number, to: number) => comparison.controller.getSnapshot().baseline?.buffer.slice(from, to),
    readOnly: (value: boolean) => workspace.setCapabilities(resource.id, { edit: value ? [] : ["human", "agent", "host"], save: true, run: true }),
    replaceTab: () => { const documentId = workspace.createDocument({ scope: "fixture", resource: "replacement", variant: "source" }, "Replacement", "replacement"); workspace.replace(tab, { kind: "text", documentId }); },
    moveTab: () => workspace.move(tab, "moved"), history });
declare global { interface Window { comparisonFixture: typeof fixture } }
window.comparisonFixture = fixture; status();
