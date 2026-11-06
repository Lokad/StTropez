import { anchoredRange } from "../../src/index.ts";
import type { ResourceLease, Selection, TabId, Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import type { ProviderInput, ProviderResult } from "../probes/provider.ts";
import { validateProviderResult } from "../probes/provider.ts";
import type { EditingPresentation } from "./presentation.ts";
type Pending = Readonly<{ input: ProviderInput; from: number; selection: Selection; lease: ResourceLease; startsInWord: boolean; endsInWord: boolean }>;
type Diagnostic = Readonly<{ from: number; to: number; message: string }>;

/** Synthetic host service. Captured revisions/views remain authoritative across worker replies. */
export function mountProviderUI(workspace: Workspace, tabId: TabId, editor: EditingCandidate, presentation: EditingPresentation) {
    const target = workspace.captureTab(tabId), documentId = editor.view.documentId, resource = workspace.resourceForDocument(documentId), owner = editor.element.ownerDocument;
    const listeners = new AbortController(), counters = { posted: 0, received: 0, applied: 0, stale: 0, cancelled: 0, invalid: 0, outOfScope: 0, failed: 0, postedUnits: 0 };
    let worker: Worker | undefined, sequence = 0, generation = 0, delay = 0, disposed = false, timeout: ReturnType<typeof setTimeout> | undefined;
    let pending: Pending | undefined, offer: Readonly<{ capture: Pending; result: ProviderResult }> | undefined;
    let diagnostics: readonly Diagnostic[] = [], diagnosticRevision = -1, fault: ProviderInput["fault"];
    const status = owner.getElementById("provider-status")!, choices = owner.getElementById("completion-choices")!, list = owner.getElementById("provider-diagnostics")!;
    const valid = () => !disposed && workspace.resolveTab(target) !== undefined && workspace.ownsDocumentView(editor.view) && !editor.snapshot().disposed
        && workspace.observeDocument(documentId).getSnapshot() !== undefined;
    const sameSelection = (selected: Selection) => { const current = editor.view.getSnapshot().selection; return selected.anchor === current.anchor && selected.head === current.head; };
    const release = () => { pending?.lease.release(); pending = undefined; if (timeout !== undefined) clearTimeout(timeout); timeout = undefined; };
    const render = (message: string) => {
        status.textContent = message; choices.replaceChildren(); list.replaceChildren();
        if (offer) { const item = owner.createElement("li"); item.textContent = offer.result.completion.insert; item.setAttribute("role", "option"); item.setAttribute("aria-selected", "true"); choices.append(item); }
        for (const diagnostic of diagnostics) { const item = owner.createElement("li"), button = owner.createElement("button");
            button.textContent = `${diagnostic.from}: ${diagnostic.message}`;
            button.dataset.from = String(diagnostic.from); button.dataset.to = String(diagnostic.to); button.dataset.revision = String(diagnosticRevision);
            item.append(button); list.append(item);
        }
        for (const id of ["completion-insert", "completion-replace"]) (owner.getElementById(id) as HTMLButtonElement).disabled = !offer;
        presentation.diagnostics = { revision: diagnosticRevision, ranges: diagnostics }; editor.viewport.invalidate();
    };
    const clearResults = (message: string) => { offer = undefined; diagnostics = []; diagnosticRevision = -1; render(message); };
    function disconnect(): void { generation++; worker?.terminate(); worker = undefined; release(); clearResults("Provider disconnected; local editing remains available."); }
    function connect(): void {
        if (disposed) return; disconnect(); const epoch = generation;
        try { worker = new Worker("/provider-worker.js", { type: "module" }); }
        catch { counters.failed++; render("Provider unavailable; local editing remains available."); return; }
        worker.addEventListener("error", event => { event.preventDefault(); if (epoch !== generation || disposed) return; counters.failed++; disconnect(); render("Provider unavailable; local editing remains available."); });
        worker.addEventListener("messageerror", () => { if (epoch !== generation || disposed) return; counters.invalid++; release(); clearResults("Provider result could not be decoded."); });
        worker.addEventListener("message", (event: MessageEvent<unknown>) => {
            if (epoch !== generation || disposed) return; counters.received++;
            let decoded: unknown;
            try { if (typeof event.data !== "string") throw new TypeError(); decoded = JSON.parse(event.data); }
            catch { counters.invalid++; release(); clearResults("Malformed provider result rejected."); return; }
            if (!pending || typeof decoded !== "object" || decoded === null || !("id" in decoded) || decoded.id !== pending.input.id) { counters.stale++; return; }
            const captured = pending, result = validateProviderResult(decoded, captured.input); release();
            if (!result) { counters.invalid++; clearResults("Malformed provider result rejected."); return; }
            if (!valid() || workspace.document(documentId).revision !== result.revision || !sameSelection(captured.selection)) { counters.stale++; clearResults("Stale provider result rejected."); return; }
            if ((captured.startsInWord && result.completion.from === 0) || (captured.endsInWord && result.completion.replaceTo === captured.input.text.length)) {
                counters.outOfScope++; clearResults("Completion word extends beyond the request window."); return;
            }
            offer = Object.freeze({ capture: captured, result }); diagnosticRevision = result.revision;
            diagnostics = Object.freeze(result.diagnostics.map(item => Object.freeze({ ...item, from: captured.from + item.from, to: captured.from + item.to })));
            render(result.diagnosticsTruncated ? "Completion ready; showing the first 256 diagnostics in this window." : "Completion and scoped diagnostics ready.");
        });
        render("Provider connected. Request completion for scoped results.");
    }
    function request(): void {
        if (!valid() || !worker) { render("Provider unavailable; local editing remains available."); return; }
        if (editor.snapshot().composing) { render("Finish composition before requesting completion."); return; }
        release(); clearResults("Request pending."); const document = workspace.document(documentId), selected = editor.view.getSnapshot().selection;
        if (selected.anchor !== selected.head) { render("Place a caret before requesting completion."); return; }
        const from = Math.max(0, selected.head - 2048), to = Math.min(document.buffer.length, selected.head + 2048);
        const input: ProviderInput = Object.freeze({ id: ++sequence, revision: document.revision, text: document.buffer.slice(from, to), offset: selected.head - from, delay, ...(fault ? { fault } : {}) }); fault = undefined;
        pending = Object.freeze({ input, from, selection: selected, lease: workspace.acquire(resource.id),
            startsInWord: from > 0 && /[a-zA-Z]/.test(document.buffer.slice(from - 1, from)) && /^[a-zA-Z]/.test(input.text),
            endsInWord: to < document.buffer.length && /[a-zA-Z]/.test(document.buffer.slice(to, to + 1)) });
        counters.posted++; counters.postedUnits += input.text.length; worker.postMessage(JSON.stringify(input));
        timeout = setTimeout(() => { counters.failed++; release(); clearResults("Provider timed out; local editing remains available."); }, 5000);
    }
    function apply(mode: "insert" | "replace"): boolean {
        const current = offer; if (!current) return false;
        if (!valid() || workspace.document(documentId).revision !== current.result.revision || !sameSelection(current.capture.selection)) { counters.stale++; clearResults("Stale completion rejected."); return false; }
        const completion = current.result.completion, from = current.capture.from + completion.from, to = current.capture.from + (mode === "replace" ? completion.replaceTo : completion.to), head = from + completion.insert.length;
        const before = workspace.document(documentId), oldDiagnostics = diagnostics;
        const result = workspace.edit({ documentId, expectedRevision: current.result.revision, origin: "human", edits: [{ from, to, insert: completion.insert }], view: editor.view,
            selection: { anchor: head, head }, history: { kind: "replace" } });
        if (!result.applied) { clearResults(`Completion rejected: ${result.reason}.`); return false; }
        counters.applied++; offer = undefined; const after = workspace.document(documentId);
        diagnostics = after.revision === before.revision ? oldDiagnostics : Object.freeze(oldDiagnostics.flatMap(item => {
            const range = after.change?.mapping.mapRange(anchoredRange(before.buffer.length, item.from, item.to, { onDelete: "invalidate" }));
            return range ? [Object.freeze({ ...item, from: range.from, to: range.to })] : [];
        }));
        diagnosticRevision = after.revision; render("Completion applied."); editor.viewport.revealOffset(head); editor.focus(); return true;
    }
    const cancel = () => { if (pending) counters.cancelled++; release(); clearResults("Request cancelled."); };
    const on = (id: string, action: () => void) => owner.getElementById(id)!.addEventListener("click", action, { signal: listeners.signal });
    on("provider-request", request); on("completion-insert", () => apply("insert")); on("completion-replace", () => apply("replace"));
    on("provider-cancel", cancel); on("provider-disconnect", disconnect); on("provider-reconnect", connect);
    list.addEventListener("click", event => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-from]");
        if (!button || !valid() || workspace.document(documentId).revision !== Number(button.dataset.revision)) return;
        const from = Number(button.dataset.from), to = Number(button.dataset.to);
        editor.view.setSelection(diagnosticRevision, { anchor: from, head: to }); editor.viewport.revealOffset(from); editor.focus();
    }, { signal: listeners.signal });
    const subscriptions = [workspace.observeDocument(documentId).subscribe(() => clearResults("Results expired after an edit.")),
        editor.view.subscribe(() => { if (offer && !sameSelection(offer.capture.selection)) { offer = undefined; render("Completion expired after selection changed."); } }),
        workspace.tabState.subscribe(() => { if (!valid()) { release(); clearResults("Captured view is unavailable."); } })];
    connect();
    return { request, apply, cancel, connect, disconnect,
        setDelay: (value: number) => { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid provider delay."); delay = value; },
        faultNext: (value: "malformed" | "failure") => { fault = value; },
        snapshot: () => ({ ...counters, connected: worker !== undefined, pending: pending !== undefined, offer: offer !== undefined, diagnostics: diagnostics.length, diagnosticRevision }),
        destroy: () => { if (disposed) return; disposed = true; disconnect(); subscriptions.forEach(unsubscribe => unsubscribe()); listeners.abort(); } };
}
