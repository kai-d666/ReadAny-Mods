export type { ToolDefinition, ToolParameter } from "./tools";

export {
  createChatModel,
  createChatModelFromEndpoint,
  resolveActiveEndpoint,
  setStreamingFetch,
} from "./llm-provider";
export type { LLMOptions } from "./llm-provider";

export { processMessages } from "./message-pipeline";
export type { ProcessedMessage } from "./message-pipeline";

export { generateSemanticContext, detectOperationType } from "./semantic-context";
export type { OperationType } from "./semantic-context";

export { StreamingChat, createMessageId, createThreadId } from "./streaming";
export type { StreamingOptions } from "./streaming";
export { getAIEndpointRequestPreview, testAIEndpoint } from "./test-endpoint";
export type { EndpointTestResult } from "./test-endpoint";

export { buildSystemPrompt } from "./system-prompt";

export { BUILTIN_EMBEDDING_MODELS } from "./builtin-embedding-models";
export type { BuiltinEmbeddingModel } from "./builtin-embedding-models";

export {
  loadEmbeddingPipeline,
  generateLocalEmbeddings,
  disposeEmbeddingPipeline,
  setEmbeddingWorkerFactory,
} from "./local-embedding-service";

export { getAvailableTools } from "./tools";

export { getContextTools } from "./tools";

export { readingContextService, getReadingContextSnapshot } from "./reading-context-service";
export {
  fallbackContentService,
  setFallbackContentProvider,
  setBookContentSearchProvider,
  getBookContentSearchProvider,
  type FallbackChapter,
  type FallbackContentProvider,
  type FallbackTextSegment,
  type BookContentSearchProvider,
  type BookContentSearchResult,
  type BookContentSearchMatch,
} from "./fallback-content-service";
