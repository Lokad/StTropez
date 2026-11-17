/** Append validated half-open rows in strictly increasing header order.
 * Completed ancestors are removed even on rejection; a crossing fold is never pushed.
 * A rejected fold leaves its conflicting parent at the top for the caller's policy. */
export function appendNestedFold<T extends Readonly<{ lineFrom: number; lineTo: number }>>(stack: T[], fold: T): boolean {
    while (stack.length && fold.lineFrom >= stack.at(-1)!.lineTo) stack.pop();
    if (stack.length && fold.lineTo > stack.at(-1)!.lineTo) return false;
    stack.push(fold); return true;
}
