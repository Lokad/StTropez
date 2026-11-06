import { Workspace, WorkspaceCommands } from "../../src/index.ts";
import type { SaveResponse, SaveSubmission } from "../../src/index.ts";
import { mountTextEditor } from "../../src/browser/index.ts";
import "./style.css";
import { corpus, corpusIds } from "../../tests/fixtures/workloads.ts";
import type { CorpusId } from "../../tests/fixtures/workloads.ts";

function element(id: string): HTMLElement {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing playground element: ${id}`);
    return found;
}
const workspace = new Workspace();
const commandErrors: string[] = [];
const commands = new WorkspaceCommands(workspace, () => commandErrors.push("Synthetic command failure"));
const documentId = workspace.createDocument({ scope: "demo", resource: "transform", variant: "working" },
    "Transform source", "// Synthetic sample\nconst rows = [12, 18, 24];\nconst total = rows.reduce((sum, value) => sum + value, 0);\n");
const sourceTab = workspace.open({ kind: "text", documentId }, "left");
const source = workspace.resourceForDocument(documentId);
const secondaryTab = workspace.open({ kind: "text", documentId }, "secondary");
type Connection = Readonly<{ path: string; format: "csv" }>;
const connection = workspace.createResource<Connection>({ scope: "demo", resource: "connection", variant: "working" },
    "Connection", { value: { path: "incoming/sample.csv", format: "csv" } });
const panelTab = workspace.open({ kind: "panel", resourceId: connection.id, panelType: "connection" }, "right");
const editor = mountTextEditor(element("left"), workspace, sourceTab);
const conflicts: { reason: string; attemptedLength: number }[] = [];
editor.element.addEventListener("sttropez-conflict", event => {
    const detail = (event as CustomEvent<{ reason: string; attemptedText: string }>).detail;
    conflicts.push({ reason: detail.reason, attemptedLength: detail.attemptedText.length });
});
const panel = document.createElement("div");
panel.className = "connection";
const heading = document.createElement("h2"); heading.textContent = "Data connection";
const label = document.createElement("label"); label.textContent = "Source path";
const sourcePath = document.createElement("input"); sourcePath.value = "incoming/sample.csv";
label.append(sourcePath);
const description = document.createElement("p");
description.textContent = "A host-owned form beside the text surface. Both participate in the same workspace revision model. No network connection is made.";
panel.append(heading, label, description);
const secondaryHost = document.createElement("div"); secondaryHost.style.height = "180px";
panel.append(secondaryHost);
const secondary = mountTextEditor(secondaryHost, workspace, secondaryTab, { ariaLabel: "Secondary source view" });
element("right").append(panel);
sourcePath.addEventListener("input", () => {
    const snapshot = connection.getSnapshot();
    if (snapshot.state !== "ready") return;
    workspace.updateResource(connection, { expectedRevision: snapshot.revision, origin: "human",
        value: { ...snapshot.value, path: sourcePath.value } });
});
const status = element("status");
function renderMetadata() {
    const snapshot = workspace.getSnapshot();
    status.textContent = `Workspace revision ${snapshot.revision} · Source revision ${workspace.document(documentId).revision}`;
    document.title = "Transform · Working copy · StTropez";
}
workspace.subscribe(renderMetadata);
connection.subscribe(() => {
    const state = connection.getSnapshot();
    if (state.state === "ready" && sourcePath.value !== state.value.path) sourcePath.value = state.value.path;
});
renderMetadata();
const pendingSaves: { submission: SaveSubmission<string>; finish: (response: SaveResponse<string>) => void }[] = [];
let serverVersion: string | null = null, savedWrites = 0, lastSavedRevision: number | null = null;
let lastRun: Readonly<{ sourceRevision: number; configurationRevision: number; sourceLength: number; pathLength: number }> | null = null;
const save = document.createElement("button"); save.textContent = "Save source";
save.addEventListener("click", () => {
    void commands.save(source, { save: submission => new Promise(resolve => pendingSaves.push({ submission, finish: resolve })) })
        .then(outcome => { if (outcome.kind === "saved") lastSavedRevision = outcome.receipt.submission.revision; });
});
const finish = document.createElement("button"); finish.textContent = "Finish deferred save";
finish.addEventListener("click", () => {
    const pending = pendingSaves.shift();
    if (!pending) return;
    if (pending.submission.expectedServerVersion !== serverVersion) {
        pending.finish({ kind: "conflict", serverVersion: serverVersion ?? "initial" }); return;
    }
    serverVersion = `v${++savedWrites}`;
    pending.finish({ kind: "saved", serverVersion, canonical: pending.submission.value.trimEnd() });
});
const run = document.createElement("button"); run.textContent = "Run preview";
run.addEventListener("click", () => {
    void commands.run(source, connection, { mode: "preview" }, { run: async submission => {
        lastRun = Object.freeze({ sourceRevision: submission.source.revision, configurationRevision: submission.configuration.revision,
            sourceLength: submission.source.value.length, pathLength: submission.configuration.value.path.length });
    } });
});
element("tabs").append(save, finish, run);
window.addEventListener("pagehide", () => { editor.destroy(); secondary.destroy(); });
for (const [title, focus] of [["Transform · Working copy", () => editor.element.focus()], ["Connection · Configuration", () => sourcePath.focus()]] as const) {
    const button = document.createElement("button"); button.textContent = title;
    button.addEventListener("click", focus); element("tabs").append(button);
}
element("move").addEventListener("click", () => {
    const tab = workspace.getSnapshot().tabs.find(t => t.id === sourceTab);
    if (!tab) return;
    const destination = tab.paneId === "left" ? "right" : "left";
    const view = editor.captureView();
    const opposite = destination === "left" ? "right" : "left";
    element(destination).append(editor.element);
    element(opposite).append(panel);
    workspace.move(sourceTab, destination);
    workspace.move(panelTab, opposite);
    editor.element.focus();
    editor.restoreView(view);
});

// Playground-only agent instrumentation; never exported by the library.
const frameSamples: number[] = [];
const handlerSamples: number[] = [];
let sampleCount = 0;
let inputStart = 0;
editor.element.addEventListener("input", () => {
    const start = performance.now();
    inputStart = start;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        frameSamples.push(performance.now() - start);
        sampleCount++;
        if (frameSamples.length > 200) frameSamples.shift();
    }));
}, { capture: true });
editor.element.addEventListener("input", () => {
    handlerSamples.push(performance.now() - inputStart);
    if (handlerSamples.length > 200) handlerSamples.shift();
});
const instrumentation = {
    ready: true,
    readyAt: performance.now(),
    setReadOnly: (readOnly: boolean) => workspace.setCapabilities(source.id, { edit: readOnly ? [] : ["human", "agent", "host"], save: true, run: true }),
    snapshot: () => ({ revision: workspace.getSnapshot().revision,
        resources: workspace.getSnapshot().resources.map(resource => ({ id: resource.id, kind: resource.kind,
            state: resource.state, dirty: resource.dirty })),
        connection: { id: connection.id, revision: connection.getSnapshot().revision },
        commands: { pendingSaves: pendingSaves.map(save => ({ revision: save.submission.revision, length: save.submission.value.length })),
            savedWrites, lastSavedRevision, serverVersion, dirty: source.metadata.getSnapshot().dirty, lastRun, errors: [...commandErrors] },
        conflicts: [...conflicts],
        documents: workspace.getSnapshot().documents.map(d => ({ id: d.id, revision: d.revision, length: d.buffer.length })),
        tabs: workspace.getSnapshot().tabs }),
    frameSamples: () => [...frameSamples],
    handlerSamples: () => [...handlerSamples],
    sampleCount: () => sampleCount,
    readText: () => workspace.document(documentId).text,
    loadCorpus: (id: CorpusId) => {
        if (!corpusIds.includes(id)) throw new RangeError("Unknown corpus.");
        const current = workspace.document(documentId);
        workspace.edit({ documentId, expectedRevision: current.revision, origin: "host",
            edits: [{ from: 0, to: current.text.length, insert: corpus(id) }] });
    },
    loadSynthetic: (lines: number) => {
        if (!Number.isSafeInteger(lines) || lines < 1 || lines > 100_000) throw new RangeError("Invalid fixture size.");
        const current = workspace.document(documentId);
        workspace.edit({ documentId, expectedRevision: current.revision, origin: "host",
            edits: [{ from: 0, to: current.text.length, insert: "const sample = 123456789;\n".repeat(lines) }] });
    },
};
declare global { interface Window { sttropez: typeof instrumentation } }
window.sttropez = instrumentation;
