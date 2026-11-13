export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Prefixes every message, so each module's lines are recognisable in the shared output channel. */
export function scopedLogger(logger: Logger, scope: string): Logger {
  const wrap =
    (fn: Logger['info']) =>
    (message: string, ...args: unknown[]) =>
      fn.call(logger, `[${scope}] ${message}`, ...args);
  return { debug: wrap(logger.debug), info: wrap(logger.info), warn: wrap(logger.warn), error: wrap(logger.error) };
}
