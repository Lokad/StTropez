type HostCoverage = "all-hosts" | "candidate-hosts" | "plain-candidate";

/** Keep test() at its declaration site so reports retain the owning file and line. */
export function coversHost(coverage: HostCoverage, host: "plain" | "react", editor: "native" | "candidate"): boolean {
    return coverage === "all-hosts" || editor === "candidate" && (host === "plain" || coverage === "candidate-hosts");
}
