import type { LspColor, LspDocumentColor } from "../protocol/lsp-features.ts";
import { mountAnchoredOverlay } from "./anchored-overlay.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import type { DocumentColorChoice, DocumentColorController } from "./document-color-controller.ts";
import { listenUntil, onAbort } from "./listen.ts";
import { reviewPanel } from "./review-controls.ts";
import type { TextEditor } from "./text-editor.ts";

type Capture = CapturedViewRequest<TextEditor["tab"]>;
export type ColorPickerOptions = Readonly<{ text?: (label: string) => string }>;

const channels = ["red", "green", "blue"] as const;
const hex = (color: LspColor) => "#" + channels
    .map(key => Math.round(color[key] * 255).toString(16).padStart(2, "0")).join("");

/** Review formats against the swatch that opened the picker, even when the caret is elsewhere. */
export function mountColorPicker(editor: TextEditor, colors: DocumentColorController, capture: () => Capture | undefined,
    signal: AbortSignal, options: ColorPickerOptions) {
    const { panel, status: message, list, pages, showEdits, node, button, text } =
        reviewPanel(editor, signal, "st-color-picker", "Color picker", options.text);
    panel.setAttribute("role", "dialog");
    const fields = node("div");
    const rgb = node("input");
    rgb.type = "color";
    const alpha = node("input");
    alpha.type = "number";
    alpha.min = "0";
    alpha.max = "100";
    alpha.step = "any";
    const format = node("select");
    for (const [label, field] of [["Color", rgb], ["Opacity (%)", alpha], ["Format", format]] as const) {
        const wrap = node("label");
        wrap.append(text(label), field);
        fields.append(wrap);
    }
    const footer = node("footer");
    let apply = button(footer, "Apply color", () => {});
    button(footer, "Cancel", () => close(true));
    panel.append(fields, message, list, pages, footer);
    const overlay = mountAnchoredOverlay(editor, panel, {
        dismissOn: ["focus-leave", "outside-pointerdown"],
        onHide(reason, focused) {
            if (reason === "hide" || reason === "disposed") return;
            const previous = source;
            queueMicrotask(() => {
                if (source === previous) close(focused && (reason === "clipped" || reason === "expired"));
            });
        },
    });
    onAbort(signal, overlay.dispose);
    const win = editor.element.ownerDocument.defaultView!;
    let timer: number | undefined;
    let source: Capture | undefined;
    let choice: DocumentColorChoice | undefined;
    let proposed: LspColor;
    function close(focus = false) {
        if (!source) return;
        const previous = source;
        source = undefined;
        choice = undefined;
        win.clearTimeout(timer);
        overlay.hide();
        previous.cancel();
        if (!signal.aborted) colors.cancel();
        if (focus && !signal.aborted) editor.focus();
    }
    onAbort(signal, () => close());
    function review() {
        const state = colors.getSnapshot();
        state.presentations[format.selectedIndex]?.select({ review: true });
    }
    function render() {
        if (!source) return;
        const state = colors.getSnapshot();
        const selection = state.review;
        if (state.status !== "review") format.replaceChildren();
        if (state.status === "presentations") {
            for (const item of state.presentations) {
                const option = node("option");
                option.textContent = item.label;
                format.append(option);
            }
        }
        format.disabled = !format.length;
        apply = button(footer, "Apply color", () => {
            if (selection?.apply().status === "done") close(true);
        }, apply);
        apply.disabled = !selection?.canApply;
        showEdits(selection);
        message.textContent = text(state.status === "failed" ? state.message
            : state.status === "discovering" || state.status === "previewing" ? "Getting color formats…"
            : state.status === "presentations" && !format.length ? "No formats for this color."
            : selection && !selection.canApply ? "This file is read-only." : "");
        if (state.status === "expired" || state.status === "idle" || state.status === "applied") {
            const previous = source;
            queueMicrotask(() => {
                if (source === previous) close(panel.matches(":focus-within"));
            });
        }
    }
    async function update() {
        win.clearTimeout(timer);
        const item = choice;
        if (!item || !source?.isCurrent()) return;
        if (!Number.isFinite(proposed.alpha) || !alpha.validity.valid) return;
        const reply = await item.presentations(proposed);
        if (reply.status === "done" && source?.isCurrent() && colors.getSnapshot().presentations === reply.value) review();
    }
    async function open(mark: LspDocumentColor) {
        close();
        const target = capture();
        if (!target) return;
        source = target;
        proposed = mark.color;
        rgb.value = hex(proposed);
        alpha.value = String(proposed.alpha * 100);
        overlay.show({ revision: target.document.revision, offset: mark.from });
        onAbort(target.signal, () => queueMicrotask(() => {
            if (source === target) close(panel.matches(":focus-within"));
        }));
        const reply = await colors.request();
        if (source !== target || !target.isCurrent() || reply.status !== "done") return;
        choice = reply.value.find(item => item.from === mark.from && item.to === mark.to
            && item.color.alpha === mark.color.alpha && channels.every(key => item.color[key] === mark.color[key]));
        if (choice) await update();
        else close(panel.matches(":focus-within"));
    }
    const listen = listenUntil(signal);
    listen(panel, "toggle", () => {
        if (source && panel.matches(":popover-open")) rgb.focus({ preventScroll: true });
    });
    listen(panel, "keydown", event => {
        if (event.key === "Escape") {
            event.preventDefault();
            close(true);
        }
    });
    listen(fields, "input", event => {
        if (!source || event.target === format) return;
        if (event.target === alpha) proposed = { ...proposed, alpha: alpha.valueAsNumber / 100 };
        else {
            const value = parseInt(rgb.value.slice(1), 16);
            proposed = { red: (value >> 16) / 255, green: (value >> 8 & 255) / 255,
                blue: (value & 255) / 255, alpha: proposed.alpha };
        }
        win.clearTimeout(timer);
        colors.dismissPreview();
        if (Number.isFinite(proposed.alpha) && alpha.validity.valid) timer = win.setTimeout(update, 120);
        else message.textContent = text("Enter an opacity between 0 and 100.");
    });
    listen(format, "change", review);
    onAbort(signal, colors.subscribe(render));
    return { open, close };
}
