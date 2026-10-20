import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from './api';
import { ChangeList } from './review';
import { go, useStore } from './store';
import type { ChatMessage, Proposal } from './types';
import { Button, cx } from './ui';

interface Turn {
  message: ChatMessage;
  proposals: Proposal[];
}

type ProposalState = 'open' | 'applied' | 'dismissed';

const STARTERS = [
  'Make a read-only agent for Claude Code on my laptop',
  'Create a profile for GitHub that reads freely but asks before writing',
  'Which of my agents can delete things without asking?',
];

const TOOL_LABEL: Record<string, string> = {
  get_config: 'Read your agents and profiles',
  list_tools: 'Looked through the tool list',
  preview_changes: 'Checked a draft against the config',
  propose_changes: 'Prepared a proposal',
  'propose_changes:failed': 'A draft did not pass validation',
  'preview_changes:failed': 'A draft did not pass validation',
};

export function AssistantDrawer() {
  const { assistantOpen, setAssistantOpen, meta, setState, reveal, toast } = useStore();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ProposalState>>({});
  const [applying, setApplying] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (assistantOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [assistantOpen]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, busy]);

  useEffect(() => {
    if (!assistantOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAssistantOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assistantOpen]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    const userMessage: ChatMessage = { role: 'user', content };
    const nextHistory = [...history, userMessage];
    setHistory(nextHistory);
    setTurns((list) => [...list, { message: userMessage, proposals: [] }]);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const result = await api.chat(nextHistory);
      setHistory([...nextHistory, ...result.messages]);
      const visible = result.messages.filter((m) => m.role === 'assistant');
      // A tool result with an error (for example a draft that failed validation) is reported as
      // such, so the step list never claims a proposal that isn't there.
      const failed = new Set(
        result.messages
          .filter((m) => m.role === 'tool' && m.content?.startsWith('{"error"'))
          .map((m) => m.tool_call_id)
      );
      const steps = result.messages
        .filter((m) => m.role === 'assistant' && m.tool_calls?.length)
        .flatMap((m) =>
          m.tool_calls!.map((c) =>
            failed.has(c.id) ? `${c.function.name}:failed` : c.function.name
          )
        );
      const final = [...visible].reverse().find((m) => m.content?.trim());
      setTurns((list) => [
        ...list,
        {
          message: {
            role: 'assistant',
            content: final?.content ?? '',
            tool_calls: steps.map((name, i) => ({
              id: String(i),
              type: 'function',
              function: { name, arguments: '' },
            })),
          },
          proposals: result.proposals,
        },
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyProposal = async (proposal: Proposal) => {
    setApplying(proposal.id);
    try {
      const result = await api.apply(proposal.ops, proposal.preview.version);
      setState(result.state);
      setDecisions((d) => ({ ...d, [proposal.id]: 'applied' }));
      if (result.createdKeys.length) reveal(result.createdKeys);
      else toast(`Applied: ${proposal.title}`);
      const created =
        proposal.ops.find((op) => op.op === 'create_agent') ??
        proposal.ops.find((op) => op.op === 'create_profile');
      if (created) go(created.op === 'create_agent' ? 'agents' : 'profiles', created.id);
      setHistory((h) => [...h, { role: 'user', content: `(I applied "${proposal.title}".)` }]);
    } catch (e) {
      toast(`${(e as Error).message} Ask the assistant to refresh its proposal.`, 'error');
    } finally {
      setApplying(null);
    }
  };

  return (
    <aside
      class={cx('assistant', assistantOpen && 'is-open')}
      aria-hidden={!assistantOpen}
      aria-label="Policy assistant"
    >
      <header class="assistant-head">
        <div>
          <h2>Assistant</h2>
          {meta?.assistant.model && <p class="dim">{meta.assistant.model}</p>}
        </div>
        <button
          type="button"
          class="icon-btn"
          aria-label="Close assistant"
          onClick={() => setAssistantOpen(false)}
        >
          ×
        </button>
      </header>

      {!meta?.assistant.enabled ? (
        <div class="assistant-setup">
          <p>
            The assistant drafts agents and profiles from a plain description. It reads your rules
            and the tool list, never your keys, and it cannot call any tool. Every change it
            suggests waits for you to apply it.
          </p>
          <p>Point the dashboard at any OpenAI-compatible endpoint and restart it:</p>
          <pre>
            AIRLOCK_ASSISTANT_BASE_URL=https://openrouter.ai/api/v1{'\n'}
            AIRLOCK_ASSISTANT_MODEL=your-model-id{'\n'}AIRLOCK_ASSISTANT_API_KEY=your-api-key
          </pre>
        </div>
      ) : (
        <>
          <div class="assistant-log" ref={logRef} aria-live="polite">
            {turns.length === 0 && (
              <div class="assistant-intro">
                <p>
                  Describe the agent or profile you want. I'll check your tools and draft it for you
                  to review.
                </p>
                <ul class="starters">
                  {STARTERS.map((s) => (
                    <li key={s}>
                      <button type="button" onClick={() => send(s)}>
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {turns.map((turn, i) => (
              <div key={i} class={cx('turn', `is-${turn.message.role}`)}>
                {turn.message.tool_calls?.length ? (
                  <ul class="steps">
                    {Array.from(new Set(turn.message.tool_calls.map((c) => c.function.name))).map(
                      (name) => (
                        <li key={name} class={cx(name.endsWith(':failed') && 'is-failed')}>
                          {TOOL_LABEL[name] ?? name.replace(':failed', ' failed')}
                        </li>
                      )
                    )}
                  </ul>
                ) : null}
                {turn.message.content && <p class="bubble">{turn.message.content}</p>}
                {turn.proposals.map((proposal) => {
                  const state = decisions[proposal.id] ?? 'open';
                  return (
                    <article class={cx('proposal', `is-${state}`)} key={proposal.id}>
                      <header>
                        <h3>{proposal.title}</h3>
                        {proposal.summary && <p>{proposal.summary}</p>}
                      </header>
                      <ChangeList preview={proposal.preview} />
                      <footer>
                        {state === 'open' ? (
                          <>
                            <Button
                              size="sm"
                              variant="quiet"
                              onClick={() => {
                                setDecisions((d) => ({ ...d, [proposal.id]: 'dismissed' }));
                                setHistory((h) => [
                                  ...h,
                                  { role: 'user', content: `(I dismissed "${proposal.title}".)` },
                                ]);
                              }}
                            >
                              Dismiss
                            </Button>
                            <Button
                              size="sm"
                              variant="primary"
                              busy={applying === proposal.id}
                              onClick={() => applyProposal(proposal)}
                            >
                              Apply
                            </Button>
                          </>
                        ) : (
                          <span class="dim">{state === 'applied' ? 'Applied' : 'Dismissed'}</span>
                        )}
                      </footer>
                    </article>
                  );
                })}
              </div>
            ))}
            {busy && <p class="thinking">Working on it</p>}
            {error && <p class="notice notice-error">{error}</p>}
          </div>
          <form
            class="assistant-input"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <textarea
              ref={inputRef}
              rows={3}
              value={input}
              placeholder="An agent for Codex on my build server that reads GitHub and Linear, and asks before writing"
              aria-label="Message"
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
            />
            <div class="assistant-input-foot">
              <span class="dim">Proposals change nothing until you apply them.</span>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                busy={busy}
                disabled={!input.trim()}
              >
                Send
              </Button>
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
