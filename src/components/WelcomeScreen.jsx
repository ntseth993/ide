/**
 * Welcome screen: hero, quick-start actions, recent workspaces, a feature
 * launcher, an account card and an appearance switch — all wired to real
 * NovaCode commands so nothing here is a dead placeholder.
 */
import { projectName } from '../utils/pathUtils';
import { THEMES } from '../themes';
import {
  NovaMarkIcon,
  FolderPlusIcon,
  FilePlusIcon,
  CommandIcon,
  SparkleIcon,
  TerminalIcon,
  PuzzleIcon,
  HistoryIcon,
  SearchIcon,
  PlayIcon,
  SignOutIcon,
  UserIcon,
} from './Icons';

const FEATURES = [
  { id: 'view.ai', icon: SparkleIcon, label: 'AI Assistant', desc: 'Agent · Ask · inline code' },
  { id: 'terminal.new', icon: TerminalIcon, label: 'New Terminal', desc: 'Run shell commands' },
  { id: 'view.extensions', icon: PuzzleIcon, label: 'Extensions', desc: 'Language & themes' },
  { id: 'view.history', icon: HistoryIcon, label: 'Change History', desc: 'Undo snapshots' },
  { id: 'view.search', icon: SearchIcon, label: 'Search', desc: 'Find across files' },
  { id: 'run.file', icon: PlayIcon, label: 'Run File', desc: 'F5 · execute editor' },
];

export default function WelcomeScreen({
  recentProjects = [],
  onOpenFolder,
  onNewProject,
  onOpenRecent,
  onCommand,
  account = null,
  isDesktop = false,
  onSignIn,
  onSignOut,
  theme = 'dark',
  onSetTheme,
}) {
  const run = (id) => () => onCommand?.(id);

  return (
    <section className="welcome-screen">
      <div className="welcome-shell">
        <div className="welcome-grid">
          {/* ---- Left: hero + primary actions + recents ---- */}
          <div className="welcome-main">
            <header className="welcome-hero">
              <span className="welcome-mark" aria-hidden="true">
                <NovaMarkIcon size={30} />
              </span>
              <p className="eyebrow">Desktop IDE · Offline-first</p>
              <h1>NovaCode</h1>
              <p className="hero-sub">
                A professional AI-powered development environment. Everything works locally — editing,
                search, terminal — and the assistant connects securely when you add your own key.
              </p>
            </header>

            <div className="welcome-actions">
              <button type="button" className="primary" onClick={onOpenFolder}>
                <FolderPlusIcon size={16} /> Open Folder
              </button>
              <button type="button" className="secondary" onClick={onNewProject}>
                <FilePlusIcon size={16} /> New Project
              </button>
              <button type="button" className="ghost" onClick={run('open-palette')}>
                <CommandIcon size={16} /> Command Palette
              </button>
            </div>

            <div className="welcome-hints">
              <div>
                <kbd>Ctrl</kbd>+<kbd>P</kbd> <span>Palette &amp; quick open</span>
              </div>
              <div>
                <kbd>Ctrl</kbd>+<kbd>S</kbd> <span>Save</span>
              </div>
              <div>
                <kbd>Ctrl</kbd>+<kbd>`</kbd> <span>Terminal</span>
              </div>
              <div>
                <kbd>F5</kbd> <span>Run</span>
              </div>
            </div>

            <div className="recent-projects">
              <div className="recent-head">
                <h3>Recent</h3>
                {recentProjects.length > 0 && (
                  <span className="recent-count">{recentProjects.length}</span>
                )}
              </div>
              {recentProjects.length === 0 ? (
                <button type="button" className="recent-empty" onClick={onOpenFolder}>
                  <FolderPlusIcon size={18} />
                  <span>
                    <strong>Open a folder to get started</strong>
                    <small>Your recent workspaces will appear here.</small>
                  </span>
                </button>
              ) : (
                <ul>
                  {recentProjects.map((project) => (
                    <li key={project}>
                      <button type="button" className="recent-item" onClick={() => onOpenRecent(project)}>
                        <span className="recent-badge" aria-hidden="true">
                          <FolderPlusIcon size={15} />
                        </span>
                        <span className="recent-text">
                          <span className="recent-name">{projectName(project)}</span>
                          <span className="recent-path">{project}</span>
                        </span>
                        <span className="recent-open" aria-hidden="true">→</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ---- Right: account, feature launcher, appearance ---- */}
          <aside className="welcome-side">
            <section className="welcome-card account-card">
              {account ? (
                <div className="account-row">
                  <span className="account-avatar" aria-hidden="true">
                    {(account.name || account.email || '?').charAt(0).toUpperCase()}
                  </span>
                  <span className="account-text">
                    <span className="account-name">{account.name || account.email}</span>
                    <span className="account-mail">{account.email}</span>
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    title="Sign out"
                    aria-label="Sign out"
                    onClick={onSignOut}
                  >
                    <SignOutIcon size={16} />
                  </button>
                </div>
              ) : (
                <div className="account-empty">
                  <span className="account-avatar ghost" aria-hidden="true">
                    <UserIcon size={16} />
                  </span>
                  <div>
                    <strong>{isDesktop ? 'Sign in to NovaCode' : 'Sign in (desktop only)'}</strong>
                    <small>Unlock the AI assistant with a per-account token budget.</small>
                  </div>
                </div>
              )}
              {!account && isDesktop && (
                <button type="button" className="primary wide" onClick={onSignIn}>
                  Sign in
                </button>
              )}
            </section>

            <section className="welcome-card">
              <h3>Jump into</h3>
              <div className="feature-grid">
                {FEATURES.map(({ id, icon: Icon, label, desc }) => (
                  <button key={id} type="button" className="feature-tile" onClick={run(id)}>
                    <span className="feature-icon" aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    <span className="feature-text">
                      <strong>{label}</strong>
                      <small>{desc}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="welcome-card appearance-card">
              <h3>Appearance</h3>
              <div className="theme-switch" role="group" aria-label="Theme">
                {THEMES.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={`theme-option${theme === entry.id ? ' active' : ''}`}
                    title={entry.blurb}
                    onClick={() => onSetTheme?.(entry.id)}
                  >
                    <span
                      className="theme-dot"
                      aria-hidden="true"
                      style={{ background: `linear-gradient(135deg, ${entry.swatch[1]}, ${entry.swatch[2]})` }}
                    />
                    {entry.label}
                  </button>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>
  );
}
