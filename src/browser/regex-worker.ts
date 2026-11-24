import { RegexSession } from "../protocol/regex-session.ts";

const session = new RegexSession();
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
    const reply = session.receive(event.data);
    if (!reply) return;
    if (reply.operation === "regex-error") globalThis.postMessage(reply);
    else globalThis.postMessage(reply, { transfer: [reply.offsets.buffer] });
});
