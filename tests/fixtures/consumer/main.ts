import { Workspace, TextBuffer, TextDiff, WordCursor, BidiCursor, createBidiIndexController, resolveBidi, importText, exportText, anchoredRange, composePositionMaps, createGraphemeCursor } from "sttropez";
import { inputConflictEvent, createFontAssetController, createFindController, createRegexFindBackend, mountTextComparison, mountTextEditor, mountTextViewport, mountEditingCandidate } from "sttropez/browser";
import { fontFixture } from "./font-fixture.js";
import { DiffReferenceCache, WorkspaceCommands } from "sttropez";
import { createSelectionSet, planSelectionEdits } from "sttropez";
import type { ResourceVisibility, SaveReview } from "sttropez";
import type { FindReason, InputConflictDetail, PresentedLine, TextComparisonSnapshot } from "sttropez/browser";
import { JsonRpcConnection } from "sttropez/protocol";
import { openWebSocketTransport } from "sttropez/browser";
const workspace = new Workspace();
const documentId = workspace.createDocument({ scope: "consumer", resource: "source", variant: "working" }, "Consumer source", "restored assets");
const tabId = workspace.open({ kind: "text", documentId }, "main");
const host = document.getElementById("editor");
if (!host) throw new Error("Missing editor host.");
mountTextEditor(host, workspace, tabId);
const viewport = mountTextViewport(document.getElementById("viewport")!, workspace, tabId, { ariaLabel: "Restored viewport" });
const candidate = mountEditingCandidate(document.getElementById("candidate")!, workspace, tabId, { ariaLabel: "Restored candidate", decorate: line => {
    const from = line.text.indexOf("restored"); return from < 0 ? [] : [{ from: line.from + from, to: line.from + from + 8, className: "consumer-token" }];
} });
const find = createFindController(workspace, tabId, candidate);
const comparisonResource = workspace.createTextResourceFromBuffer({ scope: "consumer", resource: "review", variant: "working" }, "Review", { buffer: TextBuffer.from("working\r\n"), serverVersion: "saved-1" });
const comparisonTab = workspace.open({ kind: "text", documentId: comparisonResource.documentId }, "review");
const comparisonView = workspace.createDocumentView(comparisonResource.documentId);
const reviewDecorate = (line: PresentedLine) => [{ from: line.from, to: line.to, className: "consumer-review-token" }];
const reviewOptions = { view: comparisonView, workingDecorate: reviewDecorate, baselineDecorate: reviewDecorate };
let comparison = mountTextComparison(document.getElementById("comparison")!, workspace, comparisonTab, { buffer: TextBuffer.from("baseline\r\n"), version: "reference-1" }, reviewOptions);
function mountMultipleInput() {
    const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "multiple-input", variant: "working" }, "Multiple input", { value: "abcd" });
    const tab = model.open({ kind: "text", documentId: source.documentId }, "multiple-input"), host = document.createElement("div"); host.style.height = "200px"; document.body.append(host);
    const editor = mountEditingCandidate(host, model, tab, { ariaLabel: "Restored multiple input" }); editor.focus();
    editor.view.setSelections(0, [{ anchor: 0, head: 1 }, { anchor: 4, head: 3 }], 1);
    return { model, source, tab, host, editor };
}
let multipleInput: ReturnType<typeof mountMultipleInput> | undefined;
Object.assign(window, { consumer: { text: () => workspace.document(documentId).text(),
    protocolExports: () => ({ connection: typeof JsonRpcConnection, websocket: typeof openWebSocketTransport }),
    clipboardBoundary: () => {
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "clipboard-boundary", variant: "working" }, "Source", { value: "before\r\nend" });
        const tab = model.open({ kind: "text", documentId: source.documentId }, "clipboard"), host = document.createElement("div"); host.style.height = "160px"; document.body.append(host);
        const editor = mountEditingCandidate(host, model, tab), original = "before\r\nend";
        try {
            editor.view.setSelections(0, [{ anchor: 3, head: 1 }, { anchor: 10, head: 8 }], 1); const selections = editor.view.getSnapshot().selectionSet;
            for (const type of ["copy", "cut", "paste"] as const) {
                editor.input.addEventListener(type, event => { event.clipboardData!.setData("text/plain", "host-owned"); event.preventDefault(); }, { capture: true, once: true });
                const event = new ClipboardEvent(type, { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); editor.input.dispatchEvent(event);
                if (event.clipboardData!.getData("text/plain") !== "host-owned") throw new Error("Compiled editor overwrote host clipboard ownership.");
            }
            for (const type of ["text/plain", "text/html"]) { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); event.clipboardData!.setData(type, type === "text/html" ? "<b>no plain text</b>" : "");
                editor.input.dispatchEvent(event); }
            const d = model.document(source.documentId);
            if (d.revision || d.buffer.slice(0, d.buffer.length) !== original || editor.view.getSnapshot().selectionSet !== selections || model.observeHistory(source.documentId).getSnapshot().undoDepth) throw new Error("Compiled canceled/empty clipboard input changed text, complete selections or history.");
            if (d.buffer.readMetrics().textExports) throw new Error("Compiled clipboard boundary exported text.");
        } finally { editor.destroy(); host.remove(); model.close(tab); model.releaseResource(source.id, true); }
        const { views, leases, subscriptions } = model.diagnostics(); if (views || leases || subscriptions) throw new Error("Compiled clipboard resources leaked.");
        return { cancelledOwnership: true, emptyPayloadNoDeletion: true, completeSets: true, noHistory: true, zeroExports: true, events: "synthetic", released: { views, leases, subscriptions } };
    },
    foldingPilot: async () => {
        const original = "header\r\n" + "const unchanged = 123;\r\n".repeat(100000) + "footer", footer = original.length - 6;
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "folding", variant: "working" }, "Folded source", { value: original });
        const tab = model.open({ kind: "text", documentId: source.documentId }, "folded"), view = model.createDocumentView(source.documentId), peer = model.createDocumentView(source.documentId);
        const host = document.createElement("div"), otherHost = document.createElement("div"); host.style.height = "180px"; otherHost.style.height = "180px"; document.body.append(host, otherHost);
        let editor = mountEditingCandidate(host, model, tab, { view, ariaLabel: "Restored folding" });
        const other = mountEditingCandidate(otherHost, model, tab, { view: peer, ariaLabel: "Restored fold peer" });
        const wait = async () => { const deadline = performance.now() + 10000;
            while ([editor, other].some(e => { const s = e.snapshot(), p = e.viewport.snapshot(); return s.pendingCaret || s.pendingWord || s.pendingGrapheme || s.pendingDragScroll || p.pending
                || p.revision !== model.document(source.documentId).revision || p.selectionSet !== e.view.getSnapshot().selectionSet || p.foldGeneration !== e.view.folding.getSnapshot().generation; })) {
                if (performance.now() > deadline) throw new Error("Compiled folding did not settle."); await new Promise(resolve => setTimeout(resolve, 0));
            } };
        const exact = () => { const b = model.document(source.documentId).buffer; if (b.length !== original.length) throw new Error("Compiled fold undo changed length.");
            for (let from = 0; from < original.length; from += 32768) if (b.slice(from, Math.min(b.length, from + 32768)) !== original.slice(from, from + 32768)) throw new Error("Compiled fold undo changed text."); };
        try {
            view.setSelections(0, [{ anchor: 0, head: 0 }, { anchor: original.length, head: original.length }]);
            const initial = view.folding.getSnapshot();
            if (!view.folding.setRanges(initial, [{ id: "body", from: 0, to: footer, collapsed: true }]) || view.folding.setCollapsed(initial, "body", false)) throw new Error("Compiled folding did not enforce captured versions.");
            editor.focus(); await wait();
            if (editor.viewport.snapshot().rows !== 2 || editor.viewport.snapshot().visibleLines !== 2 || peer.folding.getSnapshot().index.collapsedCount) throw new Error("Compiled folded projection is not bounded or independent.");
            // This synthetic dispatch proves the shipped command route; native device qualification is separate.
            editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await wait();
            if (view.getSnapshot().selection.head !== footer || view.getSnapshot().selectionSet.ranges.length !== 2) throw new Error("Compiled folded navigation lost a target or secondary caret.");
            const at = Math.floor(footer / 2); model.edit({ documentId: source.documentId, expectedRevision: 0, origin: "host", edits: [{ from: at, to: at, insert: "x\r\n" }] }); await wait();
            if (editor.viewport.snapshot().visibleLines !== 2) throw new Error("Compiled folded edit exposed hidden rows.");
            model.undo({ documentId: source.documentId, expectedRevision: 1 }); await wait(); exact();
            const saved = editor.captureView(), retired = editor; editor.destroy();
            editor = mountEditingCandidate(host, model, tab, { view, ariaLabel: "Restored folding" }); editor.restoreView(saved); editor.focus(); await wait();
            if (editor.viewport.snapshot().visibleLines !== 2 || view.getSnapshot().selectionSet.ranges.length !== 2) throw new Error("Compiled remount lost folds or complete selections.");
            const fresh = model.createDocumentView(source.documentId), freshHost = document.createElement("div"); freshHost.style.height = "180px"; document.body.append(freshHost);
            const restored = mountEditingCandidate(freshHost, model, tab, { view: fresh });
            try {
                restored.restoreView(saved); restored.viewport.flush(); if (fresh.folding.getSnapshot().index.visibleLineCount !== 2) throw new Error("Compiled fresh view did not restore captured folds.");
                const current = fresh.folding.getSnapshot(); fresh.folding.setCollapsed(current, "body", false); restored.restoreView(saved);
                if (fresh.folding.getSnapshot().index.collapsedCount) throw new Error("A stale capture overwrote newer fold state.");
            } finally { restored.destroy(); fresh.dispose(); freshHost.remove(); }
            view.setSelection(model.document(source.documentId).revision, { anchor: at, head: at });
            editor.viewport.revealOffset(at, { horizontal: "nearest", vertical: "nearest" }); await wait();
            if (view.folding.getSnapshot().index.collapsedCount || !editor.viewport.coordsAt(at)) throw new Error("Compiled explicit selection did not reveal its row.");
            if (model.document(source.documentId).buffer.readMetrics().textExports) throw new Error("Compiled folding exported the source value.");
            if (retired.viewport.coordsAt(0) !== undefined || retired.viewport.columnAt(0) !== undefined) throw new Error("Retired compiled geometry remained active.");
        } finally { editor.destroy(); other.destroy(); host.remove(); otherHost.remove(); view.dispose(); peer.dispose(); model.close(tab); model.releaseResource(source.id, true); }
        if (editor.viewport.coordsAt(0) !== undefined || editor.viewport.columnAt(0) !== undefined || editor.viewport.caretAtColumn(0, 0) !== undefined) throw new Error("Released compiled geometry queried a missing source.");
        const { views, leases, subscriptions } = model.diagnostics(); if (views || leases || subscriptions) throw new Error("Compiled fold resources leaked.");
        return { units: original.length, visibleRows: 2, independentViews: true, capturedVersions: true, completeSets: true, navigation: true,
            mappedUndo: true, retainedRemount: true, freshRestore: true, newerStatePreserved: true, revealedSelection: true, zeroCompleteExports: true,
            disposedGeometryInert: true, keyboardDispatch: "synthetic-event", released: { views, leases, subscriptions } };
    },
    regexPilot: async () => {
        const original = "foobar foo foo_ K k K_ 𐐀 𐐨\r\n" + "const unchanged = 123;\r\n".repeat(100000);
        const expected = "[foobar] [foo] foo_ [K] [k] K_ [𐐀] [𐐨]\r\n" + original.slice(original.indexOf("\n") + 1);
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "regex", variant: "working" }, "Regex", { value: original });
        const tab = model.open({ kind: "text", documentId: source.documentId }, "regex"), host = document.createElement("div"); host.style.height = "160px"; document.body.append(host);
        let workers = 0;
        const editor = mountEditingCandidate(host, model, tab, { ariaLabel: "Restored regex" }), find = createFindController(model, tab, editor, {
            regularExpression: createRegexFindBackend({ clock: window, createWorker: () => { workers++; return new Worker("/regex-worker.js", { type: "module" }); } }) });
        const wait = async (status: "ready" | "failed") => {
            const deadline = performance.now() + 30000;
            while (find.state.getSnapshot().status !== status) {
                if (performance.now() > deadline || find.state.getSnapshot().status === "failed" && status !== "failed") throw new Error(find.state.getSnapshot().message || "Compiled regex did not complete.");
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        };
        const exact = (text: string) => { const b = model.document(source.documentId).buffer; if (b.length !== text.length) throw new Error("Compiled regex length mismatch.");
            for (let from = 0; from < text.length; from += 32768) if (b.slice(from, Math.min(text.length, from + 32768)) !== text.slice(from, from + 32768)) throw new Error("Compiled regex text mismatch."); };
        try {
            find.setQuery("(?<value>foo|foobar|k|𐐨)"); await wait("ready"); if (workers || find.state.getSnapshot().count) throw new Error("Literal mode started a regex worker.");
            find.setOptions({ regularExpression: true, matchCase: false, wholeWord: true }); await wait("ready");
            if (find.state.getSnapshot().count !== 6 || workers < 1) throw new Error("Compiled regex worker was not used.");
            editor.view.setSelections(0, [{ anchor: 0, head: 6 }, { anchor: original.length, head: original.length }], 1);
            const selected = editor.view.getSnapshot().selectionSet;
            find.replaceAll("[$<value>]"); await wait("ready"); exact(expected);
            if (model.observeHistory(source.documentId).getSnapshot().undoDepth !== 1) throw new Error("Compiled regex replacement was not atomic.");
            model.undo({ documentId: source.documentId, expectedRevision: model.document(source.documentId).revision }); await wait("ready"); exact(original);
            if (JSON.stringify(editor.view.getSnapshot().selectionSet) !== JSON.stringify(selected)) throw new Error("Compiled regex undo lost selections.");
            const d = model.document(source.documentId); model.edit({ documentId: source.documentId, expectedRevision: d.revision, origin: "host", edits: [{ from: 0, to: d.buffer.length, insert: "😀x\r\nlast" }] });
            find.setOptions({ regularExpression: true, wholeWord: false, matchCase: true }); find.setQuery("(?:)"); await wait("ready");
            editor.view.setSelection(model.document(source.documentId).revision, { anchor: 0, head: 0 });
            for (const head of [0, 2, 3, 4, 5, 6, 7, 8, 9, 0]) { find.next(); await new Promise(resolve => setTimeout(resolve, 0));
                if (editor.view.getSnapshot().selection.head !== head) throw new Error("Compiled zero-width navigation lost a raw position."); }
            editor.viewport.flush(); const point = editor.viewport.coordsAt(4), column = editor.viewport.columnAt(4);
            if (!point || point.offset !== 4 || column === undefined || !editor.viewport.caretAtColumn(1, column)) throw new Error("Compiled CRLF caret has no painted or vertical position.");
            find.replaceAll("|"); await wait("ready"); exact("|😀|x|\r|\n|l|a|s|t|");
            find.setQuery("("); await wait("failed"); exact("|😀|x|\r|\n|l|a|s|t|");
            if (model.document(source.documentId).buffer.readMetrics().textExports) throw new Error("Compiled regex exported the model value.");
        } finally { find.destroy(); editor.destroy(); host.remove(); model.close(tab); model.releaseResource(source.id, true); }
        const { views, leases, subscriptions } = model.diagnostics(); if (views || leases || subscriptions) throw new Error("Compiled regex resources leaked.");
        if (editor.viewport.coordsAt(4) !== undefined) throw new Error("Disposed compiled viewport still exposes geometry.");
        return { actualWorker: workers > 0, workerCount: workers, units: original.length, atomicReplacement: true, completeSelectionUndo: true,
            rawZeroWidthNavigation: true, crlfCaretProjection: true, disposedGeometryInert: true, syntaxFailureSafe: true, zeroCompleteExports: true, released: { views, leases, subscriptions } };
    },
    findAuthority: async () => {
        const cases = [];
        for (const change of ["permission", "lease"] as const) {
            const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "find-authority", variant: "working" }, "Captured find", { value: "cat cat" });
            const tab = model.open({ kind: "text", documentId: source.documentId }, "find"), host = document.createElement("div"); host.style.height = "160px"; document.body.append(host);
            const editor = mountEditingCandidate(host, model, tab, { ariaLabel: "Restored captured find" }), find = createFindController(model, tab, editor);
            const ready = async () => { for (let turn = 0; find.state.getSnapshot().status !== "ready"; turn++) {
                if (turn >= 1000) throw new Error("Compiled find did not settle."); await new Promise<void>(resolve => setTimeout(resolve, 1)); } };
            try {
                find.setQuery("cat"); await ready(); editor.view.setSelections(0, [{ anchor: 0, head: 3 }, { anchor: 7, head: 7 }]);
                const selected = editor.view.getSnapshot().selectionSet, before = model.document(source.documentId), subscriptions = model.diagnostics().subscriptions;
                find.replaceAll("dog");
                if (change === "permission") { const policy = source.metadata.getSnapshot().capabilities; model.setCapabilities(source.id, { ...policy, edit: ["host"] }); model.setCapabilities(source.id, policy); }
                else { const lease = model.acquireEditLease(source.id, "consumer", "host"); lease.release(); }
                await ready();
                const reason: FindReason | null = find.state.getSnapshot().reason;
                if (model.document(source.documentId).buffer !== before.buffer || reason !== "editing-unavailable"
                    || model.observeHistory(source.documentId).getSnapshot().undoDepth !== 0 || model.diagnostics().subscriptions !== subscriptions
                    || JSON.stringify(editor.view.getSnapshot().selectionSet) !== JSON.stringify(selected)) throw new Error("Interrupted compiled replacement resumed.");
                find.replaceAll("dog"); if (find.state.getSnapshot().reason !== null) throw new Error("Compiled retry retained an old notice.");
                await ready(); const changed = model.document(source.documentId);
                if (changed.buffer.slice(0, 7) !== "dog dog" || model.observeHistory(source.documentId).getSnapshot().undoDepth !== 1
                    || find.state.getSnapshot().reason !== "replaced") throw new Error("Fresh compiled retry failed.");
                model.undo({ documentId: source.documentId, expectedRevision: changed.revision }); await ready();
                if (model.document(source.documentId).buffer.slice(0, 7) !== "cat cat" || JSON.stringify(editor.view.getSnapshot().selectionSet) !== JSON.stringify(selected)) throw new Error("Compiled retry undo lost selections.");
                find.replaceAll("cat"); await ready();
                if (model.diagnostics().subscriptions !== subscriptions || model.document(source.documentId).buffer.readMetrics().textExports !== 0) throw new Error("Compiled replacement retained idle observation or exported text.");
            } finally { find.destroy(); editor.destroy(); host.remove(); model.close(tab); model.releaseResource(source.id, true); }
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
            const original = kind === "many-carets" ? Array<string>(100000).fill("0123456789").join("\r\n") : kind === "pointer-word" ? "x".repeat(2400000) : "a" + " ".repeat(1000000) + "next";
            const heads = kind === "many-carets" ? Array.from({ length: 1024 }, (_, i) => i * 80 * 12 + 4) : [0];
            const destinations = kind === "many-carets" ? heads.map(head => head + 12) : [1000001], text = kind === "paste-word" ? "😀é\r\n" : "😀é";
            const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: kind, variant: "working" }, kind, { value: original });
            const tab = model.open({ kind: "text", documentId: source.documentId }, kind), host = document.createElement("div"); host.style.height = "200px"; document.body.append(host);
            const editor = mountEditingCandidate(host, model, tab, { ariaLabel: "Restored ordered input" }), recovered: string[] = [];
            editor.input.addEventListener(inputConflictEvent, event => recovered.push((event as CustomEvent<InputConflictDetail>).detail.attemptedText));
            const ready = async () => { for (let turn = 0; ; turn++) { const s = editor.snapshot();
                if (!s.pendingInput && !s.pendingWord && !s.pendingGrapheme && !s.pendingCaret && !editor.viewport.snapshot().pending) return;
                if (turn >= 4000) throw new Error("Compiled ordered input did not settle."); await new Promise<void>(resolve => setTimeout(resolve, 1)); } };
            const command = () => {
                if (kind !== "pointer-word") return editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: kind === "many-carets" ? "ArrowDown" : "ArrowRight", ctrlKey: kind === "long-word" || kind === "paste-word", bubbles: true, cancelable: true }));
                const point = editor.viewport.coordsAt(8); if (!point) throw new Error("Missing compiled word point.");
                return editor.element.dispatchEvent(new MouseEvent("dblclick", { button: 0, clientX: point.left + 1, clientY: point.top + point.height / 2, bubbles: true, cancelable: true }));
            };
            const type = () => {
                if (kind === "paste-word") { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
                    if (!event.clipboardData) throw new Error("Missing compiled clipboard fixture data."); event.clipboardData.setData("text/plain", text);
                    if (editor.input.dispatchEvent(event)) throw new Error("Compiled paste was not captured."); }
                else if (editor.input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }))) throw new Error("Compiled input was not captured.");
            };
            try {
                editor.focus(); editor.view.setSelections(0, heads.map(head => ({ anchor: head, head })), heads.length - 1); await ready(); command(); type();
                if (!editor.snapshot().pendingInput || model.document(source.documentId).revision !== 0) throw new Error("Compiled command failed to yield/capture input.");
                await ready(); const changed = model.document(source.documentId), parts: string[] = []; let from = 0;
                for (const head of destinations) { parts.push(original.slice(from, head), text); from = head; } parts.push(original.slice(from)); const expected = kind === "pointer-word" ? text : parts.join("");
                if (changed.buffer.length !== expected.length) throw new Error("Compiled ordered input length changed.");
                for (let at = 0; at < expected.length; at += 32768) if (changed.buffer.slice(at, Math.min(expected.length, at + 32768)) !== expected.slice(at, at + 32768)) throw new Error("Compiled input used the wrong destination.");
                if (model.observeHistory(source.documentId).getSnapshot().undoDepth !== 1 || changed.buffer.readMetrics().textExports !== 0 || recovered.length) throw new Error("Compiled input lost history/bounds.");
                model.undo({ documentId: source.documentId, expectedRevision: changed.revision }); await ready();
                if (editor.view.getSnapshot().selectionSet.ranges.some((range, i) => kind === "pointer-word" ? range.anchor !== 0 || range.head !== original.length : range.anchor !== destinations[i] || range.head !== destinations[i])) throw new Error("Compiled undo lost moved selections.");
                const document = model.document(source.documentId); editor.view.setSelections(document.revision, heads.map(head => ({ anchor: head, head })), heads.length - 1); await ready(); command(); type(); editor.destroy();
                if (recovered.length !== 1 || recovered[0] !== text || model.document(source.documentId).buffer !== document.buffer) throw new Error("Compiled detach lost pending input.");
            } finally { editor.destroy(); host.remove(); model.close(tab); model.releaseResource(source.id, true); }
            const { views, leases, subscriptions } = model.diagnostics(); if (views || leases || subscriptions) throw new Error("Compiled ordered input leaked.");
            results.push({ kind, exactText: true, sharedHistory: true, detachRecovery: true, exports: 0, released: { views, leases, subscriptions } });
        }
        return { cases: results, source: "restored-compiled-assets", nativeQualified: false };
    },
    multipleInput: () => { const { model, source, editor } = multipleInput!, document = model.document(source.documentId), state = editor.snapshot(), viewport = editor.viewport.snapshot();
        return { text: document.buffer.slice(0, document.buffer.length), selectionSet: editor.view.getSnapshot().selectionSet, revision: document.revision,
            pending: state.pendingCaret || state.pendingGrapheme || state.pendingWord || viewport.pending, commits: state.commits, exports: document.buffer.readMetrics().textExports }; },
    multipleColumn: (offset: number) => { const editor = multipleInput!.editor, release = editor.viewport.prepareNavigationRows([0]);
        try { const column = editor.viewport.columnAt(offset); return { column, caret: column === undefined ? undefined : editor.viewport.caretAtColumn(0, column) }; }
        finally { release(); } },
    prepareMultipleEnd: () => { const { model, source, editor } = multipleInput!, before = model.document(source.documentId);
        const result = model.edit({ documentId: source.documentId, expectedRevision: before.revision, origin: "human",
            edits: [{ from: 0, to: before.buffer.length, insert: "a\r\nb\r" }], view: editor.view,
            selectionSet: createSelectionSet(5, [{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }]), history: { kind: "replace" } });
        if (!result.applied) throw new Error("End target setup rejected."); },
    finishMultipleInput: () => { const { model, source, tab, host, editor } = multipleInput!; editor.destroy(); host.remove(); model.close(tab); model.releaseResource(source.id, true); multipleInput = undefined;
        return { views: model.diagnostics().views, leases: model.diagnostics().leases }; },
    readonlyIndent: async (outdent: boolean) => {
        const model = new Workspace(), text = "    const sample = 1;\r\n".repeat(1024), source = model.createTextResource({ scope: "consumer", resource: "readonly-indent", variant: "working" }, "Locked command", { value: text });
        const tab = model.open({ kind: "text", documentId: source.documentId }, "locked-command"), host = document.createElement("div"); host.style.height = "200px"; document.body.append(host);
        const editor = mountEditingCandidate(host, model, tab, { ariaLabel: "Restored locked command" });
        try {
            editor.view.setSelection(0, { anchor: 0, head: text.length }); model.setCapabilities(source.id, { edit: ["host"], save: true, run: true });
            const before = model.observeHistory(source.documentId).getSnapshot(); let lockedAtHandler = false;
            editor.input.addEventListener("keydown", () => { lockedAtHandler = editor.input.readOnly;
                queueMicrotask(() => model.setCapabilities(source.id, { edit: ["human", "host"], save: true, run: true })); }, { once: true });
            editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: outdent, bubbles: true, cancelable: true }));
            await new Promise<void>(resolve => { let turns = 16; const step = () => { if (--turns) setTimeout(step, 0); else resolve(); }; setTimeout(step, 0); });
            const current = model.document(source.documentId);
            return { outdent, lockedAtHandler, revision: current.revision, sameText: current.buffer.slice(0, text.length) === text,
                undoBefore: before.undoDepth, undoAfter: model.observeHistory(source.documentId).getSnapshot().undoDepth, exports: current.buffer.readMetrics().textExports };
        } finally { editor.destroy(); host.remove(); model.close(tab); model.releaseResource(source.id, true); }
    },
    saveReview: async () => {
        const model = new Workspace(), source = model.createTextResource({ scope: "consumer", resource: "retry", variant: "working" }, "Retry", { value: "base", serverVersion: "v0" });
        model.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 4, insert: "merged" }] });
        const commands = new WorkspaceCommands(model);
        await commands.save(source, { save: async () => ({ kind: "conflict", serverVersion: "v1" }) });
        const baselineBefore = source.metadata.getSnapshot().serverVersion;
        const review: SaveReview = { target: model.captureResource(source.id), expectedRevision: source.getSnapshot().revision, expectedServerVersion: "v1" };
        let precondition: string | null = null;
        const saved = await commands.save(source, { save: async submission => {
            precondition = submission.expectedServerVersion;
            model.edit({ documentId: source.documentId, expectedRevision: submission.revision, origin: "human", edits: [{ from: 6, to: 6, insert: " later" }] });
            return { kind: "saved", serverVersion: "v2" };
        } }, review);
        const textAfter = model.document(source.documentId).text(), dirtyAfter = source.metadata.getSnapshot().dirty;
        model.undo({ documentId: source.documentId, expectedRevision: source.getSnapshot().revision });
        return { baselineBefore, precondition, saved: saved.kind, textAfter, dirtyAfter, cleanAfterUndo: !source.metadata.getSnapshot().dirty,
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
    comparison: () => { const review: TextComparisonSnapshot = comparison.state.getSnapshot(), s = review.comparison, reference = comparison.reference.getSnapshot();
        const visibility: ResourceVisibility | undefined = reference && workspace.resourceForDocument(reference.editor.view.documentId).metadata.getSnapshot().visibility;
        const inventory = workspace.getSnapshot();
        return { status: s.status, generation: s.generation, count: s.hunks.length, version: s.baseline?.version,
        internalBaseline: visibility === "internal" && !!reference && !inventory.documents.some(document => document.id === reference.editor.view.documentId)
            && !inventory.tabs.some(tab => tab.id === reference.target.id),
        selectedHunk: review.selectedHunk, canNavigate: review.canNavigate, canRevert: review.canRevert,
        viewId: comparisonView.id, selection: comparisonView.getSnapshot().selection, reference: comparison.referenceViewport()?.snapshot(), working: comparison.working.viewport.snapshot() }; },
    remountComparison: () => {
        const baseline = comparison.controller.getSnapshot().baseline!, state = comparison.working.captureView();
        comparison.destroy(); const retained = workspace.ownsDocumentView(comparisonView);
        comparison = mountTextComparison(document.getElementById("comparison")!, workspace, comparisonTab, baseline, reviewOptions);
        comparison.working.restoreView({ ...state, ...comparisonView.getSnapshot().selection }); return retained;
    },
    acceptComparison: () => { const t = comparison.controller.beginAcceptance(); return t.complete({ buffer: t.capture.working.buffer, version: "accepted-2" }); },
    diff: () => { const cache = new DiffReferenceCache(), d = new TextDiff(TextBuffer.from("a\r\n"), TextBuffer.from("a\n"), cache);
        try { let s = d.next(512); while (s.status === "running") s = d.next(512); return { status: s.status, whitespaceOnly: s.hunks[0]?.whitespaceOnly }; }
        finally { d.dispose(); cache.dispose(); } },
    viewport: () => viewport.snapshot(),
    candidate: () => ({ ...candidate.snapshot(), viewport: candidate.viewport.snapshot() }),
    captureCandidate: candidate.captureView,
    bidi: () => resolveBidi("abc אבג xyz"),
    paragraph: () => {
        const buffer = TextBuffer.from("x".repeat(100_000) + " א"), cursor = new BidiCursor(buffer); let step = cursor.next(256), advances = 1;
        while (step.status === "running") { step = cursor.next(256); advances++; }
        const index = step.result!, level = index.levelAt(100_001); cursor.dispose();
        const controller = createBidiIndexController(workspace, tabId), document = workspace.document(documentId), ownership = workspace.ownership(workspace.resourceForDocument(documentId).id).leases;
        const generation = controller.request({ expectedRevision: document.revision, from: 0, to: document.buffer.length })!;
        let state = controller.advance(256); while (state.status === "running") state = controller.advance(256);
        const current = controller.isCurrent(generation), mainLevel = state.index!.levelAt(4), rejected = controller.request({ expectedRevision: document.revision - 1, from: 0, to: 1 }) === null;
        controller.dispose();
        return { advances, level, retainedLevel: index.levelAt(100_001), exports: buffer.readMetrics().textExports, current, mainLevel, rejected,
            releasedLease: workspace.ownership(workspace.resourceForDocument(documentId).id).leases === ownership - 1, sourceRevision: workspace.document(documentId).revision === document.revision };
    },
    bidiSample: () => {
        const document = workspace.document(documentId);
        workspace.edit({ documentId, expectedRevision: document.revision, origin: "host", edits: [{ from: 0, to: document.buffer.length, insert: "abc אבג xyz" }] });
        candidate.view.setSelection(workspace.document(documentId).revision, { anchor: 4, head: 4, anchorAffinity: "after", headAffinity: "after" });
        candidate.viewport.revealOffset(4); candidate.focus();
    },
    navigation: () => {
        const buffer = TextBuffer.from("x".repeat(100_000) + "  tail"), cursor = new WordCursor(buffer, 0, 1);
        let step = cursor.next(256), advances = 1; while (step.status === "running") { step = cursor.next(256); advances++; }
        const run = new WordCursor(buffer, 7, 1, { from: 0, to: 100_000, skipWhitespace: false });
        let runStep = run.next(256), runAdvances = 1; while (runStep.status === "running") { runStep = run.next(256); runAdvances++; }
        const runOffset = runStep.offset; run.dispose();
        candidate.viewport.revealOffset(candidate.view.getSnapshot().selection.head, { horizontal: "nearest", vertical: "nearest" });
        return { offset: step.offset, advances, runOffset, runAdvances, exports: buffer.readMetrics().textExports };
    },
    find: find.setQuery, findOptions: find.setOptions, findState: find.state.getSnapshot, findMatches: find.matchesIn, replaceAll: find.replaceAll,
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
        const tab = model.open({ kind: "text", documentId: source.documentId }, "sets"), container = document.createElement("div"); document.body.append(container);
        const mounts = [mountTextEditor(container, model, tab, { view }), mountEditingCandidate(container, model, tab, { view }), mountTextViewport(container, model, tab, { view })];
        const states = mounts.map(editor => editor.captureView());
        const browserSelections = mounts.map((editor, index) => {
            const state = states[index]!; view.setSelection(2, { anchor: 0, head: 0 });
            editor.restoreView({ ...state, anchor: 0, head: 0 }); const fullSet = view.getSnapshot().selectionSet;
            const { selectionSet: _, ...legacy } = state; editor.restoreView({ ...legacy, anchor: 2, head: 2 });
            return { captured: state.selectionSet, fullSet, legacy: view.getSnapshot().selectionSet };
        });
        mounts.forEach(editor => editor.destroy()); container.remove(); model.close(tab);
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
    } } });
