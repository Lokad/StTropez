/** Create a styled editor part in its owning document, including embedded hosts. */
export function editorElement<K extends keyof HTMLElementTagNameMap>(owner: Document, tag: K, part: string) {
    const element = owner.createElement(tag);
    element.className = "st-" + part;
    return element;
}
