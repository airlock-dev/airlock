import pino from 'pino';

function createTransport() {
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    // pino-pretty is optional — only used in development
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true } };
  } catch {
    return undefined;
  }
}

export const logger = pino({
  name: 'airlock',
  level: process.env.LOG_LEVEL ?? 'info',
  transport: createTransport(),
});

export function childLogger(component: string) {
  return logger.child({ component });
}
