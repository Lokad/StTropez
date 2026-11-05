import type { Workspace, TabId } from "../index.ts";

export type ViewState = Readonly<{ anchor: number; head: number; scrollTop: number; scrollLeft: number }>;
export type MountedEditor = Readonly<{
    element: HTMLTextAreaElement;
    captureView: () => ViewState;
    restoreView: (state: ViewState) => void;
    destroy: () => void;
}>;

/** Native input baseline for exercising workspace contracts; not the final rendering engine. */
export function mountTextEditor(host: HTMLElement, workspace: Workspace, tabId: TabId): MountedEditor {
    const target = workspace.captureTab(tabId);
    const tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text") throw new Error("Expected a text surface.");
    const documentId = tab.surface.documentId;
    const input = host.ownerDocument.createElement("textarea");
    input.className = "st-editor";
    input.setAttribute("aria-label", workspace.document(documentId).title);
    input.spellcheck = false;
    input.wrap = "off";
    input.value = workspace.document(documentId).text;
    host.append(input);
    const listeners = new AbortController();
    let revision = workspace.document(documentId).revision;
    let composing = false;

    const refresh = () => {
        if (!workspace.resolveTab(target)) { input.disabled = true; return; }
        if (composing) return;
        const document = workspace.document(documentId);
        if (input.value !== document.text) {
            const start = input.selectionStart, end = input.selectionEnd;
            input.value = document.text;
            input.setSelectionRange(Math.min(start, input.value.length), Math.min(end, input.value.length));
        }
        revision = document.revision;
    };
    const commit = () => {
        if (composing || !workspace.resolveTab(target)) return;
        const document = workspace.document(documentId);
        const result = workspace.edit({ documentId, expectedRevision: revision, origin: "human",
            edits: [{ from: 0, to: document.text.length, insert: input.value }] });
        if (!result.applied) {
            // The host can preserve the attempted text for explicit conflict review.
            input.dispatchEvent(new CustomEvent("sttropez-conflict", { bubbles: true,
                detail: { documentId, attemptedText: input.value } }));
        }
        refresh();
    };
    input.addEventListener("compositionstart", () => { composing = true; }, { signal: listeners.signal });
    input.addEventListener("compositionend", () => { composing = false; commit(); }, { signal: listeners.signal });
    input.addEventListener("input", commit, { signal: listeners.signal });
    const unsubscribe = workspace.subscribe(refresh);
    return {
        element: input,
        captureView: () => ({ anchor: input.selectionDirection === "backward" ? input.selectionEnd : input.selectionStart,
            head: input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd,
            scrollTop: input.scrollTop, scrollLeft: input.scrollLeft }),
        restoreView: state => {
            input.setSelectionRange(Math.min(state.anchor, state.head), Math.max(state.anchor, state.head),
                state.anchor > state.head ? "backward" : "forward");
            input.scrollTop = state.scrollTop;
            input.scrollLeft = state.scrollLeft;
        },
        destroy: () => { unsubscribe(); listeners.abort(); input.remove(); },
    };
}
