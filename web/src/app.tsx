import { useEffect } from 'preact/hooks';
import { Activity } from './activity';
import { AssistantDrawer } from './assistant';
import { Composer } from './composer';
import { EntityPage, Roster } from './entities';
import { KeyReveal } from './key-reveal';
import { Providers } from './providers';
import { StoreProvider, useRoute, useStore } from './store';
import { cx } from './ui';
import shieldUrl from './assets/airlock-shield.png';

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { state, loadError, pending, status, meta, toasts, assistantOpen, setAssistantOpen } =
    useStore();
  const [section = 'agents', second, third] = route;
  const path = route.join('/');

  useEffect(() => window.scrollTo(0, 0), [path]);

  useEffect(() => {
    document.title = pending.length ? `(${pending.length}) Airlock` : 'Airlock';
  }, [pending.length]);

  // n opens the composer for whatever list you're looking at.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      )
        return;
      if (e.key === 'n' && (section === 'agents' || section === 'profiles') && !second) {
        window.location.hash = `/${section}/new`;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [section, second]);

  const providerIssues = status ? status.summary.down : 0;
  const nav = [
    { id: 'agents', label: 'Agents', count: state ? Object.keys(state.agents).length : undefined },
    {
      id: 'profiles',
      label: 'Profiles',
      count: state ? Object.keys(state.profiles).length : undefined,
    },
    { id: 'activity', label: 'Activity', alert: pending.length },
    { id: 'providers', label: 'Providers', alert: providerIssues },
  ];

  let page = null;
  if (loadError) {
    page = (
      <div class="page">
        <div class="empty">
          <p class="empty-title">Airlock could not read its config</p>
          <p>{loadError}</p>
        </div>
      </div>
    );
  } else if (!state) {
    page = <div class="page boot" aria-busy="true" />;
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
  } else if (section === 'activity') {
    page = <Activity />;
  } else if (section === 'providers') {
    page = <Providers />;
  }

  return (
    <div class={cx('shell', assistantOpen && 'has-assistant')}>
      <nav class="rail" aria-label="Main">
        <a class="brand" href="#/agents" aria-label="Airlock home">
          <img class="brand-mark" src={shieldUrl} alt="" width={28} height={28} />
          <span class="brand-word">Airlock</span>
        </a>
        <ul class="rail-nav">
          {nav.map((item) => (
            <li key={item.id}>
              <a
                href={`#/${item.id}`}
                class={cx('rail-link', section === item.id && 'is-active')}
                aria-current={section === item.id ? 'page' : undefined}
              >
                <span>{item.label}</span>
                {item.alert ? (
                  <span class="rail-alert">{item.alert}</span>
                ) : item.count !== undefined ? (
                  <span class="rail-count">{item.count}</span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
        <div class="rail-foot">
          <button
            type="button"
            class={cx('rail-assistant', assistantOpen && 'is-active')}
            onClick={() => setAssistantOpen(!assistantOpen)}
          >
            Assistant
          </button>
          {state && (
            <p class="rail-config" title={state.configPath}>
              {state.configPath.split('/').slice(-2).join('/')}
            </p>
          )}
          <p class="rail-version">
            {meta ? `v${meta.version}` : ''} <a href="/classic">Classic view</a>
          </p>
        </div>
      </nav>
      <main class="stage">{page}</main>
      <AssistantDrawer />
      <KeyReveal />
      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} class={cx('toast', `is-${t.tone}`)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
