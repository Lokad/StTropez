import { CharacterWarnings } from "../core/character-warnings.ts";
import { graphemeBoundaries } from "../core/graphemes.ts";
import type { CharacterWarningBatch, CharacterWarningLimits } from "../core/character-warnings.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { DocumentId, DocumentView, TabTarget, Workspace } from "../core/workspace.ts";
import type { InlineDecoration, PresentedLine, TextViewport } from "./viewport.ts";

export type CharacterWarningCapture = CharacterWarningBatch & Readonly<{ documentId: DocumentId; revision: number; isCurrent: () => boolean }>;
export type CharacterWarningHighlights = Readonly<{
    /** Bounded source query. Retain the capture and check isCurrent before acting on its ranges. */
    query: (from: number, to: number, limits?: CharacterWarningLimits) => CharacterWarningCapture | null;
}>;
const empty: readonly InlineDecoration[] = Object.freeze([]);

/** Internal view owner: no document scans, subscriptions or asynchronous work. */
export function mountCharacterWarnings(workspace: Workspace, target: TabTarget | undefined, view: DocumentView, viewport: TextViewport, initial?: CharacterWarnings) {
    const documentId = view.documentId, resource = workspace.resourceForDocument(documentId);
    let classifier = initial, disposed = false;
    const rows = new Map<number, Readonly<{ from: number; text: string; decorations: readonly InlineDecoration[] }>>();
    const available = () => !disposed && ownsTextSurface(workspace, view, target) && resource.getSnapshot().state === "ready";
    const handle: CharacterWarningHighlights = Object.freeze({
        query: (from, to, limits) => {
            if (!classifier || !available()) return null;
            const captured = classifier, document = workspace.document(documentId), batch = captured.scan(document.buffer, from, to, limits);
            return Object.freeze({ ...batch, documentId, revision: document.revision,
                isCurrent: () => available() && classifier === captured && workspace.document(documentId).buffer === document.buffer
                    && workspace.document(documentId).revision === document.revision });
        },
    });
    const layer = viewport.decorations.addProvider({ name: "character warnings", order: 110, minimap: false,
        provide: (line: PresentedLine): readonly InlineDecoration[] => {
            if (!classifier || disposed || line.documentId !== documentId) return empty;
            const before = rows.get(line.line);
            if (before?.from === line.from && before.text === line.text) return before.decorations;
            // PresentedLine is already a bounded, complete-code-point viewport fragment.
            const batch = classifier.scanText(line.text, line.from, { maxUnits: Math.max(2, line.text.length), maxWarnings: Math.max(1, line.text.length) });
            const marked: InlineDecoration[] = [];
            if (batch.warnings.length) {
                // Splitting a joiner/variation-selector cluster across spans can alter native caret
                // rectangles. Mark its whole grapheme; the host query retains precise code-point ranges.
                const boundaries = graphemeBoundaries(line.text); let cluster = 0;
                for (const warning of batch.warnings) {
                    while (boundaries[cluster + 1]! <= warning.from - line.from) cluster++;
                    const from = line.from + boundaries[cluster]!, to = line.from + boundaries[cluster + 1]!;
                    if (marked.at(-1)?.from !== from) marked.push(Object.freeze({ from, to, className: "st-character-warning" }));
                }
            }
            const decorations = marked.length ? Object.freeze(marked) : empty;
            if (rows.size >= 128 && !rows.has(line.line)) rows.delete(rows.keys().next().value!);
            rows.set(line.line, { from: line.from, text: line.text, decorations }); return decorations;
        }
    });
    return Object.freeze({ handle, configure: (next: CharacterWarnings | undefined) => {
        classifier = next; rows.clear(); layer.invalidate();
    }, dispose: () => { disposed = true; classifier = undefined; rows.clear(); layer.dispose(); } });
}
