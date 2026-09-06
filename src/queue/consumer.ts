import { runMemoryRetention } from "../memory/retention";
import type { Env, QueueMessage } from "../types";
import { persistExchange } from "../gateway/record";

export async function handleQueueMessage(message: QueueMessage, env: Env): Promise<void> {
  switch (message.type) {
    case "gateway_exchange":
      await persistExchange(env, message);
      return;
    case "retention":
      await runMemoryRetention(env, message.namespace);
      return;
    default:
      console.warn("queue: unknown message type", (message as { type?: string }).type);
  }
}
