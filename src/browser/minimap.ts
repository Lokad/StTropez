import type { ComparisonRowIndex } from "../core/comparison-rows.ts";
import type { FoldIndex } from "../core/folding.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import { applyDecorationProperties, decorationParts } from "./decoration-parts.ts";
import type { InlineDecoration, LineClass, LineDecorator, PresentedLine } from "./viewport.ts";

type Overview = Readonly<{ document: DocumentSnapshot; index: FoldIndex | ComparisonRowIndex;
    width: number; height: number; scale: number; lineHeight: number; padding: number; pixelRatio: number; tabSize: number; color: string }>;
const rowPitch = 4, cellWidth = 1.35, inset = 4;

function excerpt(view: Overview, row: number): PresentedLine | undefined {
    if ("gapAt" in view.index && view.index.gapAt(row)) return;
    const line = view.index.lineAt(row), { buffer } = view.document, from = buffer.offsetAt(line);
    const end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
    const text = buffer.slice(from, Math.min(end, from + 100)).replace(/[\r\n]+$/, "");
    return { documentId: view.document.id, revision: view.document.revision, line, lineStart: from, from, to: from + text.length, text };
}

/** Paint actual glyphs into a back buffer. Publish whole images so an edit never blanks the strip. */
function paintThumbnail(canvas: HTMLCanvasElement, probe: HTMLElement, view: Overview, decorate?: LineDecorator, lineClass?: LineClass) {
    const owner = canvas.ownerDocument, win = owner.defaultView!, image = owner.createElement("canvas");
    image.width = Math.ceil(view.width * view.pixelRatio); image.height = Math.ceil(view.height * view.pixelRatio);
    const ink = image.getContext("2d"), output = canvas.getContext("2d");
    if (!ink || !output) return;
    const count = Math.min(view.index.visibleLineCount, Math.ceil(view.height / 2), 384);
    const stride = view.index.visibleLineCount / count;
    const pitch = Math.min(rowPitch, stride * view.lineHeight * view.scale);
    ink.font = "600 10px monospace"; ink.textBaseline = "alphabetic";
    const advance = ink.measureText("M").width, sx = cellWidth / advance, sy = pitch / 11;
    ink.setTransform(view.pixelRatio * sx, 0, 0, view.pixelRatio * sy, 0, 0);
    const palette = new Map<string, { color: string; background: string }>();
    function style(name: string, properties?: InlineDecoration["properties"]) {
        const key = properties ? JSON.stringify([name, properties]) : name;
        let result = palette.get(key);
        if (!result) {
            probe.className = name;
            if (properties) applyDecorationProperties(probe, properties);
            const css = win.getComputedStyle(probe);
            result = { color: css.color, background: css.backgroundColor };
            probe.removeAttribute("class"); if (properties) probe.removeAttribute("style"); palette.set(key, result);
        }
        return result;
    }
    let sample = 0, frame: number | undefined;
    const batch = () => {
        const deadline = win.performance.now() + 3;
        do {
            const row = Math.min(view.index.visibleLineCount - 1, Math.floor((sample + .5) * stride));
            const y = (view.padding + sample * stride * view.lineHeight) * view.scale / sy;
            sample++;
            const line = excerpt(view, row); if (!line) continue;
            const label = lineClass?.(line);
            if (label) {
                ink.fillStyle = style(label).background; ink.fillRect(0, y, view.width / sx, pitch / sy);
            }
            const parts = decorationParts(line.text, line.from, line.to, view.document.buffer.length, decorate?.(line), []);
            let column = 0;
            for (const part of parts) {
                if (part.ornament) continue;
                ink.fillStyle = part.className ? style(part.className, part.properties).color : view.color;
                const runs = part.text.split("\t");
                for (let i = 0; i < runs.length; i++) {
                    if (i) column += view.tabSize - column % view.tabSize;
                    const run = runs[i]!;
                    if (run) ink.fillText(run, inset / sx + column * advance, y + 8.5);
                    column += run.length;
                }
            }
        } while (sample < count && win.performance.now() < deadline);
        if (sample < count) { frame = win.requestAnimationFrame(batch); return; }
        canvas.width = image.width; canvas.height = image.height;
        output.drawImage(image, 0, 0);
        frame = undefined;
    };
    frame = win.requestAnimationFrame(batch);
    return () => { if (frame !== undefined) win.cancelAnimationFrame(frame); };
}

export function mountMinimap(root: HTMLElement, scroll: (top: number) => void, decorate?: LineDecorator, lineClass?: LineClass) {
    const owner = root.ownerDocument, anchor = owner.createElement("div"), track = owner.createElement("div");
    const canvas = owner.createElement("canvas"), marker = owner.createElement("div"), palette = owner.createElement("div");
    canvas.width = canvas.height = 0;
    const probe = owner.createElement("span"), preview = owner.createElement("div");
    anchor.className = "st-minimap-anchor"; track.className = "st-minimap"; palette.hidden = true; palette.append(probe);
    preview.className = "st-minimap-preview"; preview.hidden = true;
    marker.className = "st-minimap-marker"; anchor.setAttribute("aria-hidden", "true");
    track.append(canvas, marker); anchor.append(track, palette, preview); root.prepend(anchor);
    const listeners = new AbortController(), options = { signal: listeners.signal };
    let view: Overview | undefined, previous: readonly unknown[] | undefined, cancel: (() => void) | undefined;
    let maximum = 0, travel = 0, markerTop = 0, markerHeight = 0, paneHeight = 0, scrollTop = 0;
    let drag: { id: number; pointer: number; scrollFraction: number } | undefined;
    let previewRow = -1, pointerY: number | undefined;
    const hidePreview = () => {
        pointerY = undefined; previewRow = -1;
        if (!preview.hidden) { preview.hidden = true; preview.replaceChildren(); }
    };
    const localY = (event: PointerEvent) => {
        const rect = track.getBoundingClientRect();
        return (event.clientY - rect.top) * (travel + markerHeight) / (rect.height || 1);
    };
    const targetTop = (y: number) => Math.max(0, Math.min(maximum, y / view!.scale - paneHeight / 2));
    function hover(y: number) {
        if (!view || !maximum) return;
        pointerY = y;
        const row = Math.min(view.index.visibleLineCount - 1, Math.max(0, Math.floor((y / view.scale - view.padding) / view.lineHeight)));
        if (row === previewRow) return;
        previewRow = row;
        const line = excerpt(view, row);
        const title = owner.createElement("strong"); title.textContent = line ? "Line " + (line.line + 1).toLocaleString() : "Alignment gap";
        const lines: HTMLElement[] = [title];
        for (let i = Math.max(0, row - 1); i <= Math.min(view.index.visibleLineCount - 1, row + 1); i++) {
            const code = owner.createElement("span"); code.textContent = (i === row ? line : excerpt(view, i))?.text || " ";
            if (i === row) code.className = "st-minimap-preview-line";
            lines.push(code);
        }
        preview.replaceChildren(...lines); preview.hidden = false;
        preview.style.top = Math.max(0, Math.min(paneHeight - preview.offsetHeight, y - preview.offsetHeight / 2)) + "px";
    }
    const move = (event: PointerEvent) => {
        if (!travel) return;
        const y = localY(event);
        if (!drag) { if (event.pointerType === "mouse" && !event.buttons) hover(y); return; }
        if (event.pointerId !== drag.id) return;
        scroll(maximum * Math.min(1, Math.max(0, drag.scrollFraction + (y - drag.pointer) / travel)));
    };
    track.addEventListener("pointerdown", event => {
        event.stopPropagation();
        if (event.button !== 0 || !event.isPrimary || drag) return;
        event.preventDefault(); hidePreview();
        if (!travel) return;
        const y = localY(event), grabbed = y >= markerTop && y <= markerTop + markerHeight;
        const destination = grabbed ? scrollTop : targetTop(y);
        drag = { id: event.pointerId, pointer: y, scrollFraction: destination / maximum };
        track.setPointerCapture(event.pointerId);
        if (!grabbed) scroll(destination);
    }, options);
    track.addEventListener("pointermove", move, options);
    track.addEventListener("pointerleave", hidePreview, options);
    root.addEventListener("keydown", hidePreview, options);
    const end = (event: PointerEvent) => {
        if (drag?.id !== event.pointerId) return;
        if (event.type === "pointerup") move(event);
        drag = undefined;
        if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) track.addEventListener(type, end, options);
    track.addEventListener("dblclick", event => { event.preventDefault(); event.stopPropagation(); }, options);
    return {
        paint(document: DocumentSnapshot, index: Overview["index"], width: number, height: number, top: number, extent: number,
            lineHeight: number, padding: number, color: string, tabSize: number, pixelRatio: number, epoch: number) {
            const mapHeight = Math.min(height, Math.max(1, Math.ceil(extent * rowPitch / lineHeight)));
            const key = [document.buffer, index, width, mapHeight, extent, lineHeight, color, tabSize, pixelRatio, epoch, document.revision];
            if (!previous || key.some((value, i) => value !== previous![i])) {
                cancel?.(); previous = key;
                const refreshPreview = view?.document.buffer !== document.buffer || view.index !== index || view.scale !== mapHeight / extent;
                view = { document, index, width, height: mapHeight, scale: mapHeight / extent, lineHeight, padding, color, tabSize, pixelRatio };
                track.style.width = width + "px"; track.style.height = mapHeight + "px";
                preview.style.right = (width + 4) + "px";
                preview.style.maxWidth = Math.max(0, root.clientWidth - width - 8) + "px";
                if (width && mapHeight) cancel = paintThumbnail(canvas, probe, view, decorate, lineClass);
                if (refreshPreview && pointerY !== undefined) previewRow = -1;
            }
            maximum = Math.max(0, extent - height); paneHeight = height; scrollTop = top;
            markerHeight = maximum ? Math.min(mapHeight, Math.max(18, mapHeight * height / extent)) : mapHeight;
            travel = mapHeight - markerHeight; markerTop = maximum ? travel * top / maximum : 0;
            if (pointerY !== undefined) {
                if (travel && pointerY <= mapHeight) hover(pointerY);
                else hidePreview();
            }
            track.classList.toggle("st-minimap-scrollable", travel > 0);
            marker.style.height = markerHeight + "px"; marker.style.transform = `translateY(${markerTop}px)`;
        },
        dispose() { cancel?.(); listeners.abort(); drag = undefined; view = undefined; previous = undefined; anchor.remove(); }
    };
}
