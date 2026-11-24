import { TextBuffer } from "../src/core/text-buffer.ts";

/** Count public materializations by immutable buffer version during an owning test. */
export function observeBufferReads() {
    const counts = new WeakMap<TextBuffer, { textExports: number; sliceUnits: number }>();
    function record(buffer: TextBuffer) {
        let count = counts.get(buffer);
        if (!count) {
            count = { textExports: 0, sliceUnits: 0 };
            counts.set(buffer, count);
        }
        return count;
    }
    const { slice, text } = TextBuffer.prototype;
    TextBuffer.prototype.slice = function (from, to) {
        const result = slice.call(this, from, to);
        if (result.length) record(this).sliceUnits += result.length;
        return result;
    };
    TextBuffer.prototype.text = function () {
        record(this).textExports++;
        return text.call(this);
    };
    return {
        read(buffer: TextBuffer) {
            const count = counts.get(buffer);
            return count ? { ...count } : { textExports: 0, sliceUnits: 0 };
        },
        dispose() {
            TextBuffer.prototype.slice = slice;
            TextBuffer.prototype.text = text;
        }
    };
}
