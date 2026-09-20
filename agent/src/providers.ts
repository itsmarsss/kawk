import { z } from "zod";
import { BasetenModel, CodexModel, CodexReasoning, FallbackModel } from "./models";
import { OpenAIModel } from "./openai";

export const ProviderConfig = z.object({
  KAWK_MODEL_PROVIDER: z.enum(["openai", "codex"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  KAWK_OPENAI_MODEL: z.string().min(1).default("gpt-5.6-sol"),
  // Other efforts need reasoning-item persistence before being enabled.
  KAWK_OPENAI_REASONING: z.literal("none").default("none"),
  KAWK_CODEX_MODEL: z.string().optional(),
  KAWK_CODEX_REASONING: CodexReasoning,
  BASETEN_API_KEY: z.string().optional(),
  KAWK_BASETEN_MODEL: z.string().optional(),
});
export function createModels(
  env: Record<string, string | undefined>,
  codexTelemetry = true,
  basetenOnly = false,
) {
  const parsed = ProviderConfig.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid provider configuration: ${parsed.error.issues.map((e) => e.path.join(".")).join(", ")}`,
    );
  const config = parsed.data;
  const fallback =
    config.BASETEN_API_KEY && config.KAWK_BASETEN_MODEL
      ? new BasetenModel({ apiKey: config.BASETEN_API_KEY, model: config.KAWK_BASETEN_MODEL })
      : undefined;
  if (basetenOnly) {
    if (!fallback) throw new Error("Configure Baseten key/model first");
    return {
      model: fallback,
      primary: fallback,
      fallback,
      provider: "baseten" as const,
      modelName: config.KAWK_BASETEN_MODEL!,
      reasoning: "provider default",
    };
  }
  const primary =
    config.KAWK_MODEL_PROVIDER === "openai"
      ? new OpenAIModel({ apiKey: config.OPENAI_API_KEY ?? "", model: config.KAWK_OPENAI_MODEL })
      : new CodexModel({
          model: config.KAWK_CODEX_MODEL,
          reasoning: config.KAWK_CODEX_REASONING,
          telemetry: codexTelemetry,
        });
  return {
    model: new FallbackModel(primary, fallback),
    primary,
    fallback,
    provider: config.KAWK_MODEL_PROVIDER,
    modelName:
      config.KAWK_MODEL_PROVIDER === "openai"
        ? config.KAWK_OPENAI_MODEL
        : (config.KAWK_CODEX_MODEL ?? "CLI default"),
    reasoning: primary.reasoning,
  };
}
