import type { AIEndpoint } from "../types";

interface AIEndpointDebugExtras {
  action?: string;
  method?: string;
  requestUrl?: string;
  model?: string;
  requestBodySummary?: unknown;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  responseLength?: number;
  responseBodyPreview?: string;
  modelCount?: number;
}

export function summarizeDebugText(value?: string, maxLength = 280): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

export function logAIEndpointDebug(
  stage: "request" | "response" | "error",
  endpoint: AIEndpoint,
  extras: AIEndpointDebugExtras = {},
): void {
  const payload = {
    action: extras.action || "",
    endpointId: endpoint.id,
    endpointName: endpoint.name,
    provider: endpoint.provider,
    useExactRequestUrl: endpoint.useExactRequestUrl,
    hasApiKey: Boolean(endpoint.apiKey),
    method: extras.method || "",
    model: extras.model || "",
    requestBodySummary: extras.requestBodySummary,
    status: extras.status,
    statusText: extras.statusText,
    contentType: extras.contentType,
    responseLength: extras.responseLength,
    responseBodyPreview: extras.responseBodyPreview || "",
    modelCount: extras.modelCount,
  };

  console.log(`[AIEndpoint][${stage}]`, JSON.stringify(payload));
}
