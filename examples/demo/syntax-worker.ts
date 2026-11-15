import { DemoSyntaxSession } from "./syntax-session.ts";
import type { SyntaxRequest } from "./syntax-session.ts";

const session = new DemoSyntaxSession();
globalThis.addEventListener("message", (event: MessageEvent<SyntaxRequest>) => {
    const result = session.accept(event.data);
    if (result) globalThis.postMessage(result, result.kind === "result" ? { transfer: [result.spans.buffer] } : {});
});
