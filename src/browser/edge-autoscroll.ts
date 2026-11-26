import type { clientBox } from "./dom-coordinates.ts";

type Velocity = Readonly<{ x: number; y: number }>;
type Host = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;
type Viewport = Readonly<{ getSnapshot: () => Readonly<{ scrollLeft: number; scrollTop: number }>;
    scrollTo: (position: Readonly<{ left: number; top: number }>) => void; flush: () => void }>;

/** Client-space edges and pointer coordinates produce local CSS-unit velocities. */
export function edgeVelocity(point: Velocity, box: ReturnType<typeof clientBox>, units: Readonly<{ columnWidth: number; lineHeight: number }>,
    activation: "outside" | "inside"): Velocity {
    const speed = (point: number, low: number, high: number, unit: number) => {
        const zone = activation === "inside" ? Math.min(24, (high - low) / 4) : 0;
        const distance = point < low + zone ? point - low - zone : point >= high - zone ? point - high + (activation === "inside" ? zone : 1) : 0;
        return Math.sign(distance) * Math.min((high - low) / box.zoom * 3, Math.max(unit * 5, Math.abs(distance) / box.zoom * 20));
    };
    return { x: speed(point.x, box.left, box.right, units.columnWidth), y: speed(point.y, box.top, box.bottom, units.lineHeight) };
}

/** Owns one frame chain; gesture captures, pointer/data-store authority and presentation stay with callers. */
export function createEdgeAutoscroll<C>(host: Host, viewport: Viewport, options: Readonly<{
    capture: () => C | undefined; valid: (capture: C) => boolean; velocity: (capture: C) => Velocity;
    update: (capture: C) => void; cancel: (capture: C) => void;
    updateAtRest?: boolean; recheckAfterUpdate?: boolean;
}>) {
    let frame: number | undefined, previousTime: number | undefined, generation = 0;
    const stop = () => { generation++; if (frame !== undefined) host.cancelAnimationFrame(frame); frame = undefined; previousTime = undefined; };
    const valid = (capture: C, epoch: number) => {
        if (generation !== epoch || options.capture() !== capture) return false;
        if (options.valid(capture)) return true;
        stop(); options.cancel(capture); return false;
    };
    const schedule = () => {
        const capture = options.capture();
        if (capture === undefined) { stop(); return; }
        const speed = options.velocity(capture);
        if (!speed.x && !speed.y) { stop(); return; }
        request();
    };
    function request(): void {
        if (frame !== undefined) return;
        const epoch = generation;
        frame = host.requestAnimationFrame(time => {
            if (generation !== epoch) return;
            frame = undefined;
            const capture = options.capture(); if (capture === undefined) { stop(); return; }
            if (!valid(capture, epoch)) return;
            const speed = options.velocity(capture);
            if (!speed.x && !speed.y && !options.updateAtRest) { previousTime = undefined; return; }
            const elapsed = previousTime === undefined ? 1000 / 60 : Math.max(0, Math.min(32, time - previousTime)); previousTime = time;
            if (elapsed === 0) { request(); return; }
            const before = viewport.getSnapshot();
            viewport.scrollTo({ left: before.scrollLeft + speed.x * elapsed / 1000, top: before.scrollTop + speed.y * elapsed / 1000 }); viewport.flush();
            if (!valid(capture, epoch)) return;
            options.update(capture);
            // A callback may already have scheduled a replacement gesture. Its frame owns continuation.
            if (generation !== epoch || frame !== undefined) return;
            if (options.capture() === undefined) return;
            const after = viewport.getSnapshot();
            if (after.scrollLeft !== before.scrollLeft || after.scrollTop !== before.scrollTop) {
                // Selection avoids a geometry read after selection writes; drop placement rechecks its edge.
                if (options.recheckAfterUpdate) schedule(); else request();
            }
            else previousTime = undefined;
        });
    }
    return Object.freeze({ schedule, stop, pending: () => frame !== undefined });
}
