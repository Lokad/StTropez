import { invalidState } from "./bounds.ts";
/** Internal persistent balancing shared by indexed text and measured sequences. */
type Shape<T> = Readonly<{ kind: "leaf"; height: number }> | Readonly<{ kind: "branch"; height: number; left: T; right: T }>;

export function balanceTrees<T extends Shape<T>>(left: T, right: T, branch: (left: T, right: T) => T): T {
    if (left.height > right.height + 1) {
        if (left.kind !== "branch") invalidState("tree height");
        if (left.left.height >= left.right.height) return branch(left.left, branch(left.right, right));
        if (left.right.kind !== "branch") invalidState("tree rotation");
        return branch(branch(left.left, left.right.left), branch(left.right.right, right));
    }
    if (right.height > left.height + 1) {
        if (right.kind !== "branch") invalidState("tree height");
        if (right.right.height >= right.left.height) return branch(branch(left, right.left), right.right);
        if (right.left.kind !== "branch") invalidState("tree rotation");
        return branch(branch(left, right.left.left), branch(right.left.right, right.right));
    }
    return branch(left, right);
}

export function joinTrees<T extends Shape<T>>(left: T | null, right: T | null, branch: (left: T, right: T) => T): T | null {
    if (!left) return right; if (!right) return left;
    if (left.height > right.height + 1) {
        if (left.kind !== "branch") invalidState("tree height");
        return balanceTrees(left.left, joinTrees(left.right, right, branch)!, branch);
    }
    if (right.height > left.height + 1) {
        if (right.kind !== "branch") invalidState("tree height");
        return balanceTrees(joinTrees(left, right.left, branch)!, right.right, branch);
    }
    return branch(left, right);
}
