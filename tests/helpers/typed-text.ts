import type { Page } from "@playwright/test";
import { typedTextEvent, type TypedTextDetail } from "../../src/browser/input-events.ts";

export function recordTypedText(page: Page) {
    return page.evaluateHandle(name => {
        const events: TypedTextDetail[] = [];
        document.addEventListener(name, event => events.push((event as CustomEvent<TypedTextDetail>).detail));
        return events;
    }, typedTextEvent);
}
