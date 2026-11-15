import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentId } from "../src/index.ts";
import { navigationPanelModel } from "../examples/hosts/navigation-panel.ts";
import { projectPanelModel } from "../examples/hosts/project-panel.ts";
import type { NavigationSnapshot } from "../examples/hosts/navigation.ts";
import type { ProjectSnapshot } from "../examples/hosts/project.ts";

const noop = () => {};

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
