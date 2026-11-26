import { LspLineIndex } from "../../src/protocol/index.ts";
import type { LspCommandPolicy } from "../../src/protocol/index.ts";
import type { DemoFile } from "./project.ts";
import { projectActionMarker, projectCommand, projectReviewNote } from "./action-fixture.ts";

/** A narrow host registration. It neither invokes the server nor executes the edited program. */
export function demoCommandPolicy(file: DemoFile, uri: () => string | undefined, current: () => boolean): LspCommandPolicy {
    return invocation => {
        const [target, mode] = invocation.arguments;
        if (invocation.command !== projectCommand || invocation.arguments.length !== 2 || target !== uri()
            || !["note", "check", "fail"].includes(String(mode))) return null;
        return { kind: "host", isCurrent: () => current() && uri() === target, run: async (_command, context) => {
            const docs = context.snapshots(), source = docs.find(doc => doc.id === file.resource.id);
            if (!source || docs.length !== 2 || docs.some(doc => !doc.buffer.slice(0, projectActionMarker.length).startsWith(projectActionMarker))) throw new Error("The captured demo project changed.");
            if (mode === "note") {
                const index = await LspLineIndex.create(source.buffer, async () => { if (!context.isCurrent()) throw new Error("The captured command changed."); }), end = index.at(source.buffer.length);
                const result = await context.applyEdit({ label: "Demo host review note", edit: { changes: { [String(target)]: [
                    { range: { start: end, end }, newText: projectReviewNote }] } } });
                if (!result.applied) throw new Error(result.failureReason ?? "The note could not be applied.");
                return "Review note added as one undoable edit.";
            }
            if (docs.some(doc => /\bexampleRate\b/.test(doc.buffer.slice(0, doc.buffer.length)))) throw new Error("The rename must finish before the project check.");
            if (mode === "fail") throw new Error("The demo's later check deliberately failed. Use Undo to revert the rename, or keep the edits.");
            return "Project check passed after the two-file rename. The edited program was not executed.";
        } };
    };
}
