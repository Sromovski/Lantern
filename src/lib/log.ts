import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export interface LoggerOptions {
  dir: string;
  now?: () => Date;
  echo?: (line: string) => void;
}

function serialize(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

export function createLogger(opts: LoggerOptions, base: Fields = {}): Logger {
  const now = opts.now ?? (() => new Date());
  mkdirSync(opts.dir, { recursive: true });

  const write = (level: LogLevel, msg: string, fields: Fields = {}) => {
    const ts = now();
    const record: Fields = { ts: ts.toISOString(), level, msg };
    for (const [k, v] of Object.entries({ ...base, ...fields })) record[k] = serialize(v);
    const line = JSON.stringify(record);
    appendFileSync(join(opts.dir, `lantern-${ts.toISOString().slice(0, 10)}.jsonl`), line + '\n');
    opts.echo?.(line);
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger(opts, { ...base, ...fields }),
  };
}
