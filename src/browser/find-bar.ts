import { identifierAt } from "../core/identifier.ts";
import { onAbort } from "./listen.ts";
import { editorElement } from "./editor-element.ts";
import { NotificationScope, Store, type Observable } from "../core/observable.ts";
import type { TextEditor } from "./text-editor.ts";
import { createFindController, type FindController, type FindSnapshot } from "./find.ts";
import { createRegexFindBackend } from "./regex-find.ts";
import { bindFindCommands } from "./find-controls.ts";
import { findStatus } from "./find-status.ts";

export type FindBarOptions = Readonly<{
    createWorker?: () => Worker;
    targetLabel?: (editor: TextEditor) => string;
    text?: (label: string) => string;
    status?: (snapshot: FindSnapshot) => string;
}>;
export type FindBar = Observable<FindSnapshot | null> & Readonly<{
    element: HTMLElement;
    attach(editor: TextEditor): { dispose(): void };
    setTarget(editor: TextEditor): void;
    open(replace?: boolean): void;
    close(): void;
    dispose(): void;
}>;

function selectedFindQuery(source: TextEditor, regex: boolean): string | undefined {
    const { anchor, head } = source.view.getSnapshot().selection, length = Math.abs(head - anchor);
    const limit = 4096;
    if (length > limit) return;
    const buffer = source.workspace.document(source.view.documentId).buffer;
    let text: string | undefined;
    if (length) text = buffer.slice(Math.min(anchor, head), Math.max(anchor, head));
    else {
        text = identifierAt(buffer, head, limit);
    }
    if (!text || text.length > limit) return;
    const query = regex ? text.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&").replace(/\r/g, "\\r") : text.replaceAll("\r\n", "\n");
    // A textarea would turn a remaining literal CR into a different query.
    if (query.includes("\r")) return;
    return query.length <= limit ? query : undefined;
}

/** Mount outside the editor subtree. One bar can follow several independently mounted panes. */
export function mountFindBar(host: HTMLElement, options: FindBarOptions = {}): FindBar {
    const doc = host.ownerDocument;
    const text = options.text ?? (label => label);
    function node<K extends keyof HTMLElementTagNameMap>(tag: K, part: string, parent: HTMLElement) {
        const child = editorElement(doc, tag, part);
        parent.append(child);
        return child;
    }
    const bar = node("section", "find-bar", host);
    bar.hidden = true;
    bar.setAttribute("aria-label", text("Find and replace"));
    function field(parent: HTMLElement, part: string, label: string, placeholder: string) {
        const input = node("textarea", part, parent);
        input.setAttribute("aria-label", text(label));
        input.title = text("Ctrl/Cmd+Enter inserts a line break");
        input.placeholder = text(placeholder);
        input.wrap = "off";
        input.spellcheck = false;
        input.rows = 1;
        input.oninput = () => { input.rows = input.value.includes("\n") ? 2 : 1; };
        return input;
    }
    function button(parent: HTMLElement, part: string, caption: string, action: () => void, label = caption) {
        const control = node("button", part, parent);
        control.type = "button";
        control.textContent = text(caption);
        control.title = text(label);
        control.setAttribute("aria-label", text(label));
        control.onclick = action;
        return control;
    }
    const query = field(bar, "find-query", "Find text", "Find in this file");
    const flags = node("span", "find-options", bar);
    flags.setAttribute("role", "group");
    flags.setAttribute("aria-label", text("Search options"));
    function toggle(part: string, caption: string, label: string) {
        const el = button(flags, part, caption, () => {
            el.setAttribute("aria-pressed", String(!pressed(el)));
            query.focus();
            find?.setFlags(searchFlags());
        }, label);
        el.setAttribute("aria-pressed", "false");
        return el;
    }
    const matchCase = toggle("find-case", "Aa", "Match case");
    const wholeWord = toggle("find-word", "Word", "Match whole word");
    const regex = toggle("find-regex", ".*", "Use regular expression");
    regex.disabled = !options.createWorker;
    const pressed = (control: HTMLButtonElement) => control.getAttribute("aria-pressed") === "true";
    function searchFlags() {
        return { regularExpression: pressed(regex), wholeWord: pressed(wholeWord), matchCase: pressed(matchCase) };
    }
    const previous = button(bar, "find-previous", "↑", () => target?.commands.run("find.previous"), "Previous match");
    const next = button(bar, "find-next", "↓", () => target?.commands.run("find.next"), "Next match");
    const expand = button(bar, "replace-toggle", "Replace…", () => {
        showReplacement(Boolean(row.hidden));
        (row.hidden ? query : replacement).focus({ preventScroll: true });
    });
    const row = node("span", "replace-controls", bar);
    const replacement = field(row, "replacement", "Replacement text", "Replace with");
    const replace = button(row, "replace-current", "Replace", () => {
        replacement.focus({ preventScroll: true });
        target?.commands.run("find.replaceCurrent", "button");
    });
    const all = button(row, "replace-all", "Replace all", () => target?.commands.run("find.replaceAll", "button"));
    const name = node("span", "find-target", bar);
    const status = node("output", "find-status", bar);
    button(bar, "find-close", "Close", close).title = text("Close find (Escape)");
    function value() {
        return pressed(regex) ? replacement.value.replace(/\\([\\n])/g, (_, ch) => ch === "n" ? "\n" : "\\")
            : replacement.value;
    }
    function showReplacement(show: boolean) {
        row.hidden = !show;
        expand.setAttribute("aria-expanded", String(show));
    }
    showReplacement(false);
    const scope = new NotificationScope();
    const store = new Store<FindSnapshot | null>(null, scope);
    const panes = new Map<TextEditor, () => void>();
    let target: TextEditor | undefined;
    let find: FindController | undefined;
    let unsubscribe: (() => void) | undefined;
    let cached: FindSnapshot | undefined;
    let disposed = false;
    function release() {
        cached = undefined;
        find?.dispose();
        unsubscribe?.();
        unsubscribe = undefined;
        find = undefined;
        scope.publish(store, null);
    }
    function render() {
        const state = find?.getSnapshot();
        const readOnly = !!target?.getSnapshot().readOnlyReason;
        const label = target && (options.targetLabel?.(target) ?? target.workspace.document(target.view.documentId).title);
        name.textContent = readOnly ? label + " · " + text("read-only") : "";
        const message = state ? (options.status ?? findStatus)(state) : "";
        status.textContent = message;
        const ready = state?.status === "ready";
        const searching = state?.status === "searching";
        const matches = !!state?.count;
        status.classList.toggle("no-matches", ready && !matches && !!state.query);
        status.classList.toggle("search-failed", state?.status === "failed");
        previous.disabled = next.disabled = !(searching || ready && matches);
        replace.disabled = readOnly || !matches || !(ready || searching && state.retained);
        all.disabled = readOnly || !matches || !ready;
        const reason = readOnly ? text("{file} is read-only.").replace("{file}", () => label ?? "")
            : searching ? text("Waiting for search results.") : state?.status === "replacing"
            ? text("Replacement in progress.") : message || text("Enter text to find.");
        replace.title = replace.disabled ? reason : text("Replace the current match");
        all.title = all.disabled ? reason : text("Replace all matches");
        scope.publish(store, state ?? null);
        const capture = cached;
        if (capture && state?.revision !== capture.revision) {
            queueMicrotask(() => { if (cached === capture) release(); });
        }
    }
    function search() {
        if (!find && target) {
            const createWorker = options.createWorker;
            find = createFindController(target, { highlightMatches: !bar.hidden,
                ...(createWorker && { regularExpressionBackend: createRegexFindBackend({
                    createWorker, clock: doc.defaultView!,
                }) }) });
            unsubscribe = find.subscribe(render);
            find.setFlags(searchFlags());
            find.setQuery(query.value);
            render();
        }
        return find;
    }
    function setTarget(editor: TextEditor) {
        if (target === editor || !panes.has(editor)) return;
        release();
        target = editor;
        if (!bar.hidden) search();
    }
    function revealCaret() {
        if (!target) return;
        const { head } = target.view.getSnapshot().selection;
        target.viewport.revealRange(head, head);
    }
    function open(replace = false) {
        if (!target) return;
        const { anchor, head } = target.view.getSnapshot().selection;
        const focusReplacement = replace && (!!query.value || anchor !== head);
        if (bar.hidden || target.getSnapshot().focused) {
            const seed = selectedFindQuery(target, pressed(regex));
            if (seed !== undefined && seed !== query.value) {
                query.value = seed;
                query.rows = seed.includes("\n") ? 2 : 1;
                find?.setQuery(seed);
            }
        }
        cached = undefined;
        bar.hidden = false;
        showReplacement(replace);
        search()?.setHighlightMatches(true);
        const input = focusReplacement && query.value && !target.getSnapshot().readOnlyReason ? replacement : query;
        input.focus();
        input.select();
    }
    function close() {
        if (!find?.acceptPreview()) revealCaret();
        bar.hidden = true;
        if (find?.getSnapshot().status === "ready") {
            find.setHighlightMatches(false);
            cached = find.getSnapshot();
        } else release();
        target?.focus();
    }
    const focused = () => (bar.getRootNode() as Document | ShadowRoot).activeElement;
    query.addEventListener("input", () => {
        find?.setQuery(query.value, { preview: true });
        if (!query.value) revealCaret();
    });
    bar.onkeydown = event => { target?.keymap.handle(event); };
    bar.onpointerdown = event => {
        if (event.button !== 0) return;
        const control = (event.target as Element).closest("button");
        if (control?.disabled || control === previous || control === next) {
            event.preventDefault();
            if (!control.disabled && focused() !== replacement) query.focus({ preventScroll: true });
        }
    };
    function attach(editor: TextEditor) {
        if (disposed || editor.signal.aborted || panes.has(editor)) throw new Error("Find bar cannot attach this editor.");
        const events = new AbortController();
        const { signal } = events;
        const owns = () => target === editor && !bar.hidden;
        function detach() {
            if (signal.aborted) return;
            events.abort();
            panes.delete(editor);
            if (target === editor) {
                target = undefined;
                release();
                render();
            }
        }
        try {
            const bindings = bindFindCommands(editor, {
                text,
                open(replace) { setTarget(editor); open(replace); },
                navigate(direction) {
                    if (!query.value) return false;
                    setTarget(editor);
                    const current = search();
                    if (bar.hidden) cached = current?.getSnapshot();
                    current?.next(direction, { whenReady: true });
                    return true;
                },
                queryFocused: () => owns() && focused() === query,
                replaceCurrent: {
                    enabled: from => owns() && (from === "button" ? !replace.disabled : focused() === replacement),
                    run() { if (!replace.disabled) find?.replaceCurrent(value()); },
                },
                replaceAll: {
                    enabled: () => owns() && !row.hidden && !all.disabled,
                    run() { replacement.focus({ preventScroll: true }); find?.replaceAll(value()); },
                },
                insertLineBreak: {
                    enabled: () => owns() && (focused() === query || focused() === replacement),
                    run() {
                        const input = focused() === query ? query : replacement;
                        input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
                        input.dispatchEvent(new Event("input", { bubbles: true }));
                    },
                },
                close: { enabled: owns, run: close },
            });
            onAbort(signal, bindings.dispose);
            panes.set(editor, detach);
            editor.element.addEventListener("focusin", () => setTarget(editor), { signal });
            editor.signal.addEventListener("abort", detach, { once: true, signal });
            let reason = editor.getSnapshot().readOnlyReason;
            const stop = editor.subscribe(() => {
                const next = editor.getSnapshot().readOnlyReason;
                if (reason !== next && target === editor && find) render();
                reason = next;
            });
            onAbort(signal, stop);
            if (!target) setTarget(editor);
        } catch (error) {
            detach();
            throw error;
        }
        return { dispose: detach };
    }
    render();
    return Object.freeze({ element: bar, ...store.observable, attach, setTarget, open, close, dispose() {
        disposed = true;
        for (const detach of panes.values()) detach();
        store.clearSnapshotListeners();
        bar.remove();
    } });
}
