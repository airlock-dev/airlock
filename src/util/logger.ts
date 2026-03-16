import pino from 'pino';
import { createPrettyDestination } from './pretty-transport.js';

export const prettyEnabled =
  process.env.LOG_FORMAT === 'pretty' || process.argv.includes('--pretty');

function createTransport() {
  if (prettyEnabled) return undefined; // handled via destination stream
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    // pino-pretty is optional — only used in development
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, destination: 2 } };
  } catch {
    return undefined;
  }
}

function createLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL ?? 'info';

  if (prettyEnabled) {
    return pino({ name: 'airlock', level }, createPrettyDestination());
  }

  const transport = createTransport();
  // Always log to stderr (fd 2) so stdout stays clean for MCP stdio transport.
  // When using pino-pretty, destination is set in the transport options.
  // When not using a transport, we pass pino.destination(2) as the stream.
  return transport
    ? pino({ name: 'airlock', level, transport })
    : pino({ name: 'airlock', level }, pino.destination(2));
}

export const logger = createLogger();

export function childLogger(component: string) {
  return logger.child({ component });
}
