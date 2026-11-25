import type { DocumentId, DocumentViewSnapshot, ResourceMetadata } from "../core/workspace.ts";
import type { TextEdit } from "../core/changes.ts";

/** Character input accepted by this editor, once per committed gesture or replay batch. */
export const typedTextEvent = "sttropez-typed-text";
export type TypedTextDetail = Readonly<{ before: DocumentViewSnapshot; after: DocumentViewSnapshot; text: string }>;
export function dispatchTypedText(root: HTMLElement, before: DocumentViewSnapshot, after: DocumentViewSnapshot, text: string): void {
    root.dispatchEvent(new CustomEvent<TypedTextDetail>(typedTextEvent, { bubbles: true,
        detail: Object.freeze({ before, after, text }) }));
}

export function acceptedTypedText(event: Event, root: HTMLElement, view: DocumentViewSnapshot): TypedTextDetail | undefined {
    const detail = (event as CustomEvent<TypedTextDetail>).detail;
    if (event.target === root && detail?.after === view && typeof detail.text === "string") return detail;
}

/** Dispatched on the editor's input. Bubbles within its root; does not cross shadow boundaries. */
export const inputConflictEvent = "sttropez-conflict";

/** Bubbles from the editor root when read-only authority prevents an input gesture. */
export const editRefusedEvent = "sttropez-edit-refused";
export type EditRefusedDetail = Readonly<{ documentId: DocumentId; reason: "read-only" | "edit-locked" }>;

export function humanEditRefusal(metadata: ResourceMetadata): EditRefusedDetail["reason"] | undefined {
    if (!metadata.capabilities.edit.includes("human")) return "read-only";
    if (metadata.editLock) return "edit-locked";
    return undefined;
}

/** A recovery notification, not permission to apply an edit. Validate external event details. */
export type InputConflictDetail = Readonly<{
    documentId: DocumentId;
    expectedRevision: number;
    reason: string;
    /** Native value, bounded input context or pending insertion, depending on the failed operation. */
    attemptedText: string;
    /** UTF-16 input-context origin; pending insertion recovery uses 0 without implying a replacement range. */
    contextFrom?: number;
    /** When available, the attempted replacement in model UTF-16 offsets at expectedRevision. */
    attemptedEdit?: TextEdit;
    /** Original command failure. This value need not be immutable or serializable. */
    cause?: unknown;
}>;
