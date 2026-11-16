import test from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "../src/index.ts";
import { createFindController } from "../src/browser/find.ts";
import type { FindBackend, FindQueryCapture, FindPlanStep, FindSnapshot } from "../src/browser/index.ts";
import type { SearchStep } from "../src/core/search.ts";
import type { EditingCandidate } from "../src/browser/index.ts";
import { regexMatches, regexReplacement } from "../src/core/regex-search.ts";

for (const terminal of ["ready", "failed", "cancelled"] as const)
test(`unchanged regex transfer steps preserve snapshot identity and accumulated timing through ${terminal}`, async t => {
    const workspace = new Workspace(), documentId = workspace.createDocument({ scope: "find", resource: "progress", variant: "working" }, "Source", "catcat");
    const tab = workspace.open({ kind: "text", documentId }, "left"), view = workspace.createDocumentView(documentId), tasks = new Map<number, () => void>();
    let serial = 0, now = 0, calls = 0, disposed = false, late: ((step: SearchStep) => void) | undefined;
    const owner = Object.assign(new EventTarget(), { defaultView: { performance: { now: () => now },
        setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } });
    const editor = { view, element: { ownerDocument: owner }, input: new EventTarget(), activity: () => ({ composing: false, disposed: false }), viewport: { revealOffset: () => {} }, focus: () => {} } as unknown as EditingCandidate;
    const backend: FindBackend = { dispose: () => { disposed = true; }, replace: () => { throw new Error("Unexpected replacement."); }, search: () => ({
        dispose: () => {}, next: () => {
            calls++; now += calls === 52 ? 80 : calls;
            if (calls === 51 && terminal === "failed") throw new Error("Regular-expression search is unavailable in this host.");
            if (calls === 51 && terminal === "cancelled") return new Promise<SearchStep>(resolve => { late = resolve; });
            return Promise.resolve({ done: calls === 53, scanned: calls === 53 ? 6 : calls > 50 ? 3 : 0,
                readUnits: 1, matches: calls === 51 ? [{ from: 0, to: 3 }] : [] });
        } }) };
    const find = createFindController(workspace, tab, editor, { regularExpression: backend, regularExpressionDelayMs: 0 });
    find.setOptions({ regularExpression: true }); const states: FindSnapshot[] = [], stop = find.state.subscribe(() => states.push(find.state.getSnapshot()));
    const tick = async () => { const next = tasks.entries().next().value; if (next) { tasks.delete(next[0]); next[1](); } await Promise.resolve(); await Promise.resolve(); };
    try {
        find.setQuery("cat"); const initial = find.state.getSnapshot(); assert.equal(initial.reason, null);
        for (let i = 0; i < 50; i++) await tick();
        assert.equal(calls, 50); assert.equal(states.length, 1); assert.equal(find.state.getSnapshot(), initial);
        await tick();
        if (terminal === "ready") {
            const progress = find.state.getSnapshot(); assert.equal(progress.count, 1); assert.equal(progress.scanned, 3); assert.equal(progress.maxScanStepMs, 51);
            await tick(); assert.equal(find.state.getSnapshot(), progress); assert.equal(states.length, 2);
            await tick(); assert.equal(find.state.getSnapshot().maxScanStepMs, 80); assert.equal(states.length, 3);
        } else if (terminal === "cancelled") {
            find.cancel(); const cancelled = find.state.getSnapshot(); assert.equal(cancelled.maxScanStepMs, 50);
            late!({ done: true, scanned: 6, readUnits: 0, matches: [{ from: 0, to: 3 }] }); await tick(); assert.equal(find.state.getSnapshot(), cancelled);
            assert.equal(states.length, 2);
        } else { assert.equal(find.state.getSnapshot().message, "Regular-expression search is unavailable in this host."); assert.equal(find.state.getSnapshot().maxScanStepMs, 50); assert.equal(states.length, 2); }
        assert.equal(find.state.getSnapshot().status, terminal); assert.equal(tasks.size, 0);
        assert.equal(find.state.getSnapshot().reason, terminal === "ready" ? null : terminal === "failed" ? "search-failed" : "cancelled");
        t.diagnostic(JSON.stringify({ terminal, transferSteps: 50, publishedSnapshots: states.length, maxScanStepMs: find.state.getSnapshot().maxScanStepMs }));
    } finally {
        stop(); find.destroy(); assert.equal(find.state.getSnapshot().reason, null); assert.equal(find.state.getSnapshot().message, "");
        view.dispose(); workspace.close(tab); assert.equal(disposed, true); assert.equal(tasks.size, 0);
        assert.equal(workspace.diagnostics().subscriptions, 0); assert.equal(workspace.diagnostics().leases, 0);
    }
});

function fixture(text: string, supplied = true) {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "find", resource: "regex", variant: "working" }, "Source", { value: text });
    const tab = workspace.open({ kind: "text", documentId: source.documentId }, "left"), view = workspace.createDocumentView(source.documentId), peer = workspace.createDocumentView(source.documentId);
    let serial = 0, focused = 0, composing = false, holdSecond = false, failPlan = false, badPlan = false, backendDisposed = false;
    const tasks = new Map<number, () => void>(), held: (() => void)[] = [], plans: { disposed: boolean; capture: FindQueryCapture }[] = [];
    const owner = Object.assign(new EventTarget(), { defaultView: { performance, setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } });
    const editor = { view, element: { ownerDocument: owner }, input: new EventTarget(), activity: () => ({ disposed: false, composing }),
        viewport: { revealOffset: () => {} }, focus: () => { focused++; } } as unknown as EditingCandidate;
    const backend: FindBackend = {
        dispose: () => { backendDisposed = true; },
        search: capture => {
            const raw = capture.buffer.slice(0, capture.buffer.length), ranges = [...regexMatches(raw, capture.query, capture.matchCase, capture.wholeWord)].map(m => ({ from: m.from, to: m.to }));
            return { next: () => Promise.resolve({ done: true, scanned: raw.length, readUnits: raw.length, matches: ranges }), dispose: () => {} };
        },
        replace: (capture, replacement, range) => {
            const raw = capture.buffer.slice(0, capture.buffer.length), matches = [...regexMatches(raw, capture.query, capture.matchCase, capture.wholeWord, range?.from ?? 0)];
            const edits = matches.filter(m => !range || m.from === range.from && m.to === range.to).map(m => ({ from: m.from, to: m.to, insert: regexReplacement(raw, m, replacement) }));
            const job = { disposed: false, capture }; plans.push(job); let index = 0, calls = 0;
            return { next: () => {
                const value: FindPlanStep = index < edits.length ? { done: false, edits: [edits[index++]!] } : { done: true, edits: [] }; calls++;
                if (calls === 1 && badPlan && value.edits.length) return Promise.resolve({ done: false, edits: [{ ...value.edits[0]!, from: 1 }] });
                if (calls === 2 && failPlan) return Promise.reject(new Error("Synthetic plan failure."));
                if (calls === 2 && holdSecond) return new Promise<FindPlanStep>(resolve => held.push(() => resolve(value)));
                return Promise.resolve(value);
            }, dispose: () => { job.disposed = true; } };
        },
    };
    const find = createFindController(workspace, tab, editor, supplied ? { regularExpression: backend, regularExpressionDelayMs: 0 } : {});
    const tick = async () => { if (tasks.size) { const [id, work] = tasks.entries().next().value!; tasks.delete(id); work(); } await Promise.resolve(); await Promise.resolve(); };
    const drain = async () => { for (let turns = 0; turns < 100; turns++) { await tick(); if (!tasks.size) return; } throw new Error("Find did not yield."); };
    return { workspace, source, tab, view, peer, owner, editor, find, plans, tick, drain,
        text: () => { const b = workspace.document(source.documentId).buffer; return b.slice(0, b.length); },
        hold: () => { holdSecond = true; }, fail: () => { failPlan = true; }, tamper: () => { badPlan = true; }, focused: () => focused,
        compose: () => { composing = true; editor.input.dispatchEvent(new Event("compositionstart")); },
        release: () => { held.splice(0).forEach(resolve => resolve()); },
        finish: () => { find.destroy(); held.splice(0).forEach(resolve => resolve()); view.dispose(); peer.dispose(); workspace.close(tab);
            assert.equal(backendDisposed, supplied);
            assert.equal(tasks.size, 0); assert.equal(workspace.diagnostics().subscriptions, 0); assert.equal(workspace.diagnostics().leases, 0); } };
}

test("async regex find advances empty matches, accepts manual overlaps and preserves shared complete-set undo", async () => {
    const f = fixture("😀x");
    try {
        f.find.setOptions({ regularExpression: true }); f.find.setQuery("(?:)"); await f.drain(); assert.equal(f.find.state.getSnapshot().count, 3);
        assert.deepEqual(f.find.matchesIn(1, 3), [{ from: 2, to: 2 }]);
        assert.deepEqual(f.find.matchesIn(3, 3), [{ from: 3, to: 3 }]);
        for (const expected of [0, 2, 3, 0]) { assert.equal(f.find.next(), true); assert.equal(f.view.getSnapshot().selection.head, expected); }
        f.view.setSelections(0, [{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }]); const selected = f.view.getSnapshot().selectionSet;
        assert.equal(f.find.replaceCurrent("<>"), true); await f.drain(); assert.equal(f.text(), "<>😀x"); assert.equal(f.workspace.observeHistory(f.source.documentId).getSnapshot().undoDepth, 1);
        assert.equal(f.find.replaceCurrent("<>"), true); await f.drain(); assert.equal(f.text(), "<>😀x"); assert.equal(f.view.getSnapshot().selection.head, 4);
        f.workspace.undo({ documentId: f.source.documentId, expectedRevision: f.workspace.document(f.source.documentId).revision }); await f.drain(); assert.equal(f.text(), "😀x"); assert.deepEqual(f.view.getSnapshot().selectionSet, selected);
        const before = f.workspace.observeHistory(f.source.documentId).getSnapshot(); f.find.replaceCurrent("$&"); await f.drain(); assert.deepEqual(f.workspace.observeHistory(f.source.documentId).getSnapshot(), before);
        f.find.replaceCurrent("$&"); await f.drain(); assert.equal(f.view.getSnapshot().selection.head, 2); assert.equal(f.text(), "😀x");
        assert.equal(f.workspace.document(f.source.documentId).buffer.readMetrics().textExports, 0);
    } finally { f.finish(); }
    const overlap = fixture("aaa");
    try {
        overlap.find.setOptions({ regularExpression: true }); overlap.find.setQuery("aa"); await overlap.drain();
        overlap.view.setSelections(0, [{ anchor: 1, head: 3 }, { anchor: 0, head: 0 }]); const selected = overlap.view.getSnapshot().selectionSet;
        overlap.find.replaceCurrent("x"); await overlap.drain(); assert.equal(overlap.text(), "ax");
        overlap.workspace.undo({ documentId: overlap.source.documentId, expectedRevision: overlap.workspace.document(overlap.source.documentId).revision }); await overlap.drain();
        assert.equal(overlap.text(), "aaa"); assert.deepEqual(overlap.view.getSnapshot().selectionSet, selected);
    } finally { overlap.finish(); }
});

test("find options patch existing choices and unrelated selections navigate without starting replacement work", async () => {
    const f = fixture("alpha beta beta_ BETA");
    try {
        f.find.setOptions({ wholeWord: true }); f.find.setOptions({ matchCase: false }); f.find.setOptions({ regularExpression: true });
        f.find.setQuery("beta"); await f.drain();
        const state = f.find.state.getSnapshot(); assert.equal(state.wholeWord, true); assert.equal(state.matchCase, false); assert.equal(state.regularExpression, true); assert.equal(state.count, 2);
        f.view.setSelection(0, { anchor: 0, head: 5 });
        assert.equal(f.find.replaceCurrent("x"), true); await f.drain();
        assert.equal(f.plans.length, 0); assert.equal(f.text(), "alpha beta beta_ BETA");
        const selected = f.view.getSnapshot().selection; assert.deepEqual([selected.anchor, selected.head], [6, 10]);
        assert.equal(f.find.replaceCurrent("x"), true); await f.drain(); assert.equal(f.text(), "alpha x beta_ BETA");
    } finally { f.finish(); }
});

test("partial async regex plans respect selection, revision, composition, authority, option and view lifetime changes", async () => {
    for (const change of ["selection", "revision", "composition", "authority", "options", "view", "focus"] as const) {
        const f = fixture("cat cat");
        try {
            f.find.setOptions({ regularExpression: true }); f.find.setQuery("cat"); await f.drain(); f.view.setSelections(0, [{ anchor: 0, head: 0 }, { anchor: 7, head: 7 }]);
            f.hold(); const beforeFocus = f.focused(); f.find.replaceAll("dog"); await f.tick(); await f.tick(); assert.equal(f.find.state.getSnapshot().status, "replacing"); assert.equal(f.text(), "cat cat");
            if (change === "selection") f.view.setSelections(0, [{ anchor: 0, head: 0 }, { anchor: 6, head: 6 }]);
            if (change === "revision") f.workspace.edit({ documentId: f.source.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 7, to: 7, insert: " human" }] });
            if (change === "composition") f.compose();
            if (change === "authority") { const lease = f.workspace.acquireEditLease(f.source.id, "other", "host"); lease.release(); }
            if (change === "options") f.find.setOptions({ regularExpression: false });
            if (change === "view") f.view.dispose();
            if (change === "focus") f.owner.dispatchEvent(new Event("focusin"));
            f.release(); await Promise.resolve(); await f.drain();
            assert.equal(f.text(), change === "revision" ? "cat cat human" : change === "focus" ? "dog dog" : "cat cat", change);
            assert.equal(f.workspace.observeHistory(f.source.documentId).getSnapshot().undoDepth, change === "revision" || change === "focus" ? 1 : 0, change);
            assert.equal(f.focused(), beforeFocus, change); assert.equal(f.plans[0]!.disposed, true, change);
            assert.equal(f.find.state.getSnapshot().reason, { selection: null, revision: null, composition: "composition-active",
                authority: "editing-unavailable", options: null, view: "view-unavailable", focus: "replaced" }[change], change);
            if (change === "composition") {
                assert.equal(f.find.next(), false); assert.equal(f.find.state.getSnapshot().reason, "composition-active");
                assert.equal(f.find.replaceCurrent("dog"), false); assert.equal(f.find.state.getSnapshot().reason, "composition-active");
            }
        } finally { f.finish(); }
    }
});

test("missing backend, syntax errors and failed or mismatched plans cannot publish partial edits", async () => {
    const absent = fixture("cat", false);
    try { absent.find.setOptions({ regularExpression: true }); absent.find.setQuery("cat"); await absent.drain(); assert.equal(absent.find.state.getSnapshot().status, "failed"); assert.equal(absent.find.state.getSnapshot().count, 0); assert.equal(absent.text(), "cat");
        assert.equal(absent.find.state.getSnapshot().reason, "backend-unavailable");
        absent.find.setOptions({ regularExpression: false }); assert.equal(absent.find.state.getSnapshot().reason, null); await absent.drain();
        assert.equal(absent.find.state.getSnapshot().status, "ready"); assert.equal(absent.find.state.getSnapshot().count, 1);
        absent.find.setQuery(""); assert.equal(absent.find.state.getSnapshot().reason, null); assert.equal(absent.find.state.getSnapshot().message, "");
    }
    finally { absent.finish(); }
    const f = fixture("cat cat");
    try {
        f.find.setOptions({ regularExpression: true }); f.find.setQuery("("); await f.drain(); assert.equal(f.find.state.getSnapshot().status, "failed");
        assert.equal(f.find.state.getSnapshot().reason, "search-failed");
        f.find.setQuery("cat"); await f.drain(); f.fail(); f.find.replaceAll("dog"); await f.drain(); assert.equal(f.text(), "cat cat"); assert.equal(f.find.state.getSnapshot().status, "ready"); assert.match(f.find.state.getSnapshot().message, /failure/);
        assert.equal(f.find.state.getSnapshot().reason, "replacement-failed");
        assert.equal(f.workspace.observeHistory(f.source.documentId).getSnapshot().undoDepth, 0); assert.equal(f.plans[0]!.disposed, true);
        assert.ok(Object.isFrozen(f.find.matchesIn(0, 7)));
        assert.equal(f.find.next(), true); assert.equal(f.find.state.getSnapshot().reason, null); assert.equal(f.find.state.getSnapshot().message, "");
    } finally { f.finish(); }
    const wrong = fixture("cat cat");
    try {
        wrong.find.setOptions({ regularExpression: true }); wrong.find.setQuery("cat"); await wrong.drain(); wrong.tamper(); wrong.find.replaceAll("dog"); await wrong.drain();
        assert.equal(wrong.text(), "cat cat"); assert.match(wrong.find.state.getSnapshot().message, /captured search/); assert.equal(wrong.workspace.observeHistory(wrong.source.documentId).getSnapshot().undoDepth, 0);
        assert.equal(wrong.find.state.getSnapshot().reason, "replacement-failed");
    } finally { wrong.finish(); }
});
