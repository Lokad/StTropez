import { invalidRange } from "../core/bounds.ts";
/** Logical text extents can exceed browser scroll limits. The physical range remains bounded. */
export type ScrollAxis = Readonly<{ extent: number; physicalExtent: number; maximum: number; physicalMaximum: number;
    toLogical: (physical: number) => number; toPhysical: (logical: number) => number }>;
export function scrollAxis(extent: number, viewport: number, cap = 4_000_000): ScrollAxis {
    if (![extent, viewport, cap].every(Number.isFinite) || extent < 0 || viewport < 0 || cap < 1) invalidRange("scroll extent");
    const physicalExtent = Math.max(viewport, Math.min(extent, Math.max(cap, viewport)));
    const maximum = Math.max(0, extent - viewport), physicalMaximum = Math.max(0, physicalExtent - viewport);
    function project(value: number, from: number, to: number): number {
        if (!from || value <= 0) return 0;
        if (value >= from) return to;
        return from === to ? value : value / from * to;
    }
    return Object.freeze({ extent, physicalExtent, maximum, physicalMaximum,
        toLogical: (physical: number) => project(physical, physicalMaximum, maximum),
        toPhysical: (logical: number) => project(logical, maximum, physicalMaximum) });
}
