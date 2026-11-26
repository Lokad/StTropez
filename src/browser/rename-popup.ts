import { mountAnchoredOverlay } from "./anchored-overlay.ts";
import { revealSelectionHead } from "./input-caret.ts";
import { builtinKeyPriority } from "./command-registry.ts";
import { identifierAt } from "../core/identifier.ts";
import { reviewPanel } from "./review-controls.ts";
import { isFocused } from "./dom-focus.ts";
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
    review?: boolean;
    beforeOpen?: () => void;
    onNotice?: (message: string) => void;
}>;

type Source = CapturedViewRequest<TextEditor["tab"]>;
type Review = Observable<RenameSnapshot> & {
    cancel(): void;
    submit(name: string, review: boolean): Promise<boolean>;
};
const nameLimit = 256;

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

export function mountRenamePopup(editor: TextEditor, owner: LspDocumentOwner, review: Review,
    capture: () => Source | undefined, signal: AbortSignal, options: RenamePopupOptions) {
    const { element, commands } = editor;
    const doc = element.ownerDocument;
    const win = doc.defaultView!;
    const listen = listenUntil(signal);
    const { panel, text, node, button, status, pages, list, showEdits } =
        reviewPanel(editor, signal, "st-rename", "Rename symbol", options.text);
    panel.setAttribute("role", "dialog");
    const label = node("label");
    const name = node("input");
    panel.onfocus = () => name.focus({ preventScroll: true });
    name.maxLength = nameLimit;
    label.append(text("New name"), name);
    status.setAttribute("aria-label", text("Rename status"));
    const controls = node("div");
    list.tabIndex = 0;
    list.setAttribute("aria-label", text("Rename edits"));
    panel.append(label, status, controls, pages, list);
    panel.hidden = true;
    let source: Source | undefined;
    let checking = false;
    let edited = false;
    let pendingSubmit: "preview" | "apply" | undefined;
    let shown: RenamePreview | null = null;
    const preview = button(controls, "Preview rename", () => { name.focus(); submit("preview"); });
    let apply = button(controls, "Apply rename", () => {});
    button(controls, "Cancel rename", () => close(true));
    const overlay = mountAnchoredOverlay(editor, panel, {
        transient: true,
        onHide(reason, focused) {
            if (reason === "superseded") close(false);
            else if ((reason === "clipped" || reason === "expired") && source) {
                const target = source;
                queueMicrotask(() => { if (source === target) close(focused); });
            }
        },
    });
    onAbort(signal, overlay.dispose);
    function hide(focus: boolean) {
        if (!source) return;
        const previous = source;
        source = undefined;
        checking = false;
        overlay.hide();
        previous.cancel();
        if (focus && !signal.aborted && element.isConnected) editor.focus();
    }
    function close(focus: boolean) {
        hide(focus);
        review.cancel();
    }
    function accept(result: RenamePreview | null) {
        const target = source;
        if (result?.canApply && result.apply().status === "done" && source === target) {
            hide(panel.matches(":focus-within") || doc.activeElement === doc.body);
        }
    }
    function render() {
        const state = review.getSnapshot();
        const result = state.preview;
        preview.disabled = checking || state.status === "pending" || !name.value.trim();
        const hint = options.review ? "Enter to preview." : "Enter to rename. Ctrl/Cmd+Enter to preview.";
        status.textContent = text(checking ? "Checking rename target…" : state.message || hint);
        if (shown !== result) {
            shown = result;
            apply = button(controls, "Apply rename", () => accept(result), apply);
            const total = showEdits(result);
            if (result?.canApply) status.textContent = text(`Review ${total} ${total === 1 ? "change" : "changes"}.`);
        }
        apply.disabled = !result?.canApply;
    }
    function submit(mode: "preview" | "apply") {
        const target = source;
        if (!target?.isCurrent() || name.readOnly || !name.value.trim() || review.getSnapshot().status === "pending") return;
        if (checking) { pendingSubmit = mode; return; }
        void review.submit(name.value, mode === "preview").then(applied => {
            if (mode === "apply" && applied && source === target) hide(panel.matches(":focus-within"));
        });
    }
    function open() {
        close(false);
        options.beforeOpen?.();
        const target = capture();
        if (!target) return false;
        source = target;
        const caret = target.selectionSet.ranges[target.selectionSet.primary]!;
        const offset = caret.head;
        revealSelectionHead(editor);
        name.readOnly = false;
        name.value = identifierAt(target.document.buffer, offset, nameLimit) ?? "";
        edited = false;
        pendingSubmit = undefined;
        checking = owner.provider.queryFeatureOptions(renameMethod, target.document).some(o => o.prepareProvider === true);
        render();
        name.setSelectionRange(0, name.value.length);
        overlay.show({ revision: target.document.revision, offset, affinity: caret.headAffinity ?? "after" }, name);
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
                    if (isFocused(name)) name.select();
                }
                render();
                if (pendingSubmit) submit(pendingSubmit);
            }, () => reject("The language provider could not prepare a rename here."));
        }
        return true;
    }
    listen(name, "input", () => {
        edited = true;
        pendingSubmit = undefined;
        review.cancel();
    });
    listen(panel, "keydown", event => {
        if (event.target === name || event.key === "Escape") editor.keymap.handle(event);
    });
    listen(panel, "focusout", event => {
        if (checking && !panel.contains(event.relatedTarget as Node | null)) close(false);
    });
    listen(win, "blur", () => { if (checking) close(false); });
    editor.onEditIntent(() => { if (source) close(false); }, signal);
    onAbort(signal, () => hide(false));
    onAbort(signal, review.subscribe(render));
    function bind(id: string, label: string, key: string, enabled: () => boolean, run: (arg: unknown) => boolean | void, priority: number) {
        onAbort(signal, commands.register({ id, label: text(label), owner: "editor", category: "Rename", enabled, run },
            { keys: [key], priority, shared: true, repeat: false }).dispose);
    }
    bind("rename.start", "Rename symbol", "F2", () => editor.getSnapshot().readOnlyReason === null, open, builtinKeyPriority.open);
    bind("rename.dismiss", "Dismiss rename", "Escape", () => !!source, arg => close(arg !== false), builtinKeyPriority.renameDismiss);
    bind("rename.submit", "Rename symbol", "Enter", () => isFocused(name), () => {
        if (shown) accept(shown);
        else submit(options.review ? "preview" : "apply");
    }, builtinKeyPriority.renameSubmit);
    bind("rename.preview", "Preview rename", "Mod+Enter", () => isFocused(name),
        () => submit("preview"), builtinKeyPriority.renameSubmit);
    return () => hide(false);
}
