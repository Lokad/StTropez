import { anchoredRange } from "../../src/index.ts";
import type { DocumentId, DocumentSnapshot } from "../../src/index.ts";
import type { LspDiagnostic } from "../../src/protocol/index.ts";

type Location = Readonly<{ documentId: DocumentId; revision: number; from: number; to: number }>;
export type DemoDiagnostic = LspDiagnostic &
    Location &
    Readonly<{
        name: string;
        related: readonly Readonly<{
            name: string;
            message: string;
            line: number;
            character: number;
            target: Location | null;
        }>[];
    }>;
type Entry = { document: DocumentSnapshot; syntax?: readonly DemoDiagnostic[] };
const same = (a: DocumentSnapshot, b: DocumentSnapshot) =>
    a.id === b.id && a.key === b.key && a.language === b.language && a.revision === b.revision && a.buffer === b.buffer;

/** Example-owned presentation and syntax cache. Mapped messages are not fresh provider authority. */
export class DemoDiagnosticState {
    private documents = new Map<DocumentId, Entry>();
    private items: readonly DemoDiagnostic[] = Object.freeze([]);
    get diagnostics(): readonly DemoDiagnostic[] {
        return this.items;
    }
    update(documents: readonly DocumentSnapshot[]): boolean {
        if (
            documents.length === this.documents.size &&
            documents.every((document) => {
                const old = this.documents.get(document.id);
                return old && same(old.document, document);
            })
        )
            return false;
        const next = new Map<DocumentId, Entry>(documents.map((document) => [document.id, { document }]));
        const moved = (target: Location): Location | undefined => {
            const before = this.documents.get(target.documentId)?.document,
                after = next.get(target.documentId)?.document;
            if (
                !before ||
                !after ||
                before.key !== after.key ||
                before.id !== after.id ||
                before.language !== after.language ||
                before.revision !== target.revision
            )
                return;
            if (same(before, after)) return target;
            const length = before.buffer.length;
            // A point at a nonempty EOF depends on the last source unit. Map that unit, then display its end.
            const eofPoint = target.from === length && target.to === length && length > 0;
            const range = anchoredRange(length, eofPoint ? length - 1 : target.from, target.to, {
                onDelete: "invalidate",
                toAffinity: eofPoint ? "after" : "before"
            });
            const mapped =
                before.buffer === after.buffer
                    ? range
                    : after.change?.previousRevision === before.revision
                      ? after.change.mapping.mapRange(range)
                      : undefined;
            return (
                mapped &&
                Object.freeze({
                    documentId: target.documentId,
                    revision: after.revision,
                    from: eofPoint ? mapped.to : mapped.from,
                    to: mapped.to
                })
            );
        };
        const at = (id: DocumentId, offset: number) => {
            const { line, column } = next.get(id)!.document.buffer.positionAt(offset);
            return Object.freeze({ line, character: column });
        };
        const items: DemoDiagnostic[] = [];
        for (const item of this.items) {
            const location = moved(item);
            if (!location) continue;
            let changed = location !== item;
            const related = item.related.length
                ? item.related.map((info) => {
                      if (!info.target) return info;
                      const target = moved(info.target) ?? null;
                      if (target === info.target) return info;
                      changed = true;
                      return Object.freeze({ ...info, ...(target ? at(target.documentId, target.from) : {}), target });
                  })
                : item.related;
            items.push(
                changed
                    ? Object.freeze({
                          ...item,
                          ...location,
                          related: Object.freeze(related),
                          range: Object.freeze({
                              start: at(item.documentId, location.from),
                              end: at(item.documentId, location.to)
                          })
                      })
                    : item
            );
        }
        this.items = Object.freeze(items);
        for (const [id, entry] of next) {
            const before = this.documents.get(id);
            // Syntax is file-local, but any related location must still belong to its capture.
            if (
                before?.syntax &&
                same(before.document, entry.document) &&
                before.syntax.every((item) =>
                    item.related.every((info) => !info.target || moved(info.target) === info.target)
                )
            )
                entry.syntax = before.syntax;
        }
        this.documents = next;
        return true;
    }
    syntax(document: DocumentSnapshot): readonly DemoDiagnostic[] | undefined {
        const entry = this.documents.get(document.id);
        return entry && same(entry.document, document) ? entry.syntax : undefined;
    }
    acceptSyntax(document: DocumentSnapshot, items: readonly DemoDiagnostic[]): void {
        const entry = this.documents.get(document.id);
        if (entry && same(entry.document, document)) entry.syntax = Object.freeze([...items]);
    }
    accept(documents: readonly DocumentSnapshot[], items: readonly DemoDiagnostic[]): boolean {
        if (
            documents.length !== this.documents.size ||
            documents.some((document) => {
                const current = this.documents.get(document.id);
                return !current || !same(current.document, document);
            })
        )
            return false;
        this.items = Object.freeze([...items]);
        return true;
    }
    clear(): void {
        this.items = Object.freeze([]);
        for (const entry of this.documents.values()) delete entry.syntax;
    }
}
