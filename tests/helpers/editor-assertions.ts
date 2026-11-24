import { expect, type Locator } from "@playwright/test";

export async function typeAfterClick(control: Locator, editor: Locator, text: string) {
    await control.click();
    await expect(editor).toBeFocused();
    await editor.page().keyboard.type(text);
}

export function expectCaretOnRow(caret: { top: number; height: number }, row: { top: number; height: number }) {
    expect(Math.abs(caret.top - row.top)).toBeLessThan(1.1);
    expect(Math.abs(caret.height - row.height)).toBeLessThan(1.1);
}

/** Unwrapped rows, including review padding, fill the visible pane at one pitch. */
export async function expectAlignedEditorRows(editor: Locator) {
    await expect.poll(() => editor.evaluate(root => {
        const rows = new Map([...root.querySelectorAll<HTMLElement>(".st-viewport-row")].map(row =>
            [Number(row.dataset.line) + 1, row.getBoundingClientRect().top]));
        const numbers = root.querySelectorAll(".st-line-numbers span");
        if (!numbers.length) return "No line numbers";
        const gutter = root.querySelector(".st-viewport-gutter")!.getBoundingClientRect();
        for (const number of numbers) {
            const line = Number(number.textContent), top = rows.get(line);
            const box = number.getBoundingClientRect();
            if (box.left < gutter.left - 1 || box.right > gutter.right + 1) return "Number outside gutter on line " + line;
            if (top === undefined || Math.abs(top - box.top) >= 1) return "Misaligned line " + line;
            rows.delete(line);
        }
        const bands = [...root.querySelectorAll(".st-viewport-row, .st-comparison-padding")]
            .map(node => node.getBoundingClientRect()).sort((a, b) => a.top - b.top);
        for (let i = 1; i < bands.length; i++) {
            if (Math.abs(bands[i]!.top - bands[i - 1]!.bottom) >= 1) return "Row gap or overlap at y=" + bands[i]!.top;
        }
        return rows.size ? "Missing line number " + rows.keys().next().value : null;
    })).toBeNull();
}
