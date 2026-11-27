import { discoverIndentationFolds, TextBuffer, Workspace, type SaveReview, type SaveTicket } from "sttropez";
import type { ReferenceViewState, TextComparison } from "sttropez/browser";
import {
    BrowserLspWorkspace,
    mountFindBar,
    createFoldingController,
    mountTextComparison,
    mountTextEditor,
    openWebSocketTransport
} from "sttropez/browser";
import { bindLanguage } from "./language.js";
import { referenceStorage, type SavedCopy, type StorageMode } from "./storage.js";

const name = "quote.ts";
const initial = `export const accent = "#5fae99";

export function quote(price: number, quantity: number) {
    // TODO: round the final amount.
    const subtotal = price * quantity;
    return subtotal;
}

export const total = quote(24, 3);
`;
const storage = referenceStorage(initial);
const pane = document.querySelector<HTMLElement>("#pane")!;
const workingTools = document.querySelector<HTMLFieldSetElement>("#working-tools")!;
const find = mountFindBar(document.querySelector<HTMLElement>("#search")!, {
    createWorker: () => new Worker(new URL("./regex-worker.js", import.meta.url), { type: "module" })
});
document.querySelector("#find")!.addEventListener("click", () => find.open());
const saved = document.querySelector<HTMLOutputElement>("#saved")!;
const saveReviewed = document.querySelector<HTMLButtonElement>("#save-reviewed")!;
const adopt = document.querySelector<HTMLButtonElement>("#adopt")!;
const compareVersions = document.querySelector<HTMLInputElement>("#compare-versions")!;
const delay = document.querySelector<HTMLInputElement>("#delay")!;
const canonical = document.querySelector<HTMLInputElement>("#canonical")!;
const fault = document.querySelector<HTMLSelectElement>("#fault")!;
let competing: SavedCopy | undefined;
let pending = 0;
let closed = false;
let previous = Promise.resolve();
let opened: SavedCopy = { text: initial, version: "initial" };
try {
    opened = storage.read();
} catch {
    saved.value = "Saved storage is unavailable";
}

const workspace = new Workspace();
const file = workspace.createTextResource({ scope: "quote", resource: name, variant: "working" }, name, {
    value: opened.text,
    serverVersion: opened.version,
    language: { uri: "file:///reference/quote.ts", languageId: "typescript" }
});
const view = workspace.createDocumentView(file.id);
const settings = { minimap: true, bracketMatching: true, language: { tabSize: 4, lineComment: "//" } };
let baseline = { buffer: workspace.document(file.id).buffer, version: opened.version };
const provider = new BrowserLspWorkspace(workspace, {
    workspaceEdits: true,
    connect(signal) {
        const url = new URL("/lsp-fixture", location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        return openWebSocketTransport(url.href, { signal });
    }
});
const project = provider.createScope();
let languageEnabled = false;
let reviewLayout = { scrollLinked: false, rowsAligned: false };
let savedReference: ReferenceViewState | undefined;

function mount(review: boolean) {
    let comparison: TextComparison | undefined;
    if (review) {
        comparison = mountTextComparison(pane, workspace, file.id, baseline, { view, settings, ...reviewLayout });
        comparison.restoreReferenceView(savedReference);
        savedReference = undefined;
    }
    const editor =
        comparison?.panes.working ?? mountTextEditor(pane, workspace, file.id, { ariaLabel: name, view, settings });
    (comparison ?? editor).commands.register(
        {
            id: "source.save",
            label: "Save",
            run() {
                save();
            }
        },
        { keys: ["Mod+s"], repeat: false }
    );
    function showReviewSave() {
        saveReviewed.hidden = adopt.hidden = !comparison || !competing;
        saveReviewed.disabled = adopt.disabled = pending > 0 || comparison?.controller.getSnapshot().status !== "ready";
    }
    const stopReview = comparison?.controller.subscribe(showReviewSave);
    showReviewSave();
    const folds = createFoldingController(editor, (doc) => discoverIndentationFolds(doc.buffer));
    const referenceFolds =
        comparison &&
        createFoldingController(comparison.panes.reference, (doc) => discoverIndentationFolds(doc.buffer));
    find.attach(editor);
    if (comparison) find.attach(comparison.panes.reference);
    let stopLanguage: (() => void) | undefined;
    function enableLanguage() {
        stopLanguage ??= bindLanguage(editor, provider);
    }
    if (languageEnabled) enableLanguage();
    return {
        editor,
        comparison,
        enableLanguage,
        showReviewSave,
        dispose() {
            stopReview?.();
            stopLanguage?.();
            referenceFolds?.dispose();
            folds.dispose();
            if (comparison) comparison.dispose();
            else editor.dispose();
        }
    };
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
    connect.textContent = !ready
        ? "Connect language server"
        : commandRequiresReconnect
          ? "Reconnect language server"
          : "Language server connected";
    connection.value =
        error ??
        (commandRequiresReconnect
            ? "Waiting for the cancelled command’s reply. Reconnect to run another command now."
            : ready && !commandAvailable
              ? "Server command running…"
              : phase === "connecting" || phase === "initializing"
                ? "Connecting…"
                : "");
}
const stopConnection = provider.subscribe(renderConnection);
connect.onclick = () => {
    focusActivePane();
    project.attachDocument(file.id);
    languageEnabled = true;
    current.enableLanguage();
    const attempt = provider.getSnapshot().commandRequiresReconnect ? provider.reconnect() : provider.connect();
    void attempt.catch(renderConnection);
};
const pendingNotice = "An edit is pending. Try again when it finishes.";
function showSaveState() {
    saved.value = competing
        ? "The saved copy changed. Review it in Changes."
        : file.metadata.getSnapshot().dirty
          ? "Unsaved changes"
          : "No unsaved changes";
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
            savedReference = comparison.captureReferenceView();
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
    current.comparison?.controller.replaceBaseline(baseline);
}
const stopDirty = workspace.onDocumentChange(file.id, showSaveState);
function presentPeer(copy: SavedCopy) {
    if (competing?.version !== copy.version) {
        competing = copy;
        baseline = { buffer: TextBuffer.from(copy.text), version: copy.version };
        refreshBaseline();
    }
    current.showReviewSave();
    showSaveState();
}
function poll() {
    if (closed || compareVersions.checked) return;
    try {
        const copy = storage.read();
        if (copy.version !== file.metadata.getSnapshot().serverVersion) presentPeer(copy);
    } catch (error) {
        saved.value = error instanceof Error ? error.message : "Cannot read saved copy";
    }
}
function save(review?: SaveReview): boolean {
    if (!readyForHostAction()) return false;
    if (!compareVersions.checked && !review) {
        poll();
        if (competing) {
            switchView(true);
            return false;
        }
    }
    const buffer = workspace.document(file.id).buffer;
    let ticket: SaveTicket;
    try {
        ticket = workspace.captureSave(file, review);
    } catch (error) {
        saved.value = error instanceof Error ? error.message : "Save unavailable";
        return false;
    }
    const mode: StorageMode = {
        compareVersions: compareVersions.checked,
        delay: delay.checked,
        canonical: canonical.checked,
        fault: fault.value === "lose-reply" || fault.value === "fail" ? fault.value : "none"
    };
    fault.value = "none";
    const issuer = current.editor;
    pending++;
    current.showReviewSave();
    saved.value = "Saving…";
    previous = previous.then(async () => {
        try {
            const result = await ticket.run((submission) => {
                if (closed) throw new Error("Host closed");
                if (!mode.compareVersions && competing && competing.version !== review?.expectedServerVersion) {
                    return { kind: "conflict", serverVersion: competing.version };
                }
                return storage.write(submission, mode);
            });
            if (closed) return;
            if (result.kind === "conflict") {
                presentPeer(storage.read());
                if (issuer === current.editor && !current.comparison && !editPending()) switchView(true);
            } else {
                const { savedValue, serverVersion } = result.receipt;
                const savedBuffer = savedValue === ticket.value ? buffer : TextBuffer.from(savedValue);
                competing = undefined;
                if (!baseline.buffer.equals(savedBuffer)) {
                    baseline = { buffer: savedBuffer, version: serverVersion };
                    refreshBaseline();
                }
                saved.value = file.metadata.getSnapshot().dirty ? "Saved. Later edits are unsaved." : "Saved";
            }
        } catch (error) {
            if (!closed) saved.value = error instanceof Error ? error.message : "Save failed";
        } finally {
            pending--;
            if (!closed) current.showReviewSave();
        }
    });
    return true;
}
document.querySelector("#source")!.addEventListener("click", () => switchView(false));
document.querySelector("#changes")!.addEventListener("click", () => switchView(true));
document.querySelector("#save")!.addEventListener("click", () => {
    if (save()) focusActivePane();
});
function reviewed() {
    const state = current.comparison?.controller.getSnapshot();
    if (
        pending ||
        !competing ||
        state?.status !== "ready" ||
        !state.working ||
        state.baseline?.buffer !== baseline.buffer ||
        !readyForHostAction()
    )
        return;
    try {
        const latest = storage.read();
        if (latest.version === competing.version) return { copy: competing, revision: state.working.revision };
        presentPeer(latest);
    } catch (error) {
        saved.value = error instanceof Error ? error.message : "Cannot read saved copy";
    }
    current.editor.focus();
}
saveReviewed.addEventListener("click", () => {
    const review = reviewed();
    if (
        review &&
        save({
            target: workspace.captureResource(file.id),
            expectedRevision: review.revision,
            expectedServerVersion: review.copy.version
        })
    )
        current.editor.focus();
});
adopt.addEventListener("click", () => {
    const review = reviewed();
    if (!review) return;
    const result = workspace.adoptSaved(file.id, {
        text: baseline.buffer,
        serverVersion: review.copy.version,
        expectedRevision: review.revision,
        history: "record"
    });
    if (result.status === "done") {
        competing = undefined;
        saved.value = "Using saved copy";
        current.showReviewSave();
        current.editor.focus();
    }
});
let polling: number | undefined;
function configurePolling() {
    clearInterval(polling);
    if (!compareVersions.checked) {
        poll();
        polling = window.setInterval(poll, 1000);
    }
}
configurePolling();
compareVersions.addEventListener("change", configurePolling);
window.addEventListener("focus", poll);
function beforeUnload(event: BeforeUnloadEvent) {
    if (pending || file.metadata.getSnapshot().dirty || editPending()) event.preventDefault();
}
window.addEventListener("beforeunload", beforeUnload);
window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    closed = true;
    clearInterval(polling);
    window.removeEventListener("focus", poll);
    window.removeEventListener("beforeunload", beforeUnload);
    stopConnection();
    stopDirty();
    current.dispose();
    find.dispose();
    provider.dispose();
    view.dispose();
    workspace.releaseResourceWhenUnowned(file.id, true);
});
