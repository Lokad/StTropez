import { emptyList } from "../core/empty-list.ts";
import { unchangedPositionEdges } from "../core/positions.ts";
import type { BufferLine } from "../core/text-buffer.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";
import type { TextEditor } from "./text-editor.ts";
import type { InlineDecoration } from "./viewport.ts";

type TokenRow<State> = Readonly<{ endState: State; decorations: readonly InlineDecoration[] }>;
type CachedRow<State> = TokenRow<State> & { from: number; incoming: State };

/** A synchronous line lexer. Decorations use document offsets and each end state is immutable. */
export type LineTokenizerOptions<State> = Readonly<{
    initialState: () => State;
    tokenize: (line: BufferLine, state: State) => TokenRow<State>;
    order?: number;
    minimap?: boolean;
}>;

/** Color one editor and reuse unchanged lines when their incoming lexer state agrees. */
export function attachLineTokenizer<State>(editor: TextEditor, options: LineTokenizerOptions<State>) {
    const { workspace, view, signal } = editor;
    if (signal.aborted) throw new Error("Editor is disposed.");
    const observed = workspace.observeDocument(view.documentId);
    const runner = createCooperativeRunner(editor.element.ownerDocument.defaultView!);
    let rows: (CachedRow<State> | undefined)[] = [];
    let document = observed.getSnapshot();
    let next = 0, reusableFrom = 0;
    let requested = -1;
    let scheduled = false;

    function advance() {
        const source = document!;
        const state = next ? rows[next - 1]!.endState : options.initialState();
        const cached = rows[next];
        if (cached && Object.is(state, cached.incoming)) {
            next = next >= reusableFrom ? rows.length : next + 1;
            return;
        }
        const line = source.buffer.line(next);
        const tokenized = options.tokenize(line, state);
        if (source === document) rows[next++] = { ...tokenized, from: line.from, incoming: state };
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        runner.schedule(() => {
            scheduled = false;
            const first = next;
            if (!document || first > requested) return;
            runner.slice(advance, () => next <= requested, 128);
            if (next > first) layer.invalidate(first, Math.min(next, requested + 1));
            if (next <= requested) schedule();
        });
    }

    const layer = editor.decorations.addProvider({
        order: options.order ?? 0,
        minimap: options.minimap ?? true,
        provide(line) {
            if (!document || line.revision !== document.revision) return emptyList;
            if (line.line === next) advance();
            if (line.line >= next) {
                requested = Math.max(requested, line.line);
                schedule();
            }
            const row = rows[line.line];
            if (!row) return emptyList;
            const shift = line.lineStart - row.from;
            if (!shift || !row.decorations.length) return row.decorations;
            return row.decorations.map(mark => ({ ...mark, from: mark.from + shift, to: mark.to + shift }));
        },
    });
    const unsubscribe = observed.subscribe(() => {
        const previous = document;
        document = observed.getSnapshot();
        if (document?.buffer === previous?.buffer) return;
        runner.cancel();
        scheduled = false;
        requested = -1;
        const change = document?.change;
        const edges = change && change.previousRevision === previous?.revision && unchangedPositionEdges(change.mapping);
        const first = edges ? document!.buffer.lineAt(edges.prefix) : 0;
        // Keep complete lines of unchanged suffix. A line split by the edit needs its lexer run again.
        const oldSuffix = edges ? previous!.buffer.lineAt(previous!.buffer.length - edges.suffix) + 1 : rows.length;
        if (oldSuffix < rows.length) {
            const shift = document!.buffer.lineCount - previous!.buffer.lineCount;
            const newSuffix = oldSuffix + shift;
            const dirty = next < rows.length ? Math.max(next, reusableFrom) : 0;
            reusableFrom = Math.max(oldSuffix, dirty) + shift;
            rows = rows.slice(0, first).concat(new Array(newSuffix - first), rows.slice(oldSuffix));
        } else {
            rows.length = Math.min(rows.length, first);
            reusableFrom = rows.length;
        }
        next = Math.min(next, first);
        layer.invalidate(first);
    });

    function dispose() {
        signal.removeEventListener("abort", dispose);
        runner.cancel();
        unsubscribe();
        layer.dispose();
        rows.length = 0;
        requested = -1;
        document = undefined;
    }
    signal.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ dispose });
}
