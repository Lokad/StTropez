# Examples

Open the [TypeScript demo](https://lokad.github.io/StTropez/) to edit a project, inspect its JavaScript and review changes. To embed the editor in your own app, start with the [reference host](../examples/reference/main.ts).

## Development routes

With Node 24 or later, run

```sh
npm ci
npm run demo
```

Open `http://127.0.0.1:4173/`. Set `STTROPEZ_PORT` to choose another port.

| Route | What to try |
| --- | --- |
| `/` | The TypeScript demo with editing, language tools and local saves. |
| `/reference/` | Mount an editor, find text, fold code and compare edits with the saved file. |

The development server also serves these test fixtures.

| Route | What it exercises |
| --- | --- |
| `/hosts/plain/`, `/hosts/react/` | Two views of one document with deferred saves, conflicts and remounts. Both hosts use the same [controller](../tests/fixtures/hosts/controller.ts). |
| `/editing/`, `/viewport/` | Input and selection in the editor, or scrolling and layout in a read-only view. |
| `/comparison/` | Edit the working pane or add `?mode=revisions` to compare two read-only revisions. |
| `/protocol/` | Exercise the JSON-RPC connection to a local WebSocket server. |

## TypeScript demo

1. In **Shopping cart**, change a quantity in `main.ts`. **JavaScript** shows the emitted code. **Changes** shows your edit beside the saved copy. Ctrl+S (Cmd+S on macOS) saves the sample in this browser. The demo compiles the source without running it.
2. Open **Fix a type error**. Select a row in **Problems** to jump to its source. Press Ctrl+. to request a code action. In **Unopened files & navigation**, use F12 on a symbol to follow its definition across files or F2 to preview a rename.
3. In **Large file**, turn on **View → Minimap**, drag to the middle and edit a line. Check the diff in **Changes**, then undo. To try folding on nested rules, choose **Host outline**. [Sample catalogue](../examples/demo/samples.ts)

To try regex replacement in Shopping cart, find `quantity:\s*(\d+)`, enable **Use regular expression** and replace all with `quantity: $1 + 1`. One Undo restores both quantities.

To try a save conflict, open the same sample in two tabs. Edit both and save one. In the other,
choose **Review saved copy** to compare before saving your version or accepting the saved files.
If the saved copy was removed, **Save locally** recreates it from your open project.
Reloading a tab with an unsaved checkpoint offers recovery for that sample.

<a id="provider-ownership-and-adaptations"></a>

The playground runs TypeScript in a browser worker, both locally and on GitHub Pages. The WebSocket test fixture runs a separate language server. [Language server integration](language-server.md)

## Host workflows

In either development host, edit **Primary source** and undo from **Secondary source**. Each pane keeps its selection. Edit again, then use **Toggle views** twice to detach and remount the editors.

For a conflict, edit the source, choose **Simulate external source change**, save, then choose **Finish save**.
Select **Review remote source** and **Finish remote review** to compare. To keep your edits, choose
**Save reviewed source**, then **Finish save** again.

### Draft checkpoints

Make an unsaved edit, choose **Keep recovery draft** and reload. Choose **Restore source draft**,
then **Confirm draft action**. The configuration and transfer form have separate restore actions.

### Table conversion

In the demo’s **Host integrations · paste & notes** sample, open **Code → Paste format** and choose **Insert example table**. Undo removes the inserted CSV. In a development host, enable **Paste tables as CSV** to try an HTML or tab-separated table.

### Source-backed transfer form

In a development host, choose **Insert transfer instruction** or **Anchor instruction at caret** on an existing instruction. Change a form field and undo from the editor to see the corresponding source edit. [Host integration](host-integration.md#tokenization-annotations-and-forms)

## Static build and deployment

```sh
npm run build:demo
npm run preview:demo
```

Open `http://127.0.0.1:4174/StTropez/` or set `STTROPEZ_DEMO_PORT`. Run `npm run test:demo` to check the static build. The [Pages workflow](../.github/workflows/pages.yml) publishes the root demo after CI passes. The site bundles its compiler separately from the [NuGet package](packaging.md).
