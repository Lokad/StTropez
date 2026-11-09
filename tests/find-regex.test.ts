import test from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "../src/index.ts";
import { createFindController } from "../src/browser/find.ts";
import type { FindBackend, FindQueryCapture, FindPlanStep } from "../src/browser/find.ts";
import type { EditingCandidate } from "../src/browser/index.ts";
import { regexMatches, regexReplacement } from "../src/core/regex-search.ts";

function fixture(text: string, supplied = true) {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "find", resource: "regex", variant: "working" }, "Source", { value: text });
    const tab = workspace.open({ kind: "text", documentId: source.documentId }, "left"), view = workspace.createDocumentView(source.documentId), peer = workspace.createDocumentView(source.documentId);
    let serial = 0, focused = 0, composing = false, holdSecond = false, failPlan = false, badPlan = false;
    const tasks = new Map<number, () => void>(), held: (() => void)[] = [], plans: { disposed: boolean; capture: FindQueryCapture }[] = [];
    const owner = Object.assign(new EventTarget(), { defaultView: { performance, setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } });
    const editor = { view, element: { ownerDocument: owner }, input: new EventTarget(), snapshot: () => ({ disposed: false, composing }),
        viewport: { revealOffset: () => {} }, focus: () => { focused++; } } as unknown as EditingCandidate;
    const backend: FindBackend = {
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
            assert.equal(tasks.size, 0); assert.equal(workspace.diagnostics().subscriptions, 0); assert.equal(workspace.diagnostics().leases, 0); } };
}

test("async regex find advances empty matches, accepts manual overlaps and preserves shared complete-set undo", async () => {
    const f = fixture("😀x");
    try {
        f.find.setOptions({ regularExpression: true }); f.find.setQuery("(?:)"); await f.drain(); assert.equal(f.find.state.getSnapshot().count, 3);
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
        } finally { f.finish(); }
    }
});

test("missing backend, syntax errors and failed or mismatched plans cannot publish partial edits", async () => {
    const absent = fixture("cat", false);
    try { absent.find.setOptions({ regularExpression: true }); absent.find.setQuery("cat"); await absent.drain(); assert.equal(absent.find.state.getSnapshot().status, "failed"); assert.equal(absent.find.state.getSnapshot().count, 0); assert.equal(absent.text(), "cat"); }
    finally { absent.finish(); }
    const f = fixture("cat cat");
    try {
        f.find.setOptions({ regularExpression: true }); f.find.setQuery("("); await f.drain(); assert.equal(f.find.state.getSnapshot().status, "failed");
        f.find.setQuery("cat"); await f.drain(); f.fail(); f.find.replaceAll("dog"); await f.drain(); assert.equal(f.text(), "cat cat"); assert.equal(f.find.state.getSnapshot().status, "ready"); assert.match(f.find.state.getSnapshot().message, /failure/);
        assert.equal(f.workspace.observeHistory(f.source.documentId).getSnapshot().undoDepth, 0); assert.equal(f.plans[0]!.disposed, true);
        assert.ok(Object.isFrozen(f.find.state.getSnapshot().preview));
    } finally { f.finish(); }
    const wrong = fixture("cat cat");
    try {
        wrong.find.setOptions({ regularExpression: true }); wrong.find.setQuery("cat"); await wrong.drain(); wrong.tamper(); wrong.find.replaceAll("dog"); await wrong.drain();
        assert.equal(wrong.text(), "cat cat"); assert.match(wrong.find.state.getSnapshot().message, /captured search/); assert.equal(wrong.workspace.observeHistory(wrong.source.documentId).getSnapshot().undoDepth, 0);
    } finally { wrong.finish(); }
});
