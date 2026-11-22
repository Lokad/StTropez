import type { CodeActionController, CodeActionPreview } from "../../src/browser/index.ts";
import type { LspWorkspaceEditPreview } from "../../src/protocol/index.ts";
import { panelPaging, type createReviewKey } from "./panel-actions.ts";

export const actionChoicePageSize = 16;
/** The protocol's workspace-edit preview contains at most 64 notes per page. */
export const actionEditPageSize = 64;

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
        const editPaging = state.status === "ready" && preview && page && page.count > actionEditPageSize
            ? panelPaging(key(preview)!, page.page, page.count, actionEditPageSize, next => {
                const current = controller.getSnapshot();
                if (current.status !== "ready" || current.preview !== preview || edits !== page) return;
                const result = preview.readPage(next);
                if (result) { edits = result; changed(); }
            }) : null;
        return { choicePage, choicePaging, editPaging, edits };
    };
}
