"""Toy summarizer — illustrative only. The control plane never executes this; it
runs inside a sandboxed agent workload at attach time."""


def summarize(logs: list[str]) -> str:
    return f"Reviewed {len(logs)} log excerpts; see timeline above."
