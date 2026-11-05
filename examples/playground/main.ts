import { Workspace } from "../../src/index.ts";
import { mountTextEditor } from "../../src/browser/index.ts";
import "./style.css";

function element(id: string): HTMLElement {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing playground element: ${id}`);
    return found;
}
const workspace = new Workspace();
const documentId = workspace.createDocument({ scope: "demo", resource: "transform", variant: "working" },
    "Transform source", "// Synthetic sample\nconst rows = [12, 18, 24];\nconst total = rows.reduce((sum, value) => sum + value, 0);\n");
const sourceTab = workspace.open({ kind: "text", documentId }, "left");
const connectionId = workspace.createDocument({ scope: "demo", resource: "connection", variant: "working" },
    "Connection", "incoming/sample.csv");
const panelTab = workspace.open({ kind: "panel", documentId: connectionId, panelType: "connection" }, "right");
const editor = mountTextEditor(element("left"), workspace, sourceTab);
const panel = document.createElement("div");
panel.className = "connection";
const heading = document.createElement("h2"); heading.textContent = "Data connection";
const label = document.createElement("label"); label.textContent = "Source path";
const sourcePath = document.createElement("input"); sourcePath.value = workspace.document(connectionId).text;
label.append(sourcePath);
const description = document.createElement("p");
description.textContent = "A host-owned form beside the text surface. Both participate in the same workspace revision model. No network connection is made.";
panel.append(heading, label, description);
element("right").append(panel);
sourcePath.addEventListener("input", () => {
    const snapshot = workspace.document(connectionId);
    workspace.edit({ documentId: connectionId, expectedRevision: snapshot.revision, origin: "human",
        edits: [{ from: 0, to: snapshot.text.length, insert: sourcePath.value }] });
});
const status = element("status");
function renderMetadata() {
    const snapshot = workspace.getSnapshot();
    status.textContent = `Workspace revision ${snapshot.revision} · Source revision ${workspace.document(documentId).revision}`;
    sourcePath.value = workspace.document(connectionId).text;
    document.title = "Transform · Working copy · StTropez";
}
workspace.subscribe(renderMetadata);
renderMetadata();
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
    editor.restoreView(view);
    editor.element.focus();
});

// Playground-only agent instrumentation; never exported by the library.
const frameSamples: number[] = [];
editor.element.addEventListener("input", () => {
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
        frameSamples.push(performance.now() - start);
        if (frameSamples.length > 200) frameSamples.shift();
    }));
}, { capture: true });
const instrumentation = {
    ready: true,
    snapshot: () => ({ revision: workspace.getSnapshot().revision,
        documents: workspace.getSnapshot().documents.map(d => ({ id: d.id, revision: d.revision, length: d.text.length })),
        tabs: workspace.getSnapshot().tabs }),
    frameSamples: () => [...frameSamples],
    loadSynthetic: (lines: number) => {
        if (!Number.isSafeInteger(lines) || lines < 1 || lines > 100_000) throw new RangeError("Invalid fixture size.");
        const current = workspace.document(documentId);
        workspace.edit({ documentId, expectedRevision: current.revision, origin: "host",
            edits: [{ from: 0, to: current.text.length, insert: "const sample = 123456789;\n".repeat(lines) }] });
    },
};
declare global { interface Window { sttropez: typeof instrumentation } }
window.sttropez = instrumentation;
