/** Host-defined immutable form data. Runtime schemas, validation and services belong to the host. */
export type SnapshotValue = null | boolean | number | string | readonly SnapshotValue[] | { readonly [key: string]: SnapshotValue };
export type Immutable<T> = SnapshotValue extends T ? SnapshotValue : T extends null | boolean | number | string ? T : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

/** Copy plain values so caller mutations cannot change published snapshots or captured requests. */
export function snapshotValue<T extends SnapshotValue>(value: T): Immutable<T> {
    const visiting = new Set<object>();
    function copy(value: SnapshotValue): SnapshotValue {
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value !== "object" || visiting.has(value)) throw new TypeError("Expected finite, acyclic plain snapshot data.");
        visiting.add(value);
        let result: SnapshotValue;
        if (Array.isArray(value)) result = Object.freeze(Array.from(value, copy));
        else {
            if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("Expected plain snapshot data.");
            const entries: [string, SnapshotValue][] = [];
            if (Object.getOwnPropertySymbols(value).length) throw new TypeError("Snapshot data cannot contain symbol keys.");
            for (const key of Object.keys(value)) {
                const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
                if (!("value" in descriptor)) throw new TypeError("Snapshot data cannot contain accessors.");
                entries.push([key, copy(descriptor.value as SnapshotValue)]);
            }
            result = Object.freeze(Object.fromEntries(entries));
        }
        visiting.delete(value);
        return result;
    }
    return copy(value) as Immutable<T>;
}

export function equalValue(a: SnapshotValue, b: SnapshotValue): boolean {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key)
        && equalValue((a as Record<string, SnapshotValue>)[key]!, (b as Record<string, SnapshotValue>)[key]!));
}
