/**
 * An error whose message is written for the agent: it says what went wrong and what to do next.
 * Tool handlers throw it for expected failures; the registry turns it into an `isError` tool result.
 */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export type ToolErrorCode =
  | 'not_found' // The tab or terminal id does not exist (any more).
  | 'access_denied' // The user declined, or a setting forbids it.
  | 'busy' // Another agent session currently controls the resource.
  | 'unavailable' // A required VS Code capability is missing (e.g. the browser API is not enabled).
  | 'timeout'
  | 'cancelled'
  | 'invalid_input'
  | 'failed';
