// Multi-turn tool-use loop on top of `ModelHandle.invoke`.
//
// `shared/models.ts` is single-turn (one InvokeModel → one structured response).
// Dev — and any future role that needs tool-use beyond the BA's forced
// single-tool pattern — needs the conversation pattern: model emits a tool_use
// block, runtime executes the tool, appends the result, calls the model again,
// repeats until the model stops or hits a turn cap.
//
// This is intentionally thin. No retries, no streaming, no MCP. The only
// model-facing wire format is what `ModelHandle.invoke` already supports.
// Caller owns: tool definitions, tool execution, terminal-tool selection, and
// what to do with the final message history.

import type {
  ChatMessage,
  ContentBlock,
  ModelHandle,
  SystemBlock,
  ToolDefinition,
} from "./models.ts";

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ToolResult = {
  // The tool_use_id the result is paired with on the model side.
  tool_use_id: string;
  // Stringified output (JSON, plain text — caller decides). Empty string is
  // a valid "tool ran, nothing useful to say" outcome.
  content: string;
  // Mark the tool's result as an error so the model knows to recover instead
  // of treating the empty/short output as a success signal.
  is_error?: boolean;
};

export type AgentLoopStopReason =
  // A tool whose name is in `terminalTools` was executed; loop exits after
  // appending its result so the caller can branch on the call's input.
  | "terminal_tool"
  // Model returned a response with no tool_use blocks and stopReason="end_turn".
  // For roles that expect a forced terminal tool call, this is a soft failure.
  | "end_turn"
  // Loop reached `maxTurns` without seeing a terminal tool or end_turn.
  | "max_turns"
  // Model returned `stopReason="max_tokens"` mid-tool-call — output was cut off
  // and the partial tool_use is unusable. Caller should retry with higher
  // maxTokensPerTurn or surface to a human.
  | "max_tokens";

export type AgentLoopUsage = {
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
};

export type AgentLoopResult = {
  stopReason: AgentLoopStopReason;
  turns: number;
  messages: ChatMessage[];
  // Tool-use blocks emitted in the last assistant turn. Empty when stopReason
  // is `end_turn` (model produced text only) or `max_turns`.
  lastToolUses: Array<{ id: string; name: string; input: unknown }>;
  usage: AgentLoopUsage;
  costUsd: number;
};

export type ExecuteTool = (call: ToolCall) => Promise<ToolResult>;

export type AgentLoopOptions = {
  model: ModelHandle;
  system?: string | SystemBlock[];
  // Seed conversation. The loop only appends; it never rewrites earlier turns.
  initialMessages: ChatMessage[];
  tools: ToolDefinition[];
  // Caller-provided executor for any tool the model calls. Throwing here
  // bubbles up as the loop's rejection — `is_error: true` is the soft path.
  executeTool: ExecuteTool;
  // When any of these tool names is called, the loop exits after appending
  // its result. Used by Dev's `propose_plan`, future `submit_done`, etc.
  terminalTools?: string[];
  maxTurns: number;
  maxTokensPerTurn: number;
  temperature?: number;
  // Optional per-turn observer (used by tests and structured logging).
  onTurn?: (turn: number, content: ContentBlock[]) => void;
};

function extractToolUses(
  content: ContentBlock[],
): Array<{ id: string; name: string; input: unknown }> {
  const uses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      uses.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return uses;
}

export async function runAgentLoop(
  opts: AgentLoopOptions,
): Promise<AgentLoopResult> {
  if (opts.maxTurns <= 0) {
    throw new Error("maxTurns must be greater than zero");
  }

  const messages: ChatMessage[] = [...opts.initialMessages];
  const terminalSet = new Set(opts.terminalTools ?? []);
  const usage: AgentLoopUsage = {
    input_tokens: 0,
    cached_tokens: 0,
    output_tokens: 0,
  };
  let costUsd = 0;

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    const invokeOpts: Parameters<ModelHandle["invoke"]>[0] = {
      messages,
      maxTokens: opts.maxTokensPerTurn,
      tools: opts.tools,
    };
    if (opts.system !== undefined) invokeOpts.system = opts.system;
    if (opts.temperature !== undefined) invokeOpts.temperature = opts.temperature;
    const result = await opts.model.invoke(invokeOpts);

    usage.input_tokens += result.usage.input_tokens;
    usage.cached_tokens += result.usage.cached_tokens;
    usage.output_tokens += result.usage.output_tokens;
    costUsd += result.costUsd;

    opts.onTurn?.(turn, result.content);
    messages.push({ role: "assistant", content: result.content });
    const toolUses = extractToolUses(result.content);

    if (result.stopReason === "max_tokens") {
      return {
        stopReason: "max_tokens",
        turns: turn,
        messages,
        lastToolUses: toolUses,
        usage,
        costUsd,
      };
    }

    if (toolUses.length === 0) {
      return {
        stopReason: "end_turn",
        turns: turn,
        messages,
        lastToolUses: [],
        usage,
        costUsd,
      };
    }

    // Execute every tool call in order, collect tool_result blocks.
    const resultBlocks: ContentBlock[] = [];
    let sawTerminal = false;
    for (const call of toolUses) {
      const r = await opts.executeTool(call);
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: r.tool_use_id,
        content: r.content,
        ...(r.is_error ? { is_error: true } : {}),
      });
      if (terminalSet.has(call.name)) sawTerminal = true;
    }
    messages.push({ role: "user", content: resultBlocks });

    if (sawTerminal) {
      return {
        stopReason: "terminal_tool",
        turns: turn,
        messages,
        lastToolUses: toolUses,
        usage,
        costUsd,
      };
    }
  }

  return {
    stopReason: "max_turns",
    turns: opts.maxTurns,
    messages,
    lastToolUses: [],
    usage,
    costUsd,
  };
}
