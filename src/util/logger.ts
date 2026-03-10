import pino from 'pino';

export const logger = pino({
  name: 'airlock',
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export function childLogger(component: string) {
  return logger.child({ component });
}
