import type { ComparisonRowIndex } from "../core/comparison-rows.ts";
import type { FoldIndex } from "../core/folding.ts";
import type { TextBuffer } from "../core/text-buffer.ts";

type Projection = FoldIndex | ComparisonRowIndex;

/** Sample bounded source prefixes in the same visual-row space as the scrollport. */
function draw(canvas: HTMLCanvasElement, buffer: TextBuffer, index: Projection, width: number, height: number,
    scale: number, lineHeight: number, padding: number, color: string): void {
    canvas.width = width; canvas.height = height;
    const ink = canvas.getContext("2d");
    if (!ink || !width || !height) return;
    ink.fillStyle = color;
    const count = Math.min(index.visibleLineCount, Math.ceil(height / 2), 320);
    const stride = index.visibleLineCount / count, column = (width - 4) / 80;
    const thickness = Math.max(1, Math.min(3, stride * lineHeight * scale * .75));
    for (let sample = 0; sample < count; sample++) {
        const row = Math.floor((sample + .5) * stride);
        if ("gapAt" in index && index.gapAt(row)) continue;
        const line = index.lineAt(row), start = buffer.offsetAt(line);
        const end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
        const prefix = buffer.slice(start, Math.min(end, start + 80));
        const y = Math.floor((padding + row * lineHeight) * scale);
        let x = 0, run = 0;
        for (const char of prefix) {
            if (/\s/u.test(char)) {
                if (x > run) ink.fillRect(2 + run * column, y, (x - run) * column, thickness);
                x += char === "\t" ? 4 - x % 4 : 1;
                run = x;
            } else x++;
            if (x >= 80) break;
        }
        if (x > run) ink.fillRect(2 + run * column, y, (x - run) * column, thickness);
    }
}

export function mountMinimap(root: HTMLElement, scroll: (top: number) => void) {
    const owner = root.ownerDocument, anchor = owner.createElement("div"), track = owner.createElement("div");
    const canvas = owner.createElement("canvas"), marker = owner.createElement("div");
    anchor.className = "st-minimap-anchor"; track.className = "st-minimap";
    marker.className = "st-minimap-marker"; anchor.setAttribute("aria-hidden", "true");
    track.append(canvas, marker); anchor.append(track); root.prepend(anchor);
    const listeners = new AbortController(), options = { signal: listeners.signal };
    let previous: readonly unknown[] | undefined;
    let maximum = 0, travel = 0, markerTop = 0, markerHeight = 0;
    let drag: { id: number; fraction: number } | undefined;
    const localY = (clientY: number) => {
        const rect = track.getBoundingClientRect();
        return (clientY - rect.top) * (travel + markerHeight) / (rect.height || 1);
    };
    const move = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id || travel <= 0) return;
        const y = localY(event.clientY) - drag.fraction * markerHeight;
        scroll(maximum * Math.min(1, Math.max(0, y / travel)));
    };
    track.addEventListener("pointerdown", event => {
        event.stopPropagation();
        if (event.button !== 0 || !event.isPrimary || drag) return;
        event.preventDefault();
        if (!travel) return;
        const y = localY(event.clientY);
        const grabbed = y >= markerTop && y <= markerTop + markerHeight;
        drag = { id: event.pointerId, fraction: grabbed ? (y - markerTop) / markerHeight : .5 };
        track.setPointerCapture(event.pointerId);
        if (!grabbed) move(event);
    }, options);
    track.addEventListener("pointermove", move, options);
    const end = (event: PointerEvent) => {
        if (drag?.id !== event.pointerId) return;
        if (event.type === "pointerup") move(event);
        drag = undefined;
        if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) track.addEventListener(type, end, options);
    track.addEventListener("dblclick", event => { event.preventDefault(); event.stopPropagation(); }, options);
    return {
        paint(buffer: TextBuffer, index: Projection, width: number, height: number, top: number, extent: number, lineHeight: number, padding: number, color: string) {
            const key = [buffer, index, width, height, extent, lineHeight, color];
            if (!previous || key.some((value, i) => value !== previous![i])) {
                previous = key;
                track.style.width = width + "px"; track.style.height = height + "px";
                draw(canvas, buffer, index, width, height, height / Math.max(1, extent, height), lineHeight, padding, color);
            }
            maximum = Math.max(0, extent - height);
            markerHeight = maximum ? Math.min(height, Math.max(12, height * height / extent)) : height;
            travel = height - markerHeight; markerTop = maximum ? travel * top / maximum : 0;
            marker.style.height = markerHeight + "px"; marker.style.transform = `translateY(${markerTop}px)`;
        },
        dispose() { listeners.abort(); drag = undefined; previous = undefined; anchor.remove(); }
    };
}
