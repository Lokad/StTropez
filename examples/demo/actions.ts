import type { Workspace } from "../../src/index.ts";
import type {
    CodeActionChoice,
    CodeActionController,
    EditorLanguageOptions,
    TextEditor
} from "../../src/browser/index.ts";
import { demoCommandPolicy } from "./action-commands.ts";
import { projectReviewNote } from "./action-fixture.ts";
import type { DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";

export function demoActionPolicy(
    workspace: Workspace,
    file: DemoFile,
    language: DemoLanguage,
    valid: () => boolean
): Required<Pick<EditorLanguageOptions, "codeActions" | "reviewCommandEdit">> {
    return {
        codeActions: {
            popup: {
                beforeOpen: valid,
                quickApply(choice, preview) {
                    if (preview.command || (choice.kind !== "quickfix" && !choice.kind?.startsWith("quickfix.")))
                        return false;
                    const edits = preview.readEdits(0, 4);
                    return (
                        !!edits &&
                        edits.total > 0 &&
                        edits.total <= 4 &&
                        edits.notes.every((edit) => edit.document === file.resource.id) &&
                        edits.notes.reduce((units, edit) => units + edit.to - edit.from + edit.insertUnits, 0) <= 256
                    );
                }
            },
            documents: () => workspace.getSnapshot().documents.filter((doc) => doc.language !== null),
            canCapture: valid,
            commandPolicy: demoCommandPolicy(file, () => workspace.document(file.resource.id).language?.uri, valid),
            prepareRequest: (session) => language.prepareActions(session, file)
        },
        reviewCommandEdit: ({ edit }) => {
            const part = edit.documents[0];
            if (edit.documents.length !== 1 || part?.target.document.documentId !== file.resource.id) return false;
            const note = part.edits[0];
            return (
                part.edits.length === 1 &&
                note?.insert === projectReviewNote &&
                note.from === note.to &&
                note.from === part.target.document.buffer.length
            );
        }
    };
}

/** The Problems panel offers the actions already captured for its diagnostic. */
export function mountDemoActions(
    scope: CleanupScope,
    editor: TextEditor,
    tools: CodeActionController,
    idle: () => boolean
) {
    let offered: { button: HTMLButtonElement; choices: readonly CodeActionChoice[] } | undefined;
    function clearOffer() {
        offered?.button.remove();
        offered = undefined;
    }
    scope.defer(clearOffer);
    async function offerFixes(host: HTMLElement, current: () => boolean) {
        if (!idle()) return;
        const reply = await tools.request();
        if (
            reply.status !== "done" ||
            !idle() ||
            !host.isConnected ||
            !current() ||
            tools.getSnapshot().choices !== reply.value
        )
            return;
        const available = reply.value.filter((choice) => choice.disabled === null);
        const first = available[0];
        if (!first) return;
        const button = document.createElement("button");
        button.textContent = available.length === 1 ? `Review fix: ${first.title}` : `Review ${available.length} fixes`;
        button.onpointerdown = (event) => event.preventDefault();
        button.onclick = () => {
            if (
                offered?.button !== button ||
                !button.isConnected ||
                !current() ||
                !idle() ||
                tools.getSnapshot().choices !== reply.value
            )
                return;
            editor.commands.run("quickfix.show", reply.value);
        };
        offered = { button, choices: reply.value };
        host.append(button);
    }
    scope.defer(
        tools.subscribe(() => {
            if (offered && tools.getSnapshot().choices !== offered.choices) clearOffer();
        })
    );
    return { offerFixes };
}
