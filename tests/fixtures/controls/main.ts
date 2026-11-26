import { Workspace } from "sttropez";
import { attachEditorLanguage, BrowserLspWorkspace, mountFindBar, mountTextEditor, openWebSocketTransport } from "sttropez/browser";
import "sttropez/editor.css";

const workspace = new Workspace();
const name = "colors.ts";
const file = workspace.createTextResource({ scope: "controls", resource: name, variant: "working" }, name,
    { value: 'const accent = "#5fae99";\nuse(accent);' }, undefined,
    { language: { uri: "file:///colors.ts", languageId: "typescript" } });
export const editor = mountTextEditor(document.querySelector("main")!, workspace, file.documentId);
const find = mountFindBar(document.querySelector("#find")!);
find.attach(editor);
const provider = new BrowserLspWorkspace(workspace, {
    workspaceEdits: true,
    connect: signal => openWebSocketTransport(new URL("/lsp-fixture", location.href.replace(/^http/, "ws")).href, { signal }),
});
const language = attachEditorLanguage(editor, provider, {
    rename: { popup: true },
    colors: { picker: true },
    codeActions: {
        popup: true,
        commandPolicy: ({ command }) => command === "fixture.status" ? { kind: "server" } : null,
        reviewCommandEdit: () => false,
    },
    completion: { list: true },
    signature: { popup: true },
    links: { paint: true },
    hover: { popup: {
        canOpenLink: uri => uri.startsWith("file:///"),
        openLink: uri => { editor.element.dataset.openedLink = uri; },
        actions: point => [{ label: "Inspect offset", run() { editor.element.dataset.inspectedOffset = String(point.offset); } }],
    } },
});
window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    language.dispose();
    provider.dispose();
    find.dispose();
    editor.dispose();
});
