import { Workspace } from "sttropez";
import type { DocumentId, DocumentSnapshot, TextEdit } from "sttropez";
import { createLspEditor, mountEditingCandidate, openWebSocketTransport } from "sttropez/browser";
import { LspWorkspace, createLspActionClient, createLspColorClient, createLspHoverClient, createLspLinkClient, createLspNavigationClient, createLspRenameClient, createLspSignatureClient } from "sttropez/protocol";
import type { LspWorkspaceEdit } from "sttropez/protocol";

const workspace = new Workspace();
const source = workspace.createTextResource({ scope: "consumer", resource: "source", variant: "working" }, "Source", { value: 'const saMORE = 1; // TODO\r\ncatalogue;\r\nlookup("a", );\r\nimport "sample-utils";\r\nconst color = "#abc";' });
const companion = workspace.createTextResource({ scope: "consumer", resource: "companion", variant: "working" }, "Companion", { value: "const catalogue = 1;\r\ncatalogue;\r\n" });
const tab = workspace.open({ kind: "text", documentId: source.documentId }, "source");
const editor = mountEditingCandidate(document.getElementById("editor")!, workspace, tab, { ariaLabel: "Public LSP source" });
const endpoint = new URL("/lsp-fixture", location.href); endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const provider = new LspWorkspace(workspace, {
    documentInfo: snapshot => ({ uri: `consumer+opaque:project/${encodeURIComponent(snapshot.resourceId)}`, languageId: "generic" }),
    connect: context => { const abort = new AbortController(), stop = context.onCancel(() => abort.abort());
        return openWebSocketTransport(endpoint.href, { signal: abort.signal }).finally(stop); },
    schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    features: ["textDocument/completion", "textDocument/hover", "textDocument/definition", "textDocument/references", "textDocument/rename", "textDocument/codeAction", "workspace/executeCommand", "textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor", "textDocument/colorPresentation"],
    diagnostics: true, workspaceEdits: true, applyEdit: true,
});
const errors: string[] = [];
const controller = createLspEditor(workspace, tab, editor, { provider, autoConnect: false, onError: error => errors.push(String(error)) });
const hover = createLspHoverClient(provider), navigation = createLspNavigationClient(provider), rename = createLspRenameClient(provider), actions = createLspActionClient(provider);
const signature = createLspSignatureClient(provider), links = createLspLinkClient(provider), colors = createLspColorClient(provider);
const project = () => [workspace.document(source.documentId), workspace.document(companion.documentId)];
const text = () => { const buffer = workspace.document(source.documentId).buffer; return buffer.slice(0, buffer.length); };
const position = () => text().indexOf("catalogue") + 2;
const result = document.getElementById("result")!, status = document.getElementById("status")!, choices = document.getElementById("choices")!;
let plan: LspWorkspaceEdit | undefined, disposed = false;
let colorPlan: Readonly<{ document: DocumentSnapshot; edits: readonly TextEdit[]; isCurrent: () => boolean }> | undefined;
const notes: { hover?: string; navigation?: string; renameEdits?: number; actions?: number; resolved?: boolean; signature?: string; linkUri?: string; colorPresentations?: number; colorApplied?: boolean } = {};
const command = (label: string, invoke: () => void | Promise<unknown>) => { const button = document.createElement("button"); button.textContent = label;
    button.onclick = () => { void Promise.resolve().then(invoke).catch(error => { result.textContent = String(error); }); }; document.getElementById("controls")!.append(button); };
const stop = controller.state.subscribe(() => {
    const state = controller.state.getSnapshot(); status.textContent = state.message;
    if (![state, state.diagnostics, state.choices, state.unversionedDiagnostics].every(Object.isFrozen)) throw new Error("Mutable public editor snapshot");
    choices.replaceChildren(...state.choices.map((label, index) => { const item = document.createElement("li"), button = document.createElement("button");
        button.textContent = label; button.onclick = () => controller.chooseCompletion(index, state.completionId); item.append(button); return item; }));
});
command("Connect", controller.connect); command("Request completion", controller.request); command("Apply completion", () => { controller.apply("replace"); });
command("Hover", async () => { const value = await hover.run(workspace.document(source.documentId), position()).result;
    if (value?.isCurrent()) { notes.hover = value.text; result.textContent = value.text; } });
command("Definition", async () => { const value = await navigation.run(project(), source.documentId, position(), "definition");
    if (value.isCurrent()) { notes.navigation = value.locations[0]?.target.document.documentId; result.textContent = `Definition targets: ${value.locations.length}`; } });
command("Rename preview", async () => { plan = await rename.run(project(), source.documentId, position(), "inventory"); notes.renameEdits = plan.documents.reduce((sum, document) => sum + document.edits.length, 0); result.textContent = `Rename edits: ${notes.renameEdits}`; });
command("Apply rename", () => {
    if (!plan?.isCurrent()) throw new Error("Rename preview expired");
    // Explicit host edit policy: every target must still permit host and human edits.
    for (const change of plan.documents) { const metadata = workspace.resourceForDocument(change.target.document.documentId as DocumentId).metadata.getSnapshot();
        if (!metadata.capabilities.edit.includes("host") || !metadata.capabilities.edit.includes("human") || metadata.editLock !== null) throw new Error("Target is unavailable"); }
    const applied = workspace.editDocuments(plan.documents.map(change => ({ documentId: change.target.document.documentId as DocumentId,
        expectedRevision: change.target.document.revision, edits: change.edits, origin: "host" as const, history: { kind: "replace" as const },
        ...(change.target.document.documentId === source.documentId ? { view: editor.view } : {}) })));
    if (!applied.applied) throw new Error(applied.reason); result.textContent = "Rename applied";
});
command("Code actions", async () => { const at = text().indexOf("TODO"), value = await actions.run(project(), source.documentId, at, at + 4);
    if (!value.isCurrent()) throw new Error("Action preview expired"); notes.actions = value.actions.length;
    const lazy = value.actions.find(action => action.resolve); if (lazy) { const resolved = await value.resolve(lazy); notes.resolved = resolved.edit !== null; }
    result.textContent = `Action choices: ${notes.actions}`; });
command("Signature", async () => { const value = await signature.run(workspace.document(source.documentId), text().indexOf("lookup(") + 12).result;
    if (!value?.isCurrent()) throw new Error("Signature expired"); const active = value.signatures[value.activeSignature]!, parameter = active.parameters[active.activeParameter ?? 0];
    notes.signature = parameter ? active.label.slice(parameter.from, parameter.to) : active.label; result.textContent = notes.signature; });
command("Links", async () => { const value = await links.run(workspace.document(source.documentId), session => session.request("fixture/linksConfig", { delay: 0, aliases: [{ module: "sample-utils", uri: `consumer+opaque:project/${encodeURIComponent(workspace.document(companion.documentId).resourceId)}` }] }).result);
    const link = await value.resolve(value.items[0]!); if (!value.isCurrent()) throw new Error("Link expired"); notes.linkUri = link.target ?? "unresolved"; result.textContent = notes.linkUri; });
command("Colors", async () => { const document = workspace.document(source.documentId), value = await colors.run(document), choices = await value.presentations(value.items[0]!, { red: 1 / 255, green: 2 / 255, blue: 3 / 255, alpha: .5 });
    if (!value.isCurrent() || !choices[0]) throw new Error("Color presentation unavailable"); notes.colorPresentations = choices.length; colorPlan = { document, edits: choices[0].edits, isCurrent: value.isCurrent }; result.textContent = `Color choices: ${choices.length}`; });
command("Apply color", () => { if (!colorPlan?.isCurrent()) throw new Error("Color preview expired"); const metadata = workspace.resourceForDocument(source.documentId).metadata.getSnapshot();
    if (!metadata.capabilities.edit.includes("host") || !metadata.capabilities.edit.includes("human") || metadata.editLock !== null) throw new Error("Color target unavailable");
    const applied = workspace.edit({ documentId: source.documentId, expectedRevision: colorPlan.document.revision, edits: colorPlan.edits, origin: "host", view: editor.view, history: { kind: "refactor" } });
    if (!applied.applied) throw new Error(applied.reason); notes.colorApplied = true; result.textContent = "Color applied"; });
const dispose = () => { if (disposed) return; disposed = true; stop(); controller.destroy(); hover.dispose(); navigation.dispose(); rename.dispose(); actions.dispose(); signature.dispose(); links.dispose(); colors.dispose(); provider.dispose(); editor.destroy(); };
const bridge = { text, select: (at: number) => editor.view.setSelection(workspace.document(source.documentId).revision, { anchor: at, head: at }),
    state: () => ({ provider: provider.snapshot(), editor: controller.snapshot(), completion: controller.state.getSnapshot(), history: workspace.observeHistory(source.documentId).getSnapshot(), diagnostics: workspace.diagnostics(), notes, companion: companion.documentId, metrics: editor.snapshot(), errors }),
    custom: controller.customRequest, dispose };
Object.assign(window, { publicLsp: bridge });
declare global { interface Window { publicLsp: typeof bridge } }
