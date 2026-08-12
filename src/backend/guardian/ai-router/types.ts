/** @fileoverview Shared contracts for the AI Router. No logic — types only. */

export type Importance = "low" | "medium" | "high";
export type Mode =
  | "gateway" | "gateway-custom" | "provider-sdk-gateway"
  | "openai-compat" | "native" | "gemini-native";
export type Transport = "ai-sdk" | "provider-sdk" | "openai-compat" | "gemini-sdk";
export type ProviderId = "openai" | "anthropic" | "google" | "workers-ai";
export type Window = "day" | "week" | "month" | "total";

/** A validated ingress request. Unknown extra keys survive in `extra`. */
export interface RouterRequest {
  project: string;
  importance: Importance;
  mode: Mode;
  provider: string;
  model: string;
  aiGatewayId?: string;
  transport?: Transport;
  stream?: boolean;
  providerApiKey?: string;
  input: unknown;
  /** Top-level keys not in the known set — captured to payloadJson. */
  extra: Record<string, unknown>;
}

export interface Usage { tokensIn: number; tokensOut: number; }
export interface PricedUsage extends Usage {
  tokensInCost: number; tokensOutCost: number; costUsd: number;
}

/** Circuit scope string, e.g. "global" | "provider:openai" | "model:openai/gpt-5" | "project:acre". */
export type CircuitScope = string;
export interface Circuit {
  budgetUsd: number; window: Window; enabled: boolean; breakGlassUntil?: number;
}
export interface BreakerVerdict {
  admitted: boolean; scope?: CircuitScope; message?: string;
}
