/** A CLI error carrying a stable exit code (see the exit-code table in README). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}
