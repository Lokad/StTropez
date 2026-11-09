import { PositionMap, textDifference, WordCursor, createGraphemeCursor, createSelectionSet, planSelectionEdits } from "../index.ts";
import type { Affinity, DocumentView, EditKind, Selection, SelectionSet, TabId, TextBuffer, TextEdit, Workspace, GraphemeCursor, GraphemeIndex } from "../index.ts";
import type { ViewState } from "./index.ts";
import { inputContext } from "./input-context.ts";
import { localAsciiGraphemePoint } from "../core/grapheme-point.ts";
import type { GraphemePoint } from "../core/grapheme-point.ts";
import { captureNativeInsertion, resolveNativeInsertion } from "./input-target.ts";
import type { NativeInsertionTarget } from "./input-target.ts";
import type { InputContext } from "./input-context.ts";
import { mountTextViewport } from "./viewport.ts";
import type { LineClass, LineDecorator, TextViewport } from "./viewport.ts";
import { mountTextDragDrop } from "./text-drag-drop.ts";

export type EditingCandidate = Readonly<{ element: HTMLDivElement; input: HTMLTextAreaElement; view: DocumentView; viewport: TextViewport;
    focus: () => void; captureView: () => ViewState; restoreView: (state: ViewState) => void; describe: (id: string) => () => void;
    snapshot: () => Readonly<{ inputUnits: number; inputEvents: number; lastInputMs: number; keydownEvents: number; lastKeydownMs: number; navigationTurns: number; navigationPreparationMs: number; maxNavigationTurnMs: number; navigationWorkMs: number; wordSelectionEvents: number; lastWordSelectionMs: number; maxWordSelectionTurnMs: number; pendingCaret: boolean; pendingDragScroll: boolean; dragScrollFrames: number; maxDragScrollStepMs: number; commits: number; conflicts: number; composing: boolean; pendingWord: boolean; wordScanSteps: number; maxWordScanStepMs: number; pendingGrapheme: boolean; graphemeScanSteps: number; maxGraphemeScanStepMs: number; visualMoves: number; disposed: boolean }>;
    destroy: () => void }>;
let nextMount = 0;

/** Experimental bounded-input adapter. Long contextual lines and native IME/AT remain qualification gates. */
export function mountEditingCandidate(host: HTMLElement, workspace: Workspace, tabId: TabId,
    options: Readonly<{ ariaLabel?: string; view?: DocumentView; decorate?: LineDecorator; lineClass?: LineClass }> = {}): EditingCandidate {
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text") throw new Error("Expected a text surface.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId);
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to a different document or workspace.");
    const view = options.view ?? workspace.createDocumentView(documentId);
    let viewport: TextViewport;
    try { viewport = mountTextViewport(host, workspace, tabId, { ...options, view }); }
    catch (error) { if (!options.view) view.dispose(); throw error; }
    const root = viewport.element;
    const owner = host.ownerDocument, win = owner.defaultView!, input = owner.createElement("textarea"), caret = owner.createElement("div"), secondaryCarets = owner.createElement("div"), help = owner.createElement("span");
    const caretNodes: HTMLDivElement[] = [];
    const scope = ++nextMount, listeners = new AbortController();
    root.classList.add("st-editing-candidate"); root.tabIndex = -1;
    root.querySelector(".st-viewport-layer")!.setAttribute("aria-hidden", "true");
    input.className = "st-input-context"; input.wrap = "off"; input.spellcheck = false; input.autocomplete = "off";
    // The native projection belongs to the editor, independently of enclosing host forms.
    input.setAttribute("form", "");
    input.setAttribute("aria-label", options.ariaLabel ?? workspace.document(documentId).title);
    input.setAttribute("aria-multiline", "true"); input.setAttribute("autocapitalize", "off");
    help.id = `st-input-help-${scope}`; help.className = "st-input-help"; help.textContent = "Alt+click or Alt+drag adds a caret or selection. Escape keeps the primary selection. Tab inserts indentation. Press Escape, then Tab or Shift+Tab to leave the editor.";
    input.setAttribute("aria-describedby", help.id); caret.className = "st-input-caret"; caret.setAttribute("aria-hidden", "true");
    secondaryCarets.setAttribute("aria-hidden", "true"); root.append(input, caret, secondaryCarets, help);
    let revision = workspace.document(documentId).revision, context: InputContext = inputContext(workspace.document(documentId).buffer, view.getSnapshot().selection);
    let disposed = false, composing = false, selecting = false, committing = false, escaped = false;
    const escapeState = (value: boolean) => {
        if (escaped === value) return;
        escaped = value; root.toggleAttribute("data-st-tab-escape", value);
        for (const button of root.querySelectorAll<HTMLButtonElement>(".st-fold-button")) button.tabIndex = value ? -1 : 0;
    };
    const descriptions = new Map<string, number>();
    const renderDescriptions = () => input.setAttribute("aria-describedby", [help.id, ...[...descriptions.keys()].filter(id => id !== help.id)].join(" "));
    const describe = (id: string): (() => void) => {
        if (typeof id !== "string" || !id || /\s/.test(id)) throw new TypeError("Expected one description element ID.");
        if (disposed) return () => {};
        descriptions.set(id, (descriptions.get(id) ?? 0) + 1); renderDescriptions(); let active = true;
        return () => {
            if (!active || disposed) return; active = false;
            const count = descriptions.get(id)!; if (count === 1) descriptions.delete(id); else descriptions.set(id, count - 1);
            renderDescriptions();
        };
    };
    let frame: number | undefined, commits = 0, conflicts = 0, serial = 0, inputEvents = 0, lastInputMs = 0;
    let keydownEvents = 0, lastKeydownMs = 0;
    let navigationTurns = 0, navigationPreparationMs = 0, maxNavigationTurnMs = 0, navigationWorkMs = 0, navigationDepth = 0;
    let wordSelectionEvents = 0, lastWordSelectionMs = 0, maxWordSelectionTurnMs = 0;
    let preferred: Readonly<{ selections: SelectionSet; revision: number; layout: string; columns: readonly (number | undefined)[] }> | undefined;
    let wordScanSteps = 0, maxWordScanStepMs = 0;
    let graphemeScanSteps = 0, maxGraphemeScanStepMs = 0;
    let visualMoves = 0;
    let group: Readonly<{ type: string; revision: number; selectionSet: SelectionSet; time: number; key: string }> | undefined;
    let drag: Readonly<{ pointer: number; anchor: number; anchorAffinity: Affinity; revision: number; x: number; y: number; selectionSet: SelectionSet; baseRanges: readonly Selection[] }> | undefined;
    let dragFrame: number | undefined, dragTime: number | undefined, dragScrollFrames = 0, maxDragScrollStepMs = 0;
    const commandTimers = new Set<number>();
    let wordJob: Readonly<{ cursor: WordCursor; revision: number; selection: Selection }> | undefined, wordTimer: number | undefined;
    type CommandCapture = Readonly<{ buffer: TextBuffer; revision: number; selection: Selection; selectionSet: SelectionSet; deleting: boolean }>;
    let graphemeJob: Readonly<{ cursor: GraphemeCursor; capture: CommandCapture; purpose: "word" | "word-selection" | "grapheme" }> | undefined, graphemeTimer: number | undefined;
    let graphemeCache: Readonly<{ buffer: TextBuffer; from: number; to: number; index: GraphemeIndex }> | undefined;
    type InputCapture = Readonly<{ revision: number; selectionSet: SelectionSet; context: InputContext; target?: NativeInsertionTarget }>;
    let wordInput: Readonly<{ revision: number; selectionSet: SelectionSet; direction: -1 | 1; word: boolean }> | undefined;
    let insertion: InputCapture | undefined, composition: InputCapture | undefined;
    let projectedSet = view.getSnapshot().selectionSet;
    let rangeCommand: Readonly<{ capture: CommandCapture; purpose: "word" | "grapheme"; release: () => void }> | undefined, rangeTimer: number | undefined;
    const apple = /Mac|iPhone|iPad|iPod/.test(win.navigator.platform);
    function cancelScans(): void {
        wordJob?.cursor.dispose(); wordJob = undefined;
        if (wordTimer !== undefined) { win.clearTimeout(wordTimer); commandTimers.delete(wordTimer); wordTimer = undefined; }
        graphemeJob?.cursor.dispose(); graphemeJob = undefined;
        if (graphemeTimer !== undefined) { win.clearTimeout(graphemeTimer); commandTimers.delete(graphemeTimer); graphemeTimer = undefined; }
    }
    function cancelWord(): void {
        cancelScans(); rangeCommand?.release(); rangeCommand = undefined;
        if (rangeTimer !== undefined) { win.clearTimeout(rangeTimer); commandTimers.delete(rangeTimer); rangeTimer = undefined; }
    }
    function cancelCommandTimers(): void {
        commandTimers.forEach(timer => win.clearTimeout(timer)); commandTimers.clear();
    }
    const scheduleCaret = () => { if (!disposed && frame === undefined) frame = win.requestAnimationFrame(positionCaret); };
    function positionCaret(): void {
        frame = undefined; if (disposed) return;
        const { selection: selected, selectionSet } = view.getSnapshot(), point = viewport.coordsAt(selected.head, selected.headAffinity), rectangle = root.getBoundingClientRect();
        const visible = point && point.left >= rectangle.left && point.left < rectangle.left + root.clientWidth
            && point.top + point.height > rectangle.top && point.top < rectangle.top + root.clientHeight;
        caret.hidden = !visible || selected.anchor !== selected.head || composing || owner.activeElement !== input;
        // Keep the native IME anchor near the measured caret without enlarging the scroll surface.
        const left = Math.max(0, Math.min(root.clientWidth - 2, (point?.left ?? rectangle.left) - rectangle.left));
        const top = Math.max(0, Math.min(root.clientHeight - 24, (point?.top ?? rectangle.top) - rectangle.top));
        for (const element of [input, caret]) { element.style.left = `${root.scrollLeft + left}px`; element.style.top = `${root.scrollTop + top}px`; element.style.height = `${point?.height ?? viewport.snapshot().lineHeight}px`; }
        const state = viewport.snapshot(), buffer = workspace.observeDocument(documentId).getSnapshot()?.buffer;
        const points = [];
        if (!composing && owner.activeElement === input && buffer && state.selectionSet === selectionSet && state.lastLine > state.firstLine) {
            const from = buffer.offsetAt(state.firstLine), to = state.lastLine < buffer.lineCount ? buffer.offsetAt(state.lastLine) : buffer.length;
            // Heads of normalized disjoint ranges are ordered. Measure only visible candidates,
            // using the same bounded native row geometry as the primary caret.
            let low = 0, high = selectionSet.ranges.length;
            while (low < high) { const middle = (low + high) >>> 1;
                if (selectionSet.ranges[middle]!.head < from) low = middle + 1; else high = middle; }
            for (let index = low; index < selectionSet.ranges.length; index++) {
                const range = selectionSet.ranges[index]!; if (range.head > to) break;
                if (index === selectionSet.primary || range.anchor !== range.head) continue;
                if (view.folding.getSnapshot().index.hiddenBy(buffer.lineAt(range.head))) continue;
                const at = viewport.coordsAt(range.head, range.headAffinity);
                if (at && at.left >= rectangle.left && at.left < rectangle.left + root.clientWidth
                    && at.top + at.height > rectangle.top && at.top < rectangle.top + root.clientHeight) points.push(at);
            }
        }
        while (caretNodes.length > points.length) caretNodes.pop()!.remove();
        points.forEach((at, index) => {
            let node = caretNodes[index];
            if (!node) { node = owner.createElement("div"); node.className = "st-input-secondary-caret"; caretNodes.push(node); secondaryCarets.append(node); }
            node.style.left = `${root.scrollLeft + at.left - rectangle.left}px`; node.style.top = `${root.scrollTop + at.top - rectangle.top}px`; node.style.height = `${at.height}px`;
        });
    }
    function refresh(): void {
        if (disposed || selecting || committing) return;
        const state = resource.getSnapshot(); input.disabled = !workspace.resolveTab(target) || state.state !== "ready";
        input.readOnly = !state.metadata.capabilities.edit.includes("human") || state.metadata.editLock !== null;
        input.setAttribute("aria-busy", String(state.state === "loading"));
        if (!input.disabled && !composing) {
            const document = workspace.document(documentId), { selection: selected, selectionSet } = view.getSnapshot();
            if (graphemeCache?.buffer !== document.buffer) graphemeCache = undefined;
            const capture = rangeCommand?.capture ?? graphemeJob?.capture;
            if (capture && (capture.revision !== document.revision || capture.selectionSet !== selectionSet || capture.deleting && input.readOnly)) cancelWord();
            context = inputContext(document.buffer, selected); revision = document.revision; projectedSet = selectionSet;
            if (input.value !== context.text) input.value = context.text;
            const anchor = context.nativeAnchor, head = context.nativeHead;
            if (input.selectionStart !== Math.min(anchor, head) || input.selectionEnd !== Math.max(anchor, head)
                || (input.selectionDirection === "backward") !== (anchor > head)) input.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward");
        }
        scheduleCaret();
    }
    function syncSelection(): void {
        if (disposed || composing || committing || input.disabled || input.value !== context.text) return;
        const backward = input.selectionDirection === "backward";
        // LF projection cannot distinguish both sides of a removed CR. An unchanged native
        // range still represents the exact captured model selection, including a raw CRLF interior.
        if (view.getSnapshot().selectionSet === projectedSet && input.selectionStart === Math.min(context.nativeAnchor, context.nativeHead)
            && input.selectionEnd === Math.max(context.nativeAnchor, context.nativeHead) && backward === (context.nativeAnchor > context.nativeHead)) return;
        const anchor = context.toModel(backward ? input.selectionEnd : input.selectionStart), head = context.toModel(backward ? input.selectionStart : input.selectionEnd);
        const current = view.getSnapshot(); if (current.revision === revision && current.selection.anchor === anchor && current.selection.head === head) return;
        selecting = true;
        try { if (view.setSelection(revision, { anchor, head })) projectedSet = view.getSnapshot().selectionSet; }
        finally { selecting = false; }
        scheduleCaret();
    }
    const conflict = (reason: string, edit?: TextEdit, expectedRevision = revision, contextFrom = context.from) => {
        conflicts++; group = undefined;
        input.dispatchEvent(new CustomEvent("sttropez-conflict", { bubbles: true, detail: Object.freeze({ documentId, expectedRevision, reason,
            attemptedText: input.value, contextFrom, ...(edit ? { attemptedEdit: Object.freeze({ ...edit }) } : {}) }) }));
    };
    function apply(edits: readonly TextEdit[], selection: Selection | SelectionSet, kind: EditKind, type?: string, expectedRevision = revision): void {
        if (disposed) return;
        cancelWord(); preferred = undefined;
        if (!workspace.resolveTab(target)) { conflict("expired-view", edits[0]); refresh(); return; }
        let key: string | undefined;
        const now = win.performance.now(), before = view.getSnapshot().selectionSet;
        if (type) {
            const adjacent = group?.type === type && group.revision === expectedRevision && group.selectionSet === before && now - group.time < 1000;
            key = adjacent ? group!.key : `${view.id}:${scope}:${++serial}`;
        } else group = undefined;
        committing = true;
        try {
            const result = workspace.edit({ documentId, expectedRevision, origin: "human", edits, view,
                ...("ranges" in selection ? { selectionSet: selection } : { selection }),
                history: { kind, ...(key ? { group: key } : {}) } });
            if (result.applied) { commits++; const after = view.getSnapshot(); viewport.revealOffset(after.selection.head);
                if (type && key) group = { type, revision: result.revision, selectionSet: after.selectionSet, time: now, key }; }
            else conflict(result.reason, edits[0]);
        } finally { committing = false; refresh(); }
    }
    function captureInput(type: string, data: string | null): InputCapture {
        const target = captureNativeInsertion(input, type, data);
        return { revision, selectionSet: view.getSnapshot().selectionSet, context, ...(target ? { target } : {}) };
    }
    function commit(type: string, captured = insertion ?? { revision, selectionSet: projectedSet, context }): void {
        insertion = undefined;
        if (disposed || composing) return;
        if (type === "historyUndo" || type === "historyRedo") { history(type === "historyUndo" ? "undo" : "redo"); return; }
        const projection = captured.context;
        if (input.value === projection.text && input.selectionStart === (captured.target?.from ?? Math.min(projection.nativeAnchor, projection.nativeHead))
            && input.selectionEnd === (captured.target?.to ?? Math.max(projection.nativeAnchor, projection.nativeHead))) { refresh(); return; }
        if ((captured.target && captured.target.before !== projection.text) || captured.revision !== workspace.observeDocument(documentId).getSnapshot()?.revision || captured.selectionSet !== view.getSnapshot().selectionSet) {
            conflict(type === "insertCompositionText" && captured.revision !== workspace.observeDocument(documentId).getSnapshot()?.revision ? "stale-revision" : "stale-text-input", undefined, captured.revision, projection.from); refresh(); return;
        }
        const native = captured.target && resolveNativeInsertion(captured.target, input, type);
        const edit = native || textDifference(projection.text, input.value);
        if (!edit) { refresh(); return; }
        const selected = captured.selectionSet.ranges[captured.selectionSet.primary]!;
        const exactTarget = native && edit.from === Math.min(projection.nativeAnchor, projection.nativeHead) && edit.to === Math.max(projection.nativeAnchor, projection.nativeHead);
        const from = exactTarget ? Math.min(selected.anchor, selected.head) : projection.toModel(edit.from);
        const to = exactTarget ? Math.max(selected.anchor, selected.head) : edit.from === edit.to ? from : projection.toModel(edit.to), delta = edit.insert.length - (to - from);
        const typing = type === "insertText" && !edit.insert.includes("\n"), deleting = type === "deleteContentBackward" || type === "deleteContentForward";
        const kind = typing ? "typing" : deleting ? "delete" : type === "insertCompositionText" ? "composition" : type === "insertFromPaste" ? "paste" : "replace";
        if (captured.selectionSet.ranges.length > 1) {
            // A native textarea describes one primary target. Replicate only an exact captured
            // selection replacement; neighbouring autocorrection/reconversion needs its own plan.
            if (from !== Math.min(selected.anchor, selected.head) || to !== Math.max(selected.anchor, selected.head)) {
                conflict("unsupported-multiple-input-target", { from, to, insert: edit.insert }, captured.revision, projection.from); refresh(); return;
            }
            const plan = planSelectionEdits(workspace.document(documentId).buffer.length, captured.selectionSet, edit.insert);
            apply(plan.edits, plan.selectionSet, kind, typing || deleting ? type : undefined, captured.revision); return;
        }
        const map = (offset: number) => offset <= edit.from ? projection.toModel(offset)
            : offset >= edit.from + edit.insert.length ? projection.toModel(offset - edit.insert.length + edit.to - edit.from) + delta : from + offset - edit.from;
        const backward = input.selectionDirection === "backward", selection = exactTarget ? { anchor: from + edit.insert.length, head: from + edit.insert.length }
            : { anchor: map(backward ? input.selectionEnd : input.selectionStart), head: map(backward ? input.selectionStart : input.selectionEnd) };
        apply([{ from, to, insert: edit.insert }], selection, kind, typing || deleting ? type : undefined, captured.revision);
    }
    function history(direction: "undo" | "redo"): void {
        if (disposed) return; cancelWord(); group = undefined; syncSelection();
        if (!workspace.resolveTab(target)) { conflict("expired-view"); refresh(); return; }
        const result = workspace[direction]({ documentId, expectedRevision: revision });
        if (!result.applied && result.reason !== "history-empty") conflict(result.reason);
        else if (result.applied) viewport.revealOffset(view.getSnapshot().selection.head);
        refresh();
    }
    const focus = () => { if (!disposed) { input.focus({ preventScroll: true }); scheduleCaret(); } };
    function replaceSelection(insert: string, kind: EditKind, type?: string): void {
        const document = workspace.document(documentId), plan = planSelectionEdits(document.buffer.length, view.getSnapshot().selectionSet, insert);
        apply(plan.edits, plan.selectionSet, kind, type, document.revision);
    }
    const validCommand = (capture: CommandCapture) => !disposed && !composing && !input.disabled && !(capture.deleting && input.readOnly) && !!workspace.resolveTab(target) && workspace.observeDocument(documentId).getSnapshot()?.revision === capture.revision && view.getSnapshot().selectionSet === capture.selectionSet;
    function withGraphemes(capture: CommandCapture, offset: number, side: -1 | 1, purpose: "word" | "word-selection" | "grapheme", done: (point: GraphemePoint) => void,
        turn: (work: () => void) => void = work => work()): void {
        cancelScans(); if (!validCommand(capture)) return;
        const local = localAsciiGraphemePoint(capture.buffer, offset);
        if (local) { done(local); return; }
        const point = (index: GraphemeIndex): GraphemePoint => Object.freeze({ offset, floor: index.floor(offset), ceil: index.ceil(offset), preceding: index.preceding(offset), following: index.following(offset) });
        const buffer = capture.buffer; let line = buffer.lineAt(offset); if (side < 0 && line > 0 && offset === buffer.offsetAt(line)) line--;
        const from = buffer.offsetAt(line), to = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
        if (graphemeCache?.buffer === buffer && graphemeCache.from === from && graphemeCache.to === to) { done(point(graphemeCache.index)); return; }
        const job = { cursor: createGraphemeCursor(buffer, { from, to }), capture, purpose }; graphemeJob = job;
        const step = () => turn(() => {
            const started = purpose === "word-selection" ? win.performance.now() : 0;
            try {
            if (graphemeJob !== job) return; if (!validCommand(capture)) { cancelWord(); return; }
            const began = win.performance.now(); let result, calls = 0;
            try { do { result = job.cursor.next(4096); calls++; } while (result.status === "running" && calls < 8 && win.performance.now() - began < 4); }
            catch { cancelWord(); conflict("grapheme-limit"); return; }
            graphemeScanSteps++; maxGraphemeScanStepMs = Math.max(maxGraphemeScanStepMs, win.performance.now() - began);
            if (result.status === "running") { const timer = win.setTimeout(() => turn(() => { commandTimers.delete(timer); if (graphemeJob === job) graphemeTimer = undefined; step(); }), 0); graphemeTimer = timer; commandTimers.add(timer); return; }
            const index = result.result!; job.cursor.dispose(); graphemeJob = undefined; graphemeCache = Object.freeze({ buffer, from, to, index }); done(point(index));
            } finally { if (purpose === "word-selection") maxWordSelectionTurnMs = Math.max(maxWordSelectionTurnMs, win.performance.now() - started); }
        }); step();
    }
    function commandCapture(deleting: boolean): CommandCapture {
        const document = workspace.document(documentId), { selection, selectionSet } = view.getSnapshot();
        return { buffer: document.buffer, revision: document.revision, selection, selectionSet, deleting };
    }
    function eachRange(capture: CommandCapture, purpose: "word" | "grapheme", resolve: (range: Selection, done: (range: Selection) => void) => void,
        done: (ranges: readonly Selection[]) => void,
        options: Readonly<{ validLayout?: () => boolean; prepare?: (ranges: readonly Selection[]) => () => void; batchSize?: number; navigation?: boolean; inline?: boolean }> = {}): void {
        let release: (() => void) | undefined, batchEnd = options.prepare ? 0 : capture.selectionSet.ranges.length;
        const validLayout = options.validLayout ?? (() => true), turn = options.navigation ? navigationTurn : (work: () => void) => work();
        const job = { capture, purpose, release: () => { release?.(); release = undefined; } }; rangeCommand = job;
        const ranges: Selection[] = []; let index = 0, pumping = false, waiting = false;
        const active = () => rangeCommand === job && validCommand(capture);
        const pump = () => turn(() => {
            if (!active() || !validLayout()) { if (rangeCommand === job) cancelWord(); return; }
            const began = win.performance.now(); let count = 0; pumping = true;
            if (options.prepare && index === batchEnd) { job.release(); batchEnd = Math.min(capture.selectionSet.ranges.length, index + (options.batchSize ?? 32));
                release = options.prepare(capture.selectionSet.ranges.slice(index, batchEnd)); }
            while (index < batchEnd && !waiting && count++ < 64 && (options.inline || win.performance.now() - began < 4)) {
                waiting = true;
                resolve(capture.selectionSet.ranges[index]!, range => {
                    if (!active()) return;
                    ranges.push(range); index++; waiting = false; if (!pumping) pump();
                });
            }
            pumping = false;
            if (!active()) return;
            if (index === capture.selectionSet.ranges.length) { job.release(); rangeCommand = undefined; if (validLayout()) done(ranges); }
            else if (!waiting && options.inline) pump();
            else if (!waiting) { const timer = win.setTimeout(() => turn(() => { commandTimers.delete(timer); if (rangeCommand === job) rangeTimer = undefined; pump(); }), 0);
                rangeTimer = timer; commandTimers.add(timer); }
        }); pump();
    }
    function finishRanges(capture: CommandCapture, ranges: readonly Selection[], type?: string): SelectionSet | undefined {
        if (!validCommand(capture)) return;
        const selections = createSelectionSet(capture.buffer.length, ranges, capture.selectionSet.primary);
        if (capture.deleting) { const plan = planSelectionEdits(capture.buffer.length, selections, "");
            apply(plan.edits, plan.selectionSet, "delete", type, capture.revision); }
        else { cancelWord(); group = undefined; view.setSelections(capture.revision, selections.ranges, selections.primary);
            const selected = view.getSnapshot().selection;
            viewport.revealOffset(selected.head, { horizontal: "nearest", vertical: "nearest", affinity: selected.headAffinity ?? "after" }); refresh(); }
        return view.getSnapshot().selectionSet;
    }
    function moved(range: Selection, offset: number, extend: boolean, affinity: Affinity = "after"): Selection {
        return { anchor: extend ? range.anchor : offset, head: offset, anchorAffinity: extend ? range.anchorAffinity ?? "after" : affinity, headAffinity: affinity };
    }
    function grapheme(direction: -1 | 1, deleting: boolean, extend = false): void {
        cancelWord(); if (disposed || composing || input.disabled || deleting && input.readOnly) return; syncSelection();
        const capture = commandCapture(deleting); graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        eachRange(capture, "grapheme", (range, done) => {
            if (range.anchor !== range.head && (deleting || !extend)) {
                done(deleting ? range : moved(range, direction < 0 ? Math.min(range.anchor, range.head) : Math.max(range.anchor, range.head), false)); return;
            }
            const offset = range.head;
            withGraphemes(capture, offset, direction, "grapheme", point => {
                if (deleting) { const from = direction < 0 && point.floor === offset ? point.preceding ?? offset : point.floor, to = direction > 0 ? point.following ?? offset : point.ceil;
                    done({ anchor: from, head: to }); }
                else done(moved(range, direction < 0 ? point.preceding ?? offset : point.following ?? offset, extend));
            });
        }, ranges => finishRanges(capture, ranges, deleting ? direction < 0 ? "deleteContentBackward" : "deleteContentForward" : undefined));
    }
    function word(direction: -1 | 1, deleting: boolean, extend = false): void {
        cancelWord(); if (disposed || composing || input.disabled || deleting && input.readOnly) return;
        group = undefined; preferred = undefined; syncSelection();
        wordScanSteps = 0; maxWordScanStepMs = 0; graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        const capture = commandCapture(deleting);
        eachRange(capture, "word", (selected, done) => {
        if (deleting && selected.anchor !== selected.head) { done(selected); return; }
        withGraphemes(capture, selected.head, deleting ? direction < 0 ? 1 : -1 : direction, "word", point => {
        const start = (deleting ? -direction : direction) < 0 ? point.floor : point.ceil;
        const job = { cursor: new WordCursor(capture.buffer, start, direction), revision: capture.revision, selection: selected }; wordJob = job;
        const step = () => {
            if (wordJob !== job) return;
            const current = workspace.observeDocument(documentId).getSnapshot();
            if (!validCommand(capture) || current?.revision !== job.revision) { cancelWord(); return; }
            const began = win.performance.now(); let result, count = 0;
            do { result = job.cursor.next(4096); count++; } while (result.status === "running" && count < 32 && win.performance.now() - began < 4);
            wordScanSteps++; maxWordScanStepMs = Math.max(maxWordScanStepMs, win.performance.now() - began);
            if (result.status === "running") {
                const timer = win.setTimeout(() => { commandTimers.delete(timer); if (wordJob === job) wordTimer = undefined; step(); }, 0);
                wordTimer = timer; commandTimers.add(timer); return;
            }
            withGraphemes(capture, result.offset!, direction, "word", point => {
            const end = direction < 0 ? point.floor : point.ceil;
            done(deleting ? { anchor: Math.min(start, end), head: Math.max(start, end) } : moved(selected, end, extend));
            });
        }; step();
        });
        }, ranges => finishRanges(capture, ranges));
    }
    function selectWord(offset: number, add = false): void {
        cancelWord(); if (disposed || composing || input.disabled || !workspace.resolveTab(target)) return;
        stopDrag(); group = undefined; preferred = undefined; focus(); syncSelection();
        const document = workspace.document(documentId), buffer = document.buffer, selected = view.getSnapshot().selection;
        const capture = { buffer, revision: document.revision, selection: selected, selectionSet: view.getSnapshot().selectionSet, deleting: false };
        const line = buffer.lineAt(offset), from = buffer.offsetAt(line);
        let to = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) - 1 : buffer.length;
        if (line + 1 < buffer.lineCount && to > from && buffer.slice(to - 1, to) === "\r") to--;
        if (to === from) return;
        wordScanSteps = 0; maxWordScanStepMs = 0; graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        const scan = (start: number, direction: -1 | 1, done: (offset: number) => void) => {
            if (!validCommand(capture)) return;
            const job = { cursor: new WordCursor(buffer, start, direction, { from, to, skipWhitespace: false }), revision: capture.revision, selection: selected }; wordJob = job;
            const step = () => {
                const started = win.performance.now();
                try {
                if (wordJob !== job) return; if (!validCommand(capture)) { cancelWord(); return; }
                const began = win.performance.now(); let result, count = 0;
                do { result = job.cursor.next(4096); count++; } while (result.status === "running" && count < 32 && win.performance.now() - began < 4);
                wordScanSteps++; maxWordScanStepMs = Math.max(maxWordScanStepMs, win.performance.now() - began);
                if (result.status === "running") {
                    const timer = win.setTimeout(() => { commandTimers.delete(timer); if (wordJob === job) wordTimer = undefined; step(); }, 0);
                    wordTimer = timer; commandTimers.add(timer); return;
                }
                done(result.offset!);
                } finally { maxWordSelectionTurnMs = Math.max(maxWordSelectionTurnMs, win.performance.now() - started); }
            }; step();
        };
        withGraphemes(capture, Math.min(offset, to), -1, "word-selection", point => {
            const probe = Math.max(from, offset >= to ? point.preceding ?? from : point.floor);
            const width = buffer.slice(probe, Math.min(to, probe + 2)).codePointAt(0)! > 0xffff ? 2 : 1;
            scan(Math.min(to, probe + width), -1, left => scan(probe, 1, right => {
                withGraphemes(capture, left, -1, "word-selection", low => withGraphemes(capture, right, 1, "word-selection", high => {
                    if (!validCommand(capture)) return;
                    const range = { anchor: Math.max(from, low.floor), head: Math.min(to, high.ceil) };
                    if (add) view.setSelections(capture.revision, [...capture.selectionSet.ranges, range], capture.selectionSet.ranges.length);
                    else view.setSelection(capture.revision, range);
                    refresh();
                }));
            }));
        });
    }
    function navigationTurn(work: () => void): void {
        if (navigationDepth) { work(); return; }
        const began = win.performance.now(); navigationDepth++;
        try { work(); } finally { navigationDepth--; const elapsed = win.performance.now() - began;
            navigationTurns++; navigationWorkMs += elapsed; maxNavigationTurnMs = Math.max(maxNavigationTurnMs, elapsed); }
    }
    function navigationStyle(): string {
        const style = win.getComputedStyle(root);
        return [root.isConnected, style.width, style.height, style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.lineHeight,
            style.letterSpacing, style.wordSpacing, style.tabSize, style.direction, style.getPropertyValue("--st-text-direction"),
            style.fontVariantLigatures, style.fontKerning, style.fontFeatureSettings, style.fontVariationSettings, style.transform, owner.fonts.status].join("|");
    }
    function navigationLayout(): string {
        const state = viewport.snapshot();
        return [navigationStyle(), root.clientWidth, root.clientHeight, state.width, state.height, state.lineHeight, state.columnWidth, view.folding.getSnapshot().generation].join("|");
    }
    function beginNavigation(prepare: (capture: CommandCapture, style: string, inline: boolean) => void, canInline?: (capture: CommandCapture) => boolean): void {
        cancelWord(); navigationTurns = 0; navigationPreparationMs = 0; maxNavigationTurnMs = 0; navigationWorkMs = 0;
        navigationTurn(() => {
            const capture = commandCapture(false), job = { capture, purpose: "grapheme" as const, release: () => {} };
            if (!validCommand(capture)) return; rangeCommand = job;
            const inline = canInline?.(capture) ?? false, style = navigationStyle();
            const initialize = () => {
                if (rangeCommand !== job) return;
                if (!validCommand(capture) || navigationStyle() !== style) { cancelWord(); return; }
                prepare(capture, style, inline);
                if (rangeCommand === job) cancelWord();
            };
            if (capture.selectionSet.ranges.length === 1 || inline) initialize();
            else { const timer = win.setTimeout(() => navigationTurn(() => { commandTimers.delete(timer); if (rangeCommand === job) rangeTimer = undefined; initialize(); }), 0);
                rangeTimer = timer; commandTimers.add(timer); }
        });
    }
    function shortHorizontal(capture: CommandCapture): boolean {
        // At most32 ranges and bounded native rows; longer contexts keep cooperative scans.
        if (capture.selectionSet.ranges.length > 32) return false;
        const buffer = capture.buffer, folds = view.folding.getSnapshot().index, lines = new Set<number>();
        for (const range of capture.selectionSet.ranges) {
            const line = buffer.lineAt(range.head), row = folds.rowAt(line);
            lines.add(line); lines.add(buffer.lineAt(range.anchor));
            if (line) lines.add(line - 1); if (line + 1 < buffer.lineCount) lines.add(line + 1);
            if (row) lines.add(folds.lineAt(row - 1)); if (row + 1 < folds.visibleLineCount) lines.add(folds.lineAt(row + 1));
        }
        return shortRows(buffer, lines);
    }
    function shortRows(buffer: TextBuffer, lines: Iterable<number>): boolean {
        for (const line of lines) if ((line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length) - buffer.offsetAt(line) > 514) return false;
        return true;
    }
    function verticalCount(page: boolean): number {
        const state = viewport.snapshot(); return page ? Math.max(1, Math.floor(state.height / state.lineHeight) - 1) : 1;
    }
    function shortVertical(capture: CommandCapture, direction: -1 | 1, page: boolean): boolean {
        if (capture.selectionSet.ranges.length > 32) return false;
        // Page destinations use current viewport dimensions, including a pending resize.
        viewport.flush();
        const buffer = capture.buffer, folds = view.folding.getSnapshot().index, count = verticalCount(page), lines = new Set<number>();
        for (const range of capture.selectionSet.ranges) {
            const line = buffer.lineAt(range.head), row = folds.rowAt(line);
            lines.add(line); lines.add(folds.lineAt(Math.max(0, Math.min(folds.visibleLineCount - 1, row + direction * count))));
        }
        return shortRows(buffer, lines);
    }
    function boundaryOffset(buffer: TextBuffer, head: number, key: string, documentBoundary: boolean): number {
        if (documentBoundary) return key === "Home" ? 0 : buffer.length;
        const line = buffer.lineAt(head), start = buffer.offsetAt(line);
        if (key === "Home") return start;
        let end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) - 1 : buffer.length;
        if (line + 1 < buffer.lineCount && end > start && buffer.slice(end - 1, end) === "\r") end--;
        return end;
    }
    function horizontal(key: string, extend: boolean, documentBoundary = false): void {
        preferred = undefined;
        graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        // Indexed endpoints need no geometry. Finish bounded sets before the next input,
        // which would otherwise cancel queued navigation and edit the previous ranges.
        if ((key === "Home" || key === "End") && view.getSnapshot().selectionSet.ranges.length <= 32) {
            cancelWord(); navigationTurns = 0; navigationPreparationMs = 0; maxNavigationTurnMs = 0; navigationWorkMs = 0;
            navigationTurn(() => {
                const capture = commandCapture(false); if (!validCommand(capture)) return;
                finishRanges(capture, capture.selectionSet.ranges.map(range => moved(range, boundaryOffset(capture.buffer, range.head, key, documentBoundary), extend)));
            }); return;
        }
        beginNavigation((capture, style, inline) => {
        const began = win.performance.now(); viewport.flush();
        if (!validCommand(capture) || navigationStyle() !== style) { cancelWord(); return; }
        const layout = navigationLayout(), buffer = capture.buffer, arrows = key === "ArrowLeft" || key === "ArrowRight", foldIndex = view.folding.getSnapshot().index;
        navigationPreparationMs = win.performance.now() - began;
        eachRange(capture, "grapheme", (range, done) => {
            if (key === "Home" || key === "End") {
                done(moved(range, boundaryOffset(buffer, range.head, key, documentBoundary), extend)); return;
            }
            const direction = key === "ArrowLeft" ? -1 : 1;
            const point = !extend && range.anchor !== range.head
                ? viewport.collapseVisual(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head), direction, false)
                : viewport.moveVisual(range.head, range.headAffinity ?? "after", direction, false);
            if (point) { visualMoves++; done(moved(range, point.offset, extend, point.affinity)); return; }
            if (!extend && range.anchor !== range.head) { done(moved(range, direction < 0 ? Math.min(range.anchor, range.head) : Math.max(range.anchor, range.head), false)); return; }
            withGraphemes(capture, range.head, direction, "grapheme", at => done(moved(range, direction < 0 ? at.preceding ?? range.head : at.following ?? range.head, extend)), navigationTurn);
        }, ranges => finishRanges(capture, ranges), { validLayout: () => navigationLayout() === layout, navigation: true, inline, ...(arrows && capture.selectionSet.ranges.length > 1 ? {
            batchSize: 16, prepare: (ranges: readonly Selection[]) => {
                const lines = new Set<number>();
                for (const range of ranges) {
                    const line = buffer.lineAt(range.head); lines.add(line);
                    if (!extend && range.anchor !== range.head) lines.add(buffer.lineAt(range.anchor));
                    else { const row = foldIndex.rowAt(line); if (row) lines.add(foldIndex.lineAt(row - 1)); if (row + 1 < foldIndex.visibleLineCount) lines.add(foldIndex.lineAt(row + 1)); }
                }
                return viewport.prepareNavigationRows([...lines]);
            } } : {}) });
        }, shortHorizontal);
    }
    function vertical(direction: -1 | 1, page: boolean, extend: boolean): void {
        beginNavigation((capture, style, inline) => {
        const began = win.performance.now(); viewport.flush();
        const buffer = capture.buffer, selected = capture.selection;
        if (!viewport.coordsAt(selected.head, selected.headAffinity)) { viewport.revealOffset(selected.head); viewport.flush(); }
        if (!validCommand(capture) || navigationStyle() !== style) { cancelWord(); return; }
        const state = viewport.snapshot(), layout = navigationLayout(), foldIndex = view.folding.getSnapshot().index;
        const prior = preferred?.selections === capture.selectionSet && preferred.revision === capture.revision && preferred.layout === layout ? preferred.columns : undefined;
        const columns: (number | undefined)[] = [], count = verticalCount(page);
        navigationPreparationMs = win.performance.now() - began;
        let index = 0, pageDelta = 0;
        eachRange(capture, "grapheme", (range, done) => {
            const at = index++, line = buffer.lineAt(range.head), row = foldIndex.rowAt(line), next = foldIndex.lineAt(Math.max(0, Math.min(foldIndex.visibleLineCount - 1, row + direction * count)));
            if (at === capture.selectionSet.primary) pageDelta = (foldIndex.rowAt(next) - row) * state.lineHeight;
            if (next === line) { columns.push(undefined); done(moved(range, direction < 0 ? 0 : buffer.length, extend)); return; }
            const column = prior?.[at] ?? viewport.columnAt(range.head, range.headAffinity);
            const hit = column === undefined ? undefined : viewport.caretAtColumn(next, column);
            columns.push(column); done(hit ? moved(range, hit.offset, extend, hit.affinity) : range);
        }, ranges => {
            if (page) viewport.scrollTo({ top: state.scrollTop + pageDelta });
            const selections = finishRanges(capture, ranges); if (!selections) return;
            // Normalization may reorder/coalesce targets. Carry the owning range's column,
            // using the same primary/first-supplied ownership as the public selection model.
            const ordered = ranges.map((range, at) => ({ from: Math.min(range.anchor, range.head), to: Math.max(range.anchor, range.head), at }))
                .sort((a, b) => a.from - b.from || a.to - b.to || a.at - b.at);
            let cursor = 0;
            const nextColumns = selections.ranges.map(range => {
                const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head); let ownerIndex = Infinity;
                while (cursor < ordered.length && ordered[cursor]!.from >= from && ordered[cursor]!.to <= to) {
                    const at = ordered[cursor++]!.at;
                    if (at === capture.selectionSet.primary || ownerIndex !== capture.selectionSet.primary && at < ownerIndex) ownerIndex = at;
                }
                return columns[ownerIndex];
            });
            preferred = { selections, revision: capture.revision, layout, columns: nextColumns };
        }, { validLayout: () => navigationLayout() === layout, navigation: true, inline, ...(capture.selectionSet.ranges.length > 1 ? {
            ...(inline ? { batchSize: 16 } : {}),
            prepare: (ranges: readonly Selection[]) => viewport.prepareNavigationRows([...new Set(ranges.flatMap(range => {
                const line = buffer.lineAt(range.head), row = foldIndex.rowAt(line); return [line, foldIndex.lineAt(Math.max(0, Math.min(foldIndex.visibleLineCount - 1, row + direction * count)))];
            }))]) } : {}) });
        }, capture => shortVertical(capture, direction, page));
    }
    function indent(outdent: boolean): void {
        if (disposed || composing || input.disabled || input.readOnly) return;
        cancelWord();
        const capture = commandCapture(true), buffer = capture.buffer;
        if (!outdent && capture.selectionSet.ranges.every(range => range.anchor === range.head)) { replaceSelection("    ", "replace"); return; }
        const intervals: { first: number; last: number }[] = [];
        for (const range of capture.selectionSet.ranges) {
            const low = Math.min(range.anchor, range.head), high = Math.max(range.anchor, range.head);
            const first = buffer.lineAt(low), last = buffer.lineAt(high > low && buffer.offsetAt(buffer.lineAt(high)) === high ? high - 1 : high), previous = intervals.at(-1);
            if (previous && first <= previous.last + 1) previous.last = Math.max(previous.last, last); else intervals.push({ first, last });
        }
        const edits: TextEdit[] = []; let interval = 0, line = intervals[0]!.first;
        // Plan large selections in yielding chunks against the captured immutable buffer/revision.
        const step = () => {
            if (disposed) return;
            if (!validCommand(capture)) { conflict("stale-indent-command"); return; }
            let countLines = 0;
            for (; interval < intervals.length && countLines < 256; countLines++) {
                const from = buffer.offsetAt(line), prefix = buffer.slice(from, Math.min(buffer.length, from + 4));
                const count = prefix.startsWith("\t") ? 1 : /^ {0,4}/.exec(prefix)![0].length;
                if (!outdent || count) edits.push({ from, to: from + (outdent ? count : 0), insert: outdent ? "" : "    " });
                if (++line > intervals[interval]!.last && ++interval < intervals.length) line = intervals[interval]!.first;
            }
            if (interval < intervals.length) {
                const timer = win.setTimeout(() => { commandTimers.delete(timer); step(); }, 0); commandTimers.add(timer);
            } else if (edits.length) {
                const mapping = new PositionMap(buffer.length, edits);
                const result = createSelectionSet(mapping.newLength, capture.selectionSet.ranges.map(range => ({ anchor: mapping.map(range.anchor, "after").offset,
                    head: mapping.map(range.head, "after").offset })), capture.selectionSet.primary);
                apply(edits, result, "replace", undefined, capture.revision);
            }
        }; group = undefined; step();
    }
    function bracket(key: string): boolean {
        if (input.readOnly) return false;
        const { selectionSet } = view.getSnapshot(); if (selectionSet.ranges.some(range => range.anchor !== range.head)) return false;
        const buffer = workspace.document(documentId).buffer, closing = { "(": ")", "[": "]", "{": "}" }[key];
        if (!closing && ![")", "]", "}"].includes(key)) return false;
        let delta = 0, handled = false; const carets: Selection[] = [];
        const edits = selectionSet.ranges.map(range => {
            const next = buffer.slice(range.head, Math.min(buffer.length, range.head + 1));
            const pair = closing && (!next || /[\s)\]}]/.test(next)), skip = !closing && next === key;
            const insert = pair ? key + closing : skip ? "" : key;
            const head = range.head + delta + (pair || skip ? 1 : insert.length); delta += insert.length;
            carets.push({ anchor: head, head }); handled ||= !!pair || skip;
            return { from: range.head, to: range.head, insert };
        });
        if (!handled) return false;
        if (edits.every(edit => edit.insert === "")) finishRanges(commandCapture(false), carets);
        else apply(edits, createSelectionSet(buffer.length + delta, carets, selectionSet.primary), "typing"); return true;
    }
    input.addEventListener("beforeinput", event => {
        wordInput = undefined; insertion = undefined;
        if (!composing) view.folding.revealSelection(view.folding.getSnapshot());
        if (!composing && ["deleteWordBackward", "deleteWordForward", "deleteContentBackward", "deleteContentForward"].includes(event.inputType)) {
            syncSelection(); const direction = event.inputType.endsWith("Backward") ? -1 : 1, wholeWord = event.inputType.startsWith("deleteWord");
            if (event.cancelable) { event.preventDefault(); (wholeWord ? word : grapheme)(direction, true); }
            else wordInput = { revision, selectionSet: view.getSnapshot().selectionSet, direction, word: wholeWord };
        } else if (!composing && event.cancelable && (event.inputType === "historyUndo" || event.inputType === "historyRedo")) { event.preventDefault(); history(event.inputType === "historyUndo" ? "undo" : "redo"); }
        else syncSelection();
        if (!composing && !event.isComposing && !input.disabled && !input.readOnly && input.value === context.text) {
            insertion = captureInput(event.inputType, event.data);
        }
    }, { signal: listeners.signal });
    input.addEventListener("input", event => {
        const start = win.performance.now(), type = (event as InputEvent).inputType;
        if (!composing && ["deleteWordBackward", "deleteWordForward", "deleteContentBackward", "deleteContentForward"].includes(type)) {
            const captured = wordInput; wordInput = undefined;
            if (!captured || input.disabled || input.readOnly || !workspace.resolveTab(target) || captured.direction !== (type.endsWith("Backward") ? -1 : 1)
                || captured.revision !== revision || captured.selectionSet !== view.getSnapshot().selectionSet) { conflict(type.startsWith("deleteWord") ? "stale-word-input" : "stale-delete-input"); refresh(); }
            else { refresh(); (captured.word ? word : grapheme)(captured.direction, true); }
        } else commit(type);
        lastInputMs = win.performance.now() - start; inputEvents++;
    }, { signal: listeners.signal });
    input.addEventListener("compositionstart", () => { cancelWord(); cancelCommandTimers(); wordInput = undefined; insertion = undefined; syncSelection();
        view.folding.revealSelection(view.folding.getSnapshot());
        composition = captureInput("insertCompositionText", null); composing = true; group = undefined; root.classList.add("st-composing"); viewport.invalidate(); scheduleCaret(); }, { signal: listeners.signal });
    input.addEventListener("compositionend", () => { const captured = composition; composition = undefined; composing = false; root.classList.remove("st-composing"); viewport.invalidate(); commit("insertCompositionText", captured); }, { signal: listeners.signal });
    input.addEventListener("select", syncSelection, { signal: listeners.signal });
    // Tab can reset the browser range after focus dispatch. It changes focus, not model selection.
    input.addEventListener("keyup", event => { if (event.key === "Tab") refresh(); else syncSelection(); }, { signal: listeners.signal });
    input.addEventListener("focus", scheduleCaret, { signal: listeners.signal });
    input.addEventListener("blur", () => { syncSelection(); group = undefined; scheduleCaret();
        // Restore disclosure tab stops after the browser has completed focus traversal.
        if (escaped) queueMicrotask(() => { if (!disposed) escapeState(false); }); }, { signal: listeners.signal });
    function keydown(event: KeyboardEvent): void {
        if (composing || event.isComposing) return;
        if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
        if (escaped && event.key !== "Escape" && event.key !== "Tab") escapeState(false);
        view.folding.revealSelection(view.folding.getSnapshot());
        const command = (event.ctrlKey || event.metaKey) && !event.altKey, key = event.key.toLowerCase();
        if (command && (key === "z" || (event.ctrlKey && key === "y"))) { event.preventDefault(); history(event.shiftKey || key === "y" ? "redo" : "undo"); return; }
        if (command && key === "a") { event.preventDefault(); cancelWord(); preferred = undefined; const length = workspace.document(documentId).buffer.length; view.setSelection(revision, { anchor: 0, head: length }); refresh(); return; }
        if (command && (event.key === "Home" || event.key === "End")) { event.preventDefault(); syncSelection(); horizontal(event.key, event.shiftKey, true); return; }
        if (event.key === "Escape") {
            cancelWord(); cancelCommandTimers(); preferred = undefined;
            const state = view.getSnapshot();
            if (state.selectionSet.ranges.length > 1) { event.preventDefault(); view.setSelection(revision, state.selection); refresh(); }
            escapeState(true); return;
        }
        // Backward focus traversal presses Shift before Tab.
        if (escaped && event.key === "Shift") return;
        if (event.key === "Tab" && escaped) return;
        escapeState(false); syncSelection();
        const wordModifier = !event.metaKey && (event.ctrlKey && !event.altKey || apple && event.altKey && !event.ctrlKey);
        if (wordModifier && ["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(event.key)) {
            event.preventDefault(); word(event.key === "ArrowLeft" || event.key === "Backspace" ? -1 : 1, event.key === "Backspace" || event.key === "Delete", event.shiftKey); return;
        }
        if (!event.altKey && !command && ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) {
            event.preventDefault(); vertical(event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 1, event.key.startsWith("Page"), event.shiftKey); return;
        }
        if (!event.altKey && !command && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault(); horizontal(event.key, event.shiftKey); return;
        }
        preferred = undefined;
        if (!command && !event.altKey && (event.key === "Backspace" || event.key === "Delete")) {
            event.preventDefault(); grapheme(event.key === "Backspace" ? -1 : 1, true);
        } else if (event.key === "Tab" && !command && !event.altKey) { event.preventDefault(); indent(event.shiftKey); }
        else if (!command && !event.altKey && bracket(event.key)) event.preventDefault();
    }
    input.addEventListener("keydown", event => {
        const started = win.performance.now(); keydownEvents++;
        try { keydown(event); } finally { lastKeydownMs = win.performance.now() - started; }
    }, { signal: listeners.signal });
    root.addEventListener("dblclick", event => {
        const began = win.performance.now();
        try {
        wordSelectionEvents++;
        if (event.button !== 0 || disposed || composing || input.disabled || !workspace.resolveTab(target)) return;
        const point = viewport.hitTest(event.clientX, event.clientY); if (!point) return;
        event.preventDefault(); selectWord(point.offset, event.altKey);
        } finally { lastWordSelectionMs = win.performance.now() - began; maxWordSelectionTurnMs = Math.max(maxWordSelectionTurnMs, lastWordSelectionMs); }
    }, { signal: listeners.signal });
    const textDrag = mountTextDragDrop({ workspace, tab: target, view, viewport, input,
        available: () => !disposed && !composing && !input.disabled,
        beforeStart: () => { stopDrag(); cancelWord(); cancelCommandTimers(); preferred = undefined; group = undefined; },
        afterDrop: offset => { commits++; viewport.revealOffset(offset); focus(); refresh(); },
        rejected: reason => { conflict(reason); refresh(); } });
    root.addEventListener("pointerdown", event => {
        if (event.button !== 0 || disposed || composing || input.disabled || !workspace.resolveTab(target)) return;
        if (textDrag.arm(event)) return;
        if (event.target === input && !event.altKey && view.getSnapshot().selectionSet.ranges.length === 1) return;
        const point = viewport.hitTest(event.clientX, event.clientY); if (!point) return;
        event.preventDefault(); stopDrag(); cancelWord(); preferred = undefined; focus(); group = undefined;
        const state = view.getSnapshot(), extending = event.shiftKey && !event.altKey;
        const anchor = extending ? state.selection.anchor : point.offset, anchorAffinity = extending ? state.selection.anchorAffinity ?? "after" : point.affinity;
        const baseRanges = event.altKey ? state.selectionSet.ranges : extending ? state.selectionSet.ranges.filter((_, index) => index !== state.selectionSet.primary) : [];
        view.setSelections(revision, [...baseRanges, { anchor, head: point.offset, anchorAffinity, headAffinity: point.affinity }], baseRanges.length); refresh();
        drag = { pointer: event.pointerId, anchor, anchorAffinity, revision, x: event.clientX, y: event.clientY, selectionSet: view.getSnapshot().selectionSet, baseRanges }; root.setPointerCapture(event.pointerId);
    }, { signal: listeners.signal });
    root.addEventListener("pointermove", event => {
        if (drag?.pointer !== event.pointerId) return;
        if (!(event.buttons & 1) || !validDrag()) { stopDrag(); return; }
        drag = { ...drag, x: event.clientX, y: event.clientY }; updateDragHead(); scheduleDragScroll();
    }, { signal: listeners.signal });
    function validDrag(): boolean {
        return !!drag && !disposed && !composing && !input.disabled && root.isConnected && root.clientWidth > 0 && root.clientHeight > 0
            && drag.revision === revision && drag.selectionSet === view.getSnapshot().selectionSet && !!workspace.resolveTab(target) && root.hasPointerCapture(drag.pointer);
    }
    function dragBounds(): Readonly<{ left: number; right: number; top: number; bottom: number }> {
        const rectangle = root.getBoundingClientRect(), left = rectangle.left + root.clientLeft, top = rectangle.top + root.clientTop;
        return { left, right: left + root.clientWidth, top, bottom: top + root.clientHeight };
    }
    function updateDragHead(): void {
        const current = drag; if (!current) return; const bounds = dragBounds();
        const point = viewport.hitTest(Math.max(bounds.left, Math.min(bounds.right - 1, current.x)), Math.max(bounds.top, Math.min(bounds.bottom - 1, current.y)));
        if (!point) return;
        view.setSelections(current.revision, [...current.baseRanges, { anchor: current.anchor, head: point.offset, anchorAffinity: current.anchorAffinity, headAffinity: point.affinity }], current.baseRanges.length);
        if (drag === current) drag = { ...current, selectionSet: view.getSnapshot().selectionSet }; refresh();
    }
    function dragVelocity(): Readonly<{ x: number; y: number }> {
        if (!drag) return { x: 0, y: 0 }; const bounds = dragBounds(), metrics = viewport.snapshot();
        const speed = (point: number, low: number, high: number, unit: number) => {
            const outside = point < low ? point - low : point >= high ? point - high + 1 : 0;
            return Math.sign(outside) * Math.min((high - low) * 3, Math.max(unit * 5, Math.abs(outside) * 20));
        };
        return { x: speed(drag.x, bounds.left, bounds.right, metrics.columnWidth), y: speed(drag.y, bounds.top, bounds.bottom, metrics.lineHeight) };
    }
    function scheduleDragScroll(): void {
        const velocity = dragVelocity();
        if (!velocity.x && !velocity.y) { if (dragFrame !== undefined) win.cancelAnimationFrame(dragFrame); dragFrame = undefined; dragTime = undefined; }
        else if (dragFrame === undefined) dragFrame = win.requestAnimationFrame(scrollDrag);
    }
    function scrollDrag(time: number): void {
        const started = win.performance.now();
        try {
            dragFrame = undefined; if (!validDrag()) { stopDrag(); return; }
            const velocity = dragVelocity(); if (!velocity.x && !velocity.y) { dragTime = undefined; return; }
            const elapsed = dragTime === undefined ? 1000 / 60 : Math.max(0, Math.min(32, time - dragTime)); dragTime = time;
            const before = viewport.snapshot();
            viewport.scrollTo({ left: before.scrollLeft + velocity.x * elapsed / 1000, top: before.scrollTop + velocity.y * elapsed / 1000 }); viewport.flush();
            if (!validDrag()) { stopDrag(); return; } updateDragHead();
            dragScrollFrames++;
            const after = viewport.snapshot();
            if (drag && (after.scrollLeft !== before.scrollLeft || after.scrollTop !== before.scrollTop)) dragFrame = win.requestAnimationFrame(scrollDrag);
            else dragTime = undefined;
        } finally { maxDragScrollStepMs = Math.max(maxDragScrollStepMs, win.performance.now() - started); }
    }
    const stopDrag = (event?: PointerEvent) => {
        if (event && event.pointerId !== drag?.pointer) return;
        if (dragFrame !== undefined) win.cancelAnimationFrame(dragFrame); dragFrame = undefined; dragTime = undefined;
        const pointer = drag?.pointer; drag = undefined;
        if (pointer !== undefined && root.hasPointerCapture(pointer)) root.releasePointerCapture(pointer);
    };
    root.addEventListener("pointerup", stopDrag, { signal: listeners.signal }); root.addEventListener("pointercancel", stopDrag, { signal: listeners.signal });
    root.addEventListener("lostpointercapture", stopDrag, { signal: listeners.signal });
    for (const type of ["copy", "cut", "paste"] as const) input.addEventListener(type, event => {
        if (event.defaultPrevented) { cancelWord(); group = undefined; if (type !== "copy") stopDrag(); return; }
        if (composing || !event.clipboardData) return;
        event.preventDefault(); cancelWord(); syncSelection(); group = undefined;
        if (type !== "copy") view.folding.revealSelection(view.folding.getSnapshot());
        const selections = view.getSnapshot().selectionSet;
        if (type === "paste") { const text = event.clipboardData.getData("text/plain"); if (text.length) replaceSelection(text, "paste"); }
        else {
            if (type === "cut" && input.readOnly) return;
            const buffer = workspace.document(documentId).buffer;
            event.clipboardData.setData("text/plain", selections.ranges.filter(range => range.anchor !== range.head)
                .map(range => buffer.slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head))).join("\n"));
            if (type === "cut") replaceSelection("", "delete");
        }
    }, { signal: listeners.signal });
    root.addEventListener("sttropez-render", scheduleCaret, { signal: listeners.signal });
    root.addEventListener("sttropez-focus-source", focus, { signal: listeners.signal });
    let observedFoldRevision = view.folding.getSnapshot().revision;
    const subscriptions = [workspace.observeDocument(documentId).subscribe(refresh), view.subscribe(refresh),
        view.folding.subscribe(() => { const revision = view.folding.getSnapshot().revision;
            if (revision === observedFoldRevision) { cancelWord(); stopDrag(); preferred = undefined; group = undefined; }
            observedFoldRevision = revision; refresh(); }), resource.metadata.subscribe(refresh), workspace.tabState.subscribe(refresh)];
    refresh();
    return Object.freeze({ element: root, input, view, viewport, focus, describe,
        captureView: () => { syncSelection(); return viewport.captureView(); },
        restoreView: (state: ViewState) => { viewport.restoreView(state); refresh(); },
        snapshot: () => Object.freeze({ inputUnits: input.value.length, inputEvents, lastInputMs, keydownEvents, lastKeydownMs, navigationTurns, navigationPreparationMs, maxNavigationTurnMs, navigationWorkMs, wordSelectionEvents, lastWordSelectionMs, maxWordSelectionTurnMs, pendingCaret: frame !== undefined,
            pendingDragScroll: dragFrame !== undefined, dragScrollFrames, maxDragScrollStepMs, commits, conflicts, composing, pendingWord: rangeCommand?.purpose === "word" || wordJob !== undefined || graphemeJob?.purpose === "word" || graphemeJob?.purpose === "word-selection", wordScanSteps, maxWordScanStepMs, pendingGrapheme: rangeCommand?.purpose === "grapheme" || graphemeJob !== undefined, graphemeScanSteps, maxGraphemeScanStepMs, visualMoves, disposed }),
        destroy: () => {
            if (disposed) return; disposed = true;
            cancelWord(); wordInput = undefined; insertion = undefined; composition = undefined; graphemeCache = undefined; preferred = undefined;
            if (composing && input.value !== context.text) conflict("composition-detached");
            composing = false; stopDrag(); textDrag.destroy();
            if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined;
            cancelCommandTimers();
            listeners.abort(); subscriptions.forEach(unsubscribe => unsubscribe()); descriptions.clear(); input.value = ""; caretNodes.length = 0; secondaryCarets.replaceChildren(); viewport.destroy(); if (!options.view) view.dispose();
        } });
}
