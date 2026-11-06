import type { HostController } from "./controller.ts";
import type { ViewBindings } from "./bindings.ts";

export function actions(controller: HostController, bindings: ViewBindings): readonly Readonly<{ label: string; invoke: () => void }>[] {
    return [
        { label: "Associate agent", invoke: controller.associate }, { label: "Request proposal", invoke: controller.requestAgent },
        { label: "Deliver proposal", invoke: controller.deliverProposal }, { label: "Interrupt agent", invoke: controller.interrupt },
        { label: "Fail agent service", invoke: controller.failAgent }, { label: "Offer newer proposal", invoke: controller.offerNewerProposal },
        { label: "Detach agent", invoke: controller.detach }, { label: "Save source", invoke: controller.save },
        { label: "Finish save", invoke: controller.finishSave }, { label: "Retry acknowledgement", invoke: controller.retryAcknowledgement },
        { label: "Simulate external source change", invoke: controller.simulateExternalWrite },
        { label: "Open source review", invoke: controller.openReview }, { label: "Close source review", invoke: controller.closeReview },
        { label: "Capture reference refresh", invoke: bindings.beginReferenceRefresh }, { label: "Finish reference refresh", invoke: bindings.finishReferenceRefresh },
        { label: "Capture review acceptance", invoke: bindings.beginReviewAcceptance }, { label: "Finish review acceptance", invoke: bindings.finishReviewAcceptance },
        { label: "Run captured inputs", invoke: controller.run }, { label: "Finish run", invoke: controller.finishRun },
        { label: "Fail run", invoke: controller.failRun }, { label: "Queue setting and run", invoke: controller.demonstrateOrdering },
        { label: "Inspect recovered input", invoke: controller.inspectRecovery }, { label: "Discard recovered input", invoke: controller.discardRecovery },
        { label: "Dismiss message", invoke: controller.clearError },
        { label: "Move primary view", invoke: controller.move }, { label: "Toggle views", invoke: controller.toggleViews },
        { label: "Prompt close", invoke: controller.openClosePrompt }, { label: "Confirm close", invoke: controller.confirmClose },
        { label: "Cancel close", invoke: controller.cancelClose }, { label: "Replace primary panel", invoke: controller.replacePrimary },
        { label: "Reopen primary source", invoke: controller.reopenPrimary }, { label: "Begin delayed load", invoke: controller.beginDeferredLoad },
        { label: "Finish delayed load", invoke: controller.finishLoad }, { label: "Inject form error", invoke: controller.injectFormError },
    ];
}
export function statusText(controller: HostController): string {
    const review = controller.review.getSnapshot(), activity = controller.activity.getSnapshot(), metadata = controller.source.metadata.getSnapshot();
    return `Association: ${review.association?.id ?? "detached"} · Request: ${review.request ? "running" : "idle"} · Proposal: ${review.proposal?.target.revision ?? "none"} · Acknowledgement: ${review.acknowledgements[0]?.status ?? "none"} · ${metadata.dirty ? "Unsaved" : "Saved"} · Save status: ${metadata.saveStatus} · Saves: ${activity.writes} · Runs: ${activity.pendingRuns} pending, ${activity.completedRuns} completed${activity.lastRun ? ` · Captured run: source revision ${activity.lastRun.sourceRevision}, configuration revision ${activity.lastRun.configurationRevision}, ${activity.lastRun.mode}` : ""} · Background: ${activity.background}`;
}
export function conflictText(controller: HostController): string {
    const conflict = controller.saveConflict.getSnapshot();
    return conflict ? `Save conflict at local revision ${conflict.submittedRevision}. Expected server ${conflict.expectedVersion ?? "none"}; observed ${conflict.observedVersion}.${conflict.reviewVersion ? ` Reviewing remote ${conflict.reviewVersion}.` : ""} ${conflict.message}` : "";
}
