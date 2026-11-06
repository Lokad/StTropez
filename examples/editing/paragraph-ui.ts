import { createBidiIndexController } from "../../src/index.ts";
import type { TabId, Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";

/** Development host for the paragraph index. Exact global glyph layout remains a separate stage. */
export function mountParagraphUI(workspace: Workspace, tabId: TabId, editor: EditingCandidate) {
    const controller = createBidiIndexController(workspace, tabId), owner = editor.element.ownerDocument, win = owner.defaultView!, listeners = new AbortController();
    const startButton = owner.getElementById("paragraph-start") as HTMLButtonElement, cancelButton = owner.getElementById("paragraph-cancel") as HTMLButtonElement, output = owner.getElementById("paragraph-status")!;
    let timer: number | undefined, disposed = false, maxStepMs = 0, advances = 0, turns = 0;
    const clear = () => { if (timer !== undefined) win.clearTimeout(timer); timer = undefined; };
    const render = () => {
        const state = controller.getSnapshot(); if (state.status !== "running") clear();
        startButton.disabled = state.status === "expired" || state.status === "disposed"; cancelButton.disabled = state.status !== "running";
        output.textContent = state.status === "ready" ? `Indexed ${state.index!.length.toLocaleString()} units · Revision ${state.revision}`
            : state.status === "running" ? `Analyzing paragraph · ${(state.progress?.scannedUnits ?? 0).toLocaleString()} units scanned`
            : state.status === "stale" ? "Source changed; request a fresh analysis." : state.status === "idle" ? "Paragraph analysis is idle." : `Paragraph analysis ${state.status}.`;
    };
    const unsubscribe = controller.subscribe(render); render();
    function start(from: number, to: number, expectedRevision: number): boolean {
        if (disposed || controller.getSnapshot().status === "expired") return false;
        const generation = controller.request({ expectedRevision, from, to }); if (generation === null) return false;
        clear(); maxStepMs = 0; advances = 0; turns = 0;
        const step = () => {
            timer = undefined; const current = controller.getSnapshot(); if (disposed || current.generation !== generation || current.status !== "running") return;
            const began = win.performance.now(); let state = current, count = 0;
            do { state = controller.advance(4096); count++; advances++; } while (state.status === "running" && count < 8 && win.performance.now() - began < 4);
            turns++; maxStepMs = Math.max(maxStepMs, win.performance.now() - began);
            if (state.status === "running" && state.generation === generation) timer = win.setTimeout(step, 0);
        }; timer = win.setTimeout(step, 0); return true;
    }
    const currentLine = () => {
        if (disposed || controller.getSnapshot().status === "expired") return false;
        const head = editor.captureView().head, document = workspace.document(editor.view.documentId), line = document.buffer.lineAt(head);
        return start(document.buffer.offsetAt(line), line + 1 < document.buffer.lineCount ? document.buffer.offsetAt(line + 1) : document.buffer.length, document.revision);
    };
    const cancel = () => { clear(); controller.cancel(); };
    startButton.addEventListener("click", currentLine, { signal: listeners.signal }); cancelButton.addEventListener("click", cancel, { signal: listeners.signal });
    return Object.freeze({ start, currentLine, cancel,
        levelAt: (offset: number) => controller.getSnapshot().index?.levelAt(offset),
        offsetAt: (index: number) => controller.getSnapshot().index?.offsetAt(index),
        snapshot: () => { const state = controller.getSnapshot(); return { status: state.status, revision: state.revision, generation: state.generation, range: state.range,
            progress: state.progress, paragraphCount: state.index?.paragraphCount ?? 0, visualLength: state.index?.visualLength ?? 0, maxStepMs, advances, turns, pending: timer !== undefined }; },
        destroy: () => { if (disposed) return; disposed = true; clear(); listeners.abort(); unsubscribe(); controller.dispose(); render(); }
    });
}
