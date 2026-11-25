import { identifierAt } from "../core/identifier.ts";
import type { DocumentId } from "../core/workspace.ts";
import { lspRangeOffsets } from "../protocol/lsp-features.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { renameMethod } from "../protocol/lsp-methods.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { listenUntil, onAbort } from "./listen.ts";
import type { RenamePreview, RenameSnapshot } from "./rename-controller.ts";
import type { TextEditor } from "./text-editor.ts";
import type { Observable } from "../core/observable.ts";

export type RenamePopupOptions = Readonly<{
    text?: (label: string) => string;
    beforeOpen?: () => void;
    onNotice?: (message: string) => void;
}>;

type Source = CapturedViewRequest<TextEditor["tab"]>;
type Review = Observable<RenameSnapshot> & {
    cancel(): void;
    preview(name: string): void;
};
const nameLimit = 256;
const pageSize = 64;

async function preparedName(owner: LspDocumentOwner, source: Source, offset: number, fallback: string) {
    const { scope, binding } = owner;
    const call = scope.requestDocument("textDocument/prepareRename", binding, index => ({ position: index.at(offset) }));
    onAbort(source.signal, call.cancel);
    try {
        const reply = await call.result;
        if (!source.isCurrent() || reply === null) return null;
        const captured = scope.synchronized(binding);
        if (!captured || captured.document.buffer !== source.document.buffer) return null;
        if (typeof reply !== "object" || Array.isArray(reply)) throw new TypeError("Invalid rename target.");
        if ("defaultBehavior" in reply && reply.defaultBehavior === true) return fallback;
        const { from, to } = lspRangeOffsets(captured.index, "range" in reply ? reply.range : reply);
        if (from === to || offset < from || offset > to) return null;
        if ("placeholder" in reply) {
            if (typeof reply.placeholder !== "string") throw new TypeError("Invalid rename placeholder.");
            return reply.placeholder.length <= nameLimit ? reply.placeholder : "";
        }
        return to - from <= nameLimit ? source.document.buffer.slice(from, to) : "";
    } finally {
        source.signal.removeEventListener("abort", call.cancel);
    }
}

/** The field stays in the pane while the captured line scrolls out of view. */
export function mountRenamePopup(editor: TextEditor, owner: LspDocumentOwner, review: Review,
    capture: () => Source | undefined, signal: AbortSignal, options: RenamePopupOptions) {
    const { element, commands } = editor;
    const doc = element.ownerDocument;
    const win = doc.defaultView!;
    const listen = listenUntil(signal);
    const text = options.text ?? (label => label);
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElement(tag);
    const panel = node("section");
    panel.className = "st-rename";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", text("Rename symbol"));
    const label = node("label");
    const name = node("input");
    name.maxLength = nameLimit;
    label.append(text("New name"), name);
    const status = node("p");
    status.setAttribute("aria-label", text("Rename status"));
    const controls = node("div");
    const pages = node("div");
    const list = node("ol");
    list.tabIndex = 0;
    list.setAttribute("aria-label", text("Rename edits"));
    panel.append(label, status, controls, pages, list);
    panel.hidden = true;
    function button(parent: HTMLElement, label: string, action: () => void) {
        const control = node("button");
        control.type = "button";
        control.textContent = text(label);
        control.onclick = action;
        parent.append(control);
        return control;
    }
    let source: Source | undefined;
    let checking = false;
    let edited = false;
    let submitted = false;
    let shown: RenamePreview | null = null;
    let first = 0;
    const preview = button(controls, "Preview rename", () => { name.focus(); prepare(); });
    let apply = button(controls, "Apply rename", () => {});
    button(controls, "Cancel rename", () => close(true));
    function hide(focus: boolean) {
        if (!source) return;
        const previous = source;
        source = undefined;
        checking = false;
        panel.hidden = true;
        previous.cancel();
        if (focus && !signal.aborted && element.isConnected) editor.focus();
    }
    function close(focus: boolean) {
        hide(focus);
        review.cancel();
    }
    function excerpt(value: string, length: number) {
        return value + (length > value.length ? `… (${length} UTF-16 units)` : "");
    }
    function page(result: RenamePreview | null, offset: number) {
        const focus = pages.querySelector(":focus")?.textContent;
        pages.replaceChildren();
        list.replaceChildren();
        first = offset;
        list.start = offset + 1;
        const batch = result?.readEdits(offset, offset + pageSize);
        if (!batch) return;
        const { total, notes } = batch;
        if (result?.canApply) status.textContent = text(`Review ${total} ${total === 1 ? "change" : "changes"}.`);
        if (total > pageSize) {
            for (const [label, next] of [["Previous edits", offset - pageSize], ["Next edits", offset + pageSize]] as const) {
                const item = button(pages, label, () => {
                    if (shown === result && first === offset && item.isConnected) page(result, next);
                });
                item.disabled = next < 0 || next >= total;
            }
            if (focus) {
                const enabled = [...pages.querySelectorAll("button:enabled")] as HTMLButtonElement[];
                (enabled.find(item => item.textContent === focus) ?? enabled[0])?.focus({ preventScroll: true });
            }
        }
        for (const note of notes) {
            const { line, column } = editor.workspace.document(note.document as DocumentId).buffer.positionAt(note.from);
            const row = node("li");
            const code = node("code");
            const before = node("del");
            const after = node("ins");
            before.textContent = excerpt(note.before, note.to - note.from);
            after.textContent = excerpt(note.insert, note.insertUnits);
            code.append(before, " → ", after);
            row.append(`${note.title} · ${line + 1}:${column + 1} `, code);
            list.append(row);
        }
        list.scrollTop = 0;
    }
    function render() {
        const state = review.getSnapshot();
        const result = state.preview;
        preview.disabled = checking || state.status === "pending" || !name.value.trim();
        status.textContent = text(checking ? "Checking rename target…" : state.message || "Enter a name, then preview its changes.");
        if (shown !== result) {
            shown = result;
            const replacement = button(controls, "Apply rename", () => result?.apply());
            apply.replaceWith(replacement);
            apply = replacement;
            page(result, 0);
        }
        apply.disabled = !result?.canApply;
    }
    function prepare() {
        if (!source?.isCurrent() || name.readOnly || !name.value.trim()) return;
        if (checking) submitted = true;
        else review.preview(name.value);
    }
    function open() {
        close(false);
        options.beforeOpen?.();
        const target = capture();
        if (!target) return false;
        source = target;
        const caret = target.selectionSet.ranges[target.selectionSet.primary]!;
        const offset = caret.head;
        editor.viewport.revealOffset(offset, { vertical: "center-if-outside", horizontal: "nearest", affinity: caret.headAffinity ?? "after" });
        name.readOnly = false;
        name.value = identifierAt(target.document.buffer, offset, nameLimit) ?? "";
        edited = submitted = false;
        checking = owner.provider.queryFeatureOptions(renameMethod, target.document).some(o => o.prepareProvider === true);
        panel.hidden = false;
        render();
        name.focus({ preventScroll: true });
        name.select();
        onAbort(target.signal, () => queueMicrotask(() => {
            if (source === target) close(panel.matches(":focus-within"));
        }));
        if (checking) {
            const reject = (message: string) => {
                if (source !== target || !target.isCurrent()) return;
                if (options.onNotice) {
                    close(true);
                    options.onNotice(text(message));
                } else {
                    checking = false;
                    name.readOnly = true;
                    status.textContent = text(message);
                    preview.disabled = true;
                }
            };
            void preparedName(owner, target, offset, name.value).then(value => {
                if (source !== target || !target.isCurrent()) return;
                if (value === null) return reject("Place the caret on a name to rename it.");
                checking = false;
                if (!edited) {
                    name.value = value;
                    if (name.matches(":focus")) name.select();
                }
                render();
                if (submitted) prepare();
            }, () => reject("The language provider could not prepare a rename here."));
        }
        return true;
    }
    listen(name, "input", () => {
        edited = true;
        submitted = false;
        review.cancel();
    });
    listen(panel, "keydown", event => {
        if (event.target === name || event.key === "Escape") editor.keymap.handle(event);
        event.stopPropagation();
    });
    for (const type of ["pointerdown", "pointermove", "dblclick", "wheel", "dragstart", "dragenter", "dragover", "drop"]) {
        listen(panel, type, event => event.stopPropagation());
    }
    listen(panel, "focusout", event => {
        if (checking && !panel.contains(event.relatedTarget as Node | null)) close(false);
    });
    listen(win, "blur", () => { if (checking) close(false); });
    editor.onEditIntent(() => { if (source) close(false); }, signal);
    onAbort(signal, () => { hide(false); panel.remove(); });
    onAbort(signal, review.subscribe(render));
    function bind(id: string, label: string, key: string, enabled: () => boolean, run: (arg: unknown) => boolean | void, priority: number) {
        onAbort(signal, commands.register({ id, label: text(label), owner: "editor", category: "Rename", enabled, run },
            { keys: [key], priority, shared: true, repeat: false }).dispose);
    }
    bind("rename.start", "Rename symbol", "F2", () => editor.getSnapshot().readOnlyReason === null, open, 9);
    bind("rename.dismiss", "Dismiss rename", "Escape", () => !!source, arg => close(arg !== false), 39);
    bind("rename.submit", "Preview or apply rename", "Enter", () => name.matches(":focus"), () => {
        if (shown) { if (shown.canApply) shown.apply(); }
        else if (review.getSnapshot().status !== "pending") prepare();
    }, 33);
    element.querySelector(".st-viewport-surface")!.append(panel);
    return () => hide(false);
}
