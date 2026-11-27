import { invalidRange } from "../core/bounds.ts";
import { isRecord, ProtocolDecodeError, decodeJson, wireLimits, jsonSnapshot } from "./wire.ts";
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

/** Freeze and bound the arguments before reserving or dispatching a command. */
export function commandArguments(args: readonly JsonValue[]): readonly JsonValue[] {
    const value = jsonSnapshot(args);
    if (!Array.isArray(value) || JSON.stringify(value).length > wireLimits.commandArgumentUnits) {
        invalidRange("command argument size");
    }
    return value;
}
