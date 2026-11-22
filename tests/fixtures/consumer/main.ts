import { Workspace, TextBuffer, importText, exportText, anchoredRange } from "sttropez";
import { TextDiff, WordCursor, composePositionMaps, createGraphemeCursor, planSelectionEdits, JsonRpcConnection } from "sttropez/kernels";
import { editRefusedEvent, inputConflictEvent, typedTextEvent, type TypedTextDetail, createFontAssetController, createFindController, createNavigationHistory, createRegexFindBackend, mountTextComparison, mountTextViewport, mountTextEditor } from "sttropez/browser";
import * as browserApi from "sttropez/browser";
import type { TextEditorDiagnostics, ViewportDiagnostics, ViewportSnapshot } from "sttropez/browser";
import { fontFixture } from "./font-fixture.js";
import { createSelectionSet } from "sttropez";
import type { ResourceVisibility, SaveReview } from "sttropez";
import type { CapturedInsertion, EditRefusedDetail, FindDiagnostics, FindReason, TextComparisonDiagnostics, InputConflictDetail, LinePrompt, PresentedLine, TextComparisonOptions, TextComparisonSnapshot, TextViewportOptions } from "sttropez/browser";
import { openWebSocketTransport } from "sttropez/browser";
const workspace = new Workspace();
const documentId = workspace.createDocument({ scope: "consumer", resource: "source", variant: "working" }, "Consumer source", "restored assets");
const tabId = workspace.tabs.open({ kind: "text", documentId }, "main");
const host = document.getElementById("editor");
if (!host) throw new Error("Missing editor host.");
const sourceEditor = mountTextEditor(host, workspace, tabId);
const privateInput: Exclude<"input", keyof typeof sourceEditor> = "input";
const viewport = mountTextViewport(document.getElementById("viewport")!, workspace, tabId, { ariaLabel: "Restored viewport", settings: { minimap: true } } satisfies TextViewportOptions);
const candidate = mountTextEditor(document.getElementById("candidate")!, workspace, tabId, { ariaLabel: "Restored candidate" });
candidate.decorations.addProvider({ name: "tokens", order: 0, provide: line => {
    const from = line.text.indexOf("restored"); return from < 0 ? [] : [{ from: line.from + from, to: line.from + from + 8, className: "consumer-token" }];
} });
const find = createFindController(candidate);
const comparisonResource = workspace.createTextResourceFromBuffer({ scope: "consumer", resource: "review", variant: "working" }, "Review", { buffer: TextBuffer.from("working\r\n"), serverVersion: "saved-1" });
const comparisonView = workspace.createDocumentView(comparisonResource.documentId);
const reviewDecorate = (line: PresentedLine) => [{ from: line.from, to: line.to, className: "consumer-review-token" }];
const reviewOptions: TextComparisonOptions = { view: comparisonView };
function mountReview(baseline: Parameters<typeof mountTextComparison>[3]) {
    const review = mountTextComparison(document.getElementById("comparison")!, workspace, comparisonResource.documentId, baseline, reviewOptions);
    const tokens = { name: "review tokens", order: 0, provide: reviewDecorate };
    review.panes.working.decorations.addProvider(tokens);
    review.panes.reference.decorations.addProvider(tokens);
    return review;
}
let comparison = mountReview({ buffer: TextBuffer.from("baseline\r\n"), version: "reference-1" });
function mountMultipleInput() {
    const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "multiple-input", variant: "working" }, "Multiple input", { value: "abcd" });
    const tab = model.tabs.open({ kind: "text", documentId: source.documentId }, "multiple-input"), host = document.createElement("div"); host.style.height = "200px"; document.body.append(host);
    const editor = mountTextEditor(host, model, tab, { ariaLabel: "Restored multiple input" }); editor.focus();
    editor.view.setSelections(0, [{ anchor: 0, head: 1 }, { anchor: 4, head: 3 }], 1);
    return { model, source, tab, host, editor };
}
let multipleInput: ReturnType<typeof mountMultipleInput> | undefined;
const fixture = { text: () => workspace.document(documentId).text(),
    protocolExports: () => ({ connection: typeof JsonRpcConnection, websocket: typeof openWebSocketTransport }),
    editorExports: () => ({ mount: typeof browserApi.mountTextEditor,
        root: sourceEditor.element.tagName, exposesInput: privateInput in sourceEditor,
        removed: ["mountEditingCandidate", "mountTextareaEditor", "mountViewport"].filter(name => name in browserApi),
        privateNavigation: ["visualRowAt", "navigationLine", "moveVisual", "collapseVisual", "columnAt", "caretAtColumn", "prepareNavigationRows"]
            .filter(name => name in viewport || name in sourceEditor.viewport) }),
    clipboardBoundary: () => {
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "clipboard-boundary", variant: "working" }, "Source", { value: "before\r\nend" });
        const tab = model.tabs.open({ kind: "text", documentId: source.documentId }, "clipboard"), host = document.createElement("div"); host.style.height = "160px"; document.body.append(host);
        const editor = mountTextEditor(host, model, tab), original = "before\r\nend";
        const input = editor.element.querySelector("textarea")!;
        try {
            editor.view.setSelections(0, [{ anchor: 3, head: 1 }, { anchor: 10, head: 8 }], 1); const selections = editor.view.getSnapshot().selectionSet;
            for (const type of ["copy", "cut", "paste"] as const) {
                editor.element.addEventListener(type, event => { event.clipboardData!.setData("text/plain", "host-owned"); event.preventDefault(); }, { capture: true, once: true });
                const event = new ClipboardEvent(type, { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); input.dispatchEvent(event);
                if (event.clipboardData!.getData("text/plain") !== "host-owned") throw new Error("Compiled editor overwrote host clipboard ownership.");
            }
            for (const type of ["text/plain", "text/html"]) { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); event.clipboardData!.setData(type, type === "text/html" ? "<b>no plain text</b>" : "");
                input.dispatchEvent(event); }
            const d = model.document(source.documentId);
            if (d.revision || d.buffer.slice(0, d.buffer.length) !== original || editor.view.getSnapshot().selectionSet !== selections || model.observeHistory(source.documentId).getSnapshot().undoDepth) throw new Error("Compiled canceled/empty clipboard input changed text, complete selections or history.");
            if (d.buffer.readMetrics().textExports) throw new Error("Compiled clipboard boundary exported text.");

            const targets: CapturedInsertion[] = [];
            const stop = editor.registerPasteHandler({
                accepts: data => data.types.includes("text/html"),
                paste: (_data, target) => targets.push(target),
            });
            const send = (html: boolean) => {
                const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
                const data = event.clipboardData!; data.setData("text/plain", "X");
                if (html) data.setData("text/html", "<b>X</b>");
                input.dispatchEvent(event); };
            input.addEventListener("paste", event => event.preventDefault(), { capture: true, once: true });
            send(true);
            if (targets.length || model.document(source.documentId).revision !== d.revision) throw new Error("Claimed paste reached the converter.");
            send(false);
            const raw = model.document(source.documentId);
            if (targets.length || raw.buffer.slice(0, raw.buffer.length) !== "bXore\r\nXd") throw new Error("Declined paste did not retain literal editing.");
            model.undo({ documentId: raw.id, expectedRevision: raw.revision });
            send(true); const target = targets[0];
            if (!target || !target.isCurrent() || target.documentId !== source.documentId || target.selectionSet !== editor.view.getSnapshot().selectionSet)
                throw new Error("Converted paste did not capture the restored editor selections.");
            stop(); if (!target.signal.aborted || target.insert("stale") || editor.activity().pendingInput)
                throw new Error("Detached paste handler kept its insertion.");
        } finally { editor.dispose(); host.remove(); model.tabs.close(tab); model.releaseResource(source.id, true); }
        const { views, leases, subscriptions } = model.diagnostics(); if (views || leases || subscriptions) throw new Error("Compiled clipboard resources leaked.");
        return { cancelledOwnership: true, emptyPayloadNoDeletion: true, completeSets: true, noHistory: true, zeroExports: true, events: "synthetic", released: { views, leases, subscriptions } };
    },
    foldingPilot: async () => {
        const original = "header\r\n" + "const unchanged = 123;\r\n".repeat(100000) + "footer", footer = original.length - 6;
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "folding", variant: "working" }, "Folded source", { value: original });
        const tab = model.tabs.open({ kind: "text", documentId: source.documentId }, "folded"), view = model.createDocumentView(source.documentId), peer = model.createDocumentView(source.documentId);
        const host = document.createElement("div"), otherHost = document.createElement("div"); host.style.height = "180px"; otherHost.style.height = "180px"; document.body.append(host, otherHost);
        let reply!: (line: number) => void, promptSignal!: AbortSignal;
        const requestLine: LinePrompt = ({ signal }) => { promptSignal = signal; return new Promise<number>(resolve => { reply = resolve; }); };
        const options = { view, ariaLabel: "Restored folding", requestLine };
        let editor = mountTextEditor(host, model, tab, options);
        const other = mountTextEditor(otherHost, model, tab, { view: peer, ariaLabel: "Restored fold peer" });
        const wait = async () => { const deadline = performance.now() + 10000;
            while ([editor, other].some(e => { const s = e.activity(), p = e.viewport.activity(); return s.pendingCaret || s.pendingWord || s.pendingGrapheme || s.pendingDragScroll || p.pending
                || p.revision !== model.document(source.documentId).revision || p.selectionSet !== e.view.getSnapshot().selectionSet || p.foldGeneration !== e.view.folding.getSnapshot().generation; })) {
                if (performance.now() > deadline) throw new Error("Compiled folding did not settle."); await new Promise(resolve => setTimeout(resolve, 0));
            } };
        const exact = () => { const b = model.document(source.documentId).buffer; if (b.length !== original.length) throw new Error("Compiled fold undo changed length.");
            for (let from = 0; from < original.length; from += 32768) if (b.slice(from, Math.min(b.length, from + 32768)) !== original.slice(from, from + 32768)) throw new Error("Compiled fold undo changed text."); };
        try {
            view.setSelections(0, [{ anchor: 0, head: 0 }, { anchor: original.length, head: original.length }]);
            const initial = view.folding.getSnapshot();
            const body = { id: "body", from: 0, to: footer, group: "blocks" };
            if (!view.folding.setRanges(initial, [body]) || view.folding.setCollapsed(initial, "body", true)) throw new Error("Compiled folding did not enforce captured versions.");
            const discovery = browserApi.createFoldingController(editor, () => [body]);
            try {
                const command = editor.commands.get("fold.collapse-all", "blocks");
                if (!command?.enabled || editor.commands.run(command.id, "imports") || !editor.commands.run(command.id, "blocks"))
                    throw new Error("Restored grouped folding did not use the editor's command registry.");
            } finally { discovery.dispose(); }
            if (editor.commands.get("fold.collapse-all")) throw new Error("Disposed fold command remained in the menu.");
            editor.focus(); await wait();
            if (editor.viewport.getDiagnostics().rows !== 2 || editor.viewport.getDiagnostics().visibleLines !== 2 || peer.folding.getSnapshot().index.collapsedCount) throw new Error("Compiled folded projection is not bounded or independent.");
            const summary = host.querySelector<HTMLElement>(".st-fold-summary");
            if (!summary || !getComputedStyle(summary, "::after").content.includes("100000 lines hidden") || getComputedStyle(summary).pointerEvents !== "auto")
                throw new Error("Restored assets did not present a clickable hidden-line count.");
            // This synthetic dispatch proves the shipped command route; native device qualification is separate.
            editor.element.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await wait();
            if (view.getSnapshot().selection.head !== footer || view.getSnapshot().selectionSet.ranges.length !== 2) throw new Error("Compiled folded navigation lost a target or secondary caret.");
            const at = Math.floor(footer / 2);
            view.setSelections(0, [{ anchor: at, head: at }, { anchor: original.length, head: original.length }]);
            if (!view.folding.setCollapsed(view.folding.getSnapshot(), ["body"], true, { moveHiddenCarets: true })
                || view.getSnapshot().selection.head !== "header".length || view.getSnapshot().selectionSet.ranges[1]?.head !== original.length)
                throw new Error("Compiled collapse did not keep insertion carets on visible rows.");
            let forwarded = false;
            const stop = model.onDocumentChange(source.documentId, (change, afterDelivery) => {
                afterDelivery(() => {
                    const edit = change.edits[0];
                    forwarded = change.source === "fold-pilot" && change.previousRevision === 0 && change.revision === 1
                        && edit?.from === at && edit.to === at && edit.insert === "x\r\n";
                });
            });
            try {
                model.transact(source.documentId, 0, tx => {
                    tx.edit([{ from: at, to: at, insert: "x" }]);
                    tx.edit([{ from: at + 1, to: at + 1, insert: "\r\n" }]);
                }, { origin: "host", source: "fold-pilot", history: "record" });
                await wait();
                if (!forwarded) throw new Error("Restored change subscription lost the edit or its provenance.");
            } finally { stop(); }
            if (editor.viewport.getDiagnostics().visibleLines !== 2) throw new Error("Compiled folded edit exposed hidden rows.");
            model.undo({ documentId: source.documentId, expectedRevision: 1 }); await wait(); exact();
            const saved = editor.captureView(), retired = editor;
            let replyAfterRemount!: () => void;
            const delivered: string[] = [];
            const pending = editor.operation({ write: true }, async op => {
                op.apply({ edits: [{ from: 0, to: 0, insert: "expired" }] });
                await op.step(new Promise<void>(resolve => { replyAfterRemount = resolve; }), () => { delivered.push("retired"); });
            });
            let jumpCalls = 0;
            const open = editor.commands.register({ id: "sample.jump", label: "Jump to line", run: () => { jumpCalls++; return retired.commands.run("go-to-line"); } });
            if (!editor.commands.list().some(entry => entry.id === "sample.jump" && entry.enabled)) throw new Error("Restored command missing from menu.");
            let conflict = false;
            try { editor.keymap.bind("Ctrl+g", "sample.jump"); } catch { conflict = true; }
            if (!conflict) throw new Error("A host binding silently replaced the default Go to line shortcut.");
            const binding = editor.keymap.bind("Alt+j", "sample.jump", { shared: true, repeat: false });
            if (editor.keymap.getShortcuts("sample.jump").join() !== "Alt+j") throw new Error("Restored keymap reported the wrong host shortcut.");
            const jump = (repeat = false) => new KeyboardEvent("keydown", { key: "j", altKey: true, cancelable: true, repeat });
            if (!editor.keymap.handle(jump())) throw new Error("Restored shared shortcut did not request the host prompt.");
            if (!editor.keymap.handle(jump(true)) || jumpCalls !== 1) throw new Error("Holding the shared shortcut requested another prompt.");
            editor.dispose();
            editor = mountTextEditor(host, model, tab, options); editor.restoreView(saved); editor.focus(); await wait();
            binding.dispose(); open.dispose();
            if (retired.keymap.getShortcuts("sample.jump").length || retired.keymap.handle(jump()) || retired.commands.run("sample.jump") || editor.keymap.handle(jump()))
                throw new Error("Retired host command survived editor replacement.");
            if ((await pending).status !== "stale") throw new Error("A retired editor kept its pending edit.");
            replyAfterRemount();
            await editor.operation({}, op => op.step(Promise.resolve("current"), value => { delivered.push(value); }));
            if (delivered.join() !== "current") throw new Error("Operation delivery reached the wrong editor after remount.");
            if (!promptSignal.aborted) throw new Error("Retired view left its line request active.");
            reply(200); await Promise.resolve();
            if (editor.viewport.getDiagnostics().visibleLines !== 2 || view.getSnapshot().selectionSet.ranges.length !== 2) throw new Error("Compiled remount lost folds or complete selections.");
            const fresh = model.createDocumentView(source.documentId), freshHost = document.createElement("div"); freshHost.style.height = "180px"; document.body.append(freshHost);
            const restored = mountTextEditor(freshHost, model, tab, { view: fresh });
            try {
                const report = restored.restoreView(saved); restored.viewport.flush();
                if (!report?.foldsRestored || report.selection !== "captured" || fresh.folding.getSnapshot().index.visibleLineCount !== 2)
                    throw new Error("Compiled fresh view did not restore captured folds and selection.");
                const current = fresh.folding.getSnapshot(); fresh.folding.setCollapsed(current, "body", false); restored.restoreView(saved);
                if (fresh.folding.getSnapshot().index.collapsedCount) throw new Error("A stale capture overwrote newer fold state.");
            } finally { restored.dispose(); fresh.dispose(); freshHost.remove(); }
            const buffer = model.document(source.documentId).buffer, line = buffer.lineAt(at), start = buffer.offsetAt(line);
            editor.commands.run("go-to-line"); reply(line + 1); await Promise.resolve(); await wait();
            if (view.getSnapshot().selection.head !== start || view.folding.getSnapshot().index.collapsedCount || !editor.viewport.coordsAt(start)) throw new Error("Compiled line navigation did not reveal its folded destination.");
            if (model.document(source.documentId).buffer.readMetrics().textExports) throw new Error("Compiled folding exported the source value.");
            const revealed = editor.reveal({ line, column: 1 }, { align: "start", select: true });
            editor.viewport.flush();
            if (revealed?.from !== start + 1 || revealed.to !== revealed.from || !editor.viewport.coordsAt(revealed.from)
                || view.getSnapshot().selection.head !== revealed.from) throw new Error("Restored public reveal missed its selected column.");
            if (retired.reveal({ from: 0, to: 1 }, { select: true, focus: true }) !== null || retired.viewport.coordsAt(0) !== undefined)
                throw new Error("Retired compiled editor still accepted navigation.");
            const history = createNavigationHistory(model);
            try {
                const point = history.capture(editor);
                if (!point || point.visit(() => false) || history.getSnapshot() || history.capture(retired))
                    throw new Error("A failed or retired visit entered Return history.");
                other.focus();
                if (!point.visit(() => !!editor.reveal({ from: 0, to: 0 }, { select: true })) || history.back(() => "busy") !== "busy"
                    || history.getSnapshot() !== 1 || history.back(() => editor) !== "restored" || view.getSnapshot().selection.head !== start + 1
                    || !other.getSnapshot().focused)
                    throw new Error("The restored consumer lost a deferred Return.");
                const before = peer.getSnapshot().selectionSet;
                point.visit(() => !!other.reveal({ from: 0, to: 0 }));
                if (history.back(() => other) !== "empty" || peer.getSnapshot().selectionSet !== before)
                    throw new Error("Return changed a different view of the same document.");
                point.visit(() => !!other.reveal({ from: 0, to: 0 }));
                model.tabs.replace(tab, { kind: "text", documentId: source.documentId });
                const unexpected = (): never => { throw new Error("Navigation used a replaced tab."); };
                if (history.back(unexpected) !== "empty" || point.visit(unexpected)) throw new Error("A replaced tab retained an origin.");
            } finally { history.dispose(); }
        } finally { editor.dispose(); other.dispose(); host.remove(); otherHost.remove(); view.dispose(); peer.dispose(); model.tabs.close(tab); model.releaseResource(source.id, true); }
        if (editor.viewport.coordsAt(0) !== undefined) throw new Error("Released compiled geometry queried a missing source.");
        const { views, leases, subscriptions } = model.diagnostics(); if (views || leases || subscriptions) throw new Error("Compiled fold resources leaked.");
        return { units: original.length, visibleRows: 2, independentViews: true, capturedVersions: true, completeSets: true, navigation: true,
            mappedUndo: true, retainedRemount: true, freshRestore: true, newerStatePreserved: true, revealedSelection: true, zeroCompleteExports: true,
            disposedGeometryInert: true, keyboardDispatch: "synthetic-event", released: { views, leases, subscriptions } };
    },
    regexPilot: async () => {
        const original = "foobar foo foo_ K k K_ 𐐀 𐐨\r\n" + "const unchanged = 123;\r\n".repeat(100000);
        const expected = "[foobar] [foo] foo_ [K] [k] K_ [𐐀] [𐐨]\r\n" + original.slice(original.indexOf("\n") + 1);
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "regex", variant: "working" }, "Regex", { value: original });
        const tab = model.tabs.open({ kind: "text", documentId: source.documentId }, "regex"), host = document.createElement("div"); host.style.height = "160px"; document.body.append(host);
        let workers = 0;
        const editor = mountTextEditor(host, model, tab, { ariaLabel: "Restored regex" }), find = createFindController(editor, {
            regularExpressionBackend: createRegexFindBackend({ clock: window, createWorker: () => { workers++; return new Worker("/regex-worker.js", { type: "module" }); } }) });
        const wait = async (status: "ready" | "failed") => {
            const deadline = performance.now() + 30000;
            while (find.getSnapshot().status !== status) {
                if (performance.now() > deadline || find.getSnapshot().status === "failed" && status !== "failed") throw new Error(find.getSnapshot().message || "Compiled regex did not complete.");
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        };
        const exact = (text: string) => { const b = model.document(source.documentId).buffer; if (b.length !== text.length) throw new Error("Compiled regex length mismatch.");
            for (let from = 0; from < text.length; from += 32768) if (b.slice(from, Math.min(text.length, from + 32768)) !== text.slice(from, from + 32768)) throw new Error("Compiled regex text mismatch."); };
        let measurements: FindDiagnostics;
        try {
            find.setQuery("(?<value>foo|foobar|k|𐐨)"); await wait("ready"); if (workers || find.getSnapshot().count) throw new Error("Literal mode started a regex worker.");
            const buffer = model.document(source.documentId).buffer, beforeReveal = editor.view.getSnapshot();
            editor.viewport.revealRange(buffer.offsetAt(50000), buffer.offsetAt(50003)); editor.viewport.flush();
            const scrolled = editor.viewport.getSnapshot().scrollTop;
            editor.viewport.revealRange(buffer.offsetAt(50001), buffer.offsetAt(50002)); editor.viewport.flush();
            if (!scrolled || editor.viewport.getSnapshot().scrollTop !== scrolled || editor.view.getSnapshot() !== beforeReveal)
                throw new Error("Restored range reveal moved a visible result or changed the selection.");
            find.setQuery("foobar", { preview: true }); await wait("ready"); editor.viewport.flush();
            if (find.getSnapshot().current !== 0 || editor.viewport.getSnapshot().scrollTop > editor.viewport.getSnapshot().lineHeight || editor.view.getSnapshot() !== beforeReveal)
                throw new Error("Restored Find did not preview the offscreen match independently of selection.");
            if (!find.next() || find.getSnapshot().wrappedTo !== null || !find.next() || find.getSnapshot().wrappedTo !== "start")
                throw new Error("Restored Find did not select the preview and then wrap.");
            find.setFlags({ regularExpression: true, matchCase: false, wholeWord: true }); find.setQuery("(?<value>foo|foobar|k|𐐨)"); await wait("ready");
            if (find.getSnapshot().count !== 6 || workers < 1) throw new Error("Compiled regex worker was not used.");
            editor.view.setSelections(0, [{ anchor: 0, head: 6 }, { anchor: original.length, head: original.length }], 1);
            const selected = editor.view.getSnapshot().selectionSet;
            find.replaceAll("[$<value>]"); await wait("ready"); exact(expected);
            measurements = find.getDiagnostics();
            if (model.observeHistory(source.documentId).getSnapshot().undoDepth !== 1) throw new Error("Compiled regex replacement was not atomic.");
            model.undo({ documentId: source.documentId, expectedRevision: model.document(source.documentId).revision }); await wait("ready"); exact(original);
            if (JSON.stringify(editor.view.getSnapshot().selectionSet) !== JSON.stringify(selected)) throw new Error("Compiled regex undo lost selections.");
            const d = model.document(source.documentId); model.edit({ documentId: source.documentId, expectedRevision: d.revision, origin: "host", edits: [{ from: 0, to: d.buffer.length, insert: "😀x\r\nlast" }] });
            find.setFlags({ regularExpression: true, wholeWord: false, matchCase: true }); find.setQuery("(?:)"); await wait("ready");
            editor.view.setSelection(model.document(source.documentId).revision, { anchor: 0, head: 0 });
            for (const head of [0, 2, 3, 4, 5, 6, 7, 8, 9, 0]) { find.next(); await new Promise(resolve => setTimeout(resolve, 0));
                if (editor.view.getSnapshot().selection.head !== head) throw new Error("Compiled zero-width navigation lost a raw position."); }
            editor.viewport.flush(); const point = editor.viewport.coordsAt(4);
            if (!point || point.offset !== 4) throw new Error("Compiled CRLF caret has no painted position.");
            find.replaceAll("|"); await wait("ready"); exact("|😀|x|\r|\n|l|a|s|t|");
            find.setQuery("("); await wait("failed"); exact("|😀|x|\r|\n|l|a|s|t|");
            if (!/^Invalid regular expression: \S/.test(find.getSnapshot().message ?? "")) throw new Error("Compiled regex lost the syntax error detail.");
            if (model.document(source.documentId).buffer.readMetrics().textExports) throw new Error("Compiled regex exported the model value.");
        } finally { find.dispose(); editor.dispose(); host.remove(); model.tabs.close(tab); model.releaseResource(source.id, true); }
        const { views, leases, subscriptions } = model.diagnostics(); if (views || leases || subscriptions) throw new Error("Compiled regex resources leaked.");
        if (editor.viewport.coordsAt(4) !== undefined) throw new Error("Disposed compiled viewport still exposes geometry.");
        return { measurements, terminalMeasurements: find.getDiagnostics(), actualWorker: workers > 0, workerCount: workers, units: original.length, atomicReplacement: true, completeSelectionUndo: true,
            rawZeroWidthNavigation: true, crlfCaretProjection: true, disposedGeometryInert: true, syntaxFailureSafe: true, zeroCompleteExports: true, released: { views, leases, subscriptions } };
    },
    findAuthority: async () => {
        const cases = [];
        for (const change of ["permission", "lease"] as const) {
            const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "find-authority", variant: "working" }, "Captured find", { value: "cat cat" });
            const tab = model.tabs.open({ kind: "text", documentId: source.documentId }, "find"), host = document.createElement("div"); host.style.height = "160px"; document.body.append(host);
            const editor = mountTextEditor(host, model, tab, { ariaLabel: "Restored captured find" }), find = createFindController(editor);
            const ready = async () => { for (let turn = 0; find.getSnapshot().status !== "ready"; turn++) {
                if (turn >= 1000) throw new Error("Compiled find did not settle."); await new Promise<void>(resolve => setTimeout(resolve, 1)); } };
            try {
                find.setQuery("cat"); await ready(); editor.view.setSelections(0, [{ anchor: 0, head: 3 }, { anchor: 7, head: 7 }]);
                const selected = editor.view.getSnapshot().selectionSet, before = model.document(source.documentId), subscriptions = model.diagnostics().subscriptions;
                find.replaceAll("dog");
                if (change === "permission") { const policy = source.metadata.getSnapshot().capabilities; model.setCapabilities(source.id, { ...policy, edit: ["host"] }); model.setCapabilities(source.id, policy); }
                else { const lease = model.acquireEditLease(source.id, "consumer", "host"); lease.release(); }
                await ready();
                const reason: FindReason | null = find.getSnapshot().reason;
                if (model.document(source.documentId).buffer !== before.buffer || reason !== "editing-unavailable"
                    || model.observeHistory(source.documentId).getSnapshot().undoDepth !== 0 || model.diagnostics().subscriptions !== subscriptions
                    || JSON.stringify(editor.view.getSnapshot().selectionSet) !== JSON.stringify(selected)) throw new Error("Interrupted compiled replacement resumed.");
                find.replaceAll("dog"); if (find.getSnapshot().reason !== null) throw new Error("Compiled retry retained an old notice.");
                await ready(); const changed = model.document(source.documentId);
                if (changed.buffer.slice(0, 7) !== "dog dog" || model.observeHistory(source.documentId).getSnapshot().undoDepth !== 1
                    || find.getSnapshot().reason !== "replaced") throw new Error("Fresh compiled retry failed.");
                model.undo({ documentId: source.documentId, expectedRevision: changed.revision }); await ready();
                if (model.document(source.documentId).buffer.slice(0, 7) !== "cat cat" || JSON.stringify(editor.view.getSnapshot().selectionSet) !== JSON.stringify(selected)) throw new Error("Compiled retry undo lost selections.");
                find.replaceAll("cat"); await ready();
                if (model.diagnostics().subscriptions !== subscriptions || model.document(source.documentId).buffer.readMetrics().textExports !== 0) throw new Error("Compiled replacement retained idle observation or exported text.");
            } finally { find.dispose(); editor.dispose(); host.remove(); model.tabs.close(tab); model.releaseResource(source.id, true); }
            const { views, leases, subscriptions } = model.diagnostics();
            if (views || leases || subscriptions) throw new Error("Compiled find resources leaked.");
            cases.push({ change, cancelled: true, explicitRetry: true, sharedUndoSets: true, noOpReleased: true, zeroCompleteExports: true, released: { views, leases, subscriptions } });
        }
        return { cases, source: "restored-compiled-assets", nativeQualified: false };
    },
    beginMultipleInput: () => { if (multipleInput) throw new Error("Multiple input already mounted."); multipleInput = mountMultipleInput(); },
    orderedInput: async () => {
        const results = [];
        for (const kind of ["many-carets", "long-word", "pointer-word", "paste-word"]) {
            const original = kind === "many-carets" ? Array<string>(100000).fill("0123456789").join("\r\n") : kind === "pointer-word" ? "x".repeat(2400000) : "a".repeat(1000001) + ";end";
            const heads = kind === "many-carets" ? Array.from({ length: 1024 }, (_, i) => i * 80 * 12 + 4) : [0];
            const destinations = kind === "many-carets" ? heads.map(head => head + 12) : [1000001], text = kind === "paste-word" ? "😀é\r\n" : "😀é";
            const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: kind, variant: "working" }, kind, { value: original });
            const tab = model.tabs.open({ kind: "text", documentId: source.documentId }, kind), host = document.createElement("div"); host.style.height = "200px"; document.body.append(host);
            const editor = mountTextEditor(host, model, tab, { ariaLabel: "Restored ordered input" }), recovered: string[] = [];
            const input = editor.element.querySelector("textarea")!;
            const typed: TypedTextDetail[] = [];
            if (kind === "paste-word") editor.registerPasteHandler({ accepts: () => true, paste: (_data, target) => { target.insert("out of order"); } });
            host.addEventListener(typedTextEvent, event => typed.push((event as CustomEvent<TypedTextDetail>).detail));
            editor.element.addEventListener(inputConflictEvent, event => recovered.push((event as CustomEvent<InputConflictDetail>).detail.attemptedText));
            const ready = async () => { for (let turn = 0; ; turn++) { const s = editor.activity();
                if (!s.pendingInput && !s.pendingWord && !s.pendingGrapheme && !s.pendingCaret && !editor.viewport.activity().pending) return;
                if (turn >= 4000) throw new Error("Compiled ordered input did not settle."); await new Promise<void>(resolve => setTimeout(resolve, 1)); } };
            const command = () => {
                if (kind !== "pointer-word") return input.dispatchEvent(new KeyboardEvent("keydown", { key: kind === "many-carets" ? "ArrowDown" : "ArrowRight", ctrlKey: kind === "long-word" || kind === "paste-word", bubbles: true, cancelable: true }));
                const point = editor.viewport.coordsAt(8); if (!point) throw new Error("Missing compiled word point.");
                return editor.element.dispatchEvent(new MouseEvent("dblclick", { button: 0, clientX: point.left + 1, clientY: point.top + point.height / 2, bubbles: true, cancelable: true }));
            };
            const type = () => {
                if (kind === "paste-word") { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
                    if (!event.clipboardData) throw new Error("Missing compiled clipboard fixture data."); event.clipboardData.setData("text/plain", text);
                    if (input.dispatchEvent(event)) throw new Error("Compiled paste was not captured."); }
                else if (input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }))) throw new Error("Compiled input was not captured.");
            };
            try {
                editor.focus(); editor.view.setSelections(0, heads.map(head => ({ anchor: head, head })), heads.length - 1); await ready(); command(); type();
                if (!editor.activity().pendingInput || model.document(source.documentId).revision !== 0 || typed.length) throw new Error("Compiled command failed to yield/capture input.");
                await ready(); const changed = model.document(source.documentId), parts: string[] = []; let from = 0;
                if (kind !== "paste-word" && (typed[0]?.text !== text || typed[0].documentId !== source.documentId || typed[0].revision !== changed.revision
                    || typed[0].selectionSet !== editor.view.getSnapshot().selectionSet || !Object.isFrozen(typed[0]))) throw new Error("Compiled typing reported the wrong committed input.");
                for (const head of destinations) { parts.push(original.slice(from, head), kind === "paste-word" ? text.replace("\r\n", "\n") : text); from = head; } parts.push(original.slice(from)); const expected = kind === "pointer-word" ? text : parts.join("");
                if (changed.buffer.length !== expected.length) throw new Error("Compiled ordered input length changed.");
                for (let at = 0; at < expected.length; at += 32768) if (changed.buffer.slice(at, Math.min(expected.length, at + 32768)) !== expected.slice(at, at + 32768)) throw new Error("Compiled input used the wrong destination.");
                if (model.observeHistory(source.documentId).getSnapshot().undoDepth !== 1 || changed.buffer.readMetrics().textExports !== 0 || recovered.length) throw new Error("Compiled input lost history/bounds.");
                model.undo({ documentId: source.documentId, expectedRevision: changed.revision }); await ready();
                if (editor.view.getSnapshot().selectionSet.ranges.some((range, i) => kind === "pointer-word" ? range.anchor !== 0 || range.head !== original.length : range.anchor !== destinations[i] || range.head !== destinations[i])) throw new Error("Compiled undo lost moved selections.");
                const document = model.document(source.documentId); editor.view.setSelections(document.revision, heads.map(head => ({ anchor: head, head })), heads.length - 1); await ready(); command(); type(); editor.dispose();
                if (recovered.length !== 1 || recovered[0] !== text || model.document(source.documentId).buffer !== document.buffer) throw new Error("Compiled detach lost pending input.");
                if (typed.length !== (kind === "paste-word" ? 0 : 1)) throw new Error("Paste, Undo or a cancelled input produced a typing event.");
            } finally { editor.dispose(); host.remove(); model.tabs.close(tab); model.releaseResource(source.id, true); }
            const { views, leases, subscriptions } = model.diagnostics(); if (views || leases || subscriptions) throw new Error("Compiled ordered input leaked.");
            results.push({ kind, exactText: true, sharedHistory: true, detachRecovery: true, exports: 0, released: { views, leases, subscriptions } });
        }
        return { cases: results, source: "restored-compiled-assets", nativeQualified: false };
    },
    multipleInput: () => { const { model, source, editor } = multipleInput!, document = model.document(source.documentId), state = editor.getDiagnostics(), viewport = editor.viewport.getDiagnostics();
        return { text: document.buffer.slice(0, document.buffer.length), selectionSet: editor.view.getSnapshot().selectionSet, revision: document.revision,
            pending: state.pendingCaret || state.pendingGrapheme || state.pendingWord || viewport.pending, commits: state.commits, exports: document.buffer.readMetrics().textExports }; },
    prepareMultipleEnd: () => { const { model, source, editor } = multipleInput!, before = model.document(source.documentId);
        const result = model.edit({ documentId: source.documentId, expectedRevision: before.revision, origin: "human",
            edits: [{ from: 0, to: before.buffer.length, insert: "a\r\nb\r" }], view: editor.view,
            selectionSet: createSelectionSet(5, [{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }]), history: { kind: "replace" } });
        if (!result.applied) throw new Error("End target setup rejected."); },
    finishMultipleInput: () => { const { model, source, tab, host, editor } = multipleInput!; editor.dispose(); host.remove(); model.tabs.close(tab); model.releaseResource(source.id, true); multipleInput = undefined;
        return { views: model.diagnostics().views, leases: model.diagnostics().leases }; },
    readonlyIndent: async (outdent: boolean) => {
        const model = new Workspace(), text = "    const sample = 1;\r\n".repeat(1024), source = model.createTextResource({ scope: "consumer", resource: "readonly-indent", variant: "working" }, "Locked command", { value: text });
        const tab = model.tabs.open({ kind: "text", documentId: source.documentId }, "locked-command"), host = document.createElement("div"); host.style.height = "200px"; document.body.append(host);
        const editor = mountTextEditor(host, model, tab, { ariaLabel: "Restored locked command" });
        const input = editor.element.querySelector("textarea")!;
        try {
            const refusals: EditRefusedDetail["reason"][] = [];
            const observed: (EditRefusedDetail["reason"] | null)[] = [];
            const initial = editor.getSnapshot();
            editor.subscribe(() => observed.push(editor.getSnapshot().readOnlyReason));
            host.addEventListener(editRefusedEvent, event => {
                const detail = (event as CustomEvent<EditRefusedDetail>).detail;
                if (detail.documentId !== source.documentId || !Object.isFrozen(detail) || detail.reason !== editor.element.dataset.readOnly)
                    throw new Error("Refusal did not identify the mounted document and its current authority.");
                refusals.push(detail.reason);
            }, { signal: editor.signal });
            editor.view.setSelection(0, { anchor: 0, head: text.length });
            if (editor.getSnapshot() !== initial || !Object.isFrozen(initial) || initial.disabled || initial.readOnlyReason !== null)
                throw new Error("A selection changed editor focus or authority.");
            model.setCapabilities(source.id, { edit: ["host"], save: true });
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
            const before = model.observeHistory(source.documentId).getSnapshot(); let lockedAtHandler = false;
            input.addEventListener("keydown", () => { lockedAtHandler = editor.getSnapshot().readOnlyReason === "read-only";
                queueMicrotask(() => model.setCapabilities(source.id, { edit: ["human", "host"], save: true })); }, { once: true });
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: outdent, bubbles: true, cancelable: true }));
            await new Promise<void>(resolve => { let turns = 16; const step = () => { if (--turns) setTimeout(step, 0); else resolve(); }; setTimeout(step, 0); });
            const lease = model.acquireEditLease(source.id, "consumer", "host");
            try { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })); }
            finally { lease.release(); }
            if (editor.element.hasAttribute("data-read-only") || editor.getSnapshot().readOnlyReason !== null
                || JSON.stringify(observed) !== JSON.stringify(["read-only", null, "edit-locked", null]))
                throw new Error("Restored editor did not publish each permission and edit-lease transition.");
            const current = model.document(source.documentId);
            return { outdent, lockedAtHandler, refusals, revision: current.revision, sameText: current.buffer.slice(0, text.length) === text,
                undoBefore: before.undoDepth, undoAfter: model.observeHistory(source.documentId).getSnapshot().undoDepth, exports: current.buffer.readMetrics().textExports };
        } finally { editor.dispose(); host.remove(); model.tabs.close(tab); model.releaseResource(source.id, true); }
    },
    saveReview: async () => {
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "retry", variant: "working" }, "Retry", { value: "base", serverVersion: "v0" });
        const doc = model.document(source.documentId);
        const proposal = model.replaceText(doc.id, "merged", { expectedRevision: doc.revision, origin: "agent", history: "record", kind: "proposal" });
        if (!proposal.applied || !proposal.changed) throw new Error("Restored proposal did not replace the text.");
        const first = model.captureSave(source);
        try { first.start(); first.conflict(); } finally { first.finish(); }
        const baselineBefore = source.metadata.getSnapshot().serverVersion;
        const review: SaveReview = { target: model.captureResource(source.id), expectedRevision: source.getSnapshot().revision, expectedServerVersion: "v1" };
        const retry = model.captureSave(source, review);
        let precondition: string | null, savedValue: string;
        try {
            const submission = retry.start();
            precondition = submission.expectedServerVersion;
            model.edit({ documentId: source.documentId, expectedRevision: submission.revision, origin: "human", edits: [{ from: 6, to: 6, insert: " later" }] });
            savedValue = retry.accept({ serverVersion: "v2" }).savedValue;
        } finally { retry.finish(); }
        const textAfter = model.document(source.documentId).text(), dirtyAfter = source.metadata.getSnapshot().dirty;
        model.undo({ documentId: source.documentId, expectedRevision: source.getSnapshot().revision });
        return { baselineBefore, precondition, savedValue, textAfter, dirtyAfter, cleanAfterUndo: !source.metadata.getSnapshot().dirty,
            serverVersion: source.metadata.getSnapshot().serverVersion, leases: model.ownership(source.id).leases };
    },
    graphemes: () => {
        const buffer = TextBuffer.from("🇦🇧👩‍💻\r\n"), cursor = createGraphemeCursor(buffer);
        let step = cursor.next(256); while (step.status === "running") step = cursor.next(256);
        const index = step.result!; cursor.dispose();
        return { version: index.unicodeVersion, boundaries: index.boundaries(), coordinate: index.source.kind,
            released: cursor.snapshot().result === null, exports: buffer.readMetrics().textExports };
    },
    font: async () => {
        const bytes = fontFixture(), before = document.fonts.size, asset = createFontAssetController(document, "consumer-font");
        try {
            const operation = asset.request(0, bytes)!; bytes.fill(0);
            const result = await operation.settled, current = asset.getSnapshot().current!;
            const context = document.createElement("canvas").getContext("2d")!; context.font = `100px ${current.family}`;
            const captured = { status: result.status, current: asset.isCurrent(current.generation), width: context.measureText("A").width };
            asset.dispose(); return { ...captured, released: document.fonts.size === before };
        } finally { asset.dispose(); }
    },
    comparison: () => { const review: TextComparisonSnapshot = comparison.getSnapshot(), s = review.comparison, reference = comparison.panes.reference;
        const visibility: ResourceVisibility | undefined = workspace.resourceForDocument(reference.view.documentId).metadata.getSnapshot().visibility;
        const inventory = workspace.getSnapshot();
        const measurements: TextComparisonDiagnostics = comparison.getDiagnostics();
        return { measurements, status: s.status, generation: s.generation, count: s.hunks.length, version: s.baseline?.version,
        internalBaseline: visibility === "internal" && !inventory.documents.some(document => document.id === reference.view.documentId)
            && reference.tab === undefined,
        selectedHunk: review.selectedHunk, canNavigate: review.canNavigate, canRevert: review.canRevert,
        viewId: comparisonView.id, selection: comparisonView.getSnapshot().selection, reference: comparison.panes.reference.viewport.getDiagnostics(), working: comparison.panes.working.viewport.getDiagnostics() }; },
    hunkAt: (index: number) => comparison.hunkAt(index),
    remountComparison: () => {
        const baseline = comparison.controller.getSnapshot().baseline!, state = comparison.panes.working.captureView();
        comparison.dispose(); const retained = workspace.ownsDocumentView(comparisonView);
        comparison = mountReview(baseline);
        comparison.panes.working.restoreView({ ...state, ...comparisonView.getSnapshot().selection }); return retained;
    },
    acceptComparison: () => { const t = comparison.controller.beginAcceptance(); return t.complete({ buffer: t.capture.working.buffer, version: "accepted-2" }); },
    diff: () => { const d = new TextDiff(TextBuffer.from("a\r\n"), TextBuffer.from("a\n"));
        try { let s = d.next(512); while (s.status === "running") s = d.next(512); return { status: s.status, whitespaceOnly: s.hunks[0]?.whitespaceOnly }; }
        finally { d.dispose(); } },
    viewport: () => viewport.getDiagnostics(),
    candidate: () => ({ ...candidate.getDiagnostics() satisfies TextEditorDiagnostics,
        viewport: candidate.viewport.getDiagnostics() satisfies ViewportDiagnostics, geometry: candidate.viewport.getSnapshot() satisfies ViewportSnapshot }),
    captureCandidate: candidate.captureView,
    navigation: () => {
        const buffer = TextBuffer.from("x".repeat(100_000) + "  tail"), cursor = new WordCursor(buffer, 0, 1);
        let step = cursor.next(256), advances = 1; while (step.status === "running") { step = cursor.next(256); advances++; }
        const run = new WordCursor(buffer, 7, 1, { from: 0, to: 100_000, skipWhitespace: false });
        let runStep = run.next(256), runAdvances = 1; while (runStep.status === "running") { runStep = run.next(256); runAdvances++; }
        const runOffset = runStep.offset; run.dispose();
        candidate.viewport.revealOffset(candidate.view.getSnapshot().selection.head, { horizontal: "nearest", vertical: "nearest" });
        return { offset: step.offset, advances, runOffset, runAdvances, exports: buffer.readMetrics().textExports };
    },
    find: find.setQuery, findOptions: find.setFlags, findState: find.getSnapshot, findMatches: find.matchesIn, replaceAll: find.replaceAll,
    history: () => workspace.observeHistory(documentId).getSnapshot(),
    selectionSets: () => {
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "sets", variant: "working" }, "Sets", { value: "abcd" });
        const view = model.createDocumentView(source.documentId, createSelectionSet(4, [{ anchor: 0, head: 1 }, { anchor: 4, head: 3 }], 1));
        const before = view.getSnapshot().selectionSet, plan = planSelectionEdits(4, before, "X");
        model.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", view, ...plan });
        const changed = model.document(source.documentId).buffer.slice(0, 4), after = view.getSnapshot().selectionSet;
        model.undo({ documentId: source.documentId, expectedRevision: 1 });
        const restored = model.document(source.documentId).buffer.slice(0, 4), restoredSet = view.getSnapshot().selectionSet;
        const alias = view.getSnapshot().selection === restoredSet.ranges[restoredSet.primary];
        const container = document.createElement("div"); document.body.append(container);
        const mounts = [mountTextEditor(container, model, source.documentId, { view }), mountTextViewport(container, model, source.documentId, { view })];
        const states = mounts.map(editor => editor.captureView());
        const browserSelections = mounts.map((editor, index) => {
            const state = states[index]!; view.setSelection(2, { anchor: 0, head: 0 });
            editor.restoreView({ ...state, anchor: 0, head: 0 }); const fullSet = view.getSnapshot().selectionSet;
            const { selectionSet: _, ...legacy } = state; editor.restoreView({ ...legacy, anchor: 2, head: 2 });
            return { captured: state.selectionSet, fullSet, legacy: view.getSnapshot().selectionSet };
        });
        mounts.forEach(editor => editor.dispose()); container.remove();
        view.dispose(); model.releaseResource(source.id, true);
        return { before, after, restoredSet, changed, restored, alias, browserSelections, views: model.diagnostics().views, leases: model.diagnostics().leases };
    },
    storage: () => {
        const imported = importText("a😀\r\nb", "lf"), original = TextBuffer.from(imported.text);
        const changed = original.apply([{ from: 1, to: 3, insert: "X" }]);
        const mapping = composePositionMaps(imported.mapping, changed.mapping);
        const batch = TextBuffer.from("a\r\n😀b").apply([{ from: 0, to: 1, insert: "X" }, { from: 3, to: 5, insert: "Y" }]);
        return { original: original.text(), exported: exportText(changed.buffer.text(), "crlf").text,
            readMetrics: original.readMetrics(),
            batch: { text: batch.buffer.text(), mappedEnd: batch.mapping.map(6).offset, lineOffset: batch.buffer.offsetAt(1) },
            lineCount: changed.buffer.lineCount, lineOffset: changed.buffer.offsetAt(1),
            mappedEnd: mapping.map(6).offset, anchor: changed.mapping.mapRange(anchoredRange(original.length, 3, 5)) };
    } };
Object.assign(window, { consumer: fixture });
declare global { interface Window { consumer: typeof fixture } }
