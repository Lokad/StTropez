# Examples

Try the [TypeScript demo](https://lokad.github.io/StTropez/) or use the
[reference host](../examples/reference/main.ts) to embed StTropez.

## Development routes

With Node 24 or later, run

```sh
npm ci
npm run demo
```

Open `http://127.0.0.1:4173/`. Override the port with `STTROPEZ_PORT`.

| Route | Purpose |
| --- | --- |
| `/` | TypeScript playground |
| `/reference/` | [Embedding walkthrough](getting-started.md#use) |
| `/hosts/plain/`, `/hosts/react/` | Shared [controller](../tests/fixtures/hosts/controller.ts), two panes, deferred saves and remount |
| `/editing/`, `/viewport/` | Input, selection, scrolling and layout |
| `/comparison/` | Edit the working copy or use `?mode=revisions` for two read-only revisions |
| `/protocol/` | Local JSON-RPC/WebSocket fixture |

## TypeScript demo

1. In **Shopping cart**, change a quantity. **JavaScript** shows emitted code without executing it. **Changes** compares against saved text. Ctrl/Cmd+S saves locally.
2. In **Fix a type error**, select the misspelled property in **Problems** and apply **Change spelling to 'quantity'**. Inspect **Changes**. In **Unopened files & navigation**, try F12 for definition or F2 for rename.
3. In **Large file**, enable **View → Minimap**, drag to the middle, edit and Undo. In **Host outline**, fold a nested rule. [Sample catalogue](../examples/demo/samples.ts)

For regex replacement in Shopping cart, enable **Use regular expression**, find `quantity:\s*(\d+)` and
replace all with `quantity: $1 + 1`. One Undo restores both quantities.

To try conflicts, edit the same sample in two tabs and save one. In the other, **Review saved copy** lets
you keep your version or take the saved files. Identical saves preserve the peer’s Undo. **Save locally**
recreates a removed save. Each Save press captures its text, even during an earlier write. Later edits stay
dirty. Reload selects this tab’s latest available draft. **Recovery version** lists alternatives for the
sample.

<a id="provider-ownership-and-adaptations"></a>

The playground runs TypeScript in a browser worker locally and on Pages. The WebSocket fixture runs a
separate server.

## Host workflows

Open `/reference/` in two tabs and edit both copies of `quote.ts`. Save one, then the other. **Changes**
shows the competing copy beside your draft. Choose **Use saved copy** to adopt it or **Save reviewed
working copy** to keep your edits. **Storage simulation** can delay or fail a write, lose its reply, or
trim trailing whitespace. With **Compare versions on write** off, the host polls for newer copies.
A write in that mode can race another tab between the last read and the write.

In either host fixture, edit **Primary source**, undo from **Secondary source** and use **Toggle views**
twice to remount. Each pane keeps its selection.

To review a conflict, edit, choose **Simulate external source change**, save and **Finish save**. Choose
**Review remote source** and **Finish remote review**. To keep your copy, choose **Save reviewed source**
and **Finish save**.

### Table conversion

In **Host integrations · paste & notes**, choose **Code → Paste format → Insert example table**. Undo
removes the CSV. In a host fixture enable **Paste tables as CSV** for HTML or tab-separated tables.

## Static build and deployment

```sh
npm run build:demo
npm run preview:demo
```

Open `http://127.0.0.1:4174/StTropez/` or set `STTROPEZ_DEMO_PORT`. `npm run test:demo` checks this build.
The [Pages workflow](../.github/workflows/pages.yml) deploys after CI. The compiler ships separately from
the [NuGet package](packaging.md).
