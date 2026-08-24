/*
 * 实现逻辑说明：
 * 这里把外部的 OpenAI 标准请求结构转换为 Codex backend-api 的 responses 请求体，
 * 并把 Codex 的事件流改写回标准 OpenAI Responses / Chat Completions 输出格式。
 * 当前仅白名单透传已确认支持的字段，未支持参数由路由层统一记录 warning 后忽略。
 */

import type {
  CodexEvent,
  CodexFunctionTool,
  CodexResponsesRequest,
  OpenAIChatCompletionsRequest,
  OpenAIChatMessage,
  OpenAIToolCall,
  OpenAIResponsesInputItem,
  OpenAIResponsesRequest,
} from "./types.js";

const DEFAULT_MODEL = "gpt-5-codex";
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export function normalizeModelName(model?: string) {
  if (!model) return DEFAULT_MODEL;
  return model;
}

function toInputTextParts(content: OpenAIChatMessage["content"]) {
  if (!content) return [];
  if (typeof content === "string") {
    return [{ type: "input_text" as const, text: content }];
  }

  return content
    .filter((part) => part.type === "text" || part.type === "input_text")
    .map((part) => ({
      type: "input_text" as const,
      text: part.text,
    }));
}

export function chatCompletionsToResponsesInput(
  request: OpenAIChatCompletionsRequest,
): { instructions?: string; input: OpenAIResponsesInputItem[] } {
  const instructions = request.messages
    ?.filter((message) => message.role === "system")
    .flatMap((message) => toInputTextParts(message.content))
    .map((part) => part.text)
    .join("\n");

  const input: OpenAIResponsesInputItem[] = [];

  for (const message of request.messages?.filter((item) => item.role !== "system") ?? []) {
    if (message.role === "tool" && message.tool_call_id) {
      const output = typeof message.content === "string"
        ? message.content
        : toInputTextParts(message.content).map((part) => part.text).join("");
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output });
      continue;
    }

    const content = toInputTextParts(message.content);
    if (content.length > 0 && message.role !== "tool") {
      input.push({
        type: "message",
        role: message.role,
        content: content.map((part) => ({
          type: message.role === "assistant" ? "output_text" as const : "input_text" as const,
          text: part.text,
        })),
      });
    }

    for (const toolCall of message.tool_calls ?? []) {
      input.push({
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }
  }

  return {
    instructions: instructions || undefined,
    input,
  };
}

function chatToolsToCodexTools(request: OpenAIChatCompletionsRequest): CodexFunctionTool[] | undefined {
  return request.tools?.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
    strict: tool.function.strict,
  }));
}

export function buildCodexResponsesRequestFromResponses(
  request: OpenAIResponsesRequest,
): CodexResponsesRequest {
  return {
    model: normalizeModelName(request.model),
    store: false,
    stream: true,
    instructions: request.instructions || DEFAULT_INSTRUCTIONS,
    input: request.input ?? [],
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tools: request.tools,
    tool_choice: request.tool_choice ?? "auto",
    parallel_tool_calls: true,
  };
}

export function buildCodexResponsesRequestFromChatCompletions(
  request: OpenAIChatCompletionsRequest,
): CodexResponsesRequest {
  const converted = chatCompletionsToResponsesInput(request);

  return {
    model: normalizeModelName(request.model),
    store: false,
    stream: true,
    instructions: converted.instructions || DEFAULT_INSTRUCTIONS,
    input: converted.input,
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tools: chatToolsToCodexTools(request),
    tool_choice: request.tool_choice ?? "auto",
    parallel_tool_calls: true,
  };
}

export function createOpenAIResponsesOutput(responseId: string, text: string) {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    output: [
      {
        id: `${responseId}_msg`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    model: DEFAULT_MODEL,
  };
}

export function createChatCompletion(
  responseId: string,
  model: string,
  text: string,
  toolCalls: OpenAIToolCall[] = [],
) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: responseId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

export function createChatCompletionToolCallChunk(
  responseId: string,
  model: string,
  index: number,
  toolCall: {
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  },
) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          ...(toolCall.id ? { id: toolCall.id } : {}),
          ...(toolCall.type ? { type: toolCall.type } : {}),
          function: toolCall.function ?? {},
        }],
      },
      finish_reason: null,
    }],
  };
}

export function createChatCompletionChunk(responseId: string, model: string, delta: string) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          content: delta,
        },
        finish_reason: null,
      },
    ],
  };
}

export function createChatCompletionDoneChunk(
  responseId: string,
  model: string,
  finishReason: "stop" | "tool_calls" = "stop",
) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
}

export function collectTextFromCodexEvents(events: CodexEvent[]) {
  return events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta ?? "")
    .join("");
}

export function collectToolCallsFromCodexEvents(events: CodexEvent[]): OpenAIToolCall[] {
  return events.flatMap((event) => {
    if (event.type !== "response.output_item.done" || event.item?.type !== "function_call") {
      return [];
    }

    const callId = event.item.call_id;
    const name = event.item.name;
    const args = event.item.arguments;
    if (typeof callId !== "string" || typeof name !== "string" || typeof args !== "string") {
      return [];
    }

    return [{ id: callId, type: "function" as const, function: { name, arguments: args } }];
  });
}
