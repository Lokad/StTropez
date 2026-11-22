import { Workspace } from "sttropez";
import type { DocumentId } from "sttropez";
import { createCodeActionController, createCompletionController, createDiagnosticController, createDocumentColorController, createDocumentLinkController, createHoverController, createNavigationController, createRenameController, createSignatureController, mountAnchoredOverlay, mountTextEditor, openWebSocketTransport } from "sttropez/browser";
import { LspWorkspace } from "sttropez/protocol";

const workspace = new Workspace();
const source = workspace.createTextResource({ scope: "consumer", resource: "source", variant: "working" }, "Source", { value: 'const saMORE = 1; // TODO\r\ncatalogue;\r\nlookup("a", );\r\nimport "sample-utils";\r\nconst color = "#abc";' });
const companion = workspace.createTextResource({ scope: "consumer", resource: "companion", variant: "working" }, "Companion", { value: "const catalogue = 1;\r\ncatalogue;\r\n" });
const editor = mountTextEditor(document.getElementById("editor")!, workspace, source.documentId, { ariaLabel: "Public LSP source" });
const endpoint = new URL("/lsp-fixture", location.href); endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const provider = new LspWorkspace(workspace, {
    initializationOptions: { fixtureModuleUris: [{ module: "sample-utils", uri: `consumer+opaque:project/${encodeURIComponent(companion.id)}` }] },
    documentInfo: snapshot => ({ uri: `consumer+opaque:project/${encodeURIComponent(snapshot.resourceId)}`, languageId: "generic" }),
    connect: context => { const abort = new AbortController(), stop = context.onCancel(() => abort.abort());
        return openWebSocketTransport(endpoint.href, { signal: abort.signal }).finally(stop); },
    schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    features: ["textDocument/completion", "textDocument/hover", "textDocument/definition", "textDocument/references", "textDocument/rename", "textDocument/codeAction", "workspace/executeCommand", "textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor", "textDocument/colorPresentation"],
    diagnostics: true, workspaceEdits: true, applyEdit: true,
});
const errors: string[] = [];
const controller = createCompletionController(editor, provider, { autoConnect: false, onError: error => errors.push(String(error)) });
const diagnostics = createDiagnosticController(editor, provider, { autoConnect: false });
const diagnosticHint = document.createElement("aside"); diagnosticHint.id = "diagnostic-hint"; document.body.append(diagnosticHint);
const hint = mountAnchoredOverlay(editor, diagnosticHint);
const hover = createHoverController(editor, provider, { diagnostics });
const signature = createSignatureController(editor, provider), colors = createDocumentColorController(editor, provider);
const project = () => [workspace.document(source.documentId), workspace.document(companion.documentId)];
const links = createDocumentLinkController(editor, provider, { documents: project });
const rename = createRenameController(editor, provider, { documents: project });
const navigation = createNavigationController(editor, provider, { documents: project });
const actions = createCodeActionController(editor, provider, { documents: project });
const text = () => { const buffer = workspace.document(source.documentId).buffer; return buffer.slice(0, buffer.length); };
const position = () => text().indexOf("catalogue") + 2;
const result = document.getElementById("result")!, status = document.getElementById("status")!, choices = document.getElementById("choices")!;
let disposed = false;
const notes: { hover?: string; navigation?: string; renameEdits?: number; actions?: number; resolved?: boolean; signature?: string; linkUri?: string; colorPresentations?: number; colorApplied?: boolean } = {};
const command = (label: string, invoke: () => void | Promise<unknown>) => { const button = document.createElement("button"); button.textContent = label;
    button.onclick = () => { void Promise.resolve().then(invoke).catch(error => { result.textContent = String(error); }); }; document.getElementById("controls")!.append(button); return button; };
choices.onpointerdown = event => event.preventDefault();
const stop = controller.subscribe(() => {
    const state = controller.getSnapshot(); status.textContent = state.message;
    if (![state, state.choices].every(Object.isFrozen)) throw new Error("Mutable completion snapshot");
    choices.replaceChildren(...state.choices.map((label, index) => { const item = document.createElement("li"), button = document.createElement("button");
        button.textContent = label; button.onclick = () => state.completionAt(index)?.select(); item.append(button); return item; }));
});
command("Connect", controller.connect); command("Request completion", () => { editor.commands.run("completion.request"); });
const applyCompletion = command("Apply completion", () => { editor.commands.run("completion.replace"); });
applyCompletion.onpointerdown = event => event.preventDefault();
command("Hover", () => { hover.request({ revision: workspace.document(source.documentId).revision, offset: text().indexOf("TODO") + 1 }); });
hover.subscribe(() => {
    const state = hover.getSnapshot();
    if (state.status === "ready") { notes.hover = state.text; result.textContent = state.text; }
});
command("Definition", async () => { const value = await navigation.request("definition", position());
    result.textContent = `Definition targets: ${value.count}`;
    const choice = value.locationAt(0); if (!choice) return;
    const open = document.createElement("button"); open.textContent = "Open definition";
    open.onclick = () => {
        const current = choice.open(at => { notes.navigation = at.document.documentId; });
        open.textContent = current ? "Opened definition" : "Expired definition";
    };
    result.append(open); });
command("Edit companion", () => {
    const doc = workspace.document(companion.documentId);
    const changed = workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "host",
        edits: [{ from: doc.buffer.length, to: doc.buffer.length, insert: "\n" }] });
    if (!changed.applied) throw new Error(changed.reason);
});
command("Rename preview", () => {
    const offset = position();
    editor.view.setSelection(workspace.document(source.documentId).revision, { anchor: offset, head: offset });
    rename.request("inventory");
});
const applyRename = command("Apply rename", () => {});
applyRename.disabled = true;
rename.subscribe(() => {
    const state = rename.getSnapshot(), preview = state.preview, page = preview?.readPage();
    notes.renameEdits = preview?.count ?? 0;
    applyRename.disabled = !preview?.canApply; applyRename.onclick = preview?.confirm ?? null;
    result.textContent = state.status === "applied" ? "Rename applied" : page
        ? page.notes.map(note => note.title + ": " + note.before + " → " + note.insert).join("\n") : state.message;
});
command("Code actions", () => { const at = text().indexOf("TODO");
    editor.view.setSelection(workspace.document(source.documentId).revision, { anchor: at, head: at + 4 }); actions.request(); });
const resolveAction = command("Review lazy action", () => actions.getSnapshot().choices.find(choice => choice.needsResolve)?.select());
const applyAction = command("Apply reviewed action", () => {});
actions.subscribe(() => {
    const state = actions.getSnapshot(), preview = state.preview, page = preview?.readPage();
    notes.actions = state.choices.length;
    resolveAction.disabled = !state.choices.some(choice => choice.needsResolve);
    applyAction.disabled = !preview?.canApply; applyAction.onclick = preview?.confirm ?? null;
    notes.resolved = !!preview && !!state.choices[preview.index]?.needsResolve && !!page?.count;
    result.textContent = page?.notes.map(edit => edit.before + " → " + edit.insert).join("\n") || state.message;
});
command("Signature", () => { const offset = text().indexOf("lookup(") + 12;
    editor.view.setSelection(workspace.document(source.documentId).revision, { anchor: offset, head: offset }); signature.request(); });
signature.subscribe(() => { const active = signature.getSnapshot().signature;
    if (active) { const parameter = active.parameters[active.activeParameter ?? 0];
        notes.signature = parameter ? active.label.slice(parameter.from, parameter.to) : active.label; result.textContent = notes.signature; } });
command("Links", links.request);
const openLink = command("Open link", () => {});
openLink.disabled = true;
links.subscribe(() => {
    const state = links.getSnapshot(), link = state.links[0];
    openLink.disabled = state.status !== "ready" || !link;
    openLink.onclick = link ? () => link.open(uri => { notes.linkUri = uri; result.textContent = uri; }) : null;
});
command("Colors", async () => {
    await colors.request(); await colors.getSnapshot().colors[0]?.preview({ red: 0, green: 1, blue: 0, alpha: 1 });
});
command("Preview translucent color", () => colors.getSnapshot().colors[0]?.preview({ red: 1 / 255, green: 2 / 255, blue: 3 / 255, alpha: .5 }));
const applyColor = command("Apply color", () => {});
applyColor.disabled = true;
colors.subscribe(() => {
    const state = colors.getSnapshot(), review = state.review;
    notes.colorPresentations = state.presentations.length; notes.colorApplied = state.status === "applied";
    applyColor.disabled = !review?.canApply; applyColor.onclick = review?.apply ?? null;
    result.textContent = review ? review.edits.map(edit => edit.insert).join("\n") : state.status === "applied" ? "Color applied" : state.message;
});
const dispose = () => { if (disposed) return; disposed = true; stop(); controller.dispose(); diagnostics.dispose(); hover.dispose(); navigation.dispose(); rename.dispose(); actions.dispose(); signature.dispose(); links.dispose(); colors.dispose(); provider.dispose(); editor.dispose(); };
const bridge = { text, select: (at: number) => editor.view.setSelection(workspace.document(source.documentId).revision, { anchor: at, head: at }),
    state: () => ({ provider: provider.snapshot(), editor: controller.getDiagnostics(), completion: controller.getSnapshot(), history: workspace.observeHistory(source.documentId).getSnapshot(), diagnostics: workspace.diagnostics(), notes, companion: companion.documentId, companionResource: companion.id, metrics: editor.snapshot(), errors }),
    showDiagnostic: () => {
        const state = diagnostics.getSnapshot(), first = state.diagnostics[0];
        if (first) { diagnosticHint.textContent = first.message; hint.show({ revision: state.diagnosticRevision, offset: first.from }); }
    }, diagnostics, stopCompletion: controller.dispose, custom: controller.customRequest, dispose };
Object.assign(window, { publicLsp: bridge });
declare global { interface Window { publicLsp: typeof bridge } }
