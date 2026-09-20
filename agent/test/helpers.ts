import type { ChatMessage, Decision, Gate, LanguageModel, PerceptionEvent } from "../src/contracts";
export const event = (
  id: string,
  text: string,
  overrides: Partial<PerceptionEvent> = {},
): PerceptionEvent => ({
  id,
  text,
  deviceId: "test-device",
  streamId: "test-stream",
  revision: 0,
  kind: "transcript",
  final: true,
  sourceStart: Date.now(),
  sourceEnd: Date.now(),
  confidence: 0.95,
  speakerId: null,
  personIds: [],
  provenance: "fixture",
  ...overrides,
});
export const decision = (overrides: Partial<Decision> = {}): Decision => ({
  act: true,
  remember: false,
  route: "start",
  targetId: null,
  confidence: 0.95,
  ...overrides,
});
export const gate: Gate = {
  async decide() {
    return decision();
  },
};
export const call = (name: string, args: unknown, id = crypto.randomUUID()): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
export const model = (
  fn: (messages: ChatMessage[]) => ChatMessage | Promise<ChatMessage>,
): LanguageModel => ({
  async complete(messages) {
    return { message: await fn(messages), tokens: 10 };
  },
});
export async function until(fn: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for condition");
    await Bun.sleep(10);
  }
}
