// What a tool result may weigh for the client that receives it. Plain data, no `vscode`.
//
// GitHub Copilot does not give its model a large tool result: it writes the result to a file and
// hands over the path and a preview, which costs the model another call to read what it asked for
// and loses a snapshot's refs from its context. The Copilot harness in VS Code sets that limit to
// 20 KiB (`largeOutput: { maxSizeBytes: 20 * 1024 }` in its agent host, read in VS Code 1.147); the
// Copilot CLI has the same mechanism. The limit counts bytes, and Copane's own limits count
// characters: a page in Japanese is half again as many bytes as characters.
import type { SessionClient } from './sessions';

/** Above this, Copilot hands its model a file instead of the result. */
export const COPILOT_FILE_THRESHOLD_BYTES = 20 * 1024;

/**
 * What the sized part of a result (a snapshot, a log, a command's output) may weigh for Copilot.
 * Below the threshold by enough for the lines around that part (a page's URL and title, a
 * command's status) and for a count that includes JSON escaping, should Copilot measure that.
 */
export const COPILOT_BLOCK_BYTES = 17_000;

/** The byte limit for the sized part of a result sent to this client; undefined when it has none. */
export function blockByteLimit(client: Pick<SessionClient, 'kind'>): number | undefined {
  return client.kind === 'copilot' ? COPILOT_BLOCK_BYTES : undefined;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Renders with a character limit and, when the result is over `maxBytes`, again with a lower one
 * until it fits (a few times at most, never below `minChars`): the renderers cut at their own
 * boundaries (a line, an element) and say how to read on, which a cut by bytes afterwards could not.
 * Without `maxBytes` this is `render(maxChars)`.
 */
export function fitBytes<T>(render: (maxChars: number) => T, textOf: (rendered: T) => string, maxChars: number, maxBytes: number | undefined, minChars = 1000): T {
  let rendered = render(maxChars);
  if (maxBytes === undefined) return rendered;
  for (let attempt = 0; attempt < 4; attempt++) {
    const bytes = utf8Bytes(textOf(rendered));
    if (bytes <= maxBytes) break;
    // In proportion, and a little less: where the renderer cuts depends on what is there.
    const next = Math.max(minChars, Math.floor(((maxChars * maxBytes) / bytes) * 0.97));
    if (next >= maxChars) break;
    maxChars = next;
    const smaller = render(maxChars);
    // A renderer that does not get smaller at a lower limit: keep what there was.
    if (utf8Bytes(textOf(smaller)) >= bytes) break;
    rendered = smaller;
  }
  return rendered;
}
