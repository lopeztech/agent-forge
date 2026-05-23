import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAgentLoop, type ToolResult } from "../shared/agent-loop.ts";
import type {
  ContentBlock,
  InvokeOptions,
  InvokeResult,
  ModelHandle,
} from "../shared/models.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type ScriptedTurn = {
  stopReason?: string;
  content: ContentBlock[];
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

function scriptedModel(script: ScriptedTurn[]): {
  handle: ModelHandle;
  calls: InvokeOptions[];
} {
  const calls: InvokeOptions[] = [];
  let index = 0;
  const handle: ModelHandle = {
    tier: "sonnet-4-6",
    bedrockModelId: "test-model",
    async invoke(opts: InvokeOptions): Promise<InvokeResult> {
      calls.push(opts);
      const turn = script[index++];
      if (!turn) throw new Error(`script exhausted at call ${index}`);
      return {
        stopReason: turn.stopReason ?? "end_turn",
        content: turn.content,
        usage: {
          input_tokens: turn.inputTokens ?? 0,
          cached_tokens: turn.cachedTokens ?? 0,
          output_tokens: turn.outputTokens ?? 0,
        },
        costUsd: turn.costUsd ?? 0,
      };
    },
  };
  return { handle, calls };
}

function textOnly(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

function toolUse(name: string, input: unknown, id = "tu_1"): ContentBlock {
  return { type: "tool_use", id, name, input };
}

const NOOP_TOOL = {
  name: "noop",
  description: "test tool",
  input_schema: { type: "object", properties: {} },
};

const SUBMIT_TOOL = {
  name: "submit_done",
  description: "terminal",
  input_schema: { type: "object", properties: {} },
};

const okExecutor = async (): Promise<ToolResult> => ({
  tool_use_id: "tu_1",
  content: "ok",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgentLoop", () => {
  it("exits on end_turn when the model produces text without tool_use", async () => {
    const { handle, calls } = scriptedModel([
      { stopReason: "end_turn", content: textOnly("hello"), inputTokens: 10, outputTokens: 5 },
    ]);

    const r = await runAgentLoop({
      model: handle,
      initialMessages: [{ role: "user", content: "hi" }],
      tools: [NOOP_TOOL],
      executeTool: okExecutor,
      maxTurns: 5,
      maxTokensPerTurn: 100,
    });

    assert.equal(r.stopReason, "end_turn");
    assert.equal(r.turns, 1);
    assert.equal(calls.length, 1);
    assert.equal(r.usage.input_tokens, 10);
    assert.equal(r.usage.output_tokens, 5);
    // Original user turn + one assistant turn.
    assert.equal(r.messages.length, 2);
  });

  it("dispatches a tool call, appends the result, and continues", async () => {
    const { handle } = scriptedModel([
      {
        stopReason: "tool_use",
        content: [toolUse("noop", { x: 1 }, "tu_1")],
      },
      { stopReason: "end_turn", content: textOnly("done") },
    ]);

    let captured: { name: string; input: unknown } | undefined;
    const exec = async (call: { name: string; input: unknown; id: string }) => {
      captured = { name: call.name, input: call.input };
      return { tool_use_id: call.id, content: "42" };
    };

    const r = await runAgentLoop({
      model: handle,
      initialMessages: [{ role: "user", content: "do it" }],
      tools: [NOOP_TOOL],
      executeTool: exec,
      maxTurns: 5,
      maxTokensPerTurn: 100,
    });

    assert.equal(r.stopReason, "end_turn");
    assert.equal(r.turns, 2);
    assert.deepEqual(captured, { name: "noop", input: { x: 1 } });
    // user, assistant, user (tool_result), assistant.
    assert.equal(r.messages.length, 4);

    const toolResultMsg = r.messages[2]!;
    assert.equal(toolResultMsg.role, "user");
    assert.ok(Array.isArray(toolResultMsg.content));
    const block = (toolResultMsg.content as ContentBlock[])[0]!;
    assert.equal(block.type, "tool_result");
    assert.equal((block as { content: string }).content, "42");
  });

  it("stops after a terminal tool runs and preserves its tool_use block", async () => {
    const { handle, calls } = scriptedModel([
      {
        stopReason: "tool_use",
        content: [toolUse("submit_done", { summary: "yep" }, "tu_x")],
      },
    ]);

    const r = await runAgentLoop({
      model: handle,
      initialMessages: [{ role: "user", content: "ship it" }],
      tools: [SUBMIT_TOOL],
      executeTool: okExecutor,
      terminalTools: ["submit_done"],
      maxTurns: 5,
      maxTokensPerTurn: 100,
    });

    assert.equal(r.stopReason, "terminal_tool");
    assert.equal(r.turns, 1);
    assert.equal(calls.length, 1, "should not call the model again after terminal");
    assert.equal(r.lastToolUses.length, 1);
    assert.equal(r.lastToolUses[0]!.name, "submit_done");
    assert.deepEqual(r.lastToolUses[0]!.input, { summary: "yep" });
  });

  it("propagates is_error: true on tool_result back to the model", async () => {
    const { handle } = scriptedModel([
      { stopReason: "tool_use", content: [toolUse("noop", {}, "tu_e")] },
      { stopReason: "end_turn", content: textOnly("ok") },
    ]);

    const r = await runAgentLoop({
      model: handle,
      initialMessages: [{ role: "user", content: "x" }],
      tools: [NOOP_TOOL],
      executeTool: async () => ({ tool_use_id: "tu_e", content: "boom", is_error: true }),
      maxTurns: 5,
      maxTokensPerTurn: 100,
    });

    const block = (r.messages[2]!.content as ContentBlock[])[0]!;
    assert.equal(block.type, "tool_result");
    assert.equal((block as { is_error?: boolean }).is_error, true);
  });

  it("stops at max_turns when the model keeps calling tools", async () => {
    const { handle, calls } = scriptedModel([
      { stopReason: "tool_use", content: [toolUse("noop", {}, "a")] },
      { stopReason: "tool_use", content: [toolUse("noop", {}, "b")] },
      { stopReason: "tool_use", content: [toolUse("noop", {}, "c")] },
    ]);

    const r = await runAgentLoop({
      model: handle,
      initialMessages: [{ role: "user", content: "loop" }],
      tools: [NOOP_TOOL],
      executeTool: async (call) => ({ tool_use_id: call.id, content: "x" }),
      maxTurns: 3,
      maxTokensPerTurn: 100,
    });

    assert.equal(r.stopReason, "max_turns");
    assert.equal(r.turns, 3);
    assert.equal(calls.length, 3);
  });

  it("surfaces max_tokens immediately so a partial tool_use isn't dispatched", async () => {
    const { handle } = scriptedModel([
      { stopReason: "max_tokens", content: [toolUse("noop", { partial: true })] },
    ]);

    let executed = 0;
    const r = await runAgentLoop({
      model: handle,
      initialMessages: [{ role: "user", content: "x" }],
      tools: [NOOP_TOOL],
      executeTool: async (call) => {
        executed++;
        return { tool_use_id: call.id, content: "x" };
      },
      maxTurns: 5,
      maxTokensPerTurn: 100,
    });

    assert.equal(r.stopReason, "max_tokens");
    assert.equal(executed, 0, "partial tool call must not run");
  });

  it("accumulates usage and costUsd across turns", async () => {
    const { handle } = scriptedModel([
      {
        stopReason: "tool_use",
        content: [toolUse("noop", {}, "1")],
        inputTokens: 100,
        cachedTokens: 50,
        outputTokens: 20,
        costUsd: 0.01,
      },
      {
        stopReason: "end_turn",
        content: textOnly("bye"),
        inputTokens: 80,
        outputTokens: 10,
        costUsd: 0.005,
      },
    ]);

    const r = await runAgentLoop({
      model: handle,
      initialMessages: [{ role: "user", content: "x" }],
      tools: [NOOP_TOOL],
      executeTool: async (call) => ({ tool_use_id: call.id, content: "y" }),
      maxTurns: 5,
      maxTokensPerTurn: 100,
    });

    assert.equal(r.usage.input_tokens, 180);
    assert.equal(r.usage.cached_tokens, 50);
    assert.equal(r.usage.output_tokens, 30);
    assert.equal(r.costUsd, 0.015);
  });

  it("rejects maxTurns <= 0 instead of looping forever silently", async () => {
    await assert.rejects(
      runAgentLoop({
        model: scriptedModel([]).handle,
        initialMessages: [{ role: "user", content: "x" }],
        tools: [NOOP_TOOL],
        executeTool: okExecutor,
        maxTurns: 0,
        maxTokensPerTurn: 100,
      }),
      /maxTurns must be greater than zero/,
    );
  });

  it("honors result.terminate=false to keep the loop going even on a terminal tool", async () => {
    const { handle, calls } = scriptedModel([
      { stopReason: "tool_use", content: [toolUse("submit_done", { ok: false }, "1")] },
      { stopReason: "tool_use", content: [toolUse("submit_done", { ok: true }, "2")] },
      { stopReason: "end_turn", content: textOnly("done") },
    ]);

    let nthCall = 0;
    const exec = async (call: { id: string; name: string; input: unknown }) => {
      nthCall++;
      // First submit_done: validation failed, agent should retry.
      // Second submit_done: validation passed, terminate.
      const ok = (call.input as { ok: boolean }).ok === true;
      return {
        tool_use_id: call.id,
        content: ok ? "shipped" : "tests failed",
        is_error: !ok,
        terminate: ok,
      };
    };

    const r = await runAgentLoop({
      model: handle,
      initialMessages: [{ role: "user", content: "go" }],
      tools: [SUBMIT_TOOL],
      executeTool: exec,
      terminalTools: ["submit_done"],
      maxTurns: 5,
      maxTokensPerTurn: 100,
    });

    assert.equal(r.stopReason, "terminal_tool");
    assert.equal(r.turns, 2, "first submit_done shouldn't end the loop");
    assert.equal(calls.length, 2, "second model call should happen after the failed attempt");
    assert.equal(nthCall, 2);
  });

  it("honors result.terminate=true to end the loop on a non-listed tool", async () => {
    const { handle } = scriptedModel([
      { stopReason: "tool_use", content: [toolUse("noop", {}, "1")] },
    ]);

    const r = await runAgentLoop({
      model: handle,
      initialMessages: [{ role: "user", content: "x" }],
      tools: [NOOP_TOOL],
      executeTool: async (call) => ({
        tool_use_id: call.id,
        content: "stop",
        terminate: true,
      }),
      maxTurns: 5,
      maxTokensPerTurn: 100,
    });

    assert.equal(r.stopReason, "terminal_tool");
    assert.equal(r.turns, 1);
  });

  it("passes system + temperature + tools through to the model", async () => {
    const { handle, calls } = scriptedModel([
      { stopReason: "end_turn", content: textOnly("ok") },
    ]);

    await runAgentLoop({
      model: handle,
      system: [{ type: "text", text: "you are a tester" }],
      initialMessages: [{ role: "user", content: "x" }],
      tools: [NOOP_TOOL],
      executeTool: okExecutor,
      maxTurns: 1,
      maxTokensPerTurn: 256,
      temperature: 0.2,
    });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.deepEqual(call.system, [{ type: "text", text: "you are a tester" }]);
    assert.equal(call.temperature, 0.2);
    assert.equal(call.maxTokens, 256);
    assert.deepEqual(call.tools, [NOOP_TOOL]);
  });
});
