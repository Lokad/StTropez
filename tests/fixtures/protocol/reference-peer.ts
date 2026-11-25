// Development/test peer only. The reference package is never imported by src/ or shipped as an asset.
import { AbstractMessageReader, AbstractMessageWriter, createProtocolConnection } from "vscode-languageserver-protocol/node.js";
import type { DataCallback, Message, ProtocolConnection } from "vscode-languageserver-protocol/node.js";
import type { RpcTransport } from "../../../src/protocol/json-rpc.ts";

class FrameReader extends AbstractMessageReader {
    private readonly transport: RpcTransport;
    private stop: (() => void) | undefined;
    constructor(transport: RpcTransport) { super(); this.transport = transport; }
    listen(callback: DataCallback) {
        if (this.stop) throw new Error("Reference reader already has an owner.");
        const stop = this.transport.subscribe({ message: text => { try { callback(JSON.parse(text) as Message); } catch (error) { this.fireError(error); } },
            close: () => this.fireClose() }); this.stop = stop;
        return { dispose: () => { stop(); if (this.stop === stop) this.stop = undefined; } };
    }
    override dispose(): void { this.stop?.(); this.stop = undefined; super.dispose(); }
}
class FrameWriter extends AbstractMessageWriter {
    private readonly transport: RpcTransport;
    constructor(transport: RpcTransport) { super(); this.transport = transport; }
    async write(message: Message): Promise<void> { this.transport.send(JSON.stringify(message)); }
    end(): void { this.transport.dispose(); }
}
export function referencePeer(transport: RpcTransport): ProtocolConnection {
    return createProtocolConnection(new FrameReader(transport), new FrameWriter(transport));
}
