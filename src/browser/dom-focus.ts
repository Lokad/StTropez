/** Document focus is retargeted to a shadow host; inspect the element's own tree. */
export function isFocused(element: Element): boolean {
    return (element.getRootNode() as Document | ShadowRoot).activeElement === element;
}
