import chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { loadConfig } from './loader.js';
import type { Config } from './loader.js';
import { childLogger } from '../util/logger.js';

const log = childLogger('config-watcher');

export class ConfigWatcher extends EventEmitter {
  private watcher?: ReturnType<typeof chokidar.watch>;

  constructor(private configPath: string) {
    super();
  }

  start(): void {
    this.watcher = chokidar.watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher.on('change', () => {
      log.info({ path: this.configPath }, 'Config file changed, reloading');
      try {
        const newConfig = loadConfig(this.configPath);
        this.emit('reload', newConfig);
        log.info('Config reloaded successfully');
      } catch (err) {
        log.error({ err }, 'Failed to reload config, keeping old config');
      }
    });
  }

  stop(): void {
    this.watcher?.close();
  }

  on(event: 'reload', listener: (config: Config) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}
