# Getting started

Mount an editor in an empty element. A workspace holds its document and undo history across mounts.

## Use

Reference the assets-only NuGet package in your frontend project and run its staging target. Serve
or bundle the compiled modules. Map `sttropez` to `index.js` and `sttropez/browser` to
`browser/index.js` with the adjacent TypeScript declarations. See
[staging paths and MSBuild properties](packaging.md).

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
        workspace, resource, editor,
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
