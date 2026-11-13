# Documentation presentation

`sttropez/browser` exports `mountDocumentation`, `DocumentationContent` and
`DocumentationOptions`. A view owns its appended `.st-documentation` subtree; the host
owns popup placement, request lifetime and link policy. Call `dispose()` when that view
ends. Content is an immutable array of plaintext, Markdown or language-labelled code
parts. Reusing the same array avoids rebuilding the subtree.

```ts
const view = mountDocumentation(container, {
    canOpenLink: target => helpTopics.has(target),
    openLink: target => showHelpTopic(target),
});
view.setContent(hover.content);
// On dismissal or a changed request capture:
view.setContent([]);
// On host disposal:
view.dispose();
```

The focused Markdown subset supports paragraphs, emphasis and strong emphasis, flat
ordered/unordered lists, inline code, fenced code and inline links. Code language labels
are metadata, not executable instructions or an embedded syntax service. This is not a
complete CommonMark/GFM implementation: nested lists, headings, tables, entities,
reference links and automatic URL detection are outside the contract. Plaintext parts
preserve their literal text and line breaks. Legacy LSP code parts remain code.

The renderer creates elements and text nodes; it never inserts provider HTML. Images,
scripts and embedded content do not load or execute. Links use buttons with opaque
destinations, not navigable URLs. Without `openLink` they are inert. `canOpenLink`, when
supplied, is checked both during rendering and immediately before activation. The host
must enforce its chosen destination policy in its callback; the renderer never fetches,
normalizes or opens a URI itself. Replacing content or disposing the view retires old
link buttons. Hosts must also expire content when its captured request becomes obsolete.

The public LSP hover and signature models retain literal `text`/`documentation` fields
and expose structured `content` (including parameter content). MarkupContent preserves
its declared format; legacy hover strings are Markdown and `{language, value}` fragments
are code. The existing validation and aggregate response limits still apply. These types
are also exported from `sttropez/protocol`.

Set `markdownDocumentation: true` on `LspWorkspace`/`LspSession` when the host presents
this subset. Hover and signature negotiation then prefers Markdown to plaintext and
identifies the limited parser with no allowed HTML tags. The default remains plaintext;
completion documentation continues to advertise and display plaintext. The React fixture
retains its literal presentation. No Markdown package enters the runtime dependency graph.

In the main demo, choose **Documentation & help links**, inspect `applyDiscount`, or
request signature help within its call. Both popups render provider documentation through
the public view and fit their rendered dimensions inside the viewport. An explicit help
click opens only an HTTPS TypeScript documentation URL accepted by the demo host, with
`noopener,noreferrer`. Document/resource navigation remains a separate host operation.
