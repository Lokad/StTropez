import type { Locator } from "@playwright/test";

/** Use the painted text even when highlighting splits a word across several spans. */
export const paintedCharacter = (row: Locator, word: string, index: number) => row.evaluate((element, { word, index }) => {
    const start = element.textContent!.indexOf(word);
    if (start < 0) throw new Error(`Missing ${word} in the painted row.`);
    let offset = start + index;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent!.length;
        if (offset < length) {
            const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
            const box = range.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }
        offset -= length;
    }
    throw new Error("Character outside the painted row.");
}, { word, index });
