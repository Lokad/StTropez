import { transientSurface } from "./transient-surface.ts";
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
    alpha.required = true;
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
            closeLater(source, focused && (reason === "clipped" || reason === "expired"));
        },
    });
    onAbort(signal, overlay.dispose);
    const win = editor.element.ownerDocument.defaultView!;
    let timer: number | undefined;
    let source: Capture | undefined;
    let choice: DocumentColorChoice | undefined;
    let proposed: LspColor;
    function closeLater(target: Capture | undefined, focus?: boolean) {
        queueMicrotask(() => {
            if (source === target) close(focus ?? panel.matches(":focus-within"));
        });
    }
    const surface = transientSurface(editor, () => close());
    function close(focus = false) {
        if (!source) return;
        const previous = source;
        surface.release();
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
        const { status, message: detail, presentations, review: selection } = colors.getSnapshot();
        if (status !== "review") format.replaceChildren();
        if (status === "presentations") {
            for (const item of presentations) {
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
        message.textContent = text(status === "failed" ? detail
            : status === "discovering" || status === "previewing" ? "Getting color formats…"
            : status === "presentations" && !format.length ? "No formats for this color."
            : selection && !selection.canApply ? "This file is read-only." : "");
        if (status === "expired" || status === "idle" || status === "applied") {
            closeLater(source);
        }
    }
    async function update() {
        win.clearTimeout(timer);
        const item = choice;
        if (!item || !source?.isCurrent() || !alpha.validity.valid) return;
        const reply = await item.presentations(proposed);
        if (reply.status === "done" && source?.isCurrent() && colors.getSnapshot().presentations === reply.value) review();
    }
    function open(mark: LspDocumentColor | DocumentColorChoice) {
        // Closing an open picker cancels its discovery, including any choices it returned.
        const discovered = !source && "presentations" in mark ? mark : undefined;
        close();
        const target = capture();
        if (!target) return false;
        if (!surface.claim()) { target.cancel(); return false; }
        source = target;
        proposed = mark.color;
        rgb.value = hex(proposed);
        alpha.value = String(proposed.alpha * 100);
        overlay.show({ revision: target.document.revision, offset: mark.from }, rgb);
        onAbort(target.signal, () => closeLater(target));
        if (discovered) {
            choice = discovered;
            void update();
        } else {
            void colors.request().then(reply => {
                if (source !== target || !target.isCurrent() || reply.status !== "done") return;
                choice = reply.value.find(item => item.from === mark.from && item.to === mark.to
                    && item.color.alpha === mark.color.alpha && channels.every(key => item.color[key] === mark.color[key]));
                if (choice) void update();
                else close(panel.matches(":focus-within"));
            });
        }
        return true;
    }
    const listen = listenUntil(signal);
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
        if (alpha.validity.valid) timer = win.setTimeout(update, 120);
        else message.textContent = text("Enter an opacity between 0 and 100.");
    });
    listen(format, "change", review);
    onAbort(signal, colors.subscribe(render));
    return { open, close };
}
