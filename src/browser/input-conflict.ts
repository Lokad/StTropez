import type { DocumentId } from "../core/workspace.ts";
import type { TextEdit } from "../core/changes.ts";

/** Dispatched on the editor's input. Bubbles within its root; does not cross shadow boundaries. */
export const inputConflictEvent = "sttropez-conflict";

/** Bubbles from the editor root when read-only authority prevents an input gesture. */
export const editRefusedEvent = "sttropez-edit-refused";
export type EditRefusedDetail = Readonly<{ documentId: DocumentId; reason: "read-only" | "edit-locked" }>;

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
