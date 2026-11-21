import { BracketMatcher } from "../core/bracket-matching.ts";
import type { BracketMatchCursor, BracketMatchOptions, BracketMatchProgress, BracketMatchResult } from "../core/bracket-matching.ts";
import type { ResolvedLanguageConfiguration } from "../core/language-edits.ts";
import { Store } from "../core/observable.ts";
import { isFocused } from "./dom-focus.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";
import type { Observable } from "../core/observable.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { DocumentId, DocumentView, TabTarget, Workspace } from "../core/workspace.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { InlineDecoration, TextViewport } from "./viewport.ts";

export type BracketHighlightSnapshot = Readonly<{ status: "disabled" | "idle" | "pending" | "ready" | "failed" | "disposed";
    documentId: DocumentId; revision: number; caret: number | null; result: BracketMatchResult | null; failure: string | null;
    workUnits: number; readUnits: number; callbackCalls: number }>;
export type BracketHighlights = Observable<BracketHighlightSnapshot> & Readonly<{
    refresh: () => void }>;
const empty: readonly InlineDecoration[] = Object.freeze([]);

/** Internal view owner. The editor supplies its existing activity/configuration without a second editor state. */
export function mountBracketHighlights(workspace: Workspace, target: TabTarget | undefined, view: DocumentView, viewport: TextViewport, input: HTMLTextAreaElement,
    configuration: () => ResolvedLanguageConfiguration, idle: () => boolean, initial: false | Required<BracketMatchOptions> = false) {
    const documentId = view.documentId, win = input.ownerDocument.defaultView!;
    const notifications = workspace.createNotificationScope(), runner = createCooperativeRunner(win);
    const cell = new Store<BracketHighlightSnapshot>(Object.freeze({ status: "disabled", documentId, revision: workspace.document(documentId).revision,
        caret: null, result: null, failure: null, workUnits: 0, readUnits: 0, callbackCalls: 0 }), notifications);
    let disposed = false, limits: Required<BracketMatchOptions> | undefined, matcher: BracketMatcher | undefined, language: ResolvedLanguageConfiguration | undefined;
    let events: AbortController | undefined;
    const stops: (() => void)[] = [];
    type Job = { cursor: BracketMatchCursor; current: () => boolean; revision: number; caret: number; running: boolean };
    let job: Job | undefined, current: (() => boolean) | undefined, decorations = empty;
    const layer = viewport.decorations.add({ name: "matching brackets", order: 100, minimap: false });
    const focused = () => isFocused(input);
    const available = () => !disposed && !!limits && !input.disabled && ownsTextSurface(workspace, view, target) && focused();
    function cursor(buffer: TextBuffer, at: number): BracketMatchCursor {
        const configured = configuration();
        if (configured !== language) { language = configured; matcher = new BracketMatcher(configured); }
        return matcher!.createCursor(buffer, at, limits);
    }
    const publish = (status: BracketHighlightSnapshot["status"], revision = cell.get().revision, caret: number | null = null, progress?: BracketMatchProgress) => {
        const result = progress?.result ?? null;
        const next = result?.kind === "matched" ? [result.at!, result.match!].sort((a, b) => a - b)
            .map(from => Object.freeze({ from, to: from + 1, className: "st-matching-bracket" })) : empty;
        if (next.length !== decorations.length || next.some((range, index) => range.from !== decorations[index]!.from)) {
            decorations = Object.freeze(next);
            if (decorations.length) layer.set(revision, decorations); else layer.clear();
        }
        const before = cell.get(), failure = progress?.failure ?? null;
        if (before.status === status && before.revision === revision && before.caret === caret && before.result === result && before.failure === failure) return;
        notifications.publish(cell, Object.freeze({ status, documentId, revision, caret, result, failure,
            workUnits: progress?.workUnits ?? 0, readUnits: progress?.readUnits ?? 0, callbackCalls: progress?.callbackCalls ?? 0 }));
    };
    const cancel = () => {
        runner.cancel();
        const captured = job; job = undefined; if (captured && !captured.running) captured.cursor.dispose();
    };
    const advance = (captured: Job) => {
        if (job !== captured) return;
        if (!captured.current()) { refresh(); return; }
        captured.running = true; let progress: BracketMatchProgress;
        try {
            const work = captured.cursor.snapshot().workUnits;
            progress = runner.slice(() => captured.cursor.next(256),
                next => job === captured && next.status === "running" && next.workUnits - work < 4096, 16);
        } catch { progress = captured.cursor.snapshot(); }
        finally { captured.running = false; }
        if (job !== captured || !captured.current()) {
            captured.cursor.dispose(); if (job === captured) refresh(); return;
        }
        if (progress.status === "running") runner.schedule(() => advance(captured));
        else { job = undefined; captured.cursor.dispose(); publish(progress.status === "ready" ? "ready" : "failed", captured.revision, captured.caret, progress); }
    };
    function refresh(force = false) {
        if (!force && current?.()) return;
        current = undefined;
        cancel();
        if (disposed) return;
        if (!available() || !idle()) { publish(limits ? "idle" : "disabled"); return; }
        const document = workspace.document(documentId), selections = view.getSnapshot().selectionSet, selected = selections.ranges[selections.primary]!;
        if (selected.anchor !== selected.head) { publish("idle", document.revision); return; }
        const configured = configuration();
        const captured: Job = { cursor: cursor(document.buffer, selected.head), revision: document.revision, caret: selected.head, running: false,
            current: () => available() && idle() && configuration() === configured && workspace.document(documentId).revision === document.revision
                && workspace.document(documentId).buffer === document.buffer && view.getSnapshot().selectionSet === selections };
        current = captured.current; job = captured; publish("pending", document.revision, selected.head);
        runner.schedule(() => advance(captured));
    }
    const observed = () => refresh();
    const configure = (value: false | Required<BracketMatchOptions>): boolean => {
        if (disposed) return false;
        const next = value === false ? undefined : value;
        if (limits?.maxDepth === next?.maxDepth && limits?.maxWorkUnits === next?.maxWorkUnits) return true;
        limits = next;
        if (!limits) { events?.abort(); events = undefined; stops.splice(0).forEach(stop => stop()); matcher = undefined; language = undefined; }
        else if (!events) {
            events = new AbortController();
            for (const name of ["focus", "blur", "compositionstart", "compositionend", "input", "keyup"] as const) input.addEventListener(name, observed, { signal: events.signal });
            stops.push(workspace.observeDocument(documentId).subscribe(observed), view.subscribe(observed));
            if (target) stops.push(workspace.tabState.subscribe(() => { if (!available()) refresh(); }));
        }
        refresh(true); return true;
    };
    const handle: BracketHighlights = Object.freeze({ ...cell.observable,
        refresh: () => { notifications.assertWritable(); refresh(true); } });
    configure(initial);
    return Object.freeze({ handle, cursor, configure, refresh: observed,
        dispose: () => { if (disposed) return; disposed = true; current = undefined; cancel(); events?.abort(); stops.splice(0).forEach(stop => stop()); matcher = undefined; language = undefined; publish("disposed"); layer.dispose(); } });
}
