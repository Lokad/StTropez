import { Workspace } from "sttropez";
import { attachEditorLanguage, BrowserLspWorkspace, createFoldingController, mountFindBar, mountTextComparison,
    mountTextEditor, openWebSocketTransport } from "sttropez/browser";
import type { ControlStrings } from "sttropez/browser";
import "sttropez/editor.css";

const workspace = new Workspace();
const name = "colors.ts";
const file = workspace.createTextResource({ scope: "controls", resource: name, variant: "working" }, name,
    {
        value: 'const accent = "#5fae99";\nuse(accent);',
        language: { uri: "file:///colors.ts", languageId: "typescript" },
    });
const strings: ControlStrings = location.search === "?locale=fr" ? {
    text: label => label === "New name" ? "Nouveau nom" : label,
    reviewChanges: count => String(count) + (count === 1 ? " modification" : " modifications"),
    findStatus: state => String(state.count) + " résultats",
} : {};
export const editor = mountTextEditor(document.querySelector("main")!, workspace, file.id, { strings });
const find = mountFindBar(document.querySelector("#find")!, { strings });
find.attach(editor);
const provider = new BrowserLspWorkspace(workspace, {
    workspaceEdits: true,
    connect: signal => openWebSocketTransport(new URL("/lsp-fixture", location.href.replace(/^http/, "ws")).href, { signal }),
});
const language = attachEditorLanguage(editor, provider, {
    navigation: { chooser: { capture: () => at => {
        editor.reveal({ from: at.from, to: at.from },
            { select: true, focus: true, expectedRevision: at.document.revision });
    } } },
    rename: { popup: true },
    colors: { picker: true },
    reviewCommandEdit: () => false,
    codeActions: {
        popup: true,
        commandPolicy: ({ command }) => command === "fixture.status" ? { kind: "server" } : null,
    },
    completion: { list: true },
    signature: { popup: true },
    links: { paint: true },
    linkPolicy: {
        canOpenLink: uri => uri.startsWith("file:///"),
        openLink: uri => { editor.element.dataset.openedLink = uri; },
    },
    hover: { popup: {
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

/** Read the shortcut reference from the same mounted controls the host can inspect. */
export function readDefaultShortcuts() {
    const container = document.createElement("div");
    document.body.append(container);
    const folding = createFoldingController(editor, () => []);
    let comparison: ReturnType<typeof mountTextComparison> | undefined;
    try {
        comparison = mountTextComparison(container, workspace, file.id, {
            buffer: workspace.document(file.id).buffer, version: "saved",
        });
        const rows = new Map<string, { id: string; category: string; keys: readonly string[] }>();
        for (const pane of [editor, comparison.panes.working]) {
            for (const { id, owner, category } of pane.commands.list()) {
                if (owner !== "editor" || rows.has(id)) continue;
                const keys = pane.keymap.getShortcuts(id);
                if (keys.length) rows.set(id, { id, category, keys });
            }
        }
        return [...rows.values()];
    } finally {
        comparison?.dispose();
        folding.dispose();
        container.remove();
    }
}
