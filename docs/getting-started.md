# Getting started

Build a two-pane checklist editor with shared text and Undo, a saved baseline and a separate caret in each
pane.

## Use

Try the [reference host](http://127.0.0.1:4173/reference/) with `npm run demo`. Edit `quote.ts`, open
**Changes**, choose **Save for this tab** and reload. **Connect language server** enables completion and
fixes in the working pane.

### Open the first editor

Start `site/app.js` with the working document.

```js file=app.js
import { Workspace } from "sttropez";
import { mountTextEditor } from "sttropez/browser";

const workspace = new Workspace();
const name = "tasks.md";
const readSaved = () => sessionStorage.getItem(name) ?? "- [ ] Review the draft\n";
const openedText = readSaved();
const file = workspace.createTextResource(
    { scope: "checklist", resource: name, variant: "working" }, name, { value: openedText, serverVersion: openedText }, undefined,
    { language: { uri: "file:///tasks.md", languageId: "markdown" } });

const primary = document.querySelector("main");
if (!primary) throw new Error("Missing <main>.");
const editor = mountTextEditor(primary, workspace, file.documentId, { ariaLabel: name });
editor.focus();
```

Copy the package’s `assets/` contents (or `dist/` after `npm ci` and `npm run build`) to `site/sttropez/`.
Save this as `site/index.html`.

```html
<!doctype html>
<meta charset="utf-8">
<title>Checklist editor</title>
<link rel="stylesheet" href="./sttropez/editor.css">
<style>
  #panes { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }
  main, #notes, #split, #review:not(:empty) { height: 16rem; min-width: 0; }
  .open-task { color: #e9a85c; }
  .done-task { color: #68bc98; }
</style>
<script type="importmap">
{ "imports": {
  "sttropez": "./sttropez/index.js",
  "sttropez/browser": "./sttropez/browser/index.js",
  "sttropez/protocol": "./sttropez/protocol/index.js"
} }
</script>
<nav></nav>
<div id="panes"><main></main><aside id="notes" hidden></aside></div>
<div id="review"></div>
<output></output>
<script type="module" src="./app.js"></script>
```

From `site/`, run `python -m http.server 8000` and open `http://localhost:8000/`.

### Add features to a browser IDE

Append the following blocks to `app.js` in order, except for the tokenizer marked `checklist.js`. Check
every editable checklist pane before acting on its text.

```js file=app.js
const controls = new AbortController();
const toolbar = document.querySelector("nav");
const output = document.querySelector("output");
if (!toolbar || !output) throw new Error("Missing toolbar or output.");

/** @param {string} label @param {() => unknown} command */
const button = (label, command) => {
    const item = document.createElement("button");
    item.textContent = label;
    item.addEventListener("click", command, { signal: controls.signal });
    toolbar.append(item);
};

/** @param {(import("sttropez/browser").TextEditor | undefined)[]} panes */
const editsReady = panes => {
    for (const pane of panes) {
        const state = pane?.activity();
        if (state && (state.input !== "idle")) {
            output.textContent = "An edit is pending. Try again when it finishes.";
            return false;
        }
    }
    return true;
};
const checklistPanes = [editor];
const checklistReady = () => editsReady(checklistPanes);
```

#### Switch and move tabs

**Notes** and **Checklist** switch panes. **Dock notes** displays both.

```js file=app.js
const notes = workspace.createTextResource(
    { scope: "checklist", resource: "notes.md", variant: "working" }, "notes.md", { value: "" });
const notesHost = document.querySelector("aside");
if (!notesHost) throw new Error("Missing notes pane.");
const openNotes = () => {
    return { pane: "main", editor: mountTextEditor(notesHost, workspace, notes.documentId, { ariaLabel: "notes.md" }) };
};
/** @type {ReturnType<typeof openNotes> | undefined} */
let notesTab;
```

```js file=app.js
const showChecklist = () => {
    primary.hidden = false;
    notesHost.hidden = notesTab?.pane !== "side";
    editor.focus();
};
button("Checklist", showChecklist);
button("Notes", () => {
    notesTab ??= openNotes();
    primary.hidden = notesTab?.pane === "main";
    notesHost.hidden = false;
    notesTab.editor.focus();
});
button("Dock notes", () => {
    if (!notesTab) return;
    notesTab.pane = "side";
    showChecklist();
});
```

#### Close a tab and keep its draft

**Review close** targets the Notes tab. Moving the tab preserves the prompt. An edit or replacement expires
it. Reopen Notes to recover its draft and history.

```js file=app.js
/** @type {{ tab: ReturnType<typeof openNotes>, revision: number } | undefined} */
let closing;
button("Review close", () => {
    if (!notesTab) return;
    const state = notes.getSnapshot();
    closing = { tab: notesTab, revision: state.revision };
    output.textContent = state.metadata.dirty ? "Close notes and keep the draft?" : "Close notes?";
});
button("Close notes", () => {
    if (!closing || !editsReady([notesTab?.editor])) return;
    const current = closing.tab === notesTab && closing.revision === notes.getSnapshot().revision;
    closing = undefined;
    if (!current) { output.textContent = "Notes changed. Review close again."; return; }
    notesTab?.editor.dispose();
    notesTab = undefined;
    showChecklist();
    output.textContent = "Notes closed.";
});
```

#### Propose an edit, apply it later, and undo

**Apply task** checks the revision captured by **Propose task**.

```js file=app.js
/** @type {(() => boolean) | undefined} */
let proposal;
button("Propose task", () => {
    if (!checklistReady()) return;
    const before = workspace.document(file.documentId);
    const end = before.buffer.length;
    const newline = end > 0 && before.buffer.slice(end - 1, end) !== "\n" ? "\n" : "";
    proposal = () => workspace.edit({ documentId: before.id, expectedRevision: before.revision,
        origin: "host", edits: [{ from: end, to: end, insert: newline + "- [ ] New task\n" }] }).applied;
    output.textContent = "Append an unchecked task?";
});
button("Apply task", () => {
    if (!proposal || !checklistReady()) return;
    output.textContent = proposal() ? "Task added." : "File changed. Propose again.";
    proposal = undefined;
});
button("Undo", () => {
    if (!checklistReady()) return;
    workspace.undo({ documentId: file.documentId, expectedRevision: workspace.document(file.documentId).revision });
});
```

<a id="split-the-view-and-color-tokens"></a>

#### Plug in a standalone tokenizer

Save this tokenizer as `site/checklist.js`. Its ranges use UTF-16 offsets within the line.

```js file=checklist.js
/** @param {string} prefix */
export function tokens(prefix) {
    if (prefix === "- [ ]") return [{ from: 0, to: 5, kind: "open" }];
    if (prefix.toLowerCase() === "- [x]") return [{ from: 0, to: 5, kind: "done" }];
    return [];
}
```

In `app.js`, color the split pane’s checkboxes using document offsets.

```js file=app.js
import { tokens } from "./checklist.js";

const second = document.createElement("section");
second.id = "split";
document.getElementById("panes")?.after(second);
const split = mountTextEditor(second, workspace, file.documentId, {
    ariaLabel: "Checklist split", settings: { minimap: true,
        language: { tabSize: 2, insertSpaces: true, blockComment: { open: "<!--", close: "-->" } } }
});
checklistPanes.push(split);
const checklist = split.decorations.addProvider({
    order: 0,
    provide(line) {
        if (line.from >= line.lineStart + 5) return [];
        const buffer = workspace.document(line.documentId).buffer;
        const prefix = buffer.slice(line.lineStart, Math.min(line.lineStart + 5, buffer.length));
        return tokens(prefix).map(t => ({ from: line.lineStart + t.from, to: line.lineStart + t.to,
            className: t.kind + "-task" }));
    }
});
```

For async tokens, cache spans by document and revision, then call
`checklist.invalidate(firstLine, endLine)`.
[Host tokenization](host-integration.md#tokenization-annotations-and-forms)

#### Paste a list

Paste tab-separated cells into either pane to insert checklist rows in one Undo step.

```js file=app.js
for (const pane of [editor, split]) {
    const stop = pane.registerPasteHandler(data => {
        const text = data.getData("text/plain");
        if (!text.includes("\t")) return;
        const cells = text.split(/\t|\r?\n/).filter(Boolean);
        return target => target.insert(cells.map(cell => "- [ ] " + cell).join("\n"));
    });
    controls.signal.addEventListener("abort", stop, { once: true });
}
```

#### Save the working text

Show unsaved changes in the title.

```js file=app.js
const showDirty = () => { document.title = file.metadata.getSnapshot().dirty ? name + " (unsaved)" : name; };
const stopDirty = file.metadata.subscribe(showDirty);
showDirty();
```

Use the text stored in this tab as its version. On conflict, **Compare saved** shows the competing text. For
asynchronous writes, share a [save queue](workspace.md#save-and-conflicts).

```js file=app.js
import { TextBuffer } from "sttropez";

/** @type {import("sttropez/browser").TextComparison | undefined} */
let review;
let baseline = { buffer: workspace.document(file.documentId).buffer, version: "opened" };
/** @param {import("sttropez").ComparisonBaseline} next */
function showSaved(next) {
    if (baseline.buffer.equals(next.buffer)) return;
    baseline = next;
    review?.controller.beginRefresh().complete(next);
}
button("Save", () => {
    if (!checklistReady()) return;
    const ticket = workspace.captureSave(file);
    try {
        const submission = ticket.start();
        const stored = readSaved();
        if (stored !== submission.expectedServerVersion && stored !== submission.value) {
            ticket.conflict();
            showSaved({ buffer: TextBuffer.from(stored), version: "saved in this tab" });
            output.textContent = "Another view saved first. See Compare saved.";
            return;
        }
        sessionStorage.setItem(name, submission.value);
        ticket.accept({ serverVersion: submission.value });
        showSaved({ buffer: workspace.document(file.documentId).buffer, version: String(ticket.revision) });
        output.textContent = "Saved";
    } catch (error) {
        ticket.fail();
        output.textContent = String(error);
    } finally {
        ticket.finish();
    }
});
```

#### Run a check on the draft

**Run** counts unchecked tasks using the marker in settings.

```js file=app.js
const rules = workspace.createResource(
    { scope: "checklist", resource: "rules", variant: "working" },
    "Checklist rules", { value: { marker: "- [ ] " } });
button("Run", () => {
    if (!checklistReady()) return;
    const draft = file.getSnapshot(), config = rules.getSnapshot();
    if (draft.state !== "ready" || config.state !== "ready") return;
    const marker = config.value().marker;
    const count = draft.value().split("\n").filter(line => line.startsWith(marker)).length;
    output.textContent = `${count} open tasks`;
});
```

#### Compare saved and working text

Keep the review mounted when Save refreshes the baseline.

```js file=app.js
import { mountTextComparison } from "sttropez/browser";

const reviewHost = document.getElementById("review");
if (!reviewHost) throw new Error("Missing review container.");
button("Compare saved", () => {
    if (!checklistReady()) return;
    if (!review) {
        review = mountTextComparison(reviewHost, workspace, file.documentId, baseline);
        checklistPanes.push(review.panes.working);
    }
    review.activePane().focus();
});
```

#### Connect a language server

Supply a Markdown LSP server at `/lsp` with WebSocket and UTF-16 positions. [Protocol](language-server.md)

```js file=app.js
import { BrowserLspWorkspace, attachEditorLanguage, openWebSocketTransport } from "sttropez/browser";

const endpoint = new URL("/lsp", location.href);
endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const provider = new BrowserLspWorkspace(workspace, {
    connect: signal => openWebSocketTransport(endpoint.href, { signal })
});
```

Choose **Connect**, focus the first pane and press Ctrl+Space. Use the arrows and Enter to accept a
suggestion.

```js file=app.js
const language = attachEditorLanguage(editor, provider, {
    completion: { list: true, autoConnect: false }, diagnostics: { autoConnect: false }
});
const { completion, diagnostics } = language;
const languageStatus = document.createElement("output");
toolbar.append(languageStatus);
const showLanguage = () => {
    const state = completion.getSnapshot();
    languageStatus.textContent = diagnostics.getSnapshot().diagnostics[0]?.message ?? state.message;
};
const stopLanguage = completion.subscribe(showLanguage);
const stopDiagnostics = diagnostics.subscribe(showLanguage);
button("Connect", completion.connect);
```

## Contract

Edits and Undo advance the revision. Undo to the saved text marks the file clean.

## Host responsibilities

Check all panes for pending edits before close. Confirm draft discard and dispose attachments before
releasing their owners.

```js file=app.js
button("Close", () => {
    if (!checklistReady() || !editsReady([notesTab?.editor])) return;
    const dirty = file.metadata.getSnapshot().dirty || notes.metadata.getSnapshot().dirty;
    if (dirty && !window.confirm("Discard unsaved changes and close the workspace?")) return;
    controls.abort();
    stopDirty();
    stopLanguage();
    stopDiagnostics();
    language.dispose();
    provider.dispose();
    review?.dispose();
    checklist.dispose();
    split.dispose();
    notesTab?.editor.dispose();
    editor.dispose();
    workspace.releaseResourceWhenUnowned(file.id, dirty);
    workspace.releaseResourceWhenUnowned(notes.id, dirty);
    workspace.releaseResourceWhenUnowned(rules.id);
    toolbar.replaceChildren();
});
```

### Mount an editor in React

Create one callback ref per host pane.

```tsx
import type { DocumentView, Workspace } from "sttropez";
import { mountTextEditor, type TextEditor } from "sttropez/browser";

export function createEditorRef(workspace: Workspace, view: DocumentView) {
    let editor: TextEditor | undefined;
    return (element: HTMLDivElement | null) => {
        editor?.dispose();
        editor = element ? mountTextEditor(element, workspace, view.documentId, { view }) : undefined;
    };
}

export function EditorPane({ bind }: { bind: ReturnType<typeof createEditorRef> }) {
    return <div ref={bind} style={{ height: "20rem" }} />;
}
```

Create the view with `workspace.createDocumentView(file.documentId)`. Pass the same ref to `EditorPane`
across renders and dispose the view when retiring the pane.
[React fixture](../tests/fixtures/hosts/react-main.tsx)

## Not covered

[Device support](README.md#support-matrix) · [Runnable examples](examples.md#development-routes)
