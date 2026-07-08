export async function unsupportedService(): Promise<never> {
  throw new Error("Companion agent service management is not supported on this platform yet");
}
