import type { CodeActionController, CodeActionPreview } from "../../src/browser/index.ts";
import type { LspWorkspaceEditPreview } from "../../src/protocol/index.ts";
import { panelPaging, type createReviewKey } from "./panel-actions.ts";
import { editPaging } from "./edit-review.ts";

export const actionChoicePageSize = 16;

export async function requestActionsForReview(controller: CodeActionController) {
    const result = await controller.request();
    const first = result.status === "done" ? result.value[0] : undefined;
    if (first && !first.needsResolve && first.disabled === null && controller.getSnapshot().choice === null) {
        await first.select({ review: true });
    }
}

/** Keep the list page across choices, and start each edit preview on its first page. */
export function createActionPages(controller: CodeActionController, key: ReturnType<typeof createReviewKey>, changed: () => void) {
    let choices = controller.getSnapshot().choices, choicePage = 0;
    let shown: CodeActionPreview | null = null, edits: LspWorkspaceEditPreview | undefined;
    return () => {
        const state = controller.getSnapshot(), { preview } = state;
        if (choices !== state.choices) { choices = state.choices; choicePage = 0; }
        if (shown !== preview) {
            shown = preview; edits = preview?.readPage();
            if (state.choice !== null) choicePage = Math.floor(state.choice / actionChoicePageSize);
        }
        const from = choicePage, page = edits;
        const choicePaging = state.status === "ready" && choices.length > actionChoicePageSize
            ? panelPaging(key(choices)!, from, choices.length, actionChoicePageSize, next => {
                const current = controller.getSnapshot();
                if (current.status !== "ready" || current.choices !== state.choices || choicePage !== from) return;
                choicePage = next; changed();
            }) : null;
        const editControls = state.status === "ready" && preview && page
            ? editPaging(key(preview)!, page.page, page.count, next => {
                const current = controller.getSnapshot();
                if (current.status !== "ready" || current.preview !== preview || edits !== page) return;
                const result = preview.readPage(next);
                if (result) { edits = result; changed(); }
            }) : null;
        return { choicePage, choicePaging, editPaging: editControls, edits };
    };
}
