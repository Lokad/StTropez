import { isRecord, ProtocolDecodeError, decodeJson } from "./wire.ts";
import type { JsonValue } from "./wire.ts";

export type LspCommand = Readonly<{ title: string; command: string; arguments: readonly JsonValue[] }>;

/** Decode command data only; execution and authorization belong to the captured command owner. */
export function decodeLspCommand(value: unknown): LspCommand {
    if (!isRecord(value)) throw new ProtocolDecodeError("Malformed LSP command.");
    const command = value;
    if (typeof command.title !== "string" || typeof command.command !== "string" || !command.command
        || command.arguments !== undefined && !Array.isArray(command.arguments)) throw new ProtocolDecodeError("Malformed LSP command.");
    return Object.freeze({ title: command.title, command: command.command, arguments: decodeJson(command.arguments ?? []) as readonly JsonValue[] });
}
