import type { ResourceMetadata } from "../../../src/index.ts";
import type { Activity, HostController } from "./controller.ts";
import type { SaveConflictPresentation } from "./source-review.ts";

export function operationStatusModel(activity: Activity, metadata: ResourceMetadata) {
    return { label: "Host operation status",
        text: `${metadata.dirty ? "Unsaved" : "Saved"} · Save status: ${metadata.saveStatus} · Saves: ${activity.writes} · Runs: ${activity.pendingRuns} pending, ${activity.completedRuns} completed${activity.lastRun ? ` · Captured run: source revision ${activity.lastRun.sourceRevision}, configuration revision ${activity.lastRun.configurationRevision}, ${activity.lastRun.mode}` : ""} · Background: ${activity.background}`,
    } as const;
}

export function inputRecoveryModel(state: ReturnType<HostController["recovery"]["getSnapshot"]>) {
    const text = state.items.at(-1)?.attemptedText ?? "";
    return { label: "Input recovery", hidden: state.items.length === 0,
        status: `${state.items.length} input ${state.items.length === 1 ? "change" : "changes"} retained for recovery.`,
        preview: { hidden: !state.visible, text: state.visible ? text.slice(0, 4096) + (text.length > 4096 ? "…" : "") : "" },
    } as const;
}

type ConflictCommands = Pick<HostController, "reviewSaveConflict" | "finishConflictReview" | "saveReviewedSource">;
export function saveConflictPanelModel(controller: ConflictCommands, state: SaveConflictPresentation) {
    const conflict = state.conflict;
    return { label: "Save conflict", hidden: conflict === null,
        status: conflict ? `Save conflict at local revision ${conflict.submittedRevision}. Expected server ${conflict.expectedVersion ?? "none"}; observed ${conflict.observedVersion}.${conflict.reviewVersion ? ` Reviewing remote ${conflict.reviewVersion}.` : ""} ${conflict.message}` : "",
        actions: [
            { label: "Review remote source", invoke: () => controller.reviewSaveConflict(conflict), disabled: state.disposed || conflict === null },
            { label: "Finish remote review", invoke: () => { controller.finishConflictReview(conflict); }, disabled: state.disposed || conflict?.review !== "loading" },
            { label: "Save reviewed source", invoke: () => controller.saveReviewedSource(conflict), disabled: !state.canSaveReviewed },
        ],
    } as const;
}

export function mountSaveConflictPanel(host: HTMLElement, controller: ConflictCommands & Pick<HostController, "saveConflictPresentation">): () => void {
    const owner = host.ownerDocument, status = owner.createElement("output"), initial = saveConflictPanelModel(controller, controller.saveConflictPresentation.getSnapshot());
    host.setAttribute("aria-label", initial.label);
    const buttons = initial.actions.map(action => { const button = owner.createElement("button"); button.textContent = action.label; return button; });
    host.replaceChildren(status, ...buttons);
    const render = () => { const model = saveConflictPanelModel(controller, controller.saveConflictPresentation.getSnapshot());
        host.hidden = model.hidden; status.textContent = model.status;
        buttons.forEach((button, i) => { button.disabled = model.actions[i]!.disabled; button.onclick = model.actions[i]!.invoke; }); };
    const stop = controller.saveConflictPresentation.subscribe(render); render();
    return () => { stop(); buttons.forEach(button => { button.onclick = null; }); host.replaceChildren(); };
}
