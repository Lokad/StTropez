import { BracketMatcher, bracketMatchLimits } from "../core/bracket-matching.ts";
import type { BracketMatchCursor, BracketMatchOptions, BracketMatchProgress, BracketMatchResult } from "../core/bracket-matching.ts";
import type { ResolvedLanguageConfiguration } from "../core/language-edits.ts";
import { Store } from "../core/observable.ts";
import { isFocused } from "./dom-focus.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentId, DocumentView, TabId, Workspace } from "../core/workspace.ts";
import type { InlineDecoration, PresentedLine, TextViewport } from "./viewport.ts";

export type BracketHighlightSnapshot = Readonly<{ status: "disabled" | "idle" | "pending" | "ready" | "failed" | "disposed";
    documentId: DocumentId; revision: number; caret: number | null; result: BracketMatchResult | null; failure: string | null;
    workUnits: number; readUnits: number; callbackCalls: number }>;
export type BracketHighlights = Readonly<{ state: Observable<BracketHighlightSnapshot>;
    configure: (options: boolean | BracketMatchOptions) => boolean; refresh: () => void }>;
const empty: readonly InlineDecoration[] = Object.freeze([]);

/** Internal view owner. The editor supplies its existing activity/configuration without a second editor state. */
export function mountBracketHighlights(workspace: Workspace, tabId: TabId, view: DocumentView, viewport: TextViewport, input: HTMLTextAreaElement,
    configuration: () => ResolvedLanguageConfiguration, idle: () => boolean, initial: boolean | BracketMatchOptions = false) {
    const target = workspace.captureTab(tabId), documentId = view.documentId, win = input.ownerDocument.defaultView!;
    const notifications = workspace.createNotificationScope();
    const cell = new Store<BracketHighlightSnapshot>(Object.freeze({ status: "disabled", documentId, revision: workspace.document(documentId).revision,
        caret: null, result: null, failure: null, workUnits: 0, readUnits: 0, callbackCalls: 0 }), notifications);
    let disposed = false, limits: Required<BracketMatchOptions> | undefined, matcher: BracketMatcher | undefined, language: ResolvedLanguageConfiguration | undefined;
    let timer: number | undefined, events: AbortController | undefined;
    const stops: (() => void)[] = [];
    type Job = { cursor: BracketMatchCursor; current: () => boolean; revision: number; caret: number; running: boolean };
    let job: Job | undefined, current: (() => boolean) | undefined, decorations = empty, first = empty, second = empty;
    const focused = () => isFocused(input);
    const available = () => !disposed && !!limits && !input.disabled && workspace.ownsDocumentView(view) && !!workspace.resolveTab(target) && focused();
    const publish = (status: BracketHighlightSnapshot["status"], revision = cell.get().revision, caret: number | null = null, progress?: BracketMatchProgress) => {
        const result = progress?.result ?? null;
        const next = result?.kind === "matched" ? [result.at!, result.match!].sort((a, b) => a - b)
            .map(from => Object.freeze({ from, to: from + 1, className: "st-matching-bracket" })) : empty;
        if (next.length !== decorations.length || next.some((range, index) => range.from !== decorations[index]!.from)) {
            decorations = Object.freeze(next); first = decorations.length ? Object.freeze([decorations[0]!]) : empty;
            second = decorations.length ? Object.freeze([decorations[1]!]) : empty; viewport.invalidate();
        }
        const before = cell.get(), failure = progress?.failure ?? null;
        if (before.status === status && before.revision === revision && before.caret === caret && before.result === result && before.failure === failure) return;
        const changed = new Set<Store<unknown>>(); cell.set(Object.freeze({ status, documentId, revision, caret, result, failure,
            workUnits: progress?.workUnits ?? 0, readUnits: progress?.readUnits ?? 0, callbackCalls: progress?.callbackCalls ?? 0 }), changed);
        notifications.deliver([...changed]);
    };
    const cancel = () => {
        if (timer !== undefined) win.clearTimeout(timer); timer = undefined;
        const captured = job; job = undefined; if (captured && !captured.running) captured.cursor.dispose();
    };
    const advance = (captured: Job) => {
        if (job !== captured) return;
        timer = undefined;
        if (!captured.current()) { refresh(); return; }
        captured.running = true; let progress: BracketMatchProgress;
        try {
            const start = win.performance.now(), work = captured.cursor.snapshot().workUnits;
            do { progress = captured.cursor.next(256); }
            while (job === captured && progress.status === "running" && progress.workUnits - work < 4096 && win.performance.now() - start < 4);
        } catch { progress = captured.cursor.snapshot(); }
        finally { captured.running = false; }
        if (job !== captured || !captured.current()) {
            captured.cursor.dispose(); if (job === captured) refresh(); return;
        }
        if (progress.status === "running") timer = win.setTimeout(() => advance(captured), 0);
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
        const configured = configuration(); if (configured !== language) { language = configured; matcher = new BracketMatcher(configured); }
        const captured: Job = { cursor: matcher!.createCursor(document.buffer, selected.head, limits), revision: document.revision, caret: selected.head, running: false,
            current: () => available() && idle() && configuration() === configured && workspace.document(documentId).revision === document.revision
                && workspace.document(documentId).buffer === document.buffer && view.getSnapshot().selectionSet === selections };
        current = captured.current; job = captured; publish("pending", document.revision, selected.head);
        timer = win.setTimeout(() => advance(captured), 0);
    }
    const observed = () => refresh();
    const configure = (value: boolean | BracketMatchOptions): boolean => {
        if (disposed) return false;
        const next = value === false ? undefined : bracketMatchLimits(value === true ? {} : value);
        if (limits?.maxDepth === next?.maxDepth && limits?.maxWorkUnits === next?.maxWorkUnits) return true;
        limits = next;
        if (!limits) { events?.abort(); events = undefined; stops.splice(0).forEach(stop => stop()); matcher = undefined; language = undefined; }
        else if (!events) {
            events = new AbortController();
            for (const name of ["focus", "blur", "compositionstart", "compositionend", "input", "keyup"] as const) input.addEventListener(name, observed, { signal: events.signal });
            stops.push(workspace.observeDocument(documentId).subscribe(observed), view.subscribe(observed),
                workspace.tabState.subscribe(() => { if (!available()) refresh(); }));
        }
        refresh(true); return true;
    };
    const handle: BracketHighlights = Object.freeze({ state: cell.observable,
        configure: value => { notifications.assertWritable(); return configure(value); },
        refresh: () => { notifications.assertWritable(); refresh(true); } });
    configure(initial);
    return Object.freeze({ handle, refresh: observed,
        decorate: (line: PresentedLine): readonly InlineDecoration[] => {
            if (line.documentId !== documentId || line.revision !== cell.get().revision || !decorations.length) return empty;
            const left = decorations[0]!.from >= line.from && decorations[0]!.to <= line.to, right = decorations[1]!.from >= line.from && decorations[1]!.to <= line.to;
            return left ? right ? decorations : first : right ? second : empty;
        },
        dispose: () => { if (disposed) return; disposed = true; current = undefined; cancel(); events?.abort(); stops.splice(0).forEach(stop => stop()); matcher = undefined; language = undefined; publish("disposed"); } });
}
