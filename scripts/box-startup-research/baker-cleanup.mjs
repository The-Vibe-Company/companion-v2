export async function retryTrackedBakerBoxCleanup(input) {
  let complete = true;
  for (const boxId of input.boxIds) {
    try {
      const result = await input.lifecycle.deletePermanentlyAndWait({
        boxId,
        deadlineAt: input.now() + 120_000,
        signal: input.signal,
      });
      if (result.outcome !== "deleted" && result.outcome !== "already_deleted") complete = false;
    } catch {
      complete = false;
    }
  }
  return complete;
}
