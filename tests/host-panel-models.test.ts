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

const noop = () => {};

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
