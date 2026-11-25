import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  Activity as ActivityIcon,
  Bot,
  CircleAlert,
  CircleCheck,
  Inbox as InboxIcon,
  KeyRound,
  Layers,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Server,
  Sparkles,
  Sun,
} from 'lucide-preact';
import { Activity } from './activity';
import { AssistantDrawer } from './assistant';
import { Composer } from './composer';
import { EntityPage, Roster } from './entities';
import { GrantsPage } from './grants';
import { Inbox } from './inbox';
import { KeyReveal } from './key-reveal';
import { Providers } from './providers';
import { StoreProvider, useRoute, useStore } from './store';
import type { ThemePreference } from './types';
import { Button, Empty, Kbd, Segmented, Sheet, cx } from './ui';
import shieldUrl from './assets/airlock-shield.png';

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

interface NavItem {
  id: string;
  label: string;
  icon: ComponentChildren;
  count?: number;
  attention?: number;
  danger?: boolean;
}

const ALIASES: Record<string, string> = { '': 'inbox', overview: 'inbox', approvals: 'inbox' };

function Shell() {
  const route = useRoute();
  const {
    state,
    loadError,
    pending,
    grants,
    status,
    meta,
    liveState,
    toasts,
    assistantOpen,
    setAssistantOpen,
    theme,
    setTheme,
  } = useStore();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  const [raw = '', second, third] = route;
  const section = ALIASES[raw] ?? raw;
  const path = route.join('/');

  useEffect(() => {
    window.scrollTo(0, 0);
    setNavOpen(false);
  }, [path]);

  useEffect(() => {
    document.title = pending.length ? `(${pending.length}) Airlock` : 'Airlock';
  }, [pending.length]);

  useEffect(() => {
    const color = getComputedStyle(document.body).backgroundColor;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  }, [theme]);

  // Global keys: / search, ? shortcuts, n new, g-then-letter to jump.
  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if (e.metaKey || e.ctrlKey || e.altKey || inInput) return;

      if (pendingG && Date.now() - pendingG < 900) {
        const jump: Record<string, string> = {
          i: 'inbox',
          g: 'grants',
          l: 'activity',
          a: 'agents',
          p: 'profiles',
          v: 'providers',
        };
        pendingG = 0;
        if (jump[e.key]) {
          e.preventDefault();
          e.stopPropagation();
          window.location.hash = `/${jump[e.key]}`;
          return;
        }
      }
      if (e.key === 'g' && !document.querySelector('.scrim, .menu, .assistant.is-open')) {
        pendingG = Date.now();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === '/') {
        const search = document.querySelector<HTMLInputElement>('[data-page-search="true"]');
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if (e.key === 'n') {
        if ((section === 'agents' || section === 'profiles') && !second) {
          e.preventDefault();
          window.location.hash = `/${section}/new`;
        } else if (section === 'providers') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('airlock:new-provider'));
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [section, second]);

  const down = status?.summary.down ?? 0;
  const live: NavItem[] = [
    {
      id: 'inbox',
      label: 'Inbox',
      icon: <InboxIcon size={16} aria-hidden="true" />,
      attention: pending.length,
    },
    {
      id: 'grants',
      label: 'Grants',
      icon: <KeyRound size={16} aria-hidden="true" />,
      count: grants.length || undefined,
    },
    { id: 'activity', label: 'Activity', icon: <ActivityIcon size={16} aria-hidden="true" /> },
  ];
  const policy: NavItem[] = [
    {
      id: 'agents',
      label: 'Agents',
      icon: <Bot size={16} aria-hidden="true" />,
      count: state ? Object.keys(state.agents).length : undefined,
    },
    {
      id: 'profiles',
      label: 'Profiles',
      icon: <Layers size={16} aria-hidden="true" />,
      count: state ? Object.keys(state.profiles).length : undefined,
    },
    {
      id: 'providers',
      label: 'Providers',
      icon: <Server size={16} aria-hidden="true" />,
      count: state ? Object.keys(state.providers).length : undefined,
      attention: down,
      danger: true,
    },
  ];

  let page: ComponentChildren = null;
  if (loadError) {
    page = (
      <div class="page">
        <Empty title="Airlock could not read its config">
          <p>{loadError}</p>
        </Empty>
      </div>
    );
  } else if (!state) {
    page = <div class="boot" aria-busy="true" />;
  } else if (section === 'inbox') {
    page = <Inbox />;
  } else if (section === 'grants') {
    page = <GrantsPage />;
  } else if (section === 'activity') {
    page = <Activity />;
  } else if (section === 'agents' || section === 'profiles') {
    const kind = section === 'agents' ? 'agent' : 'profile';
    page =
      second === 'new' ? (
        <Composer key={`${kind}-new-${third ?? ''}`} kind={kind} baseId={third} />
      ) : second ? (
        <EntityPage key={`${kind}-${second}`} kind={kind} id={second} />
      ) : (
        <Roster kind={kind} />
      );
  } else if (section === 'providers') {
    page = <Providers />;
  } else {
    page = <Inbox />;
  }

  const nav = (items: NavItem[]) => (
    <ul class="rail-nav">
      {items.map((item) => (
        <li key={item.id}>
          <a
            href={`#/${item.id}`}
            class="rail-link"
            aria-current={section === item.id ? 'page' : undefined}
          >
            {item.icon}
            <span class="rail-link-label">{item.label}</span>
            {item.attention ? (
              <span
                class={cx('rail-count', 'is-attention', item.danger && 'is-danger')}
                aria-label={item.danger ? `${item.attention} down` : `${item.attention} waiting`}
              >
                {item.attention}
              </span>
            ) : item.count !== undefined ? (
              <span class="rail-count">{item.count}</span>
            ) : null}
          </a>
        </li>
      ))}
    </ul>
  );

  const markStyle = { '--mark': `url(${shieldUrl})` } as Record<string, string>;

  return (
    <div class="shell" style={markStyle}>
      <a class="skip-link" href="#main">
        Skip to content
      </a>

      <div class="mobile-bar">
        <Button
          variant="ghost"
          icon
          aria-label="Open navigation"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
        >
          <MenuIcon size={16} aria-hidden="true" />
        </Button>
        <a class="brand" href="#/inbox">
          <span class="brand-mark" aria-hidden="true" />
          Airlock
        </a>
        {pending.length > 0 && section !== 'inbox' && (
          <a href="#/inbox" class="rail-count is-attention">
            {pending.length} waiting
          </a>
        )}
      </div>

      {navOpen && <div class="rail-scrim" onClick={() => setNavOpen(false)} />}
      <nav class={cx('rail', navOpen && 'is-open')} aria-label="Main">
        <a class="brand" href="#/inbox" aria-label="Airlock, go to Inbox">
          <span class="brand-mark" aria-hidden="true" />
          Airlock
        </a>
        {nav(live)}
        <div class="rail-divider" role="separator" />
        {nav(policy)}

        <div class="rail-foot">
          <a
            href="#/assistant"
            class="rail-link"
            aria-pressed={assistantOpen}
            onClick={(e) => {
              e.preventDefault();
              setAssistantOpen(!assistantOpen);
            }}
          >
            <Sparkles size={16} aria-hidden="true" />
            <span class="rail-link-label">Policy assistant</span>
          </a>
          <Segmented<ThemePreference>
            label="Theme"
            class="is-icons"
            value={theme}
            onChange={setTheme}
            options={[
              {
                value: 'system',
                label: <Monitor size={14} aria-hidden="true" />,
                title: 'System theme',
              },
              { value: 'light', label: <Sun size={14} aria-hidden="true" />, title: 'Light theme' },
              { value: 'dark', label: <Moon size={14} aria-hidden="true" />, title: 'Dark theme' },
            ]}
          />
          <div class="rail-meta">
            <span class={cx('dot', `is-${liveState}`)} aria-hidden="true" />
            <span>
              {liveState === 'live'
                ? 'Live'
                : liveState === 'reconnecting'
                  ? 'Reconnecting…'
                  : 'Config only'}
            </span>
            {meta && <span>· v{meta.version}</span>}
            <span class="rail-meta-spacer" />
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              onClick={() => setShortcutsOpen(true)}
            >
              <Kbd>?</Kbd>
            </Button>
          </div>
          {state && (
            <p class="rail-config truncate" title={state.configPath}>
              {state.configPath.split('/').slice(-2).join('/')}
            </p>
          )}
        </div>
      </nav>

      <main class="stage" id="main">
        {page}
      </main>
      <AssistantDrawer />
      <KeyReveal />

      <Sheet
        open={shortcutsOpen}
        dialog
        onClose={() => setShortcutsOpen(false)}
        title="Keyboard shortcuts"
      >
        <dl class="shortcuts">
          {(
            [
              [['J', 'K'], 'Next and previous request'],
              [['A'], 'Approve once'],
              [['D'], 'Deny'],
              [['Enter'], 'Open request (on small screens)'],
              [['/'], 'Search this page'],
              [['N'], 'New agent, profile, or provider'],
              [['G', 'I'], 'Go to Inbox'],
              [['G', 'L'], 'Go to Activity'],
              [['G', 'A'], 'Go to Agents'],
              [['Esc'], 'Close panel or menu'],
            ] as const
          ).map(([keys, text]) => (
            <div key={text}>
              <dt>{text}</dt>
              <dd>
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </Sheet>

      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} class={cx('toast', t.tone === 'error' && 'is-error')}>
            {t.tone === 'error' ? (
              <CircleAlert size={15} aria-hidden="true" />
            ) : (
              <CircleCheck size={15} aria-hidden="true" />
            )}
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
