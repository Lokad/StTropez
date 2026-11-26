import { discoverIndentationFolds, TextBuffer, Workspace, type SaveReview } from "sttropez";
import type { TextComparison } from "sttropez/browser";
import {
    BrowserLspWorkspace, mountFindBar, createFoldingController,
    mountTextComparison, mountTextEditor, openWebSocketTransport,
} from "sttropez/browser";
import { bindLanguage } from "./language.js";
import { restoreReferenceView, type SavedReferenceView } from "../shared/reference-view.js";

const name = "quote.ts";
const initial = `export const accent = "#5fae99";

export function quote(price: number, quantity: number) {
    // TODO: round the final amount.
    const subtotal = price * quantity;
    return subtotal;
}

export const total = quote(24, 3);
`;
const key = "sttropez.reference.quote";
const pane = document.querySelector<HTMLElement>("#pane")!;
const workingTools = document.querySelector<HTMLFieldSetElement>("#working-tools")!;
const find = mountFindBar(document.querySelector<HTMLElement>("#search")!, {
    createWorker: () => new Worker(new URL("./regex-worker.js", import.meta.url), { type: "module" }),
});
document.querySelector("#find")!.addEventListener("click", () => find.open());
const saved = document.querySelector<HTMLOutputElement>("#saved")!;
const saveReviewed = document.querySelector<HTMLButtonElement>("#save-reviewed")!;
let competingText: string | undefined;
const readSaved = () => sessionStorage.getItem(key) ?? initial;
let opened = initial;
try {
    opened = readSaved();
} catch {
    saved.value = "Tab storage unavailable";
}

const workspace = new Workspace();
const file = workspace.createTextResource({ scope: "quote", resource: name, variant: "working" }, name,
    { value: opened, serverVersion: opened }, undefined, { language: { uri: "file:///reference/quote.ts", languageId: "typescript" } });
const view = workspace.createDocumentView(file.documentId);
const settings = { minimap: true, bracketMatching: true, language: { tabSize: 4, lineComment: "//" } };
let baseline = { buffer: workspace.document(file.documentId).buffer, version: "opened" };
const provider = new BrowserLspWorkspace(workspace, {
    workspaceEdits: true,
    connect(signal) {
        const url = new URL("/lsp-fixture", location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        return openWebSocketTransport(url.href, { signal });
    },
});
const project = provider.createScope();
let languageEnabled = false;
let reviewLayout = { scrollLinked: false, rowsAligned: false };
let savedReference: SavedReferenceView | undefined;

function mount(review: boolean) {
    let comparison: TextComparison | undefined;
    if (review) {
        comparison = mountTextComparison(pane, workspace, file.documentId, baseline, { view, settings, ...reviewLayout });
        restoreReferenceView(comparison.panes.reference, baseline, savedReference);
        savedReference = undefined;
    }
    const editor = comparison?.panes.working
        ?? mountTextEditor(pane, workspace, file.documentId, { ariaLabel: name, view, settings });
    (comparison ?? editor).commands.register({ id: "source.save", label: "Save for this tab", run() { save(); } },
        { keys: ["Mod+s"], repeat: false });
    function showReviewSave() {
        saveReviewed.hidden = !comparison || competingText === undefined;
        saveReviewed.disabled = comparison?.controller.getSnapshot().status !== "ready";
    }
    const stopReview = comparison?.controller.subscribe(showReviewSave);
    showReviewSave();
    const folds = createFoldingController(editor, doc => discoverIndentationFolds(doc.buffer));
    const referenceFolds = comparison && createFoldingController(comparison.panes.reference,
        doc => discoverIndentationFolds(doc.buffer));
    find.attach(editor);
    if (comparison) find.attach(comparison.panes.reference);
    let stopLanguage: (() => void) | undefined;
    function enableLanguage() {
        stopLanguage ??= bindLanguage(editor, provider);
    }
    if (languageEnabled) enableLanguage();
    return { editor, comparison, enableLanguage, dispose() {
        stopReview?.();
        stopLanguage?.();
        referenceFolds?.dispose();
        folds.dispose();
        if (comparison) comparison.dispose();
        else editor.dispose();
    } };
}

let current = mount(false);
pane.addEventListener("focusin", () => {
    const review = current.comparison;
    workingTools.disabled = !!review && review.activePane() !== current.editor;
});
const connect = document.querySelector<HTMLButtonElement>("#connect")!;
const connection = document.querySelector<HTMLOutputElement>("#connection")!;
const serverCommand = document.querySelector<HTMLButtonElement>("#command")!;
function renderConnection() {
    const { phase, error, commandAvailable, commandRequiresReconnect } = provider.getSnapshot();
    const ready = phase === "ready";
    document.querySelector<HTMLElement>("#tools")!.hidden = !ready;
    serverCommand.disabled = !commandAvailable;
    connect.disabled = !(phase === "disconnected" || (ready && commandRequiresReconnect));
    connect.textContent = !ready ? "Connect language server"
        : commandRequiresReconnect ? "Reconnect language server" : "Language server connected";
    connection.value = error ?? (commandRequiresReconnect ? "Waiting for the cancelled command’s reply. Reconnect to run another command now."
        : ready && !commandAvailable ? "Server command running…"
        : phase === "connecting" || phase === "initializing" ? "Connecting…" : "");
}
const stopConnection = provider.subscribe(renderConnection);
connect.onclick = () => {
    focusActivePane();
    project.attachDocument(file.documentId);
    languageEnabled = true;
    current.enableLanguage();
    const attempt = provider.getSnapshot().commandRequiresReconnect ? provider.reconnect() : provider.connect();
    void attempt.catch(error => { connection.value = String(error); });
};
const pendingNotice = "An edit is pending. Try again when it finishes.";
function showSaveState() {
    saved.value = competingText !== undefined ? "The saved copy changed. Review it in Changes."
        : file.metadata.getSnapshot().dirty ? "Unsaved changes" : "No unsaved changes";
}
function editPending() {
    const { input } = current.editor.activity();
    return input !== "idle" || find.getSnapshot()?.status === "replacing";
}
function readyForHostAction() {
    if (editPending()) {
        saved.value = pendingNotice;
        return false;
    }
    if (saved.value === pendingNotice) showSaveState();
    return true;
}
function focusActivePane() {
    (current.comparison?.activePane() ?? current.editor).focus();
}
function switchView(review: boolean) {
    if (Boolean(current.comparison) !== review) {
        if (!readyForHostAction()) return;
        const position = current.editor.captureView();
        const { comparison } = current;
        if (comparison) {
            const state = comparison.getSnapshot();
            reviewLayout = { scrollLinked: state.scrollLinked, rowsAligned: state.alignment.enabled };
            const shown = state.comparison.baseline;
            if (shown) savedReference = { baseline: shown, state: comparison.panes.reference.captureView() };
        }
        current.dispose();
        current = mount(review);
        current.editor.restoreView(position);
    }
    document.querySelector("#source")!.setAttribute("aria-pressed", String(!review));
    document.querySelector("#changes")!.setAttribute("aria-pressed", String(review));
    focusActivePane();
}
function refreshBaseline() {
    const refresh = current.comparison?.controller.beginRefresh();
    if (refresh) {
        try { refresh.complete(baseline); } finally { refresh.finish(); }
    }
}
const stopDirty = workspace.onDocumentChange(file.documentId, showSaveState);
function save(review?: SaveReview): boolean {
    if (!readyForHostAction()) return false;
    const ticket = workspace.captureSave(file, review);
    const buffer = workspace.document(file.documentId).buffer;
    let conflict: string | undefined;
    try {
        const submission = ticket.start();
        const stored = readSaved();
        if (stored !== submission.expectedServerVersion && stored !== submission.value) {
            ticket.conflict();
            conflict = stored;
        } else {
            sessionStorage.setItem(key, submission.value);
            ticket.accept({ serverVersion: submission.value });
        }
    } catch (error) {
        ticket.fail();
        saved.value = error instanceof Error ? error.message : "Save failed";
        return false;
    } finally {
        ticket.finish();
    }
    if (conflict !== undefined) {
        if (conflict !== competingText) {
            competingText = conflict;
            baseline = { buffer: TextBuffer.from(conflict), version: "saved in this tab" };
            refreshBaseline();
        }
        if (!current.comparison) switchView(true);
        showSaveState();
    } else {
        competingText = undefined;
        saveReviewed.hidden = true;
        if (!baseline.buffer.equals(buffer)) {
            baseline = { buffer, version: String(ticket.revision) };
            refreshBaseline();
        }
        saved.value = "Saved";
    }
    if (review) current.editor.focus();
    return conflict === undefined;
}
document.querySelector("#source")!.addEventListener("click", () => switchView(false));
document.querySelector("#changes")!.addEventListener("click", () => switchView(true));
document.querySelector("#save")!.addEventListener("click", () => {
    if (save()) focusActivePane();
});
saveReviewed.addEventListener("click", () => {
    const state = current.comparison?.controller.getSnapshot();
    if (competingText !== undefined && state?.status === "ready" && state.working && state.baseline?.buffer === baseline.buffer) {
        save({ target: workspace.captureResource(file.id), expectedRevision: state.working.revision,
            expectedServerVersion: competingText });
    }
});
function beforeUnload(event: BeforeUnloadEvent) {
    if (file.metadata.getSnapshot().dirty || editPending()) event.preventDefault();
}
window.addEventListener("beforeunload", beforeUnload);
window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    window.removeEventListener("beforeunload", beforeUnload);
    stopConnection();
    stopDirty();
    current.dispose();
    find.dispose();
    provider.dispose();
    view.dispose();
    workspace.releaseResourceWhenUnowned(file.id, true);
});
