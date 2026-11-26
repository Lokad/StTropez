import { emptyList } from "../core/empty-list.ts";
import { unchangedPositionEdges } from "../core/positions.ts";
import type { BufferLine } from "../core/text-buffer.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";
import type { TextEditor } from "./text-editor.ts";
import type { InlineDecoration } from "./viewport.ts";

type TokenRow<State> = Readonly<{ endState: State; decorations: readonly InlineDecoration[] }>;

/** A synchronous line lexer. Decorations use document offsets and each end state is immutable. */
export type LineTokenizerOptions<State> = Readonly<{
    initialState: () => State;
    tokenize: (line: BufferLine, state: State) => TokenRow<State>;
    order?: number;
    minimap?: boolean;
}>;

/** Color one editor, retaining the unchanged prefix and discovering distant lexical states in bounded tasks. */
export function attachLineTokenizer<State>(editor: TextEditor, options: LineTokenizerOptions<State>) {
    const { workspace, view, signal } = editor;
    if (signal.aborted) throw new Error("Editor is disposed.");
    const observed = workspace.observeDocument(view.documentId);
    const runner = createCooperativeRunner(editor.element.ownerDocument.defaultView!);
    const rows: TokenRow<State>[] = [];
    let document = observed.getSnapshot();
    let requested = -1;
    let scheduled = false;

    function advance() {
        const source = document!;
        const state = rows.length ? rows[rows.length - 1]!.endState : options.initialState();
        const row = options.tokenize(source.buffer.line(rows.length), state);
        if (source === document) rows.push(row);
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        runner.schedule(() => {
            scheduled = false;
            const first = rows.length;
            if (!document || first > requested) return;
            runner.slice(advance, () => rows.length <= requested, 128);
            if (rows.length > first) layer.invalidate(first, rows.length);
            if (rows.length <= requested) schedule();
        });
    }

    const layer = editor.decorations.addProvider({
        order: options.order ?? 0,
        minimap: options.minimap ?? true,
        provide(line) {
            if (!document || line.revision !== document.revision) return emptyList;
            if (line.line === rows.length) advance();
            if (line.line >= rows.length) {
                requested = Math.max(requested, line.line);
                schedule();
                return emptyList;
            }
            return rows[line.line]!.decorations;
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
        const prefix = change && change.previousRevision === previous?.revision
            ? unchangedPositionEdges(change.mapping)?.prefix : undefined;
        const first = prefix === undefined ? 0 : document!.buffer.lineAt(prefix);
        rows.length = Math.min(rows.length, first);
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
