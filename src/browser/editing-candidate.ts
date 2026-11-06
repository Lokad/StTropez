import { PositionMap, textDifference, WordCursor, createGraphemeCursor } from "../index.ts";
import type { Affinity, DocumentView, EditKind, Selection, TabId, TextBuffer, TextEdit, Workspace, GraphemeCursor, GraphemeIndex } from "../index.ts";
import type { ViewState } from "./index.ts";
import { inputContext } from "./input-context.ts";
import type { InputContext } from "./input-context.ts";
import { mountTextViewport } from "./viewport.ts";
import type { LineClass, LineDecorator, TextViewport } from "./viewport.ts";

export type EditingCandidate = Readonly<{ element: HTMLDivElement; input: HTMLTextAreaElement; view: DocumentView; viewport: TextViewport;
    focus: () => void; captureView: () => ViewState; restoreView: (state: ViewState) => void;
    snapshot: () => Readonly<{ inputUnits: number; inputEvents: number; lastInputMs: number; keydownEvents: number; lastKeydownMs: number; pendingCaret: boolean; commits: number; conflicts: number; composing: boolean; pendingWord: boolean; wordScanSteps: number; maxWordScanStepMs: number; pendingGrapheme: boolean; graphemeScanSteps: number; maxGraphemeScanStepMs: number; visualMoves: number; disposed: boolean }>;
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
    const owner = host.ownerDocument, win = owner.defaultView!, input = owner.createElement("textarea"), caret = owner.createElement("div"), help = owner.createElement("span");
    const scope = ++nextMount, listeners = new AbortController();
    root.classList.add("st-editing-candidate"); root.tabIndex = -1;
    root.querySelector(".st-viewport-layer")!.setAttribute("aria-hidden", "true");
    input.className = "st-input-context"; input.wrap = "off"; input.spellcheck = false; input.autocomplete = "off";
    input.setAttribute("aria-label", options.ariaLabel ?? workspace.document(documentId).title);
    input.setAttribute("aria-multiline", "true"); input.setAttribute("autocapitalize", "off");
    help.id = `st-input-help-${scope}`; help.className = "st-input-help"; help.textContent = "Tab inserts indentation. Press Escape, then Tab to leave the editor.";
    input.setAttribute("aria-describedby", help.id); caret.className = "st-input-caret"; caret.setAttribute("aria-hidden", "true"); root.append(input, caret, help);
    let revision = workspace.document(documentId).revision, context: InputContext = inputContext(workspace.document(documentId).buffer, view.getSnapshot().selection);
    let disposed = false, composing = false, selecting = false, committing = false, escaped = false;
    let frame: number | undefined, commits = 0, conflicts = 0, serial = 0, preferredX: number | undefined, inputEvents = 0, lastInputMs = 0;
    let keydownEvents = 0, lastKeydownMs = 0;
    let preferredSelection: Selection | undefined, preferredColumnWidth = 0;
    let wordScanSteps = 0, maxWordScanStepMs = 0;
    let graphemeScanSteps = 0, maxGraphemeScanStepMs = 0;
    let visualMoves = 0;
    let group: Readonly<{ type: string; edge: number; time: number; key: string }> | undefined;
    let drag: Readonly<{ pointer: number; anchor: number; anchorAffinity: Affinity; revision: number }> | undefined;
    const commandTimers = new Set<number>();
    let wordJob: Readonly<{ cursor: WordCursor; revision: number; selection: Selection }> | undefined, wordTimer: number | undefined;
    type CommandCapture = Readonly<{ buffer: TextBuffer; revision: number; selection: Selection; deleting: boolean }>;
    let graphemeJob: Readonly<{ cursor: GraphemeCursor; capture: CommandCapture; purpose: "word" | "grapheme" }> | undefined, graphemeTimer: number | undefined;
    let graphemeCache: Readonly<{ buffer: TextBuffer; from: number; to: number; index: GraphemeIndex }> | undefined;
    let wordInput: Readonly<{ revision: number; selection: Selection; direction: -1 | 1 }> | undefined;
    const apple = /Mac|iPhone|iPad|iPod/.test(win.navigator.platform);
    function cancelWord(): void {
        wordJob?.cursor.dispose(); wordJob = undefined;
        if (wordTimer !== undefined) { win.clearTimeout(wordTimer); commandTimers.delete(wordTimer); wordTimer = undefined; }
        graphemeJob?.cursor.dispose(); graphemeJob = undefined;
        if (graphemeTimer !== undefined) { win.clearTimeout(graphemeTimer); commandTimers.delete(graphemeTimer); graphemeTimer = undefined; }
    }
    const scheduleCaret = () => { if (!disposed && frame === undefined) frame = win.requestAnimationFrame(positionCaret); };
    function positionCaret(): void {
        frame = undefined; if (disposed) return;
        const selected = view.getSnapshot().selection, point = viewport.coordsAt(selected.head, selected.headAffinity), rectangle = root.getBoundingClientRect();
        const visible = point && point.left >= rectangle.left && point.left < rectangle.left + root.clientWidth
            && point.top + point.height > rectangle.top && point.top < rectangle.top + root.clientHeight;
        caret.hidden = !visible || selected.anchor !== selected.head || composing || owner.activeElement !== input;
        // Keep the native IME anchor near the measured caret without enlarging the scroll surface.
        const left = Math.max(0, Math.min(root.clientWidth - 2, (point?.left ?? rectangle.left) - rectangle.left));
        const top = Math.max(0, Math.min(root.clientHeight - 24, (point?.top ?? rectangle.top) - rectangle.top));
        for (const element of [input, caret]) { element.style.left = `${root.scrollLeft + left}px`; element.style.top = `${root.scrollTop + top}px`; element.style.height = `${point?.height ?? viewport.snapshot().lineHeight}px`; }
    }
    function refresh(): void {
        if (disposed || selecting || committing) return;
        const state = resource.getSnapshot(); input.disabled = !workspace.resolveTab(target) || state.state !== "ready";
        input.readOnly = !state.metadata.capabilities.edit.includes("human") || state.metadata.editLock !== null;
        input.setAttribute("aria-busy", String(state.state === "loading"));
        if (!input.disabled && !composing) {
            const document = workspace.document(documentId), selected = view.getSnapshot().selection;
            if (graphemeCache?.buffer !== document.buffer) graphemeCache = undefined;
            if (graphemeJob && (graphemeJob.capture.revision !== document.revision || graphemeJob.capture.selection !== selected)) cancelWord();
            context = inputContext(document.buffer, selected); revision = document.revision;
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
        const anchor = context.toModel(backward ? input.selectionEnd : input.selectionStart), head = context.toModel(backward ? input.selectionStart : input.selectionEnd);
        const current = view.getSnapshot(); if (current.revision === revision && current.selection.anchor === anchor && current.selection.head === head) return;
        selecting = true;
        try { view.setSelection(revision, { anchor, head }); }
        finally { selecting = false; }
        scheduleCaret();
    }
    const conflict = (reason: string, edit?: TextEdit) => {
        conflicts++; group = undefined;
        input.dispatchEvent(new CustomEvent("sttropez-conflict", { bubbles: true, detail: Object.freeze({ documentId, expectedRevision: revision, reason,
            attemptedText: input.value, contextFrom: context.from, ...(edit ? { attemptedEdit: Object.freeze({ ...edit }) } : {}) }) }));
    };
    function apply(edits: readonly TextEdit[], selection: Selection, kind: EditKind, type?: string, expectedRevision = revision): void {
        if (disposed) return;
        cancelWord(); preferredX = undefined;
        if (!workspace.resolveTab(target)) { conflict("expired-view", edits[0]); refresh(); return; }
        let key: string | undefined;
        if (type && edits.length === 1) {
            const edit = edits[0]!, now = win.performance.now();
            const adjacent = group?.type === type && now - group.time < 1000 && (type === "deleteContentBackward" ? edit.to === group.edge : edit.from === group.edge);
            key = adjacent ? group!.key : `${view.id}:${scope}:${++serial}`;
            group = { type, edge: edit.from + edit.insert.length, time: now, key };
        } else group = undefined;
        committing = true;
        try {
            const result = workspace.edit({ documentId, expectedRevision, origin: "human", edits, view, selection,
                history: { kind, ...(key ? { group: key } : {}) } });
            if (result.applied) { commits++; viewport.revealOffset(selection.head); }
            else conflict(result.reason, edits[0]);
        } finally { committing = false; refresh(); }
    }
    function commit(type: string): void {
        if (disposed || composing) return;
        if (type === "historyUndo" || type === "historyRedo") { history(type === "historyUndo" ? "undo" : "redo"); return; }
        const edit = textDifference(context.text, input.value); if (!edit) { refresh(); return; }
        const from = context.toModel(edit.from), to = edit.from === edit.to ? from : context.toModel(edit.to), delta = edit.insert.length - (to - from);
        const map = (offset: number) => offset <= edit.from ? context.toModel(offset)
            : offset >= edit.from + edit.insert.length ? context.toModel(offset - edit.insert.length + edit.to - edit.from) + delta : from + offset - edit.from;
        const backward = input.selectionDirection === "backward", selection = { anchor: map(backward ? input.selectionEnd : input.selectionStart), head: map(backward ? input.selectionStart : input.selectionEnd) };
        const typing = type === "insertText" && !edit.insert.includes("\n"), deleting = type === "deleteContentBackward" || type === "deleteContentForward";
        apply([{ from, to, insert: edit.insert }], selection, typing ? "typing" : deleting ? "delete" : type === "insertCompositionText" ? "composition" : "replace", typing || deleting ? type : undefined);
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
    function move(offset: number, extend: boolean, affinity: Affinity = "after"): void {
        cancelWord(); group = undefined; const selected = view.getSnapshot().selection;
        view.setSelection(revision, { anchor: extend ? selected.anchor : offset, head: offset, anchorAffinity: extend ? selected.anchorAffinity ?? "after" : affinity, headAffinity: affinity });
        viewport.revealOffset(offset, { horizontal: "nearest", vertical: "nearest", affinity }); refresh();
    }
    function replaceSelection(insert: string, kind: EditKind, type?: string): void {
        const selected = view.getSnapshot().selection, from = Math.min(selected.anchor, selected.head), to = Math.max(selected.anchor, selected.head), head = from + insert.length;
        apply([{ from, to, insert }], { anchor: head, head }, kind, type);
    }
    const validCommand = (capture: CommandCapture) => !disposed && !composing && !input.disabled && !(capture.deleting && input.readOnly) && !!workspace.resolveTab(target) && workspace.observeDocument(documentId).getSnapshot()?.revision === capture.revision && view.getSnapshot().selection === capture.selection;
    function withGraphemes(capture: CommandCapture, offset: number, side: -1 | 1, purpose: "word" | "grapheme", done: (index: GraphemeIndex) => void): void {
        cancelWord(); if (!validCommand(capture)) return;
        const buffer = capture.buffer; let line = buffer.lineAt(offset); if (side < 0 && line > 0 && offset === buffer.offsetAt(line)) line--;
        const from = buffer.offsetAt(line), to = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
        if (graphemeCache?.buffer === buffer && graphemeCache.from === from && graphemeCache.to === to) { done(graphemeCache.index); return; }
        const job = { cursor: createGraphemeCursor(buffer, { from, to }), capture, purpose }; graphemeJob = job;
        const step = () => {
            if (graphemeJob !== job) return; if (!validCommand(capture)) { cancelWord(); return; }
            const began = win.performance.now(); let result, calls = 0;
            try { do { result = job.cursor.next(4096); calls++; } while (result.status === "running" && calls < 8 && win.performance.now() - began < 4); }
            catch { cancelWord(); conflict("grapheme-limit"); return; }
            graphemeScanSteps++; maxGraphemeScanStepMs = Math.max(maxGraphemeScanStepMs, win.performance.now() - began);
            if (result.status === "running") { const timer = win.setTimeout(() => { commandTimers.delete(timer); if (graphemeJob === job) graphemeTimer = undefined; step(); }, 0); graphemeTimer = timer; commandTimers.add(timer); return; }
            const index = result.result!; job.cursor.dispose(); graphemeJob = undefined; graphemeCache = Object.freeze({ buffer, from, to, index }); done(index);
        }; step();
    }
    function grapheme(direction: -1 | 1, deleting: boolean, extend = false): void {
        cancelWord(); if (disposed || composing || input.disabled || deleting && input.readOnly) return; syncSelection();
        const document = workspace.document(documentId), selection = view.getSnapshot().selection, capture = { buffer: document.buffer, revision: document.revision, selection, deleting }, offset = selection.head;
        graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        withGraphemes(capture, offset, direction, "grapheme", index => {
            if (deleting) { const from = direction < 0 && index.isBoundary(offset) ? index.preceding(offset) ?? offset : index.floor(offset), to = direction > 0 ? index.following(offset) ?? offset : index.ceil(offset);
                apply([{ from, to, insert: "" }], { anchor: from, head: from }, "delete", direction < 0 ? "deleteContentBackward" : "deleteContentForward", capture.revision); }
            else move(direction < 0 ? index.preceding(offset) ?? offset : index.following(offset) ?? offset, extend);
        });
    }
    function word(direction: -1 | 1, deleting: boolean, extend = false): void {
        cancelWord(); if (disposed || composing || input.disabled || deleting && input.readOnly) return;
        group = undefined; preferredX = undefined; syncSelection();
        const document = workspace.document(documentId), selected = view.getSnapshot().selection;
        if (deleting && selected.anchor !== selected.head) { replaceSelection("", "delete"); return; }
        wordScanSteps = 0; maxWordScanStepMs = 0; graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        const capture = { buffer: document.buffer, revision: document.revision, selection: selected, deleting };
        withGraphemes(capture, selected.head, deleting ? direction < 0 ? 1 : -1 : direction, "word", index => {
        const start = (deleting ? -direction : direction) < 0 ? index.floor(selected.head) : index.ceil(selected.head);
        const job = { cursor: new WordCursor(document.buffer, start, direction), revision: document.revision, selection: selected }; wordJob = job;
        const step = () => {
            if (wordJob !== job) return;
            const current = workspace.observeDocument(documentId).getSnapshot();
            if (!validCommand(capture) || current?.revision !== job.revision) { cancelWord(); return; }
            const began = win.performance.now(); let result, count = 0;
            do { result = job.cursor.next(4096); count++; } while (result.status === "running" && count < 8 && win.performance.now() - began < 4);
            wordScanSteps++; maxWordScanStepMs = Math.max(maxWordScanStepMs, win.performance.now() - began);
            if (result.status === "running") {
                const timer = win.setTimeout(() => { commandTimers.delete(timer); if (wordJob === job) wordTimer = undefined; step(); }, 0);
                wordTimer = timer; commandTimers.add(timer); return;
            }
            withGraphemes(capture, result.offset!, direction, "word", index => {
            const end = direction < 0 ? index.floor(result.offset!) : index.ceil(result.offset!);
            if (deleting) { const from = Math.min(start, end), to = Math.max(start, end); apply([{ from, to, insert: "" }], { anchor: from, head: from }, "delete", undefined, job.revision); }
            else move(end, extend);
            });
        }; step();
        });
    }
    function vertical(direction: -1 | 1, page: boolean, extend: boolean): void {
        cancelWord(); viewport.flush(); let state = viewport.snapshot(); const selected = view.getSnapshot().selection;
        let point = viewport.coordsAt(selected.head, selected.headAffinity);
        if (!point) { viewport.revealOffset(selected.head); viewport.flush(); state = viewport.snapshot(); point = viewport.coordsAt(selected.head, selected.headAffinity); }
        if (!point) return;
        if (selected !== preferredSelection || state.columnWidth !== preferredColumnWidth) preferredX = undefined;
        const buffer = workspace.document(documentId).buffer, line = buffer.lineAt(selected.head), count = page ? Math.max(1, Math.floor(state.height / state.lineHeight) - 1) : 1;
        const nextLine = Math.max(0, Math.min(buffer.lineCount - 1, line + direction * count));
        if (nextLine === line) { preferredX = undefined; preferredSelection = undefined; move(direction < 0 ? 0 : buffer.length, extend); return; }
        const rectangle = root.getBoundingClientRect(); preferredX ??= point.left - rectangle.left + state.scrollLeft;
        const delta = (nextLine - line) * state.lineHeight, targetTop = point.top - rectangle.top + delta;
        let top = page ? state.scrollTop + delta : state.scrollTop;
        if (!page) { if (targetTop < 0) top += targetTop; else if (targetTop + point.height > state.height) top += targetTop + point.height - state.height; }
        const left = preferredX < state.scrollLeft || preferredX > state.scrollLeft + state.width ? Math.max(0, preferredX - state.width / 2) : state.scrollLeft;
        viewport.scrollTo({ top, left }); viewport.flush(); const next = viewport.snapshot();
        const hit = viewport.hitTest(rectangle.left + preferredX - next.scrollLeft, point.top + point.height / 2 + delta - (next.scrollTop - state.scrollTop));
        if (hit) { move(hit.offset, extend, hit.affinity); preferredSelection = view.getSnapshot().selection; preferredColumnWidth = state.columnWidth; }
    }
    function indent(outdent: boolean): void {
        const document = workspace.document(documentId), buffer = document.buffer, selected = view.getSnapshot().selection;
        const low = Math.min(selected.anchor, selected.head), high = Math.max(selected.anchor, selected.head);
        if (!outdent && low === high) { replaceSelection("    ", "replace"); return; }
        const first = buffer.lineAt(low), last = buffer.lineAt(high > low && buffer.offsetAt(buffer.lineAt(high)) === high ? high - 1 : high);
        const edits: TextEdit[] = []; let line = first;
        // Plan large selections in yielding chunks against the captured immutable buffer/revision.
        const step = () => {
            if (disposed) return;
            if (!workspace.resolveTab(target) || workspace.document(documentId).revision !== document.revision || view.getSnapshot().selection !== selected) { conflict("stale-indent-command"); return; }
            const stop = Math.min(last + 1, line + 256);
            for (; line < stop; line++) {
                const from = buffer.offsetAt(line), prefix = buffer.slice(from, Math.min(buffer.length, from + 4));
                const count = prefix.startsWith("\t") ? 1 : /^ {0,4}/.exec(prefix)![0].length;
                if (!outdent || count) edits.push({ from, to: from + (outdent ? count : 0), insert: outdent ? "" : "    " });
            }
            if (line <= last) {
                const timer = win.setTimeout(() => { commandTimers.delete(timer); step(); }, 0); commandTimers.add(timer);
            } else if (edits.length) {
                const mapping = new PositionMap(buffer.length, edits);
                apply(edits, { anchor: mapping.map(selected.anchor, "after").offset, head: mapping.map(selected.head, "after").offset }, "replace", undefined, document.revision);
            }
        }; group = undefined; step();
    }
    input.addEventListener("beforeinput", event => {
        wordInput = undefined;
        if (!composing && (event.inputType === "deleteWordBackward" || event.inputType === "deleteWordForward")) {
            syncSelection(); const direction = event.inputType === "deleteWordBackward" ? -1 : 1;
            if (event.cancelable) { event.preventDefault(); word(direction, true); }
            else wordInput = { revision, selection: view.getSnapshot().selection, direction };
        } else if (!composing && event.cancelable && (event.inputType === "historyUndo" || event.inputType === "historyRedo")) { event.preventDefault(); history(event.inputType === "historyUndo" ? "undo" : "redo"); }
        else syncSelection();
    }, { signal: listeners.signal });
    input.addEventListener("input", event => {
        const start = win.performance.now(), type = (event as InputEvent).inputType;
        if (!composing && (type === "deleteWordBackward" || type === "deleteWordForward")) {
            const captured = wordInput; wordInput = undefined;
            if (!captured || input.disabled || input.readOnly || !workspace.resolveTab(target) || captured.direction !== (type === "deleteWordBackward" ? -1 : 1)
                || captured.revision !== revision || captured.selection !== view.getSnapshot().selection) { conflict("stale-word-input"); refresh(); }
            else { refresh(); word(captured.direction, true); }
        } else commit(type);
        lastInputMs = win.performance.now() - start; inputEvents++;
    }, { signal: listeners.signal });
    input.addEventListener("compositionstart", () => { cancelWord(); wordInput = undefined; syncSelection(); composing = true; group = undefined; root.classList.add("st-composing"); scheduleCaret(); }, { signal: listeners.signal });
    input.addEventListener("compositionend", () => { composing = false; root.classList.remove("st-composing"); commit("insertCompositionText"); }, { signal: listeners.signal });
    for (const type of ["select", "keyup"] as const) input.addEventListener(type, syncSelection, { signal: listeners.signal });
    input.addEventListener("focus", scheduleCaret, { signal: listeners.signal });
    input.addEventListener("blur", () => { syncSelection(); group = undefined; scheduleCaret(); }, { signal: listeners.signal });
    function keydown(event: KeyboardEvent): void {
        if (composing || event.isComposing) return;
        const command = (event.ctrlKey || event.metaKey) && !event.altKey, key = event.key.toLowerCase();
        if (command && (key === "z" || (event.ctrlKey && key === "y"))) { event.preventDefault(); history(event.shiftKey || key === "y" ? "redo" : "undo"); return; }
        if (command && key === "a") { event.preventDefault(); cancelWord(); const length = workspace.document(documentId).buffer.length; view.setSelection(revision, { anchor: 0, head: length }); refresh(); return; }
        if (command && (event.key === "Home" || event.key === "End")) { event.preventDefault(); preferredX = undefined; move(event.key === "Home" ? 0 : workspace.document(documentId).buffer.length, event.shiftKey); return; }
        if (event.key === "Escape") { escaped = true; return; }
        if (event.key === "Tab" && escaped) { escaped = false; return; }
        escaped = false; syncSelection();
        const wordModifier = !event.metaKey && (event.ctrlKey && !event.altKey || apple && event.altKey && !event.ctrlKey);
        if (wordModifier && ["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(event.key)) {
            event.preventDefault(); word(event.key === "ArrowLeft" || event.key === "Backspace" ? -1 : 1, event.key === "Backspace" || event.key === "Delete", event.shiftKey); return;
        }
        const selected = view.getSnapshot().selection, buffer = workspace.document(documentId).buffer;
        if (!event.altKey && !command && ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) {
            event.preventDefault(); vertical(event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 1, event.key.startsWith("Page"), event.shiftKey); return;
        }
        if (!event.altKey && !command && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault(); let offset = selected.head;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                const direction = event.key === "ArrowLeft" ? -1 : 1;
                viewport.flush();
                const point = !event.shiftKey && selected.anchor !== selected.head
                    ? viewport.collapseVisual(Math.min(selected.anchor, selected.head), Math.max(selected.anchor, selected.head), direction)
                    : viewport.moveVisual(offset, selected.headAffinity ?? "after", direction);
                if (point) { visualMoves++; preferredX = undefined; move(point.offset, event.shiftKey, point.affinity); return; }
                if (event.shiftKey || selected.anchor === selected.head) { preferredX = undefined; grapheme(direction, false, event.shiftKey); return; }
                offset = direction < 0 ? Math.min(selected.anchor, selected.head) : Math.max(selected.anchor, selected.head);
                preferredX = undefined;
            } else if (event.key === "Home" || event.key === "End") {
                const line = buffer.lineAt(offset); offset = event.key === "Home" ? buffer.offsetAt(line) : line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) - 1 : buffer.length;
                if (event.key === "End" && offset > 0 && buffer.slice(offset - 1, offset) === "\r") offset--; preferredX = undefined;
            }
            move(offset, event.shiftKey); return;
        }
        preferredX = undefined;
        if (!command && !event.altKey && (event.key === "Backspace" || event.key === "Delete")) {
            event.preventDefault(); const from = Math.min(selected.anchor, selected.head), to = Math.max(selected.anchor, selected.head), backward = event.key === "Backspace";
            if (from === to) grapheme(backward ? -1 : 1, true);
            else apply([{ from, to, insert: "" }], { anchor: from, head: from }, "delete", backward ? "deleteContentBackward" : "deleteContentForward");
        } else if (event.key === "Tab" && !command && !event.altKey) { event.preventDefault(); indent(event.shiftKey); }
        else if (!command && !event.altKey && selected.anchor === selected.head && !input.readOnly) {
            const closing = { "(": ")", "[": "]", "{": "}" }[event.key], next = buffer.slice(selected.head, Math.min(buffer.length, selected.head + 1));
            if (closing && (!next || /[\s)\]}]/.test(next))) { event.preventDefault(); apply([{ from: selected.head, to: selected.head, insert: event.key + closing }], { anchor: selected.head + 1, head: selected.head + 1 }, "typing"); }
            else if ([")", "]", "}"].includes(event.key) && next === event.key) { event.preventDefault(); move(selected.head + 1, false); }
        }
    }
    input.addEventListener("keydown", event => {
        const started = win.performance.now(); keydownEvents++;
        try { keydown(event); } finally { lastKeydownMs = win.performance.now() - started; }
    }, { signal: listeners.signal });
    root.addEventListener("pointerdown", event => {
        if (event.button !== 0 || event.target === input) return;
        const point = viewport.hitTest(event.clientX, event.clientY); if (!point) return;
        event.preventDefault(); cancelWord(); preferredX = undefined; focus(); group = undefined;
        const selected = view.getSnapshot().selection, anchor = event.shiftKey ? selected.anchor : point.offset;
        const anchorAffinity = event.shiftKey ? selected.anchorAffinity ?? "after" : point.affinity;
        view.setSelection(revision, { anchor, head: point.offset, anchorAffinity, headAffinity: point.affinity }); refresh(); drag = { pointer: event.pointerId, anchor, anchorAffinity, revision }; root.setPointerCapture(event.pointerId);
    }, { signal: listeners.signal });
    root.addEventListener("pointermove", event => {
        if (drag?.pointer !== event.pointerId) return;
        if (drag.revision !== revision) { drag = undefined; return; }
        const point = viewport.hitTest(event.clientX, event.clientY); if (point) { view.setSelection(revision, { anchor: drag.anchor, head: point.offset, anchorAffinity: drag.anchorAffinity, headAffinity: point.affinity }); refresh(); }
    }, { signal: listeners.signal });
    const stopDrag = () => { drag = undefined; };
    root.addEventListener("pointerup", stopDrag, { signal: listeners.signal }); root.addEventListener("pointercancel", stopDrag, { signal: listeners.signal });
    for (const type of ["copy", "cut", "paste"] as const) input.addEventListener(type, event => {
        if (composing || !event.clipboardData) return;
        event.preventDefault(); syncSelection(); group = undefined;
        const selected = view.getSnapshot().selection;
        if (type === "paste") replaceSelection(event.clipboardData.getData("text/plain"), "paste");
        else {
            if (type === "cut" && input.readOnly) return;
            event.clipboardData.setData("text/plain", workspace.document(documentId).buffer.slice(Math.min(selected.anchor, selected.head), Math.max(selected.anchor, selected.head)));
            if (type === "cut") replaceSelection("", "delete");
        }
    }, { signal: listeners.signal });
    root.addEventListener("sttropez-render", scheduleCaret, { signal: listeners.signal });
    const subscriptions = [workspace.observeDocument(documentId).subscribe(refresh), view.subscribe(refresh), resource.metadata.subscribe(refresh), workspace.tabState.subscribe(refresh)];
    refresh();
    return Object.freeze({ element: root, input, view, viewport, focus,
        captureView: () => { syncSelection(); return viewport.captureView(); },
        restoreView: (state: ViewState) => { viewport.restoreView(state); refresh(); },
        snapshot: () => Object.freeze({ inputUnits: input.value.length, inputEvents, lastInputMs, keydownEvents, lastKeydownMs, pendingCaret: frame !== undefined, commits, conflicts, composing, pendingWord: wordJob !== undefined || graphemeJob?.purpose === "word", wordScanSteps, maxWordScanStepMs, pendingGrapheme: graphemeJob !== undefined, graphemeScanSteps, maxGraphemeScanStepMs, visualMoves, disposed }),
        destroy: () => {
            if (disposed) return; disposed = true;
            cancelWord(); wordInput = undefined; graphemeCache = undefined;
            if (composing && input.value !== context.text) conflict("composition-detached");
            composing = false; drag = undefined;
            if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined;
            commandTimers.forEach(timer => win.clearTimeout(timer)); commandTimers.clear();
            listeners.abort(); subscriptions.forEach(unsubscribe => unsubscribe()); input.value = ""; viewport.destroy(); if (!options.view) view.dispose();
        } });
}
