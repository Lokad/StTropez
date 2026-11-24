# Getting started

StTropez is a TypeScript library for embedding a text editor and a workspace in a browser app.
Use it when several views need to edit, compare or undo changes to the same files, while your
application decides where to save them and what happens when the user clicks Run.

A **resource** identifies a file or a typed value such as project settings. A text resource’s
**document** holds shared text, revision and undo history. A **tab** records where a resource
is open. Each editor **view** has its own selection and folds,
and each mounted pane scrolls independently. The host owns storage, execution and network I/O.

| Public import | Use it to |
| --- | --- |
| `sttropez` | Open files and edit shared text with the headless `Workspace`. Capture a ticket when saving. |
| `sttropez/browser` | Mount the DOM editor with `mountTextEditor`, review changes with `mountTextComparison`, or open a WebSocket transport. |
| `sttropez/protocol` | Share an `LspWorkspace` across views. The host supplies its transport and scheduler. |

Capture the document and revision when you request an edit. If the user types or switches tabs before
the reply arrives, its offsets refer to the original text.

**Where the work runs.** Typing, rendering and literal search run on the browser’s main thread.
Longer tasks such as diffing yield between chunks. The host can supply a dedicated Web Worker
for regex matching and replacement planning. Local syntax coloring needs no server. When LSP is
enabled the connected provider computes its diagnostics and completions. The host decides where
Save and Run execute. [Regex worker](search.md#regular-expressions-and-worker-limits)

## Use

### Open the first editor

Start `app.js` with a checklist. Create a resource for the file and mount its document in the page.

```ts
import { Workspace } from "sttropez";
import { mountTextEditor } from "sttropez/browser";

const workspace = new Workspace();
const name = "tasks.md";
const openedText = sessionStorage.getItem(name) ?? "- [ ] Review the draft\n";
const file = workspace.createTextResource(
    { scope: "checklist", resource: name, variant: "working" }, name, { value: openedText }, undefined,
    { language: { uri: "file:///tasks.md", languageId: "markdown" } });

const primary = document.querySelector("main");
if (!primary) throw new Error("Missing <main>.");
const editor = mountTextEditor(primary, workspace, file.documentId, { ariaLabel: name });
editor.focus();
```

To run it, put the contents of the `assets/` directory from the StTropez NuGet archive in
`site/sttropez/`, beside `site/app.js` and the following `site/index.html`. From a source checkout,
`npm ci` and `npm run build` produce the same directory layout in `dist/`. Copy the whole tree
so the modules can find their shared chunks. [NuGet restore and staging](packaging.md#use)

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

Serve `site/` over HTTP. For example, from that directory run `python -m http.server 8000`
and open `http://localhost:8000/`. The examples use native ES modules and need no bundler.

### Add features to a browser IDE

Add this toolbar helper to `app.js`. Append the remaining snippets there too, except for the tokenizer
in `checklist.js`.

```js
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
```

#### Switch and move tabs

Choose **Notes** to open a second file. Switch back to the checklist, then return to Notes. Keeping
both editors mounted preserves each caret, fold and scroll position. Your toolbar decides which tab to
show and where to put focus. `workspace.tabs.move` keeps the tab ID and pending captures valid across
panes. `workspace.tabs.replace` reuses the ID and expires captures for the old tab.

```js
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

```js
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

Choose **Review close**, move the notes tab, then choose **Close notes**. The close works. Try
editing the notes after **Review close** instead. The edit expires the decision, as would replacing
the tab. Reopening **Notes** gives the same document a new tab, with its draft and undo history
intact.

```js
/** @type {import("sttropez").CloseIntent | undefined} */
let closing;
button("Review close", () => {
    if (!notesTab) return;
    closing = workspace.tabs.captureClose(notesTab.target.id);
    output.textContent = closing.dirty ? "Close notes and keep the draft?" : "Close notes?";
});
button("Close notes", () => {
    if (!closing) return;
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

The remaining commands act on the checklist. Click **Propose task**, type in the checklist,
then click **Apply task**. The workspace rejects the
old offsets. Propose again and apply without typing to add the task in one undo step.

```js
/** @type {(() => boolean) | undefined} */
let proposal;
button("Propose task", () => {
    const before = workspace.document(file.documentId);
    const end = before.buffer.length;
    const newline = end > 0 && before.buffer.slice(end - 1, end) !== "\n" ? "\n" : "";
    proposal = () => workspace.edit({ documentId: before.id, expectedRevision: before.revision,
        origin: "host", edits: [{ from: end, to: end, insert: newline + "- [ ] New task\n" }] }).applied;
    output.textContent = "Append an unchecked task?";
});
button("Apply task", () => {
    if (!proposal) return;
    output.textContent = proposal() ? "Task added." : "File changed. Propose again.";
    proposal = undefined;
});
button("Undo", () => workspace.undo({ documentId: file.documentId,
    expectedRevision: workspace.document(file.documentId).revision }));
```

<a id="split-the-view-and-color-tokens"></a>

#### Plug in a standalone tokenizer

Save this tokenizer as `site/checklist.js`. It recognizes open and completed task markers at the
start of a line. Each token has a kind and a half-open UTF-16 range relative to that line.
For example, `[0, 5)` colors the first five units.

```js file=checklist.js
/** @param {string} prefix */
export function tokens(prefix) {
    if (prefix === "- [ ]") return [{ from: 0, to: 5, kind: "open" }];
    if (prefix.toLowerCase() === "- [x]") return [{ from: 0, to: 5, kind: "done" }];
    return [];
}
```

Back in `app.js`, attach a token provider to the second editor. The host loads the
tokenizer or grammar parser and maps its output to document offsets and CSS classes. The stylesheet gives
`open-task` and `done-task` different colors. Change a space to `x` to see the marker change.

```js
import { tokens } from "./checklist.js";

const second = document.createElement("section");
second.id = "split";
document.getElementById("panes")?.after(second);
const split = mountTextEditor(second, workspace, file.documentId, {
    ariaLabel: "Checklist split", settings: { minimap: true,
        language: { tabSize: 2, insertSpaces: true, blockComment: { open: "<!--", close: "-->" } } }
});
const checklist = split.decorations.addProvider({
    name: "checklist", order: 0,
    provide(line) {
        if (line.from >= line.lineStart + 5) return [];
        const buffer = workspace.document(line.documentId).buffer;
        const prefix = buffer.slice(line.lineStart, Math.min(line.lineStart + 5, buffer.length));
        return tokens(prefix).map(t => ({ from: line.lineStart + t.from, to: line.lineStart + t.to,
            className: t.kind + "-task" }));
    }
});
```

For a multiline token, pass the previous line’s ending state into the next call, as in
`const { tokens, endState } = lexLine(text, startState)`. A line can start inside a block comment.
Cache results by document and revision. After an edit, tokenize from the first changed line until the
unchanged suffix has its original incoming state. Paint spans that intersect the visible fragment.

`provide` runs synchronously during paint. For an expensive grammar, run its tokenizer in a
host worker. Check the document ID and revision when the result arrives, cache the spans, then
call `checklist.invalidate(firstLine, endLine)` to repaint the affected lines. Comment
and indentation rules use `language`. Completion and diagnostics use a separate provider.
[Host tokenization](host-integration.md#tokenization-annotations-and-forms)

#### Paste a list

Paste tab-separated text in either pane to turn it into checklist rows. Other text uses the usual
paste handler. `insert` replaces the captured selections in one undo step. If your converter runs
asynchronously, keep the capture until it finishes.

```js
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

Show unsaved edits in the page title. Subscribe once, then read the snapshot on each change.

```js
const showDirty = () => { document.title = file.metadata.getSnapshot().dirty ? name + " (unsaved)" : name; };
const stopDirty = file.metadata.subscribe(showDirty);
showDirty();
```

The example writes to session storage and keeps each successful save as a review baseline.
`captureSave` fixes the text before the write starts. If the user keeps typing, the later edits stay
unsaved. For shared storage, send `expectedServerVersion` with the write. Call `ticket.conflict()`
if the server reports a competing version.

```js
import { TextBuffer } from "sttropez";

let baseline = { buffer: TextBuffer.from(openedText), version: "opened" };
button("Save", () => {
    const ticket = workspace.captureSave(file);
    try {
        sessionStorage.setItem(name, ticket.start().value);
        const receipt = ticket.accept({ serverVersion: crypto.randomUUID() });
        baseline = { buffer: TextBuffer.from(receipt.savedValue), version: receipt.serverVersion };
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

This host counts unfinished tasks using the current draft and the configured marker.

```js
const rules = workspace.createResource(
    { scope: "checklist", resource: "rules", variant: "working" },
    "Checklist rules", { value: { marker: "- [ ] " } });
button("Run", () => {
    const draft = file.getSnapshot(), config = rules.getSnapshot();
    if (draft.state !== "ready" || config.state !== "ready") return;
    const marker = config.value().marker;
    const count = draft.value().split("\n").filter(line => line.startsWith(marker)).length;
    output.textContent = `${count} open tasks`;
});
```

#### Compare saved and working text

Open a review against the last successful save, or the
file as opened. The reference stays fixed while the working pane follows edits. Click again
to pick up a later save.

```js
import { mountTextComparison } from "sttropez/browser";

const reviewHost = document.getElementById("review");
if (!reviewHost) throw new Error("Missing review container.");
/** @type {import("sttropez/browser").TextComparison | undefined} */
let review;
button("Compare saved", () => {
    review?.dispose();
    review = mountTextComparison(reviewHost, workspace, file.documentId, baseline);
});
```

#### Connect a language server

The HTTP server above serves the checklist files. **Connect** needs a separately provided Markdown
language server at the same origin’s `/lsp` WebSocket endpoint. It must speak LSP 3.17, use
UTF-16 positions and recognize the URI assigned to the checklist resource.

```js
import { BrowserLspWorkspace, attachEditorLanguage, openWebSocketTransport } from "sttropez/browser";

const endpoint = new URL("/lsp", location.href);
endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const provider = new BrowserLspWorkspace(workspace, {
    connect: signal => openWebSocketTransport(endpoint.href, { signal })
});
```

Attach the provider to the first pane. Use **Connect**, then Ctrl+Space in the editor to request
completion. Arrow keys choose a suggestion and Enter accepts it.

```js
const language = attachEditorLanguage(editor, provider, {
    completion: { autoConnect: false }, diagnostics: { autoConnect: false }
});
const { completion, diagnostics } = language;
function showLanguage() {
    const state = completion.getSnapshot();
    output.textContent = state.offerText ?? diagnostics.getSnapshot().diagnostics[0]?.message ?? state.message;
}
const stopLanguage = completion.subscribe(showLanguage);
const stopDiagnostics = diagnostics.subscribe(showLanguage);
button("Connect", completion.connect);
```

For cross-file rename, set `workspaceEdits: true` and pass the project’s document snapshots to
the client returned by `createLspRenameClient(provider)`. Its `run` method returns a proposed
edit. Show the changes with `previewLspWorkspaceEdit`. On approval, recheck the target and
apply the plan with `applyLspWorkspaceEdit`. One undo restores every affected file.
[Complete rename example](language-features.md#rename-and-workspace-edits)

## Contract

A revision changes when you edit or undo. The saved version changes when your storage service
acknowledges a write. Undo back to the saved text and the file is clean again.
[Save and conflicts](workspace.md#save-and-conflicts)

## Host responsibilities

Close the attachments when the host closes this file. Ask before discarding edits.
To keep selections and folds across a remount, retain a
`DocumentView` for each pane. In React, mount through a stable ref and dispose on detach.
[Document views](workspace.md#document-views)

```js
button("Close", () => {
    const dirty = file.metadata.getSnapshot().dirty || notes.metadata.getSnapshot().dirty;
    if (dirty && !window.confirm("Discard unsaved changes and close the workspace?")) return;
    controls.abort();
    stopDirty();
    stopLanguage();
    stopDiagnostics();
    language.dispose();
    provider.dispose();
    review?.dispose();
    split.dispose();
    if (notesTab) { notesTab.editor.dispose(); workspace.tabs.close(notesTab.target.id); }
    editor.dispose();
    workspace.releaseResourceWhenUnowned(file.id, dirty);
    workspace.releaseResourceWhenUnowned(notes.id, dirty);
    workspace.releaseResourceWhenUnowned(rules.id);
    toolbar.replaceChildren();
});
```

## Not covered

See the [support matrix](README.md#support-matrix) for browser and device coverage.
For runnable host examples, see the [example catalogue](examples.md#development-routes).
