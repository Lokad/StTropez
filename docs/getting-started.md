# Getting started

Embed StTropez by creating a workspace and text resource, opening a tab, and mounting an
editor inside an empty host element. The host retains the model and owns its storage policy.

## Use

Reference the assets-only NuGet package from the project that owns your frontend. Invoke the
package's asset staging target and serve or bundle its compiled modules. Configure your
application's resolver to map `sttropez` to the staged `index.js` and `sttropez/browser` to
`browser/index.js`, with the adjacent declarations for TypeScript. The
[packaging contract](packaging.md) describes the MSBuild properties, manifest and paths.

Load the staged stylesheet and give the editor a bounded container:

```html
<link rel="stylesheet" href="./sttropez/editor.css">
<div id="editor" style="height: 400px; min-width: 0"></div>
```

In your application's TypeScript entry point:

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

Call `openDocument` when the container is attached, retain its result in the host controller,
and call `dispose` when that controller closes the document. The library modules are already
compiled; your application can use its usual TypeScript build.

## Contract

The workspace owns text and history. A tab identifies a presentation target; a mounted view
owns its independent selections and scroll state. The editor owns the supplied element's
descendants. Destroying a mount releases its subscriptions, input handlers and internally
created view. Resource retention and external service operations belong to their owners.

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

Keep the controller outside component rendering. In plain JavaScript, invoke explicit mount
and teardown functions. In React, pass stable ref callbacks supplied by that controller:
attachment mounts a view and detachment destroys it. Retain the workspace/document separately
when a view is temporarily unmounted. Components read immutable observable handles through
`useSyncExternalStore`; events invoke controller commands. Effects register and clean up
listeners rather than synchronize editor or application state.

Cancel host operations and release their leases before releasing their resources. Store view
state by document/view identity if the host remounts it. Capture resource, revision and tab
identity before awaiting storage or service work; do not use the currently focused editor as
the completion target. Treat saving as a captured operation, not a read of whichever text is
current when a server reply arrives.

For the next integration step, use [resource and save contracts](workspace.md),
[language-server integration](language-server.md), [host extension points](host-integration.md)
or [editor commands and configuration](editor.md).

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features and device checks.
