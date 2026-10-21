/** Activity bar: primary view switchers and layout toggles. */
import {
  FilesIcon,
  SearchIcon,
  TerminalIcon,
  SparkleIcon,
  GearIcon,
  CommandIcon,
  PanelLeftIcon,
  HistoryIcon,
  PuzzleIcon,
} from './Icons';

export default function ActivityBar({
  view,
  onView,
  terminalVisible,
  aiPanelVisible,
  sidebarVisible,
  onToggleTerminal,
  onToggleAiPanel,
  onToggleSidebar,
  onOpenPalette,
  onOpenSettings,
  onOpenHistory,
  settingsActive = false,
  historyActive = false,
}) {
  const views = [
    { id: 'explorer', icon: FilesIcon, label: 'Explorer' },
    { id: 'search', icon: SearchIcon, label: 'Search' },
    { id: 'extensions', icon: PuzzleIcon, label: 'Extensions' },
  ];

  return (
    <nav className="activity-bar" aria-label="Primary">
      <div className="activity-group">
        {views.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            className={view === id && sidebarVisible ? 'activity-button active' : 'activity-button'}
            title={label}
            aria-label={label}
            onClick={() => onView(id)}
          >
            <Icon size={20} />
          </button>
        ))}
        <button
          type="button"
          className={terminalVisible ? 'activity-button active' : 'activity-button'}
          title="Toggle terminal (Ctrl+`)"
          aria-label="Toggle terminal"
          onClick={onToggleTerminal}
        >
          <TerminalIcon size={20} />
        </button>
        <button
          type="button"
          className={aiPanelVisible ? 'activity-button active' : 'activity-button'}
          title="Toggle AI assistant"
          aria-label="Toggle AI assistant"
          onClick={onToggleAiPanel}
        >
          <SparkleIcon size={20} />
        </button>
      </div>

      <div className="activity-group">
        <button
          type="button"
          className="activity-button"
          title="Command palette (Ctrl+P)"
          aria-label="Command palette"
          onClick={onOpenPalette}
        >
          <CommandIcon size={20} />
        </button>
        <button
          type="button"
          className={!sidebarVisible ? 'activity-button active' : 'activity-button'}
          title="Toggle sidebar (Ctrl+B)"
          aria-label="Toggle sidebar"
          onClick={onToggleSidebar}
        >
          <PanelLeftIcon size={20} />
        </button>
        <button
          type="button"
          className={historyActive ? 'activity-button active' : 'activity-button'}
          title="Change history"
          aria-label="Change history"
          onClick={onOpenHistory}
        >
          <HistoryIcon size={20} />
        </button>
        <button
          type="button"
          className={settingsActive ? 'activity-button active' : 'activity-button'}
          title="Settings"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <GearIcon size={20} />
        </button>
      </div>
    </nav>
  );
}
