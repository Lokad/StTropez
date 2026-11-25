import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { Workspace, TextBuffer } from "../src/index.ts";
import type { ComparisonSnapshot, DocumentView } from "../src/index.ts";
import { createComparisonAlignment } from "../src/browser/comparison-alignment.ts";
import { createComparisonScroll } from "../src/browser/comparison-scroll.ts";
import { createComparisonPanes } from "../src/browser/comparison-panes.ts";
import type { TextEditor } from "../src/browser/text-editor.ts";
import type { TextViewport, ViewportComparisonRows } from "../src/browser/viewport.ts";

function fixture(count = 5000) {
    const workspace = new Workspace(), baseline = TextBuffer.from("a\n-\n".repeat(count));
    const resource = workspace.createTextResource({ scope: "test", resource: "working", variant: "text" }, "Working", { value: "b\n-\n".repeat(count) });
    const ref = workspace.createTextResource({ scope: "test", resource: "baseline", variant: "text" }, "Baseline", { value: "a\n-\n".repeat(count) });
    const view = workspace.createDocumentView(resource.documentId), refView = workspace.createDocumentView(ref.documentId);
    let state: ComparisonSnapshot = Object.freeze({ status: "ready", generation: 0, baseline: Object.freeze({ buffer: baseline, version: "one", epoch: 0 }),
        working: workspace.document(resource.documentId), progress: null, failure: null,
        hunks: Object.freeze(Array.from({ length: count }, (_, i) => {
            const range = Object.freeze({ from: i * 4, to: i * 4 + 1, lineFrom: i * 2, lineTo: i * 2 + 1 });
            return Object.freeze({ baseline: range, working: range, whitespaceOnly: false });
        })) });
    const tasks = new Map<number, () => void>(); let serial = 0, time = 0, clockStep = 0, reads = 0, notifications = 0, composing = false;
    const queue = (run: () => void) => { tasks.set(++serial, run); return serial; }, cancel = (id: number) => tasks.delete(id);
    const win = Object.assign(new EventTarget(), { setTimeout: queue, clearTimeout: cancel, requestAnimationFrame: queue, cancelAnimationFrame: cancel,
        performance: { now: () => { time += clockStep; return time; } } }) as unknown as Window;
    function viewport(current: DocumentView) {
        let installed: ViewportComparisonRows | undefined, top = 0;
        const element = Object.assign(new EventTarget(), { isConnected: true }), rendered = new EventTarget();
        const read = () => { reads++; return { revision: current.getSnapshot().revision,
            foldGeneration: current.folding.getSnapshot().generation, naturalLineHeight: 20, lineHeight: 20, rowGeneration: installed?.id ?? 0,
            aligned: !!installed, alignmentId: installed?.id ?? null, pending: false, disposed: false, scrollTop: top, verticalExtent: count * 40, height: 200 }; };
        const value = { view: current, element, getSnapshot: read, activity: read,
            onRender: (listener: () => void) => { rendered.addEventListener("render", listener); return () => rendered.removeEventListener("render", listener); },
            scrollTo: ({ top: next }: { top?: number }) => { if (next !== undefined) top = next; }, flush: () => {} } as unknown as TextViewport;
        return { value, element, setComparisonRows: (rows: ViewportComparisonRows | undefined) => { installed = rows; return true; }, installed: () => installed, render: () => rendered.dispatchEvent(new Event("render")), renderListeners: () => getEventListeners(rendered, "render").length };
    }
    const working = viewport(view), reference = viewport(refView);
    const workingInput = new EventTarget() as HTMLTextAreaElement, referenceInput = new EventTarget() as HTMLTextAreaElement;
    const editor = { view, viewport: working.value, activity: () => ({ composing, pendingInput: false, pendingCommand: false, pendingDragScroll: false }) } as unknown as TextEditor;
    let compositions = 0, focuses = 0;
    const baselineEditor = { view: refView, viewport: reference.value, focus: () => { focuses++; } } as unknown as TextEditor;
    const baselineMount = { editor: baselineEditor, input: referenceInput, setComparisonRows: reference.setComparisonRows };
    const panes = createComparisonPanes({ editor, input: workingInput, setComparisonRows: working.setComparisonRows }, () => { compositions++; }); panes.setReference(baselineMount);
    const alignment = createComparisonAlignment(win, panes, () => state, () => notifications++, () => !composing);
    const step = () => { const entry = tasks.entries().next().value; assert.ok(entry, "Expected scheduled work"); tasks.delete(entry[0]); entry[1](); };
    const drain = () => { let turns = 0; while (tasks.size) { assert.ok(++turns < 1000, "Scheduler failed to settle"); step(); } return turns; };
    return { workspace, view, refView, win, working, reference, editor, referenceInput, panes, alignment, tasks, step, drain, state: () => state,
        counters: () => ({ reads, notifications, compositions, focuses }), setClockStep: (value: number) => { clockStep = value; },
        setComposing: (value: boolean) => { composing = value; }, setReference: (value: TextViewport | undefined) => { panes.setReference(value ? baselineMount : undefined); },
        refresh: () => { state = Object.freeze({ ...state, generation: state.generation + 1 }); },
        dispose: () => { alignment.dispose(); panes.dispose(); view.dispose(); refView.dispose(); assert.equal(tasks.size, 0); assert.equal(workspace.diagnostics().subscriptions, 0);
            for (const input of [workingInput, referenceInput]) for (const type of ["compositionstart", "compositionend"]) assert.equal(getEventListeners(input, type).length, 0); } };
}

test("alignment bounds each turn by elapsed time and work, publishes once, and cancels stale captures", () => {
    const f = fixture();
    try {
        f.alignment.setEnabled(true); const start = f.counters().notifications; f.step();
        assert.equal(f.alignment.snapshot().work, 4096); assert.equal(f.counters().notifications, start);
        assert.equal(f.working.installed(), undefined); assert.ok(f.drain() < 5);
        assert.equal(f.alignment.snapshot().status, "ready"); assert.equal(f.counters().notifications, start + 1);
        assert.equal(f.working.installed()!.id, f.reference.installed()!.id);
        f.refresh(); f.alignment.update(); f.setClockStep(1); const before = f.counters().notifications; f.step();
        // Four 256-unit advances reach the elapsed-time target; progress alone does not publish.
        assert.equal(f.alignment.snapshot().work, 1024); assert.equal(f.counters().notifications, before);
        const obsolete = [...f.tasks.values()][0]!;
        f.alignment.setEnabled(false); assert.equal(f.tasks.size, 0); assert.equal(f.working.installed(), undefined);
        f.alignment.setEnabled(true); const replacement = [...f.tasks]; obsolete();
        assert.deepEqual([...f.tasks], replacement); assert.equal(f.alignment.snapshot().work, 0);
        f.step(); f.refresh(); f.alignment.update();
        assert.equal(f.alignment.snapshot().work, 0); f.setClockStep(0); f.setComposing(true); f.drain();
        assert.equal(f.alignment.snapshot().status, "waiting"); assert.equal(f.working.installed(), undefined);
        f.setComposing(false); f.working.render(); f.drain();
        assert.equal(f.alignment.snapshot().status, "ready"); assert.equal(f.working.installed()!.id, f.reference.installed()!.id);
    } finally { f.dispose(); }
});

test("optional comparison listeners detach, rebind current references and cancel pending frames", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"), observed = new Set<Element>();
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
        observe(element: Element) { observed.add(element); } unobserve(element: Element) { observed.delete(element); } disconnect() { observed.clear(); }
    } });
    const f = fixture(10), scroll = createComparisonScroll(f.win, f.panes, f.state, () => true);
    const navigateBeforePaint = (top: number) => {
        f.working.element.dispatchEvent(new Event("keydown"));
        f.working.value.scrollTo({ top });
        assert.ok(scroll.snapshot().pending);
    };
    const listeners = () => [f.working, f.reference].flatMap(pane => [pane.renderListeners(), ...["scroll", "keydown", "beforeinput", "pointerdown", "compositionend"].map(type => getEventListeners(pane.element, type).length)]);
    const idle = () => {
        assert.ok(listeners().every(n => n === 0)); assert.equal(f.workspace.diagnostics().subscriptions, 0); assert.equal(observed.size, 0);
        const before = f.counters().reads;
        for (const pane of [f.working, f.reference]) { pane.render(); for (const type of ["scroll", "keydown"]) pane.element.dispatchEvent(new Event(type)); }
        f.alignment.update(); scroll.update(); assert.equal(f.counters().reads, before); assert.equal(f.tasks.size, 0);
    };
    try {
        idle();
        f.referenceInput.dispatchEvent(new Event("compositionstart")); f.reference.element.dispatchEvent(new Event("focus"));
        // Each mounted editor routes viewport focus. A comparison must not redirect an armed native drag.
        assert.equal(f.counters().compositions, 1); assert.equal(f.counters().focuses, 0);
        for (let pass = 0; pass < 2; pass++) {
            f.alignment.setEnabled(true); scroll.setLinked(true); f.drain(); assert.equal(observed.size, 2);
            assert.equal(f.working.renderListeners(), 1);
            assert.equal(getEventListeners(f.working.element, "pointerdown").length, 1);
            assert.equal(f.workspace.diagnostics().subscriptions, 2);
            navigateBeforePaint(40 + pass * 20); scroll.setLinked(false);
            assert.equal(scroll.snapshot().pending, false); assert.equal(getEventListeners(f.working.element, "keydown").length, 0);
            assert.equal(f.working.renderListeners(), 1); assert.equal(observed.size, 0);
            f.alignment.setEnabled(false); idle();
        }
        f.alignment.setEnabled(true); scroll.setLinked(true); f.drain(); navigateBeforePaint(100);
        f.setReference(undefined); assert.equal(scroll.snapshot().pending, false); f.drain();
        assert.equal(f.reference.renderListeners(), 0); assert.equal(observed.size, 1);
        assert.equal(f.reference.installed(), undefined); assert.equal(f.working.installed(), undefined);
        f.referenceInput.dispatchEvent(new Event("compositionend")); f.reference.element.dispatchEvent(new Event("focus"));
        assert.equal(f.counters().compositions, 1); assert.equal(f.counters().focuses, 0);
        const before = f.counters().reads; f.reference.render(); f.reference.element.dispatchEvent(new Event("scroll"));
        assert.equal(f.counters().reads, before); assert.equal(f.tasks.size, 0);
        f.setReference(f.reference.value); f.drain();
        f.referenceInput.dispatchEvent(new Event("compositionend")); assert.equal(f.counters().compositions, 2);
        f.alignment.setEnabled(false); assert.equal(f.working.renderListeners(), 1);
        assert.equal(getEventListeners(f.working.element, "compositionend").length, 0); assert.equal(f.workspace.diagnostics().subscriptions, 2);
        f.drain();
        navigateBeforePaint(140); scroll.dispose(); f.alignment.dispose(); idle();
    } finally { scroll.dispose(); f.dispose(); if (previous) Object.defineProperty(globalThis, "ResizeObserver", previous); else Reflect.deleteProperty(globalThis, "ResizeObserver"); }
});
