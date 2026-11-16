import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentId } from "../src/index.ts";
import { navigationPanelModel } from "../examples/hosts/navigation-panel.ts";
import { projectPanelModel } from "../examples/hosts/project-panel.ts";
import type { NavigationSnapshot } from "../examples/hosts/navigation.ts";
import type { ProjectSnapshot } from "../examples/hosts/project.ts";
import { renamePanelModel } from "../examples/hosts/rename-panel.ts";
import { actionsPanelModel } from "../examples/hosts/actions-panel.ts";
import type { RenameSnapshot } from "../examples/hosts/rename.ts";
import type { ActionsSnapshot } from "../examples/hosts/code-actions.ts";
import { documentColorsPanelModel } from "../examples/hosts/document-colors-panel.ts";
import { documentLinksPanelModel } from "../examples/hosts/document-links-panel.ts";
import type { DocumentColorsSnapshot } from "../examples/hosts/document-colors.ts";
import type { DocumentLinksSnapshot } from "../examples/hosts/document-links.ts";
import { languagePanelModel } from "../examples/hosts/language-panel.ts";

const noop = () => {};

test("language result callbacks cannot follow a newer view or diagnostic batch while rendering stays snapshot-only", () => {
    type Snapshot = Parameters<typeof languagePanelModel>[1];
    const chosen: [number, number | undefined][] = [], inserted: (number | undefined)[] = [], diagnostics: number[] = [];
    const state: Snapshot = Object.freeze({ readOnlyReference: false, view: "primary", find: null, folds: null, foldMessage: "Captured folds", query: "sa", replacement: "sample", wholeWord: false, matchCase: true, regularExpression: false,
        provider: Object.freeze({ message: "Captured offer", connected: true, pending: false, offerText: "sample", completionId: 17, choices: Object.freeze(["sample"]),
            diagnostics: Object.freeze([Object.freeze({ from: 5, to: 9, message: "First diagnostic" })]), diagnosticRevision: 1 }) });
    let current = state, reads = 0;
    const tools: Parameters<typeof languagePanelModel>[0] = { state: { getSnapshot: () => { reads++; return current; }, subscribe: () => noop }, toolsRef: noop, queryRef: noop, replacementRef: noop, keyFromTools: noop,
        request: noop, insert: id => { inserted.push(id); }, replace: noop, cancel: noop, disconnect: noop, reconnect: noop, next: noop, previous: noop, replaceCurrent: noop, replaceAll: noop, cancelFind: noop, foldSelection: noop, expandFolds: noop, focusEditor: noop,
        chooseCompletion: (index, id) => { chosen.push([index, id]); }, selectDiagnostic: index => { diagnostics.push(index); }, setQuery: noop, setReplacement: noop, setWholeWord: noop, setMatchCase: noop, setRegularExpression: noop };
    const first = languagePanelModel(tools, state), oldChoice = first.choices.items()[0]!, oldDiagnostic = first.diagnostics.items()[0]!;
    assert.equal(reads, 0); assert.equal(first.folds.text, "Captured folds");
    current = { ...state, view: "secondary", provider: { ...state.provider!, diagnostics: [{ from: 10, to: 14, message: "Second diagnostic" }] } };
    const newer = languagePanelModel(tools, current);
    oldChoice.invoke(); oldDiagnostic.invoke(); first.actions.find(action => action.label === "Insert completion")!.invoke();
    assert.deepEqual(chosen, []); assert.deepEqual(diagnostics, []); assert.deepEqual(inserted, []);
    newer.choices.items()[0]!.invoke(); newer.diagnostics.items()[0]!.invoke(); newer.actions.find(action => action.label === "Insert completion")!.invoke();
    assert.deepEqual(chosen, [[0, 17]]); assert.deepEqual(diagnostics, [0]); assert.deepEqual(inserted, [17]);
    const oldCurrentDiagnostic = newer.diagnostics.items()[0]!; current = { ...current, query: "changed" }; const status = languagePanelModel(tools, current);
    assert.equal(status.diagnostics.items()[0]!.key, oldCurrentDiagnostic.key); oldCurrentDiagnostic.invoke(); assert.deepEqual(diagnostics, [0]);
    status.diagnostics.items()[0]!.invoke(); assert.deepEqual(diagnostics, [0, 0], "retained rows renew their activation snapshot");
    const reference = languagePanelModel(tools, { ...current, readOnlyReference: true, provider: null });
    assert.equal(reference.replacement.disabled, true); assert.match(reference.status.text, /read-only reference/);
    assert.equal(first.query.bind, tools.queryRef); assert.equal(first.replacement.bind, tools.replacementRef); assert.equal(first.bind, tools.toolsRef);
});

test("color presentation retains its confirmation tuple and resource while equivalent rows keep their identity", () => {
    const inspected: [number | null, number][] = [], applied: [number | null, number | null, string][] = [], opened: DocumentId[] = [];
    const firstId = "first" as DocumentId, secondId = "second" as DocumentId;
    const tools: Parameters<typeof documentColorsPanelModel>[0] = { discover: noop, cancel: noop, previousPage: noop, nextPage: noop, disconnect: noop, reconnect: noop,
        bindList: noop, bindValue: noop, setValue: noop, preview: noop, setPresentation: noop,
        inspect: (token, ordinal) => { inspected.push([token, ordinal]); }, apply: (token, preview, id) => { applied.push([token, preview, id]); }, openChanged: id => { opened.push(id); } };
    const state: DocumentColorsSnapshot = Object.freeze({ available: true, connected: true, disconnected: false, pending: false, token: 3, previewToken: 4, view: "primary",
        status: "presentations", message: "Captured color", work: 1, total: 1, count: 1, page: 0, selected: 0, value: "#abc", css: "rgb(170, 187, 204)", presentation: "hex", canPreview: true, canApply: true,
        colors: Object.freeze([Object.freeze({ from: 1, to: 5, text: "#abc", label: "#abc", color: Object.freeze({ red: 170 / 255, green: 187 / 255, blue: 204 / 255, alpha: 1 }), ordinal: 0, line: 1, column: 2, css: "rgb(170, 187, 204)" })]),
        choices: Object.freeze([Object.freeze({ id: "hex", label: "Hex" })]), edits: Object.freeze([]), changed: Object.freeze({ document: firstId, title: "First" }) });
    const first = documentColorsPanelModel(tools, state), pending = documentColorsPanelModel(tools, { ...state, pending: true, selected: -1, colors: state.colors.map(color => ({ ...color })) });
    assert.equal(first.results.retentionKey(), pending.results.retentionKey()); assert.equal(first.results.disabled, false); assert.equal(pending.results.disabled, true);
    assert.equal(first.results.isSelected(0), true); assert.equal(pending.results.isSelected(0), false);
    const newer = documentColorsPanelModel(tools, { ...state, token: 5, previewToken: 6, presentation: "rgba", changed: { document: secondId, title: "Second" } });
    assert.notEqual(first.results.retentionKey(), newer.results.retentionKey());
    newer.results.items()[0]!.invoke(); first.results.items()[0]!.invoke(); newer.apply.invoke(); first.apply.invoke(); newer.changed.invoke(); first.changed.invoke();
    assert.deepEqual(inspected, [[5, 0], [3, 0]]); assert.deepEqual(applied, [[5, 6, "rgba"], [3, 4, "hex"]]); assert.deepEqual(opened, [secondId, firstId]);
    assert.equal(first.results.bind, tools.bindList); assert.equal(first.value.bind, tools.bindValue);
});

test("link presentation retains captured ordinals while status updates do not replace equivalent result rows", () => {
    const opened: [number | null, number][] = [];
    const tools: Parameters<typeof documentLinksPanelModel>[0] = { discover: noop, returnToOrigin: noop, cancel: noop, previousPage: noop, nextPage: noop, addCompanion: noop,
        disconnect: noop, reconnect: noop, bindList: noop, open: (token, ordinal) => { opened.push([token, ordinal]); } };
    let formatted = 0;
    const state: DocumentLinksSnapshot = Object.freeze({ available: true, connected: true, disconnected: false, pending: false, token: 7, requestView: "primary",
        status: "ready", message: "Captured links", work: 1, total: 1, count: 1, page: 0, canReturn: false,
        links: Object.freeze([Object.freeze({ from: 8, to: 20, module: "module", tooltip: "Resolve module", target: null, resolvable: true, ordinal: 0, line: 1, column: 9,
            get title() { formatted++; return "First"; }, targetTitle: null })]) });
    const first = documentLinksPanelModel(tools, state); assert.equal(formatted, 0, "formatting and retention keys are lazy");
    const resolving = documentLinksPanelModel(tools, { ...state, status: "resolving", pending: true, links: state.links.map(link => ({ ...link })) });
    assert.equal(first.results.retentionKey(), resolving.results.retentionKey()); assert.equal(first.results.disabled, false); assert.equal(resolving.results.disabled, true);
    const newer = documentLinksPanelModel(tools, { ...state, token: 8, page: 1, links: [{ ...state.links[0]!, ordinal: 64 }] });
    assert.notEqual(first.results.retentionKey(), newer.results.retentionKey());
    newer.results.items()[0]!.invoke(); first.results.items()[0]!.invoke(); assert.deepEqual(opened, [[8, 64], [7, 0]]);
    assert.equal(first.results.items()[0]!.available, true); assert.equal(first.results.bind, tools.bindList);
});

test("rename presentation retains its preview name, confirmation token and changed resource", () => {
    const applied: (number | null)[] = [], opened: DocumentId[] = [], firstId = "first" as DocumentId, secondId = "second" as DocumentId;
    const tools: Parameters<typeof renamePanelModel>[0] = { usesLsp: false, prepare: noop, apply: token => { applied.push(token); }, cancel: noop,
        previousPage: noop, nextPage: noop, disconnect: noop, reconnect: noop, bindName: noop, setName: noop, openChanged: id => { opened.push(id); } };
    let formatted = 0;
    const state: RenameSnapshot = Object.freeze({ available: true, connected: true, disconnected: false, pending: false, status: "ready", message: "Captured rename",
        name: "firstName", symbol: "symbol", token: 3, canApply: true, work: 1, total: 1, count: 1, page: 0,
        locations: Object.freeze([Object.freeze({ ordinal: 0, document: firstId, resource: "source", title: "First", revision: 1, from: 0, to: 6, line: 0, column: 0,
            get context() { formatted++; return "symbol"; } })]), changes: Object.freeze([Object.freeze({ document: firstId, title: "First" })]) });
    const first = renamePanelModel(tools, state), renamed = renamePanelModel(tools, { ...state, name: "secondName", token: 4, changes: [{ document: secondId, title: "Second" }] });
    assert.equal(formatted, 0); assert.equal(first.targets.identity, renamed.targets.identity);
    assert.match(first.targets.items()[0]!.text, /symbol → firstName/); assert.match(renamed.targets.items()[0]!.text, /symbol → secondName/);
    renamed.actions.find(action => action.label === "Apply captured rename")!.invoke(); first.actions.find(action => action.label === "Apply captured rename")!.invoke();
    renamed.changes.items()[0]!.invoke(); first.changes.items()[0]!.invoke();
    assert.deepEqual(applied, [4, 3]); assert.deepEqual(opened, [secondId, firstId]); assert.equal(first.name.bind, tools.bindName);
});

test("action presentation reads current state only on choice activation and rejects an older choice generation", () => {
    const selected: number[] = [], applied: (number | null)[] = [], opened: DocumentId[] = [], firstId = "first" as DocumentId, secondId = "second" as DocumentId;
    const state: ActionsSnapshot = Object.freeze({ available: true, connected: true, disconnected: false, reconnectRequired: false, pending: false, canApply: true,
        token: 9, module: "module", status: "ready", message: "Captured action", title: "Action", disabled: null, work: 1, total: 1, command: null, edits: Object.freeze([]),
        changed: Object.freeze({ document: firstId, title: "First" }), changes: Object.freeze([Object.freeze({ document: firstId, title: "First" })]),
        choices: Object.freeze([Object.freeze({ index: 0, title: "First action", kind: null, preferred: false, disabled: null, needsResolve: false })]),
        choice: 0, choicePage: 0, resolving: false, page: 0, editCount: 0 });
    let current = state, reads = 0;
    const tools: Parameters<typeof actionsPanelModel>[0] = { usesLsp: true, state: { getSnapshot: () => { reads++; return current; }, subscribe: () => noop },
        request: noop, apply: token => { applied.push(token); }, cancel: noop, moveChoicePage: noop, previousPage: noop, nextPage: noop, disconnect: noop,
        reconnect: noop, bindModule: noop, setModule: noop, selectChoice: index => { selected.push(index); }, openChangedDocument: id => { opened.push(id); } };
    const first = actionsPanelModel(tools, state), legacy = actionsPanelModel({ ...tools, usesLsp: false }, state), oldChoice = first.choices.items()[0]!;
    current = { ...state, token: 10, changed: { document: secondId, title: "Second" }, changes: [{ document: secondId, title: "Second" }] };
    const newer = actionsPanelModel(tools, current), newChoice = newer.choices.items()[0]!;
    assert.equal(reads, 0, "model derivation and row formatting use only their supplied snapshot");
    assert.equal(first.choices.identity, newer.choices.identity); assert.notEqual(first.choices.pageKey, newer.choices.pageKey);
    oldChoice.invoke(); assert.deepEqual(selected, []); newChoice.invoke(); assert.deepEqual(selected, [0]); assert.equal(reads, 2);
    first.actions.find(action => action.label === "Apply captured action")!.invoke(); assert.deepEqual(applied, [9]);
    newer.changes.items()[0]!.invoke(); legacy.changes.items()[0]!.invoke(); assert.deepEqual(opened, [secondId, firstId]);
    assert.equal(first.module.bind, tools.bindModule);
});

test("navigation presentation keeps a captured target while a newer snapshot supplies another page", () => {
    const opened: [number, number][] = [];
    const tools: Parameters<typeof navigationPanelModel>[0] = { findDefinition: noop, findReferences: noop, cancel: noop, returnToOrigin: noop,
        previousPage: noop, nextPage: noop, addCompanion: noop, disconnect: noop, reconnect: noop, setIncludeDeclaration: noop,
        open: (token, ordinal) => { opened.push([token, ordinal]); } };
    let formatted = 0;
    const state: NavigationSnapshot = Object.freeze({ available: true, connected: true, disconnected: false, syncedDocuments: 1, view: "primary", requestView: "primary",
        token: 7, status: "ready", message: "Captured results", work: 1, total: 1, includeDeclaration: true, count: 70, truncated: false, page: 0, canReturn: false,
        locations: Object.freeze([Object.freeze({ document: "first", revision: 1, from: 2, to: 5, declaration: true, ordinal: 0,
            get title() { formatted++; return "First"; }, line: 1, column: 3 })]) });
    const first = navigationPanelModel(tools, state), statusOnly = navigationPanelModel(tools, { ...state, message: "Origin focused", canReturn: true });
    assert.equal(formatted, 0, "status presentation does not format the retained result list");
    assert.equal(statusOnly.results.identity, first.results.identity);
    const newer = navigationPanelModel(tools, { ...state, token: 8, page: 1, locations: [{ ...state.locations[0]!, ordinal: 64 }] });
    newer.results.items()[0]!.invoke(); first.results.items()[0]!.invoke();
    assert.deepEqual(opened, [[8, 64], [7, 0]], "old rows never resolve through the newer result page");
    assert.notEqual(newer.results.identity, first.results.identity);
    assert.equal(state.token, 7); assert.equal(state.page, 0);
});

test("project presentation retains review tokens and resource identities across newer results", () => {
    const decisions: (number | null)[] = [], opened: DocumentId[] = [], firstId = "first" as DocumentId, secondId = "second" as DocumentId;
    const tools: Parameters<typeof projectPanelModel>[0] = { usesLsp: true, register: noop, unregister: noop, requestEdits: noop, requestStatus: noop, cancel: noop,
        confirmReview: token => { decisions.push(token); }, declineReview: token => { decisions.push(token); }, previousReviewPage: noop, nextReviewPage: noop,
        disconnect: noop, reconnect: noop, openChanged: id => { opened.push(id); } };
    const state: ProjectSnapshot = Object.freeze({ available: true, connected: true, disconnected: false, reconnectRequired: false, registered: true, pending: true,
        status: "pending", message: "Review captured changes", view: "primary", changes: Object.freeze([Object.freeze({ document: firstId, title: "First" })]),
        review: Object.freeze({ token: 5, label: "Captured review", count: 0, page: 0, notes: Object.freeze([]), canApply: true }) });
    const first = projectPanelModel(tools, state), statusOnly = projectPanelModel(tools, { ...state, pending: false, message: "Ready" });
    assert.equal(first.changes.identity, statusOnly.changes.identity); assert.equal(first.review.identity, statusOnly.review.identity);
    const newer = projectPanelModel(tools, { ...state, changes: [{ document: secondId, title: "Second" }], review: { ...state.review!, token: 6 } });
    const invoke = (model: typeof first, label: string) => model.actions.find(action => action.label === label)!.invoke();
    invoke(newer, "Apply captured provider edits"); invoke(first, "Apply captured provider edits"); invoke(first, "Decline captured provider edits");
    newer.changes.items()[0]!.invoke(); first.changes.items()[0]!.invoke();
    assert.deepEqual(decisions, [6, 5, 5]); assert.deepEqual(opened, [secondId, firstId]);
    assert.equal(state.review!.token, 5); assert.equal(state.changes[0]!.document, firstId);
});
