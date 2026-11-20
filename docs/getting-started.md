# Getting started

Mount an editor in an empty element. A workspace holds its document and undo history across mounts.

## Use

Pin the compiled assets before mounting the editor. For a local evaluation, run
`npm run pack:nuget` in this checkout and use `artifacts/nuget/feed` as a NuGet source. Reference
`StTropez.Assets` with the exact version `[0.0.0-local]`. Local builds reuse that version. To pin
one, vendor the archive in a local feed and record its SHA-256 and producer revision. Stage the
restored directory and resolve the public imports and CSS from it. See the
[consumer project and staging commands](packaging.md#use).

Load the stylesheet and give the container a height.

```html
<link rel="stylesheet" href="./sttropez/editor.css">
<div id="editor" style="height: 400px; min-width: 0"></div>
```

Mount the document from your TypeScript entry point.

```ts
import { Workspace } from "sttropez";
import { mountTextEditor } from "sttropez/browser";

export function openDocument(host: HTMLElement) {
    const workspace = new Workspace();
    const resource = workspace.createTextResource(
        { scope: "example", resource: "main.ts", variant: "working" },
        "main.ts", { value: "const answer = 42;\n" });
    const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "main");
    const editor = mountTextEditor(host, workspace, tab, {
        ariaLabel: "Source code",
        language: { tabSize: 4, insertSpaces: true, lineComment: "//", enter: "keep" }
    });
    let disposed = false;
    return {
        workspace, resource, tab, editor,
        dispose() {
            if (disposed) return;
            disposed = true;
            editor.dispose();
            workspace.close(tab);
            workspace.releaseResource(resource.id);
        }
    };
}
```

Call `openDocument` after attaching the container. Keep the result in your host controller and call
`dispose()` when you close the document.

### Add features to a browser IDE

Try typing and undo in the [hosted editor](https://lokad.github.io/StTropez/). The local examples
below also need Node.js 24 or later. In this checkout run `npm ci`, then `npm run demo`.

**Color tokens and convert a paste.** Open [Paste & notes](https://lokad.github.io/StTropez/?sample=host).
Keywords in `workflow.rules` get their colors from a host `LineDecorator` passed as the editor’s
`decorate` option. Return source offsets and CSS classes for each visible fragment. Open
`inventory.csv`, put the caret at the end and choose **Code → Paste format → Table as CSV**, then
**Insert example table**. Three quoted rows appear. Undo removes them together. For real paste,
copy clipboard data during the event and call `editor.captureInsertion("paste")` before starting
conversion. Call `insert(csv)` on that capture, or `cancel()` if dismissed. Remove the listener and
cancel outstanding work on detach. [Paste and decoration examples](host-integration.md#use)

**Connect a language server.** Open the [local TypeScript server demo](http://127.0.0.1:4173/?provider=server&sample=errors)
and wait for **Language ready**. In **Problems**, select the argument error and change `"10%"` to
`0.1`. The error clears. Type `cart.` on a new line and choose `map` from completion. Delete the
trial line. For a cross-file refactor, press F2 on the call to `calculateTotal`, preview a new name
and apply it. The call in `main.ts` and declaration in `pricing.ts` change together. One undo
restores both.

Create one `LspWorkspace` with stable document URIs and an `openWebSocketTransport` connection.
Attach `createLspEditor` to each editor for completion and diagnostics. For rename, use
`createLspRenameClient`, preview its captured edit, then call `applyLspWorkspaceEdit` on approval.
Dispose per-view clients on detach and the shared provider when the project closes. The local
bridge runs `typescript-language-server` and requests revision-checked diagnostics through a demo
extension. Pages uses a TypeScript worker. The **Project actions** sample has scripted actions.
[Connection example](language-server.md#use) · [Rename example](language-features.md#rename-and-workspace-edits)

For a command-based refactor, run `node --test tests/integration/demo-provider.test.ts`. Its real
server offers Extract Constant, the host reviews the incoming `workspace/applyEdit`, and undo
restores the expression. This profile is enabled only in the
[integration test](../tests/integration/demo-provider.test.ts).

**Save or run the current draft.** Open the [local two-pane host](http://127.0.0.1:4173/hosts/plain/?editor=candidate).
Type in **Primary source**, choose **Save source**, type again, then **Finish save**. The later
edit stays dirty. Pass `workspace.captureSave(source)` to `WorkspaceCommands.save` with the host’s
save port. **Run captured inputs** records the working text and settings at invocation, even
with unsaved changes. Type again, choose **Finish run** and inspect the Run to see its original
inputs. Supply a run port to `WorkspaceCommands.run` for actual execution. The fixture lets you
finish both calls by hand. For crash recovery, **Keep recovery draft** writes a separate IndexedDB
checkpoint. [Save and Run](workspace.md#save-conflicts-and-run) · [Recovery](examples.md#draft-checkpoints)

**Open a second view.** In that host, place the two carets on different lines. Type in one pane
and undo in the other. Both show the same text, each with its own selection, folds and scroll.
Mount each editor against the same document with a separate `workspace.createDocumentView(id)`
passed as `view`. Keep those handles during a remount, save scroll with `editor.captureView()` and
call `view.dispose()` when its pane closes. [Document views](workspace.md#document-views)

**Compare a revision.** Choose **Keep draft version**, select that draft under **Review version**,
edit the working text and choose **Finish version load**. The reference pane shows the captured
draft. Pass its immutable buffer and version to `mountTextComparison` and dispose the mount when
review closes. For two fixed revisions, open the [local read-only comparison](http://127.0.0.1:4173/comparison/?mode=revisions)
and choose **Next change**. Both panes allow selection and refuse edits. Use
`createTextResourceFromBuffer` with `{ edit: [], save: false, run: false }` for the second buffer.
Close its tab and release the resource when the review closes. For just the hunks, pass the buffers
to `TextDiff`. [Comparison mount](comparison.md#use) · [Two-buffer comparison](comparison.md#exact-text-and-scheduling)

**Apply an external edit.** In the same host choose **Preview proposal**, then **Apply proposal**.
Undo in either working pane restores the original. Try typing between preview and apply. The
stale proposal needs a fresh preview. Capture the document when requesting edits and submit a
single transaction on approval. The offsets refer to that captured buffer.

```ts
import type { DocumentId, TextEdit, Workspace } from "sttropez";

export function requestProposal(workspace: Workspace, documentId: DocumentId) {
    const before = workspace.document(documentId);
    return {
        buffer: before.buffer,
        accept(edits: readonly TextEdit[]) {
            return workspace.edit({
                documentId, expectedRevision: before.revision, origin: "host",
                edits, history: { kind: "proposal" }
            }).applied;
        }
    };
}
```

Drop a dismissed proposal and its capture. For a proposal tied to a particular tab or selection,
also guard its presentation with a [captured view request](host-integration.md#captured-view-requests).

## Contract

The workspace owns text and history. Each view has its own selections and scroll position. Disposing
the mount removes the editor DOM and releases its handlers, subscriptions and internally created
view. The host manages resource and service lifetimes.

| Asset or identifier | Purpose |
| --- | --- |
| `sttropez` | Headless model and workspace entry point |
| `sttropez/browser` | Editor, viewport and browser controllers |
| `sttropez/protocol` | Headless JSON-RPC and LSP clients |
| `editor.css` | Editor and controller presentation |
| `browser/regex-worker.js` | Regular-expression worker; serve the worker and its relative module graph together |
| Resource key | Distinguishes resources even when their display names match |
| Tab capture | Prevents delayed commands from following a replaced presentation target |

## Host responsibilities

In plain JavaScript, mount and dispose explicitly. In React, mount through a stable ref, read
observable handles with `useSyncExternalStore` and call controller commands from event handlers. Use
effects for listener setup and cleanup. Keep the workspace alive while a view is detached.

Store view state by document and view ID. Capture the resource, revision and tab before starting a
save or other service call. Cancel outstanding operations and release their leases before releasing
the resource. See [saving](workspace.md), [language services](language-server.md),
[host controls](host-integration.md) and [editor configuration](editor.md).

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features and device checks.
