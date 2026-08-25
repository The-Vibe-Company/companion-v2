export {
  BrokerCommandError,
  COMPANION_PI_BROKER_MAX_COMMAND_BYTES,
  COMPANION_PI_BROKER_MAX_LINE_BYTES,
  COMPANION_PI_BROKER_READ_LIMIT,
  COMPANION_PI_BROKER_READ_BYTES,
  COMPANION_PI_BROKER_SEGMENT_BYTES,
  COMPANION_PI_SUPPORTED_EVENT_TYPES,
  CompanionPiDispatchLedger,
  CompanionPiBroker,
  SegmentedCompanionPiJournal,
  StrictLfJsonlDecoder,
  createCompanionPiOutputDecoder,
  normalizePiModelCatalog,
  sendCompanionPiBrokerCommand,
  startCompanionPiBrokerSocket,
} from "./companionPiBrokerCore";
export type {
  CompanionPiBrokerClientOptions,
  CompanionPiAcceptedDispatch,
  CompanionPiBrokerCounters,
  CompanionPiBrokerOptions,
  CompanionPiBrokerSocketOptions,
  CompanionPiJournalAppend,
  CompanionPiJournalRead,
  CompanionPiJournalRecord,
  CompanionPiRpcTransport,
  PiJsonObject,
  SegmentedCompanionPiJournalOptions,
  StrictLfJsonlDecoderOptions,
} from "./companionPiBrokerCore";

/** Paths relative to the Box user's home. */
export const COMPANION_PI_BROKER_SCRIPT_PATH = ".companion/bin/companion-pi-broker.mjs";
export const COMPANION_PI_BROKER_SOCKET_PATH = ".companion/runtime/state/pi-broker.sock";
export const COMPANION_PI_BROKER_JOURNAL_PATH = ".companion/runtime/events";

/**
 * Standalone ESM staged onto layout-14 Boxes. Kept in a separate source module so the control-plane
 * adapter can install the exact broker tested in this package without adding a Box dependency.
 */
export { COMPANION_PI_BROKER_SOURCE } from "./companionPiBrokerSource";
