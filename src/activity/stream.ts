import { generateId } from '../util/id.js';

export type AirlockActivityKind = 'notification' | 'log';
export type AirlockActivitySeverity = 'info' | 'success' | 'warning' | 'error';

export interface AirlockActivityEvent {
  id: string;
  kind: AirlockActivityKind;
  agentId: string;
  title: string;
  body: string;
  severity: AirlockActivitySeverity;
  createdAt: string;
}

type ActivityListener = (event: AirlockActivityEvent) => void;

export class ActivityStream {
  private events: AirlockActivityEvent[] = [];
  private listeners = new Set<ActivityListener>();

  constructor(private maxEvents = 200) {}

  emit(params: {
    kind: AirlockActivityKind;
    agentId: string;
    title: string;
    body: string;
    severity?: AirlockActivitySeverity;
  }): AirlockActivityEvent {
    const event: AirlockActivityEvent = {
      id: generateId(),
      kind: params.kind,
      agentId: params.agentId,
      title: params.title,
      body: params.body,
      severity: params.severity ?? 'info',
      createdAt: new Date().toISOString(),
    };

    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(0, this.maxEvents);
    }
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  recent(): AirlockActivityEvent[] {
    return [...this.events];
  }

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
