# Getting started

Panes share a document and Undo history. Each keeps its own selection, folds and scroll position.
Your application supplies storage and language services.
[Public imports](api.md) · [Architecture](architecture.md)

## Use

Run `npm run demo` from the checkout and open the [reference host](http://127.0.0.1:4173/reference/).

1. Edit `quote.ts` and choose **Changes**. The working pane keeps your selection and folds.
2. Use **Save for this tab** or Ctrl+S (Cmd+S on macOS), then reload to reopen the saved text.
   If another view saved first, inspect both copies and choose **Save reviewed working copy**.
3. Choose **Connect language server** to try completion and code actions. In Changes, language
   commands act on the working pane. Find can search either pane.

The reference host keeps the working view across mounts and checks for pending edits before
Save or reload. [Mount, Find and Save](../examples/reference/main.ts) · [Language commands](../examples/reference/language.ts)

### Open the first editor

To embed an editor in your own page, start `site/app.js` with this checklist document.

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

Copy the NuGet archive’s `assets/` tree into `site/sttropez/`, or build `dist/` with
`npm ci` and `npm run build` and copy its contents there. Save the HTML as `site/index.html`.
[Staging the package](packaging.md#use)

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

From `site/` run `python -m http.server 8000` and open `http://localhost:8000/`.

### Add features to a browser IDE

Append each block to `app.js` in order. Save the tokenizer in `checklist.js`.

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
        if (state && (state.composing || state.pendingInput || state.pendingCommand)) {
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

**Notes** opens a second document. **Checklist** switches back. **Dock notes** shows both panes.
Keeping them mounted preserves each caret and scroll position.

```js file=app.js
const notes = workspace.createTextResource(
    { scope: "checklist", resource: "notes.md", variant: "working" }, "notes.md", { value: "" });
const notesHost = document.querySelector("aside");
if (!notesHost) throw new Error("Missing notes pane.");
const openNotes = () => {
    const id = workspace.tabs.open({ kind: "text", documentId: notes.documentId }, "main");
    return { target: workspace.tabs.capture(id),
        editor: mountTextEditor(notesHost, workspace, id, { ariaLabel: "notes.md" }) };
};
/** @type {ReturnType<typeof openNotes> | undefined} */
let notesTab;
const notesPane = () => notesTab && workspace.tabs.resolve(notesTab.target)?.paneId;
```

```js file=app.js
const showChecklist = () => {
    primary.hidden = false;
    notesHost.hidden = notesPane() !== "side";
    editor.focus();
};
button("Checklist", showChecklist);
button("Notes", () => {
    notesTab ??= openNotes();
    primary.hidden = notesPane() === "main";
    notesHost.hidden = false;
    notesTab.editor.focus();
});
button("Dock notes", () => {
    if (!notesTab) return;
    workspace.tabs.move(notesTab.target.id, "side");
    showChecklist();
});
```

#### Close a tab and keep its draft

**Review close** captures the Notes tab for **Close notes**. Moving it keeps the decision valid.
An edit or replacement expires it. Reopening Notes restores its text and history.
[Resource lifetime](workspace.md#loading-and-resource-lifetime)

```js file=app.js
/** @type {import("sttropez").CloseIntent | undefined} */
let closing;
button("Review close", () => {
    if (!notesTab) return;
    closing = workspace.tabs.captureClose(notesTab.target.id);
    output.textContent = closing.dirty ? "Close notes and keep the draft?" : "Close notes?";
});
button("Close notes", () => {
    if (!closing || !editsReady([notesTab?.editor])) return;
    const closed = workspace.tabs.completeClose(closing, "close");
    closing = undefined;
    if (!closed) { output.textContent = "Notes changed. Review close again."; return; }
    notesTab?.editor.dispose();
    notesTab = undefined;
    showChecklist();
    output.textContent = "Notes closed.";
});
```

#### Propose an edit, apply it later, and undo

**Propose task** captures the revision. **Apply task** appends one undoable row if it matches.
If a checklist pane has a pending edit, retry the action when it finishes.

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

Save this as `site/checklist.js`. Its ranges count UTF-16 units from the start of a line.

```js file=checklist.js
/** @param {string} prefix */
export function tokens(prefix) {
    if (prefix === "- [ ]") return [{ from: 0, to: 5, kind: "open" }];
    if (prefix.toLowerCase() === "- [x]") return [{ from: 0, to: 5, kind: "done" }];
    return [];
}
```

Mount a second pane. Its decoration provider colors each checkbox using document offsets.

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

`provide` runs during paint. Track lexical state for multiline tokens. For async tokens, check
the document and revision, cache spans and call `checklist.invalidate(firstLine, endLine)`.
[Host tokenization](host-integration.md#tokenization-annotations-and-forms)

#### Paste a list

Paste tab-separated cells into either checklist pane to turn them into rows in one Undo step.
Plain text uses the editor’s usual paste behavior. [Asynchronous conversion](host-integration.md#captured-insertion-and-structured-paste)

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

Mark unsaved changes in the page title.

```js file=app.js
const showDirty = () => { document.title = file.metadata.getSnapshot().dirty ? name + " (unsaved)" : name; };
const stopDirty = file.metadata.subscribe(showDirty);
showDirty();
```

The stored text acts as its version. A conflict shows the other copy in **Compare saved**.
Queue Save presses when writing asynchronously.
[Save queue and reviewed retries](workspace.md#save-and-conflicts)

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

**Run** counts unfinished tasks using the current draft and the marker in a separate settings resource.

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

**Compare saved** opens or refocuses the review. Save refreshes its baseline in place.
[Review commands](comparison.md#hunk-commands-and-host-tickets)

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

Supply a Markdown language server at `/lsp` on the same origin for completion. It uses WebSocket,
LSP 3.17 and UTF-16 positions. [Language server](language-server.md)

```js file=app.js
import { BrowserLspWorkspace, attachEditorLanguage, openWebSocketTransport } from "sttropez/browser";

const endpoint = new URL("/lsp", location.href);
endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const provider = new BrowserLspWorkspace(workspace, {
    connect: signal => openWebSocketTransport(endpoint.href, { signal })
});
```

Choose **Connect**, focus the first pane and press Ctrl+Space. Use the arrows to select a
completion and Enter to insert it.

```js file=app.js
const language = attachEditorLanguage(editor, provider, {
    completion: { autoConnect: false }, diagnostics: { autoConnect: false }
});
const { completion, diagnostics } = language;
const showLanguage = () => {
    const state = completion.getSnapshot();
    output.textContent = state.offerText ?? diagnostics.getSnapshot().diagnostics[0]?.message ?? state.message;
};
const stopLanguage = completion.subscribe(showLanguage);
const stopDiagnostics = diagnostics.subscribe(showLanguage);
button("Connect", completion.connect);
```

For cross-file rename, supply the participating documents and review the returned edit before
applying it. [Rename example](language-features.md#rename-and-workspace-edits)

## Contract

Typing and Undo advance the revision. Undo to the saved text marks the file clean. [Save and conflicts](workspace.md#save-and-conflicts)

## Host responsibilities

Check pending edits and confirm before discarding a draft. Dispose attachments before their
provider and mounts before releasing their resources.

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
    if (notesTab) { notesTab.editor.dispose(); workspace.tabs.close(notesTab.target.id); }
    editor.dispose();
    workspace.releaseResourceWhenUnowned(file.id, dirty);
    workspace.releaseResourceWhenUnowned(notes.id, dirty);
    workspace.releaseResourceWhenUnowned(rules.id);
    toolbar.replaceChildren();
});
```

### Mount an editor in React

Create a stable callback ref when the host opens the pane. React supplies the element on mount
and `null` on detach.

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

Create the view with `workspace.createDocumentView(file.documentId)`. Pass the same
`createEditorRef(workspace, view)` result to `EditorPane` on each render. The view keeps its
selection and folds across remounts. Dispose it when the host retires the pane.
[Document views](workspace.md#document-views) · [React fixture](../tests/fixtures/hosts/react-main.tsx)

## Not covered

[Device support](README.md#support-matrix) · [Runnable examples](examples.md#development-routes)
