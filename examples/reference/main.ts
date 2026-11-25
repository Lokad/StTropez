import { discoverIndentationFolds, Workspace } from "sttropez";
import type { TextComparison } from "sttropez/browser";
import {
    BrowserLspWorkspace, createFindController, createFoldingController, createRegexFindBackend,
    mountTextComparison, mountTextEditor, openWebSocketTransport,
} from "sttropez/browser";
import { bindLanguage } from "./language.js";

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
const query = document.querySelector<HTMLInputElement>("#query")!;
const regex = document.querySelector<HTMLInputElement>("#regex")!;
const saved = document.querySelector<HTMLOutputElement>("#saved")!;
let opened = initial;
try {
    opened = sessionStorage.getItem(key) ?? initial;
} catch {
    saved.value = "Tab storage unavailable";
}

const workspace = new Workspace();
const file = workspace.createTextResource({ scope: "quote", resource: name, variant: "working" }, name,
    { value: opened }, undefined, { language: { uri: "file:///reference/quote.ts", languageId: "typescript" } });
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
let languageEnabled = false;

function mount(review: boolean) {
    let comparison: TextComparison | undefined;
    if (review) comparison = mountTextComparison(pane, workspace, file.documentId, baseline, { view, settings });
    const editor = comparison?.panes.working
        ?? mountTextEditor(pane, workspace, file.documentId, { ariaLabel: name, view, settings });
    const folds = createFoldingController(editor, doc => discoverIndentationFolds(doc.buffer));
    const referenceFolds = comparison && createFoldingController(comparison.panes.reference,
        doc => discoverIndentationFolds(doc.buffer));
    const find = createFindController(editor, {
        regularExpressionBackend: createRegexFindBackend({
            clock: window,
            createWorker: () => new Worker(new URL("./regex-worker.js", import.meta.url), { type: "module" }),
        }),
    });
    const result = document.querySelector<HTMLOutputElement>("#match-count")!;
    function renderFind() {
        const state = find.getSnapshot();
        result.value = state.query ? state.status === "ready" ? `${state.count} matches` : state.message : "";
    }
    const stopFind = find.subscribe(renderFind);
    find.setFlags({ regularExpression: regex.checked });
    find.setQuery(query.value);
    renderFind();
    let stopLanguage: (() => void) | undefined;
    function enableLanguage() {
        stopLanguage ??= bindLanguage(editor, provider);
    }
    if (languageEnabled) enableLanguage();
    return { editor, comparison, find, enableLanguage, dispose() {
        stopLanguage?.();
        stopFind();
        find.dispose();
        referenceFolds?.dispose();
        folds.dispose();
        if (comparison) comparison.dispose();
        else editor.dispose();
    } };
}

let current = mount(false);
const connect = document.querySelector<HTMLButtonElement>("#connect")!;
const connection = document.querySelector<HTMLOutputElement>("#connection")!;
function renderConnection() {
    const { phase, error } = provider.getSnapshot();
    document.querySelector<HTMLElement>("#tools")!.hidden = phase !== "ready";
    connect.disabled = phase === "connecting" || phase === "initializing" || phase === "ready";
    connect.textContent = phase === "ready" ? "Language server connected" : "Connect language server";
    connection.value = error ?? (connect.disabled && phase !== "ready" ? "Connecting…" : "");
}
const stopConnection = provider.subscribe(renderConnection);
connect.onclick = () => {
    languageEnabled = true;
    current.enableLanguage();
    void provider.connect().catch(error => { connection.value = String(error); });
};
const pendingNotice = "An edit is pending. Try again when it finishes.";
function showSaveState() {
    saved.value = file.metadata.getSnapshot().dirty ? "Unsaved changes" : "No unsaved changes";
}
function readyForHostAction() {
    const { composing, pendingInput, pendingCommand } = current.editor.activity();
    if (composing || pendingInput || pendingCommand) {
        saved.value = pendingNotice;
        return false;
    }
    if (saved.value === pendingNotice) showSaveState();
    return true;
}
function switchView(review: boolean) {
    if (Boolean(current.comparison) !== review) {
        if (!readyForHostAction()) return;
        const position = current.editor.captureView();
        current.dispose();
        current = mount(review);
        current.editor.restoreView(position);
    }
    document.querySelector("#source")!.setAttribute("aria-pressed", String(!review));
    document.querySelector("#changes")!.setAttribute("aria-pressed", String(review));
    current.editor.focus();
}
const stopDirty = workspace.onDocumentChange(file.documentId, showSaveState);
function save() {
    if (!readyForHostAction()) return;
    const ticket = workspace.captureSave(file);
    const buffer = workspace.document(file.documentId).buffer;
    const version = String(ticket.revision);
    try {
        sessionStorage.setItem(key, ticket.start().value);
        ticket.accept({ serverVersion: version });
    } catch (error) {
        ticket.fail();
        saved.value = error instanceof Error ? error.message : "Save failed";
        return;
    } finally {
        ticket.finish();
    }
    baseline = { buffer, version };
    const refresh = current.comparison?.controller.beginRefresh();
    if (refresh) {
        try { refresh.complete(baseline); } finally { refresh.finish(); }
    }
    saved.value = "Saved";
}
document.querySelector("#source")!.addEventListener("click", () => switchView(false));
document.querySelector("#changes")!.addEventListener("click", () => switchView(true));
document.querySelector("#save")!.addEventListener("click", save);
query.addEventListener("input", () => current.find.setQuery(query.value));
regex.addEventListener("change", () => current.find.setFlags({ regularExpression: regex.checked }));
document.querySelector("#back")!.addEventListener("click", () => current.find.next(-1, { whenReady: true }));
document.querySelector("#find")!.addEventListener("submit", event => {
    event.preventDefault();
    current.find.next(1, { whenReady: true });
});
window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    stopConnection();
    stopDirty();
    current.dispose();
    provider.dispose();
    view.dispose();
    workspace.releaseResourceWhenUnowned(file.id, true);
});
