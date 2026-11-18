import type { Page } from "@playwright/test";

type HostCase = (args: { page: Page }) => Promise<void>;
type HostCoverage = "all-hosts" | "candidate-hosts" | "plain-candidate";

/** Register host dimensions explicitly; titles describe behavior without selecting coverage. */
export function hostCases(register: (name: string, body: HostCase) => void,
    host: "plain" | "react", editor: "native" | "candidate") {
    return (coverage: HostCoverage, name: string, body: HostCase): void => {
        if (coverage === "all-hosts" || editor === "candidate" && (host === "plain" || coverage === "candidate-hosts")) register(name, body);
    };
}
