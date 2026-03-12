import pino from 'pino';

function createTransport() {
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    // pino-pretty is optional — only used in development
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, destination: 2 } };
  } catch {
    return undefined;
  }
}

const transport = createTransport();

// Always log to stderr (fd 2) so stdout stays clean for MCP stdio transport.
// When using pino-pretty, destination is set in the transport options.
// When not using a transport, we pass pino.destination(2) as the stream.
export const logger = transport
  ? pino({ name: 'airlock', level: process.env.LOG_LEVEL ?? 'info', transport })
  : pino({ name: 'airlock', level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));

export function childLogger(component: string) {
  return logger.child({ component });
}
