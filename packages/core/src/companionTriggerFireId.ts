import { uuidv5 } from "./companionRoutineFireId";

/**
 * Namespace for deterministic trigger-fire `client_message_id`s. An external service that retries a
 * webhook delivery collapses to exactly one turn via `(companion_id, client_message_id)`, keyed on
 * the trigger and the provider's delivery id rather than on when the request arrived.
 */
export const TRIGGER_FIRE_NAMESPACE = "b7f1d5e3-9ca2-5444-8d58-2e3f4a5b6c7d";

export function triggerFireMessageId(input: {
  triggerId: string;
  deliveryId: string;
}): string {
  return uuidv5(`${input.triggerId}|${input.deliveryId}`, TRIGGER_FIRE_NAMESPACE);
}
