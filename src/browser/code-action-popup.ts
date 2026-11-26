import { transientSurface } from "./transient-surface.ts";
import { builtinKeyPriority } from "./command-registry.ts";
import type { CodeActionChoice, CodeActionController, CodeActionPreview } from "./code-action-controller.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { mountAnchoredOverlay } from "./anchored-overlay.ts";
import { revealSelectionHead } from "./input-caret.ts";
import { listenUntil, onAbort } from "./listen.ts";
import { reviewPanel } from "./review-controls.ts";
import type { TextEditor } from "./text-editor.ts";

export type CodeActionPopupOptions = Readonly<{
    beforeOpen?: () => boolean | void;
    quickApply?: (choice: CodeActionChoice, preview: CodeActionPreview) => boolean;
}>;

const pageSize = 16;

export function mountCodeActionPopup(editor: TextEditor, owner: LspDocumentOwner, actions: CodeActionController,
    signal: AbortSignal, options: CodeActionPopupOptions) {
    const { panel, status, list: edits, pages: editPages, showEdits, paging, node, button, text } =
        reviewPanel(editor, signal, "st-code-actions", "Quick fixes");
    const body = node("div"), footer = node("footer");
    const choices = node("div"), count = node("small"), pages = node("div");
    status.setAttribute("aria-label", text("Quick-fix status"));
    edits.setAttribute("aria-label", text("Quick-fix edits"));
    body.append(status, choices, count, pages, edits, editPages);
    panel.append(body, footer);
    let apply = button(footer, "Apply fix", () => {});
    button(footer, "Cancel fix", close);
    const overlay = mountAnchoredOverlay(editor, panel, {
        onHide(reason, focused) {
            if (focused && (reason === "expired" || reason === "clipped")) editor.focus();
        },
    });
    onAbort(signal, overlay.dispose);
    let open = false, command = false, start = 0;
    let shown: CodeActionPreview | null = null;
    let list: readonly CodeActionChoice[] | undefined;
    const surface = transientSurface(editor, () => {
        open = false;
        overlay.hide();
        actions.cancel();
    });
    onAbort(signal, surface.release);
    function close() {
        actions.cancel();
        editor.focus();
    }
    function anchor() {
        const { revision, selection } = editor.view.getSnapshot();
        overlay.show({ revision, offset: selection.head, affinity: selection.headAffinity ?? "after" });
    }
    async function pick(choice: CodeActionChoice) {
        const result = await choice.select({ review: true });
        if (result.status === "done" && result.value.canApply && options.quickApply?.(choice, result.value) !== false) {
            await result.value.apply();
        }
    }
    function page(items: readonly CodeActionChoice[], offset: number) {
        start = offset;
        choices.replaceChildren();
        const visible = items.slice(start, start + pageSize);
        for (const choice of visible) {
            const control = node("button");
            control.type = "button";
            control.textContent = choice.title;
            control.disabled = choice.disabled !== null;
            control.title = choice.disabled ?? "";
            control.dataset.choice = String(choice.index);
            control.onclick = () => void pick(choice);
            choices.append(control);
        }
        count.textContent = items.length <= pageSize ? "" : editor.strings.resultPage(start + 1, start + visible.length, items.length);
        paging(pages, "fixes", start, items.length, pageSize, next => {
            page(items, next);
            markChoice();
        });
    }
    function markChoice() {
        const index = actions.getSnapshot().choice;
        for (const row of choices.querySelectorAll<HTMLButtonElement>("button")) {
            row.dataset.chosen = String(Number(row.dataset.choice) === index);
        }
    }
    function render() {
        if (!open) return;
        const { status: phase, message, preview, choice, choices: items } = actions.getSnapshot();
        if (phase === "idle" || phase === "expired" || phase === "applied" && !command) {
            open = false;
            surface.release();
            const focused = panel.matches(":focus-within");
            overlay.hide();
            if (focused) editor.focus();
        }
        if (phase === "ready") command = !!preview?.command;
        status.textContent = text(message);
        if (list !== items) {
            list = items;
            page(list, 0);
        }
        if (shown !== preview) {
            shown = preview;
            apply = button(footer, preview?.command ? "Run action" : "Apply fix", () => preview?.apply(), apply);
            showEdits(preview);
            if (choice !== null && (choice < start || choice >= start + pageSize)) {
                page(list, Math.floor(choice / pageSize) * pageSize);
            }
        }
        markChoice();
        apply.disabled = !preview?.canApply || !!preview.command && !owner.provider.getSnapshot().commandAvailable;
    }
    function selectFirst(items: readonly CodeActionChoice[]) {
        const state = actions.getSnapshot();
        if (!open || items !== state.choices || state.choice !== null) return;
        const first = items.find(item => item.disabled === null);
        if (first && !first.needsResolve) void first.select({ review: true });
    }
    function show(items: unknown) {
        const state = actions.getSnapshot();
        if (items !== undefined && (state.status !== "ready" || items !== state.choices)) return false;
        if (options.beforeOpen?.() === false || items !== undefined && actions.getSnapshot() !== state) return false;
        if (!surface.claim()) return false;
        editor.focus();
        revealSelectionHead(editor);
        command = false;
        if (items === undefined) {
            // A refresh replaces its capture. Keep the open popover in place during the reset.
            open = false;
            void actions.request().then(reply => {
                if (reply.status === "done") selectFirst(reply.value);
            });
        }
        open = true;
        anchor();
        render();
        if (items !== undefined) selectFirst(state.choices);
        return true;
    }
    function move(direction: number) {
        const state = actions.getSnapshot(), length = state.choices.length;
        const focused = choices.querySelector<HTMLElement>(":focus")?.dataset.choice;
        const index = focused === undefined ? state.choice ?? (direction > 0 ? -1 : 0) : Number(focused);
        for (let n = 1; n <= length; n++) {
            const choice = state.choices[(index + n * direction + length) % length]!;
            if (choice.disabled !== null) continue;
            editor.focus();
            void choice.select({ review: true });
            return true;
        }
        return state.status === "pending" || state.status === "executing";
    }
    const listen = listenUntil(signal);
    listen(panel, "keydown", event => editor.keymap.handle(event));
    listen(panel, "pointerdown", event => {
        const control = (event.target as Element).closest("button");
        if (!control || event.button !== 0) return;
        event.preventDefault();
        if (pages.contains(control) || editPages.contains(control)) control.focus({ preventScroll: true });
    });
    onAbort(signal, actions.subscribe(render));
    onAbort(signal, owner.provider.subscribe(() => { if (shown?.command) render(); }));
    onAbort(signal, editor.view.subscribe(() => { if (open && command) anchor(); }));
    function bind(id: string, label: string, key: string, run: (arg: unknown) => boolean | void, opening = false) {
        const enabled = () => opening || !panel.hidden && (editor.getSnapshot().focused || panel.matches(":focus-within"));
        onAbort(signal, editor.commands.register({ id, label, category: text("Code actions"), owner: "editor", enabled, run },
            { keys: [key], priority: opening ? builtinKeyPriority.open : builtinKeyPriority.quickFix, shared: key !== "Enter", repeat: key !== "Enter" }).dispose);
    }
    bind("quickfix.show", "Show quick fixes", "Mod+.", show, true);
    bind("quickfix.dismiss", "Dismiss quick fixes", "Escape", close);
    bind("quickfix.previous", "Previous quick fix", "ArrowUp", () => move(-1));
    bind("quickfix.next", "Next quick fix", "ArrowDown", () => move(1));
    bind("quickfix.apply", "Apply selected fix", "Enter", () => {
        const state = actions.getSnapshot();
        if (state.preview) {
            if (!apply.disabled) void state.preview.apply();
        } else if (state.status === "ready") {
            const first = state.choices.find(item => item.disabled === null);
            if (first) void pick(first);
        }
    });
}
