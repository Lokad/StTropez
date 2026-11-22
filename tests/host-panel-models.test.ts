import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, type DocumentId } from "../src/index.ts";
import { HostController } from "../examples/hosts/controller.ts";
import { hostSceneModel } from "../examples/hosts/scene-model.ts";
import { variantPanelModel } from "../examples/hosts/variant-panel.ts";
import type { VariantReviewSnapshot } from "../examples/hosts/variants.ts";
import { navigationPanelModel } from "../examples/hosts/navigation-panel.ts";
import { projectPanelModel } from "../examples/hosts/project-panel.ts";
import type { NavigationSnapshot } from "../examples/hosts/navigation.ts";
import type { ProjectSnapshot } from "../examples/hosts/project.ts";
import { renamePanelModel } from "../examples/hosts/rename-panel.ts";
import { actionsPanelModel } from "../examples/hosts/actions-panel.ts";
import type { HostRenameSnapshot } from "../examples/hosts/rename.ts";
import type { ActionsSnapshot } from "../examples/hosts/code-actions.ts";
import { documentColorsPanelModel } from "../examples/hosts/document-colors-panel.ts";
import { documentLinksPanelModel } from "../examples/hosts/document-links-panel.ts";
import type { DocumentColorsSnapshot } from "../examples/hosts/document-colors.ts";
import type { DocumentLinksSnapshot } from "../examples/hosts/document-links.ts";
import { languagePanelModel } from "../examples/hosts/language-panel.ts";
import { domainPanelModel } from "../examples/hosts/domain-panel.ts";
import type { DomainSnapshot } from "../examples/hosts/domain.ts";

const noop = () => {};

test("scene identity ignores modal/review traffic while readiness and captured tab generations govern mounting", async () => {
    const host = new HostController();
    try {
        const layout = host.layout.getSnapshot(), tab = host.workspace.tabs.resolve(host.workspace.tabs.capture(host.viewTab("primary")))!;
        const derive = (next = layout, target = tab, ready = true) => hostSceneModel(next, target, ready, host.source.documentId);
        const initial = derive(), reviewLayout = { ...layout, navigation: { kind: "review" as const } }, review = derive(reviewLayout);
        assert.equal(review.key, initial.key); assert.equal(review.primaryKey, initial.primaryKey); assert.ok(review.reviewKey);
        const modal = derive({ ...reviewLayout, modal: { kind: "error", message: "Keep typing" } });
        assert.equal(modal.key, review.key); assert.equal(modal.reviewKey, review.reviewKey); assert.equal(modal.message, "Keep typing");
        const moved = derive({ ...reviewLayout, position: "right" });
        assert.notEqual(moved.key, review.key); assert.equal(moved.reviewKey, review.reviewKey); assert.equal(moved.position, "right");
        assert.notEqual(derive(reviewLayout, { ...tab, generation: tab.generation + 1 }).primaryKey, review.primaryKey);
        assert.notEqual(derive(reviewLayout, { ...tab, generation: tab.generation + 1 }).reviewKey, review.reviewKey);
        for (const unavailable of [derive({ ...reviewLayout, visible: false }), derive({ ...reviewLayout, formFault: true }),
            derive({ ...reviewLayout, primarySurface: "loading" }), derive(reviewLayout, tab, false),
            hostSceneModel(reviewLayout, undefined, true, host.source.documentId)]) {
            assert.equal(unavailable.primaryKey, undefined); assert.equal(unavailable.reviewKey, undefined);
        }
        const hidden = derive({ ...reviewLayout, visible: false }); assert.equal(hidden.placeholder, undefined); assert.equal(hidden.secondary, false);
        const other = derive(reviewLayout, { ...tab, surface: { kind: "text", documentId: "another-source" as DocumentId } });
        assert.ok(other.primaryKey); assert.equal(other.reviewKey, undefined, "other text resources never inherit source review");
    } finally { await host.dispose(); }
});

test("review presentation pins captured versions across catalogue replacement and uses the supplied reference", () => {
    const chosen: string[] = [];
    const variants: Parameters<typeof variantPanelModel>[0] = { review: id => { chosen.push(id); return true; }, keepDraft: noop, finishNext: () => false, failNext: noop, cancel: noop };
    const bindings = { beginDiscard: noop, finishDiscard: noop, cancelDiscard: noop };
    const captured = Object.freeze({ id: "server", kind: "server" as const, label: "Server version", version: "remote-1" });
    const state: VariantReviewSnapshot = { generation: 1, choices: [captured], selected: null, requested: captured, status: "loading", pending: 1, message: "Loading" };
    const reference = { generation: 3, baseline: { version: "old-reference", buffer: TextBuffer.from("old") } };
    const first = variantPanelModel(variants, bindings, state, reference);
    const newer = variantPanelModel(variants, bindings, { ...state, choices: [{ ...captured, version: "remote-2" }] }, reference);
    assert.equal(first.value, "server"); assert.equal(newer.value, "__captured"); assert.match(newer.captured.label, /remote-1/);
    assert.equal(newer.choices[0]!.key, first.choices[0]!.key); assert.match(newer.choices[0]!.label, /remote-2/);
    newer.choose(""); newer.choose("__captured"); newer.choose("missing"); assert.deepEqual(chosen, []);
    newer.choose("server"); assert.deepEqual(chosen, ["server"]);
    const completed = variantPanelModel(variants, bindings, { ...state, requested: null, selected: captured, pending: 0, status: "ready" },
        { ...reference, baseline: { ...reference.baseline, version: "remote-1" } });
    assert.match(first.status.text, /old-reference/); assert.match(completed.status.text, /remote-1/);
    assert.equal(first.actions.find(action => action.label === "Finish version load")!.disabled, false);
    assert.equal(completed.actions.find(action => action.label === "Finish version load")!.disabled, true);
    assert.equal(completed.actions.find(action => action.label === "Confirm reviewed discard")!.invoke, bindings.finishDiscard);
});

test("domain annotation callbacks retain session and revision when another view reuses the annotation ID", () => {
    const revealed: [string, number, string][] = [];
    const tools: Parameters<typeof domainPanelModel>[0] = { discover: noop, collapse: noop, insertImport: noop, cancel: noop,
        reveal: (token, revision, id) => { revealed.push([token, revision, id]); } };
    let formatted = 0;
    const state: DomainSnapshot = Object.freeze({ available: true, editable: true, view: "primary", token: "first", revision: 4, status: "ready", message: "Captured regions",
        work: 100, total: 100, pendingView: null, annotationCount: 1, foldCount: 1,
        annotations: Object.freeze([Object.freeze({ id: "region", from: 0, to: 12, get label() { formatted++; return "Region"; } })]) });
    const first = domainPanelModel(tools, state), status = domainPanelModel(tools, { ...state, message: "Collapsed", annotations: state.annotations.slice() });
    assert.equal(formatted, 0, "status updates need not format retained annotation rows");
    assert.equal(first.annotations.capture, status.annotations.capture); assert.equal(first.annotations.identity[0], status.annotations.identity[0]);
    const newer = domainPanelModel(tools, { ...state, view: "secondary", token: "second", revision: 5 });
    assert.notEqual(first.annotations.capture, newer.annotations.capture); assert.notEqual(first.annotations.items()[0]!.key, newer.annotations.items()[0]!.key);
    newer.annotations.items()[0]!.invoke(); first.annotations.items()[0]!.invoke(); assert.deepEqual(revealed, [["second", 5, "region"], ["first", 4, "region"]]);
    domainPanelModel(tools, { ...state, token: null, revision: null }).annotations.items()[0]!.invoke(); assert.equal(revealed.length, 2);
});

test("language result callbacks cannot follow a newer view or diagnostic batch while rendering stays snapshot-only", () => {
    type Snapshot = Parameters<typeof languagePanelModel>[1];
    const chosen: number[] = [], inserted: string[] = [], diagnostics: number[] = [];
    const state: Snapshot = Object.freeze({ readOnlyReference: false, view: "primary", providerError: null, find: null, folds: null, foldMessage: "Captured folds", query: "sa", replacement: "sample", wholeWord: false, matchCase: true, regularExpression: false,
        provider: Object.freeze({ message: "Captured offer", connected: true, pending: false, offerText: "sample", choices: Object.freeze(["sample"]),
            choiceIndex: 0, completionDetail: "", completionIncomplete: false, resolving: false, snippet: null, omittedCompletions: [],
            diagnosticsPending: false, unversionedDiagnostics: [],
            completionAt: (index: number) => ({ label: "sample", select: () => { chosen.push(index); return true; },
                accept: (mode: "insert" | "replace") => { inserted.push(mode); return true; } }),
            diagnostics: Object.freeze([Object.freeze({ from: 5, to: 9, message: "First diagnostic", select: () => { diagnostics.push(5); return true; } })]), diagnosticRevision: 1 }) });
    let current = state, reads = 0;
    const tools: Parameters<typeof languagePanelModel>[0] = { state: { getSnapshot: () => { reads++; return current; }, subscribe: () => noop }, toolsRef: noop, queryRef: noop, replacementRef: noop, keyFromTools: noop,
        request: noop, cancel: noop, disconnect: noop, reconnect: noop, next: noop, previous: noop, replaceCurrent: noop, replaceAll: noop, cancelFind: noop, foldSelection: noop, expandFolds: noop, focusEditor: noop,
        setQuery: noop, setReplacement: noop, setWholeWord: noop, setMatchCase: noop, setRegularExpression: noop };
    const first = languagePanelModel(tools, state), oldChoice = first.choices.items()[0]!, oldDiagnostic = first.diagnostics.items()[0]!;
    assert.equal(reads, 0); assert.equal(first.folds.text, "Captured folds");
    current = { ...state, view: "secondary", provider: { ...state.provider!, diagnostics: [{ from: 10, to: 14, message: "Second diagnostic", select: () => { diagnostics.push(10); return true; } }] } };
    const newer = languagePanelModel(tools, current);
    oldChoice.invoke(); oldDiagnostic.invoke(); first.actions.find(action => action.label === "Insert completion")!.invoke();
    assert.deepEqual(chosen, []); assert.deepEqual(diagnostics, []); assert.deepEqual(inserted, []);
    newer.choices.items()[0]!.invoke(); newer.diagnostics.items()[0]!.invoke(); newer.actions.find(action => action.label === "Insert completion")!.invoke();
    assert.deepEqual(chosen, [0]); assert.deepEqual(diagnostics, [10]); assert.deepEqual(inserted, ["insert"]);
    const oldCurrentDiagnostic = newer.diagnostics.items()[0]!; current = { ...current, query: "changed" }; const status = languagePanelModel(tools, current);
    assert.equal(status.diagnostics.items()[0]!.key, oldCurrentDiagnostic.key); oldCurrentDiagnostic.invoke(); assert.deepEqual(diagnostics, [10]);
    status.diagnostics.items()[0]!.invoke(); assert.deepEqual(diagnostics, [10, 10], "retained rows renew their activation snapshot");
    const reference = languagePanelModel(tools, { ...current, readOnlyReference: true, provider: null });
    assert.equal(reference.replacement.disabled, true); assert.match(reference.status.text, /read-only reference/);
    assert.equal(first.query.bind, tools.queryRef); assert.equal(first.replacement.bind, tools.replacementRef); assert.equal(first.bind, tools.toolsRef);
});

test("color controls keep the reference and reviewed Apply from the displayed snapshot", () => {
    const calls: string[] = [];
    const tools: Parameters<typeof documentColorsPanelModel>[0] = { discover: noop, cancel: noop, disconnect: noop, reconnect: noop,
        bindList: noop, bindValue: noop, setValue: noop, preview: noop, openChanged: noop };
    const state: DocumentColorsSnapshot = { available: true, connected: true, disconnected: false, pending: false, view: "primary", status: "presentations", message: "",
        count: 1, page: 0, paging: null, selected: 0, value: "#abc", css: "#abc", presentation: "hex", canPreview: true, canApply: true, reviewKey: 1, apply: () => { calls.push("apply first"); return { applied: true } as const; },
        colors: [{ from: 1, to: 5, text: "#abc", label: "#abc", color: { red: 1, green: 1, blue: 1, alpha: 1 }, ordinal: 0, line: 1, column: 2, css: "#abc", inspect: () => calls.push("inspect first") }],
        choices: [{ id: "hex", label: "Hex", select: () => calls.push("hex") }], edits: [], changed: null };
    const first = documentColorsPanelModel(tools, state), newer = documentColorsPanelModel(tools, { ...state, apply: () => { calls.push("apply next"); return { applied: true } as const; } });
    assert.equal(first.results.retentionKey(), newer.results.retentionKey()); first.results.items()[0]!.invoke(); first.presentation.change("hex");
    newer.apply.invoke(); first.apply.invoke(); assert.deepEqual(calls, ["inspect first", "hex", "apply next", "apply first"]);
});

test("link rows retain their own action through repaging and resolution", () => {
    const opened: string[] = [];
    const tools: Parameters<typeof documentLinksPanelModel>[0] = { discover: noop, returnToOrigin: noop, cancel: noop, addCompanion: noop,
        disconnect: noop, reconnect: noop, bindList: noop };
    let formatted = 0;
    const state: DocumentLinksSnapshot = { available: true, connected: true, disconnected: false, pending: false, requestView: "primary",
        status: "ready", message: "Captured links", count: 1, page: 0, paging: null, canReturn: false,
        links: [{ from: 8, to: 20, module: "module", tooltip: "Resolve module", target: null, resolvable: true, line: 1, column: 9,
            get title() { formatted++; return "First"; }, targetTitle: null, open: () => { opened.push("first"); } }] };
    const first = documentLinksPanelModel(tools, state); assert.equal(formatted, 0);
    assert.equal(documentLinksPanelModel(tools, { ...state, status: "resolving" }).results.disabled, true);
    const newer = documentLinksPanelModel(tools, { ...state, page: 1, links: [{ ...state.links[0]!, open: () => { opened.push("next"); } }] });
    newer.results.items()[0]!.invoke(); first.results.items()[0]!.invoke(); assert.deepEqual(opened, ["next", "first"]);
    assert.equal(first.results.items()[0]!.available, true); assert.equal(first.results.bind, tools.bindList);
});

test("rename presentation retains its preview name, confirmation action and changed resource", () => {
    const applied: (number | null)[] = [], opened: DocumentId[] = [], firstId = "first" as DocumentId, secondId = "second" as DocumentId;
    const tools: Parameters<typeof renamePanelModel>[0] = { prepare: noop, cancel: noop,
        showPage: noop, disconnect: noop, reconnect: noop, bindName: noop, setName: noop, openChanged: id => { opened.push(id); } };
    let formatted = 0;
    const preview = (id: number, name: string) => ({ name, count: 1, canApply: true, readPage: () => undefined, confirm: () => { applied.push(id); return { applied: true } as const; } });
    const state: HostRenameSnapshot = Object.freeze({ available: true, connected: true, disconnected: false, pending: false, status: "ready", message: "Captured rename",
        name: "firstName", symbol: "symbol", reviewKey: 3, preview: preview(3, "firstName"), canApply: true, count: 1, page: 0,
        locations: Object.freeze([Object.freeze({ ordinal: 0, document: firstId, resource: "source", title: "First", revision: 1, from: 0, to: 6, line: 0, column: 0,
            get context() { formatted++; return "symbol"; } })]), changes: Object.freeze([Object.freeze({ document: firstId, title: "First" })]) });
    const first = renamePanelModel(tools, state), renamed = renamePanelModel(tools, { ...state, name: "secondName", preview: preview(4, "secondName"), changes: [{ document: secondId, title: "Second" }] });
    assert.equal(formatted, 0); assert.equal(first.targets.identity, renamed.targets.identity);
    assert.match(first.targets.items()[0]!.text, /symbol → firstName/); assert.match(renamed.targets.items()[0]!.text, /symbol → secondName/);
    renamed.actions.find(action => action.label === "Apply captured rename")!.invoke(); first.actions.find(action => action.label === "Apply captured rename")!.invoke();
    renamed.changes.items()[0]!.invoke(); first.changes.items()[0]!.invoke();
    assert.deepEqual(applied, [4, 3]); assert.deepEqual(opened, [secondId, firstId]); assert.equal(first.name.bind, tools.bindName);
});

test("action controls invoke the choice and confirmation supplied by their snapshot", () => {
    const selected: number[] = [], applied: number[] = [], opened: DocumentId[] = [], firstId = "first" as DocumentId, secondId = "second" as DocumentId;
    const state: ActionsSnapshot = Object.freeze({ reviewKey: 1, available: true, connected: true, disconnected: false, reconnectRequired: false, pending: false, canApply: true,
        active: true, confirm: () => { applied.push(9); }, module: "module", status: "ready", message: "Captured action", title: "Action", disabled: null, command: null, edits: Object.freeze([]),
        changed: Object.freeze({ document: firstId, title: "First" }), changes: Object.freeze([Object.freeze({ document: firstId, title: "First" })]),
        choices: Object.freeze([Object.freeze({ index: 0, title: "First action", kind: null, preferred: false, disabled: null, needsResolve: false, select: () => { selected.push(9); } })]),
        choice: 0, choicePage: 0, choicePaging: null, editPaging: null, resolving: false, page: 0, editCount: 0 });
    const tools: Parameters<typeof actionsPanelModel>[0] = { request: noop, cancel: noop, disconnect: noop,
        reconnect: noop, bindModule: noop, setModule: noop, openChangedDocument: id => { opened.push(id); } };
    const first = actionsPanelModel(tools, state), oldChoice = first.choices.items()[0]!;
    const current = { ...state, confirm: () => { applied.push(10); }, choices: [{ ...state.choices[0]!, select: () => { selected.push(10); } }],
        changed: { document: secondId, title: "Second" }, changes: [{ document: secondId, title: "Second" }] };
    const newer = actionsPanelModel(tools, current), newChoice = newer.choices.items()[0]!;
    assert.notEqual(first.choices.identity, newer.choices.identity);
    oldChoice.invoke(); newChoice.invoke(); assert.deepEqual(selected, [9, 10]);
    newer.actions.find(action => action.label === "Apply captured action")!.invoke!();
    first.actions.find(action => action.label === "Apply captured action")!.invoke!(); assert.deepEqual(applied, [10, 9]);
    newer.changes.items()[0]!.invoke(); first.changes.items()[0]!.invoke(); assert.deepEqual(opened, [secondId, firstId]);
    assert.equal(first.module.bind, tools.bindModule);
});

test("navigation presentation keeps a captured target while a newer snapshot supplies another page", () => {
    const opened: [number, number][] = [];
    const tools: Parameters<typeof navigationPanelModel>[0] = { findDefinition: noop, findReferences: noop, cancel: noop, returnToOrigin: noop,
        addCompanion: noop, disconnect: noop, reconnect: noop, setIncludeDeclaration: noop };
    let formatted = 0;
    const state: NavigationSnapshot = Object.freeze({ available: true, connected: true, disconnected: false, canCancel: true,
        paging: { key: 7, previous: null, next: noop }, status: "ready", message: "Captured results", work: 1, total: 1, includeDeclaration: true, canReturn: false,
        locations: Object.freeze([Object.freeze({ declaration: true, ordinal: 0,
            get title() { formatted++; return "First"; }, line: 1, column: 3, open: () => { opened.push([7, 0]); } })]) });
    const first = navigationPanelModel(tools, state), statusOnly = navigationPanelModel(tools, { ...state, message: "Origin focused", canReturn: true });
    assert.equal(formatted, 0, "status presentation does not format the retained result list");
    assert.equal(statusOnly.results.identity, first.results.identity);
    const newer = navigationPanelModel(tools, { ...state, paging: { key: 8, previous: noop, next: null }, locations: [{ ...state.locations[0]!, ordinal: 64, open: () => { opened.push([8, 64]); } }] });
    newer.results.items()[0]!.invoke(); first.results.items()[0]!.invoke();
    assert.deepEqual(opened, [[8, 64], [7, 0]], "old rows never resolve through the newer result page");
    assert.notEqual(newer.results.identity, first.results.identity);
    assert.equal(first.actions.find(a => a.label === "Next navigation results")!.invoke, noop);
    assert.equal(newer.actions.find(a => a.label === "Next navigation results")!.disabled, true);
});

test("project presentation keeps decisions, edit pages and resources tied to the displayed review", () => {
    const decisions: number[] = [], opened: DocumentId[] = [], firstId = "first" as DocumentId, secondId = "second" as DocumentId;
    const tools: Parameters<typeof projectPanelModel>[0] = { register: noop, unregister: noop, requestEdits: noop, requestStatus: noop, cancel: noop,
        disconnect: noop, reconnect: noop, openChanged: id => { opened.push(id); } };
    const review = (key: number) => Object.freeze({ key, label: "Captured review", count: 130, page: 1, notes: Object.freeze([]), canApply: true,
        apply: () => { decisions.push(key); }, decline: () => { decisions.push(key); },
        nextPage: () => { decisions.push(key); }, previousPage: () => { decisions.push(key); } });
    const state: ProjectSnapshot = Object.freeze({ available: true, connected: true, disconnected: false, reconnectRequired: false, registered: true, pending: true,
        status: "pending", message: "Review captured changes", view: "primary", changes: Object.freeze([Object.freeze({ document: firstId, title: "First" })]),
        review: review(5) });
    const first = projectPanelModel(tools, state), statusOnly = projectPanelModel(tools, { ...state, pending: false, message: "Ready" });
    assert.equal(first.changes.identity, statusOnly.changes.identity); assert.equal(first.review.identity, statusOnly.review.identity);
    const newer = projectPanelModel(tools, { ...state, changes: [{ document: secondId, title: "Second" }], review: review(6) });
    const invoke = (model: typeof first, label: string) => model.actions.find(action => action.label === label)!.invoke();
    invoke(newer, "Apply captured provider edits"); invoke(first, "Apply captured provider edits"); invoke(first, "Decline captured provider edits");
    invoke(first, "Next provider edits"); invoke(newer, "Previous provider edits");
    newer.changes.items()[0]!.invoke(); first.changes.items()[0]!.invoke();
    assert.deepEqual(decisions, [6, 5, 5, 5, 6]); assert.deepEqual(opened, [secondId, firstId]);
    assert.equal(state.review!.key, 5); assert.equal(state.changes[0]!.document, firstId);
});
