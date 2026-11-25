import type { CodeActionChoice, CodeActionController, CodeActionPreview } from "./code-action-controller.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { mountAnchoredOverlay } from "./anchored-overlay.ts";
import { listenUntil, onAbort } from "./listen.ts";
import { editPreview, reviewElements } from "./review-controls.ts";
import type { TextEditor } from "./text-editor.ts";

export type CodeActionPopupOptions = Readonly<{
    text?: (label: string) => string;
    beforeOpen?: () => boolean | void;
    quickApply?: (choice: CodeActionChoice, preview: CodeActionPreview) => boolean;
}>;

const pageSize = 16;

export function mountCodeActionPopup(editor: TextEditor, owner: LspDocumentOwner, actions: CodeActionController,
    signal: AbortSignal, options: CodeActionPopupOptions) {
    const text = options.text ?? (label => label);
    const ui = reviewElements(editor.element.ownerDocument, text);
    const { node, button } = ui;
    const panel = node("section"), body = node("div"), footer = node("footer");
    const status = node("p"), choices = node("div"), count = node("small"), pages = node("div");
    const edits = node("ol"), editPages = node("div");
    panel.className = "st-code-actions";
    panel.setAttribute("aria-label", text("Quick fixes"));
    status.setAttribute("aria-label", text("Quick-fix status"));
    edits.setAttribute("aria-label", text("Quick-fix edits"));
    body.append(status, choices, count, pages, edits, editPages);
    panel.append(body, footer);
    const showEdits = editPreview(editor, ui, edits, editPages);
    let apply = button(footer, "Apply fix", () => {});
    button(footer, "Cancel fix", close);
    onAbort(signal, () => panel.remove());
    const overlay = mountAnchoredOverlay(editor, panel, {
        onHide(reason, focused) {
            if (focused && (reason === "expired" || reason === "clipped")) editor.focus();
        },
    });
    onAbort(signal, overlay.dispose);
    let open = false, command = false, start = 0;
    let shown: CodeActionPreview | null = null;
    let list: readonly CodeActionChoice[] | undefined;
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
        if (result.status === "done" && result.value.canApply && !result.value.command
            && options.quickApply?.(choice, result.value)) await result.value.apply();
    }
    function page(items: readonly CodeActionChoice[], offset: number) {
        start = offset;
        choices.replaceChildren();
        for (const choice of items.slice(start, start + pageSize)) {
            const control = node("button");
            control.type = "button";
            control.textContent = choice.title;
            control.disabled = choice.disabled !== null;
            control.title = choice.disabled ?? "";
            control.dataset.choice = String(choice.index);
            control.onclick = () => void pick(choice);
            choices.append(control);
        }
        count.textContent = items.length <= pageSize ? "" : `${start + 1}–${Math.min(start + pageSize, items.length)} of ${items.length}`;
        ui.paging(pages, "fixes", start, items.length, pageSize, next => {
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
        const state = actions.getSnapshot(), preview = state.preview;
        if (state.status === "idle" || state.status === "expired" || state.status === "applied" && !command) {
            open = false;
            const focused = panel.matches(":focus-within");
            overlay.hide();
            if (focused) editor.focus();
        }
        if (state.status === "ready") command = !!preview?.command;
        status.textContent = text(state.status === "ready" && !state.choices.length ? "No quick fix at this position." : state.message);
        if (list !== state.choices) {
            list = state.choices;
            page(list, 0);
        }
        if (shown !== preview) {
            shown = preview;
            const control = button(footer, preview?.command ? "Run action" : "Apply fix", () => preview?.apply());
            apply.replaceWith(control);
            apply = control;
            showEdits(preview);
            if (state.choice !== null && (state.choice < start || state.choice >= start + pageSize)) {
                page(list, Math.floor(state.choice / pageSize) * pageSize);
            }
        }
        markChoice();
        apply.disabled = !preview?.canApply || !!preview.command && !owner.provider.getSnapshot().commandAvailable;
    }
    function selectFirst(items: readonly CodeActionChoice[]) {
        if (!open || items !== actions.getSnapshot().choices || actions.getSnapshot().choice !== null) return;
        const first = items.find(item => item.disabled === null);
        if (first && !first.needsResolve) void first.select({ review: true });
    }
    function show(items: unknown) {
        const state = actions.getSnapshot();
        if (items !== undefined && (state.status !== "ready" || items !== state.choices)) return false;
        if (options.beforeOpen?.() === false || items !== undefined && actions.getSnapshot() !== state) return false;
        editor.focus();
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
        return false;
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
        onAbort(signal, editor.commands.register({ id, label: text(label), category: text("Code actions"), owner: "editor", enabled, run },
            { keys: [key], priority: opening ? 9 : 35, shared: key !== "Enter" }).dispose);
    }
    bind("quickfix.show", "Show quick fixes", "Mod+.", show, true);
    bind("quickfix.dismiss", "Dismiss quick fixes", "Escape", close);
    bind("quickfix.previous", "Previous quick fix", "ArrowUp", () => move(-1));
    bind("quickfix.next", "Next quick fix", "ArrowDown", () => move(1));
    bind("quickfix.apply", "Apply selected fix", "Enter", () => {
        const state = actions.getSnapshot();
        if (state.preview && !apply.disabled) {
            void state.preview.apply();
            return true;
        }
        if (!["pending", "resolving", "executing"].includes(state.status)) actions.cancel();
        return false;
    });
}
