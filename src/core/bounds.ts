export function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
    return isNonNegativeInteger(value) && value > 0;
}

/** End offsets can equal the length. An item index must identify an existing item. */
export function isOffset(value: number, length: number): boolean {
    return isNonNegativeInteger(value) && value <= length;
}

export function isIndex(value: number, length: number): boolean {
    return isNonNegativeInteger(value) && value < length;
}

export function isOffsetRange(from: number, to: number, length = Number.MAX_SAFE_INTEGER): boolean {
    return isOffset(from, to) && isOffset(to, length);
}
