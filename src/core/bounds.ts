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

function invalid(subject: string, kind: ErrorConstructor): never {
    const code = "invalid-" + subject.toLowerCase().replaceAll(" ", "-");
    throw Object.assign(new kind(`Invalid ${subject}.`), { code });
}

export function invalidRange(subject: string): never {
    return invalid(subject, RangeError);
}

export function invalidType(subject: string): never {
    return invalid(subject, TypeError);
}
