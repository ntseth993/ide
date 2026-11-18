/**
 * Welcome screen: hero, quick-start actions, and recent workspaces — all wired
 * to real NovaCode commands so nothing here is a dead placeholder.
 */
import { projectName } from '../utils/pathUtils';
import {
  NovaMarkIcon,
  FolderPlusIcon,
  FilePlusIcon,
  CommandIcon,
} from './Icons';

export default function WelcomeScreen({
  recentProjects = [],
  onOpenFolder,
  onNewProject,
  onOpenRecent,
  onCommand,
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
        </div>
      </div>
    </section>
  );
}
