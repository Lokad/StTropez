import type { DocumentSnapshot, DocumentView, Observable, ResourceHandle, ResourceSnapshot, SaveSubmission } from "../src/index.ts";
import type { FontAssetSnapshot } from "../src/browser/index.ts";

import type { GraphemeIndex, GraphemeProgress } from "../src/index.ts";

export function graphemeReadContract(index: GraphemeIndex, progress: GraphemeProgress): void {
    // @ts-expect-error Published boundaries are immutable.
    index.boundaries().push(0);
    // @ts-expect-error Cluster coordinates are immutable.
    index.clusterAt(0).from = 1;
    // @ts-expect-error Source identity is captured.
    index.source.kind = "buffer";
    // @ts-expect-error Ready-only progress is immutable.
    progress.result = null;
}

export function fontReadContract(state: FontAssetSnapshot): void {
    if (state.current) {
        // @ts-expect-error Native font versions retain their captured generation.
        state.current.generation = 0;
    }
}






type Form = { nested: { enabled: boolean }; fields: string[] };
/** Compile-only consumer contract; these attempted writes must remain type errors. */
export function readCompatibility(handle: ResourceHandle<Form>, submission: SaveSubmission<Form>): Observable<ResourceSnapshot<Form>> {
    const snapshot = handle.getSnapshot();
    if (snapshot.state === "ready") {
        // @ts-expect-error Published nested values are deeply readonly even for a mutable host schema.
        snapshot.value.nested.enabled = false;
        // @ts-expect-error Published arrays are immutable.
        snapshot.value.fields.push("field");
    }
    // @ts-expect-error A captured submission must not become a second writable form.
    submission.value.nested.enabled = false;
    return handle;
}

export function documentReadContract(document: DocumentSnapshot, view: DocumentView): void {
    // @ts-expect-error Buffer snapshots expose no mutable text or position properties.
    document.buffer.length = 0;
    // @ts-expect-error Selection writes require the versioned view command.
    view.getSnapshot().selection.head = 0;
    // @ts-expect-error A published map's coordinate dimensions are immutable.
    if (document.change) document.change.mapping.oldLength = 0;
}
