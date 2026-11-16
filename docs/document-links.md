# Captured module document links

This page describes the default local-worker fixture. The `language=lsp` route
uses [public document-link discovery/resolve](language-features.md#document-links) with the same host
controls and captured opening policy.

Both candidate hosts offer **Add module companion**, **Discover module links**,
paged results, explicit Open buttons and **Return to link origin**. The companion
registers the module name `sample-utils` to an owned working resource. The module
import action writes a matching line, so the action-to-link-to-resource workflow
runs end to end through the actual worker. Host applications can register other
bounded aliases through the controller; a name is never resolved by future focus
or a tab's array position. Unknown modules remain visible and cannot activate.

F4 in primary, secondary or comparison working source captures discovery and
focuses the result list if the source still has focus when the result arrives.
Tab reaches a resolved link button; Enter activates it. Shift+F4 returns to the
captured source with its complete selection set. Escape in the list dismisses it
and returns focus when that origin view remains mounted. Delayed discovery leaves
new host form focus alone. A secondary-origin round trip may detach and restore
that pane through explicit host lifecycle APIs. Comparison return preserves the
secondary destination and the primary Save/Run target independently.

The worker reuses `DomainCursor`'s bounded exact-line policy: `import "module";`
on its own line, optional leading BOM, LF/CRLF and an ASCII module of at most 64
characters using letters/digits/underscore/dot/slash/hyphen with an initial letter.
This is a line fixture. It does not parse enclosing comments/templates, general
import/export syntax, modules or types. General semantic links and consuming-host
protocol/URI policy remain required. No parser dependency is added to the runtime.

The source uses the existing acknowledged project snapshots/deltas. One worker
continuation scans at most 16,384 UTF-16 units. Target aliases carry only captured
resource/document IDs, revisions and lengths; target text is not transferred or
scanned. The host retains the corresponding snapshots and resource leases. Up to
100 distinct documents and 16 Mi total captured UTF-16 units are supported, with
at most 100 aliases and 1,024 links; the view displays 64 links per page. An oversized
or incomplete result is rejected in full. Long lines retain the planner's 512-unit
prefix bound and cannot become a large preview or a whole-document export.

Every returned link must cover the exact captured line and raw UTF-16 module
range. Ranges are ordered, non-overlapping and at most 64 units. Targets must match
the captured host alias's resource ID, document ID, revision and length. A changed
or unknown target, URI string, malformed later entry or incomplete scan rejects
the entire result before presentation. Labels/tooltips are bounded plain text;
no provider HTML, URL or script executes. Activation uses the host's existing
captured-resource reveal API and checks current revisions, routes, authority and
pending input again. Read-only targets can be viewed.

Pending discovery captures the origin's complete selections, visible fold projection,
tab/view, source/target revisions and authority. Ready results are document-based;
ordinary selection/fold movement can continue, and Return is an explicit command
to restore the captured origin. Text changes, target changes, route replacement,
authority transitions, composition and view lifecycle expire old results. Capture
and activation respect pending navigation, semantic input and table conversion.
Resource leases stay owned until dismissal; core notifications latch invalidity
immediately and defer cleanup. Each reply has a 5-second deadline and the whole
request has a 30-second deadline. Failure/reconnect discards uncertain transport
state. Disposal releases fields, sessions, subscriptions, leases and workers.

Discovery and each lazy resolution use `captureViewRequest`. Ready results transfer origin
retention to resource guards before ending the discovery capture, so selection movement remains
possible. Lazy resolution captures the current view again and releases it before revealing a
validated destination. Return preserves the original discovery selection, independent of resolution.

Discovery, paging, activation and Return do not write text or add history. Later
source/target edits and action undo/redo remain independent. Immutable references
and primary Save/Run keep their identities after opening another resource.

Focused model and browser checks cover Unicode/BOM/CRLF, normal/100k sources,
action-to-link navigation, remounted origins, complete sets, unresolved/page/count
bounds, stale source/target/route/authority/tokens, safe tooltips, malformed results,
reconnect, synthetic input guards and disposal. Native IME/reconversion/dead keys,
OS/application clipboard and physical display latency remain
unverified. Command dispatch and complete discovery/reveal readiness are distinct
from actual typing-handler timings; bulk correctness is not a latency pass.
