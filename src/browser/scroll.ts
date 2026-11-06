/** Logical text extents can exceed browser scroll limits. The physical range remains bounded. */
export type ScrollAxis = Readonly<{ extent: number; physicalExtent: number; maximum: number; physicalMaximum: number;
    toLogical: (physical: number) => number; toPhysical: (logical: number) => number }>;
export function scrollAxis(extent: number, viewport: number, cap = 4_000_000): ScrollAxis {
    if (![extent, viewport, cap].every(Number.isFinite) || extent < 0 || viewport < 0 || cap < 1) throw new RangeError("Invalid scroll extent.");
    const physicalExtent = Math.max(viewport, Math.min(extent, Math.max(cap, viewport)));
    const maximum = Math.max(0, extent - viewport), physicalMaximum = Math.max(0, physicalExtent - viewport);
    return Object.freeze({ extent, physicalExtent, maximum, physicalMaximum,
        toLogical: (physical: number) => physicalMaximum ? Math.min(physicalMaximum, Math.max(0, physical)) / physicalMaximum * maximum : 0,
        toPhysical: (logical: number) => maximum ? Math.min(maximum, Math.max(0, logical)) / maximum * physicalMaximum : 0 });
}
