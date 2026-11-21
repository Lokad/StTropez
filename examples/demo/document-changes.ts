import { TextDocument } from "vscode-languageserver-protocol/browser.js";
import type { TextDocumentContentChangeEvent } from "vscode-languageserver-protocol/browser.js";
import { RpcError } from "../../src/protocol/index.ts";

/** Incremental LSP ranges address the result of all earlier changes in the notification. */
export function changeDemoDocument(before: TextDocument, version: number, changes: readonly TextDocumentContentChangeEvent[], maxLength = Infinity): TextDocument {
    let base = before, source = base.getText(), tail = source.length, length = tail;
    const pieces: string[] = [];
    function flush() {
        if (pieces.length) {
            const prefix = source.slice(0, tail);
            if (pieces.length === 2) source = prefix + pieces[1]! + pieces[0]!;
            else { pieces.push(prefix); source = pieces.reverse().join(""); }
            pieces.length = 0;
        }
        base = TextDocument.create(before.uri, before.languageId, version, source);
        tail = source.length;
    }
    for (const change of changes) {
        if ("range" in change) {
            const { start, end } = change.range;
            let from = base.offsetAt(start), to = base.offsetAt(end);
            if (pieces.length) {
                const actualEnd = base.positionAt(to);
                // Replace All sends ranges from the bottom up. Positions strictly before
                // the last splice still use the same line index. Rebase at touching ranges
                // as a splice can form a new CRLF across the boundary.
                if (to >= tail || from > to || actualEnd.line !== end.line || actualEnd.character !== end.character) {
                    flush();
                    from = base.offsetAt(start); to = base.offsetAt(end);
                }
            }
            pieces.push(source.slice(to, tail), change.text);
            tail = from;
            length += change.text.length - (to - from);
        } else {
            pieces.length = 0;
            source = change.text;
            flush();
            length = source.length;
        }
        if (length > maxLength) throw new RpcError(-32602, "Demo document exceeds its limit.");
    }
    flush();
    return base;
}
