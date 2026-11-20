# Getting started

A **resource** identifies a file or a typed value such as project settings. A text resource’s
**document** holds shared text, revision and undo history. A **tab** records where a resource
is open. Each editor **view** has its own selection and folds,
and each mounted pane scrolls independently. The host owns storage, execution and network I/O.

| Public import | Use it to |
| --- | --- |
| `sttropez` | Open a file with `Workspace`, edit its document and run or save through `WorkspaceCommands`. |
| `sttropez/browser` | Mount an editor with `mountTextEditor` or review changes with `mountTextComparison`. |
| `sttropez/protocol` | Connect a language server with `LspWorkspace` and share it across views. |

Capture the document and revision before requesting an edit. A reply can arrive after more typing
or a tab change. Its offsets belong to the text it was calculated from.

## Use

### Open the first editor

Start `app.js` with a checklist. `createTextResource` gives the file an identity,
`open` gives it a tab, and `mountTextEditor` attaches a view to the page. You can type and undo
as soon as it mounts.

```ts
import { Workspace } from "sttropez";
import { mountTextEditor } from "sttropez/browser";

const workspace = new Workspace();
const name = "tasks.md";
const openedText = sessionStorage.getItem(name) ?? "- [ ] Review the draft\n";
const file = workspace.createTextResource(
    { scope: "checklist", resource: name, variant: "working" }, name, { value: openedText });
const tab = workspace.open({ kind: "text", documentId: file.documentId }, "main");

const primary = document.querySelector("main");
if (!primary) throw new Error("Missing <main>.");
const editor = mountTextEditor(primary, workspace, tab, { ariaLabel: name });
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
  main, #split, #review:not(:empty) { height: 16rem; min-width: 0; }
  .open-task { color: #e9a85c; }
</style>
<script type="importmap">
{ "imports": {
  "sttropez": "./sttropez/index.js",
  "sttropez/browser": "./sttropez/browser/index.js",
  "sttropez/protocol": "./sttropez/protocol/index.js"
} }
</script>
<nav></nav>
<main></main>
<div id="review"></div>
<output></output>
<script type="module" src="./app.js"></script>
```

Serve `site/` over HTTP. For example, from that directory run `python -m http.server 8000`
and open `http://localhost:8000/`. The examples use native ES modules and need no bundler.

### Add features to a browser IDE

Append the following snippets to the same `app.js`. This helper puts each command in the toolbar.

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

#### Propose an edit, apply it later, and undo

Click **Propose task**, type a character, then click **Apply task**. The workspace rejects the
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

#### Split the view and color tokens

Mount a second editor on the same tab. Enable its minimap with one option. The decorator
colors the five characters of an unchecked task marker using document-relative offsets.

```js
const second = document.createElement("section");
second.id = "split";
primary.after(second);
const split = mountTextEditor(second, workspace, tab, {
    ariaLabel: "Checklist split", minimap: true,
    decorate: line => line.from === line.lineStart && line.text.startsWith("- [ ]")
        ? [{ from: line.from, to: line.from + 5, className: "open-task" }] : []
});
```

#### Paste a list

In either pane, turn plain text with tab separators into checklist rows.
Other pastes use the editor’s normal handler. `insert` replaces the captured selections in
one undo step. If conversion takes an asynchronous step, keep this same capture until it finishes.

```js
for (const pane of [editor, split]) {
    pane.input.addEventListener("paste", event => {
        const text = event.clipboardData?.getData("text/plain");
        if (event.defaultPrevented || !text?.includes("\t")) return;
        event.preventDefault();
        const target = pane.captureInsertion("paste");
        target?.insert(text.split(/\t|\r?\n/).filter(Boolean).map(cell => "- [ ] " + cell).join("\n"));
    }, { capture: true, signal: controls.signal });
}
```

#### Save the working text

Show unsaved edits in the page title. Subscribe once, then read the snapshot on each change.

```js
const showDirty = () => { document.title = file.metadata.getSnapshot().dirty ? name + " (unsaved)" : name; };
const stopDirty = file.metadata.subscribe(showDirty);
showDirty();
```

The host writes this tab’s copy to session storage. The save ticket
freezes the submitted text. Typing while a write is pending leaves the newer draft dirty. Keep
the acknowledged value as the reference for review. A shared store must check
`expectedServerVersion` and return `{ kind: "conflict", serverVersion }` on a mismatch.

```js
import { TextBuffer, WorkspaceCommands } from "sttropez";

const commands = new WorkspaceCommands(workspace, console.error);
let baseline = { buffer: TextBuffer.from(openedText), version: "opened" };
button("Save", async () => {
    const result = await commands.save(workspace.captureSave(file), {
        async save({ value }) {
            sessionStorage.setItem(name, value);
            return { kind: "saved", serverVersion: crypto.randomUUID() };
        }
    });
    if (result.kind === "saved") {
        baseline = { buffer: TextBuffer.from(result.receipt.savedValue), version: result.receipt.serverVersion };
    }
    output.textContent = result.kind;
});
```

#### Run a check on the draft

This host counts unfinished tasks. `run` captures the working
file, configuration and settings together when clicked, including unsaved edits.

```js
const rules = workspace.createResource(
    { scope: "checklist", resource: "rules", variant: "working" },
    "Checklist rules", { value: { marker: "- [ ] " } });
button("Run", async () => {
    const count = await commands.run(file, rules, {}, {
        async run({ source, configuration }) {
            return source.value.split("\n").filter(line => line.startsWith(configuration.value.marker)).length;
        }
    });
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
    review = mountTextComparison(reviewHost, workspace, tab, baseline);
});
```

#### Connect a language server

The HTTP server above serves the checklist files. **Connect** needs a separately provided Markdown
language server at the same origin’s `/lsp` WebSocket endpoint. It must speak LSP 3.17, use
UTF-16 positions and recognize the URI below.

```js
import { createLspEditor, openWebSocketTransport } from "sttropez/browser";
import { LspWorkspace } from "sttropez/protocol";

const endpoint = new URL("/lsp", location.href);
endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const provider = new LspWorkspace(workspace, {
    documentInfo: doc => doc.id === file.documentId
        ? { uri: "file:///tasks.md", languageId: "markdown" } : undefined,
    features: ["textDocument/completion"], diagnostics: true,
    schedule(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
    },
    connect: () => openWebSocketTransport(endpoint.href)
});
```

Attach the provider to the first pane. Use **Connect**, then Ctrl+Space in the editor to request
completion. Arrow keys choose a suggestion and Enter accepts it.

```js
const language = createLspEditor(workspace, tab, editor, { provider, autoConnect: false });
const stopLanguage = language.subscribe(() => {
    const state = language.getSnapshot();
    output.textContent = state.offerText ?? state.diagnostics[0]?.message ?? state.message;
});
button("Connect", language.connect);
```

For cross-file rename, enable `textDocument/rename` and pass the project’s document snapshots to
the client returned by `createLspRenameClient(provider)`. Its `run` method returns a proposed
edit. Show the changes with `previewLspWorkspaceEdit`. On approval, recheck the target and
apply the plan with `applyLspWorkspaceEdit`. One undo restores every affected file.
[Complete rename example](language-features.md#rename-and-workspace-edits)

## Contract

A document revision identifies local text. The saved version identifies the host’s acknowledged
write. Undoing back to the saved text clears the dirty flag. [Save and conflicts](workspace.md#save-conflicts-and-run)

## Host responsibilities

Close the attachments when the host closes this file. Ask before discarding edits.
To keep selections and folds across a remount, retain a
`DocumentView` for each pane. In React, mount through a stable ref and dispose on detach.
[Document views](workspace.md#document-views)

```js
button("Close", () => {
    const dirty = file.metadata.getSnapshot().dirty;
    if (dirty && !window.confirm("Discard unsaved checklist changes?")) return;
    controls.abort();
    stopDirty();
    stopLanguage();
    language.dispose();
    provider.dispose();
    review?.dispose();
    split.dispose();
    editor.dispose();
    workspace.close(tab);
    workspace.releaseResourceWhenUnowned(file.id, dirty);
    workspace.releaseResourceWhenUnowned(rules.id);
    toolbar.replaceChildren();
});
```

## Not covered

See the [support matrix](README.md#support-matrix) for browser and device coverage.
For runnable host examples, see the [example catalogue](examples.md#development-routes).
