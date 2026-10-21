/**
 * Extensions sidebar view: search, sections, cards with lifecycle actions.
 *
 * Two sources are shown side by side:
 *   1. The bundled example catalog (curated, always available offline).
 *   2. The live Open VSX marketplace — the same registry VSCodium/Cursor use —
 *      fetched over the network as you type, with publishers & download counts.
 * Installing from the marketplace imports only the declarative subset NovaCode
 * supports (today: snippets); NovaCode never downloads or runs extension code.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronIcon, PuzzleIcon, RefreshIcon } from './Icons';
import { client, isDesktop } from '../services/novaClient';

function formatDownloads(count) {
  if (!count) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(count);
}

function ExtensionCard({ entry, installed, busyId, onInstall, onToggle, onUpdate, onUninstall }) {
  const [open, setOpen] = useState(false);
  const manifest = entry?.manifest || installed.manifest;
  const isInstalled = Boolean(installed);
  const busy = busyId === manifest.id;
  const enabled = isInstalled && installed.enabled;

  return (
    <article className={`ext-card${busy ? ' busy' : ''}`}>
      <div className="ext-card-main">
        <div className="ext-icon" aria-hidden="true">{manifest.name.charAt(0)}</div>
        <div className="ext-meta">
          <span className="ext-name" title={manifest.id}>{manifest.name}</span>
          <span className="ext-sub muted">
            {manifest.publisher} · v{manifest.version}
            {isInstalled && installed.updateAvailable ? ' · update available' : ''}
          </span>
          <span className="ext-desc">{manifest.description}</span>
        </div>
        <span className={`ext-status ${enabled ? 'tone-ok' : isInstalled ? 'tone-warn' : 'tone-muted'}`}>
          {isInstalled ? (enabled ? 'Enabled' : 'Disabled') : 'Not installed'}
        </span>
      </div>

      <div className="ext-actions">
        {!isInstalled && (
          <button type="button" className="small" disabled={busy} onClick={() => onInstall(manifest.id)}>
            Install
          </button>
        )}
        {isInstalled && (
          <>
            {installed.updateAvailable && (
              <button type="button" className="small" disabled={busy} onClick={() => onUpdate(manifest.id)}>
                Update
              </button>
            )}
            <button type="button" className="small" disabled={busy} onClick={() => onToggle(manifest.id, !enabled)}>
              {enabled ? 'Disable' : 'Enable'}
            </button>
            <button type="button" className="small danger" disabled={busy} onClick={() => onUninstall(manifest.id)}>
              Uninstall
            </button>
          </>
        )}
        <button type="button" className="icon-button" aria-expanded={open} title="Details" onClick={() => setOpen((value) => !value)}>
          <ChevronIcon open={open} size={14} />
        </button>
      </div>

      {open && (
        <div className="ext-details">
          <div><span className="muted">Categories:</span> {manifest.categories.join(', ')}</div>
          <div><span className="muted">Compatibility:</span> NovaCode {manifest.engines?.nova || 'any'}</div>
          <div><span className="muted">Permissions:</span> {manifest.permissions?.length ? manifest.permissions.join(', ') : 'none (declarative only)'}</div>
          <div className="muted tiny">
            Contributions are data only (themes, snippets, formatter flags). NovaCode never executes extension code.
          </div>
        </div>
      )}
    </article>
  );
}

function MarketplaceIcon({ item }) {
  const [broken, setBroken] = useState(false);
  // Reset the failure flag whenever a different icon URL arrives.
  useEffect(() => setBroken(false), [item.iconUrl]);
  const letter = (item.displayName || item.name || '?').charAt(0);
  if (!item.iconUrl || broken) {
    return <div className="ext-icon ext-icon-market fallback" aria-hidden="true">{letter}</div>;
  }
  return (
    <div className="ext-icon ext-icon-market" aria-hidden="true">
      <img
        src={item.iconUrl}
        alt=""
        width={38}
        height={38}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    </div>
  );
}

function MarketplaceCard({ item, busy, installed, onInstall, onOpen }) {
  return (
    <article className={`ext-card ext-market${busy ? ' busy' : ''}`}>
      <div className="ext-card-main">
        <MarketplaceIcon item={item} />
        <div className="ext-meta">
          <span className="ext-name" title={item.id}>{item.displayName}</span>
          <span className="ext-sub muted">
            {item.publisher} · v{item.version} · {formatDownloads(item.downloadCount)} installs
          </span>
          <span className="ext-desc">{item.description}</span>
        </div>
        <span className={`ext-status ${installed ? 'tone-ok' : 'tone-muted'}`}>
          {installed ? 'Installed' : 'Marketplace'}
        </span>
      </div>
      <div className="ext-actions">
        <button type="button" className="small" disabled={busy || installed} onClick={() => onInstall(item)}>
          {installed ? 'Installed' : (busy ? 'Installing…' : 'Install')}
        </button>
        <button type="button" className="small secondary" onClick={() => onOpen(item)}>
          Details
        </button>
      </div>
    </article>
  );
}

export default function ExtensionsView({
  data,
  busyId,
  error,
  onRefresh,
  onInstall,
  onToggle,
  onUpdate,
  onUninstall,
  onInstalled,
}) {
  const [search, setSearch] = useState('');
  const [market, setMarket] = useState([]);
  const [marketStatus, setMarketStatus] = useState('idle'); // idle | loading | ready | error | unavailable
  const [marketError, setMarketError] = useState('');
  const [marketBusyId, setMarketBusyId] = useState(null);
  const requestId = useRef(0);

  // Live marketplace search (debounced). Empty query loads top downloads.
  useEffect(() => {
    if (!isDesktop) {
      setMarket([]);
      setMarketStatus('unavailable');
      return undefined;
    }
    const term = search.trim();
    if (term.length > 0 && term.length < 2) return undefined; // wait for a real query
    const id = requestId.current + 1;
    requestId.current = id;
    setMarketStatus('loading');
    setMarketError('');
    const timer = setTimeout(async () => {
      try {
        const result = await client.searchExtensions(term);
        if (requestId.current !== id) return; // a newer query superseded this one
        setMarket(result?.results || []);
        setMarketStatus('ready');
      } catch (searchError) {
        if (requestId.current !== id) return;
        setMarket([]);
        setMarketStatus('error');
        setMarketError(searchError?.message || 'The registry could not be reached.');
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const installedIds = useMemo(
    () => new Set((data?.installed || []).map((record) => record.manifest.id)),
    [data],
  );

  const { installedSections, availableSections } = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matches = (manifest) => !term
      || manifest.name.toLowerCase().includes(term)
      || manifest.description.toLowerCase().includes(term)
      || manifest.publisher.toLowerCase().includes(term)
      || manifest.id.toLowerCase().includes(term);

    const installed = (data?.installed || []).filter((record) => matches(record.manifest));
    const available = (data?.available || []).filter((entry) => matches(entry.manifest));

    return {
      installedSections: installed,
      availableSections: {
        recommended: available.filter((entry) => entry.recommended),
        popular: available.filter((entry) => entry.popular && !entry.recommended),
        other: available.filter((entry) => !entry.recommended && !entry.popular),
      },
    };
  }, [data, search]);

  async function handleInstallMarket(item) {
    setMarketBusyId(item.id);
    try {
      await client.installMarketplace({ namespace: item.namespace, name: item.name });
      onInstalled?.();
    } catch (installError) {
      setMarketStatus('error');
      setMarketError(installError?.message || 'Install failed.');
    } finally {
      setMarketBusyId(null);
    }
  }

  function handleOpenMarket(item) {
    client.openExternal(`https://open-vsx.org/extension/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.name)}`);
  }

  return (
    <div className="extensions-panel" aria-label="Extensions">
      <div className="panel-header">
        <h3>Extensions</h3>
        <button type="button" className="icon-button" title="Refresh" onClick={onRefresh}>
          <RefreshIcon size={15} />
        </button>
      </div>

      <input
        className="ext-search"
        type="search"
        placeholder="Search the marketplace…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label="Search extensions"
      />

      {error && <div className="ai-error">{error}</div>}

      {installedSections.length > 0 && <h4 className="ext-section">Installed</h4>}
      {installedSections.map((record) => (
        <ExtensionCard
          key={record.manifest.id}
          installed={record}
          entry={null}
          busyId={busyId}
          onInstall={onInstall}
          onToggle={onToggle}
          onUpdate={onUpdate}
          onUninstall={onUninstall}
        />
      ))}

      <h4 className="ext-section">
        Marketplace
        <span className="ext-section-tag">via Open VSX</span>
      </h4>

      {marketStatus === 'unavailable' && (
        <p className="ext-note muted tiny">Marketplace search runs in the desktop app. Launch with “npm run dev”.</p>
      )}
      {marketStatus === 'loading' && <p className="ext-note muted tiny">Searching the marketplace…</p>}
      {marketStatus === 'error' && <div className="ai-error">{marketError}</div>}
      {marketStatus === 'ready' && market.length === 0 && (
        <p className="ext-note muted tiny">No marketplace extensions matched {search.trim() ? 'your search.' : 'the registry.'}</p>
      )}
      {marketStatus === 'ready' && market.map((item) => (
        <MarketplaceCard
          key={item.id}
          item={item}
          busy={marketBusyId === item.id}
          installed={installedIds.has(item.id) || installedIds.has(`${item.namespace}.${item.name}`)}
          onInstall={handleInstallMarket}
          onOpen={handleOpenMarket}
        />
      ))}

      <h4 className="ext-section">
        Bundled examples
        <span className="ext-section-tag">offline</span>
      </h4>
      <div className="ext-note muted tiny">
        Curated sample extensions — themes, snippets and a formatter — that work without a connection.
      </div>

      {availableSections.recommended.length > 0 && <h5 className="ext-subsection">Recommended</h5>}
      {availableSections.recommended.map((entry) => (
        <ExtensionCard
          key={entry.manifest.id}
          entry={entry}
          installed={null}
          busyId={busyId}
          onInstall={onInstall}
          onToggle={onToggle}
          onUpdate={onUpdate}
          onUninstall={onUninstall}
        />
      ))}

      {availableSections.popular.length > 0 && <h5 className="ext-subsection">Popular</h5>}
      {availableSections.popular.map((entry) => (
        <ExtensionCard
          key={entry.manifest.id}
          entry={entry}
          installed={null}
          busyId={busyId}
          onInstall={onInstall}
          onToggle={onToggle}
          onUpdate={onUpdate}
          onUninstall={onUninstall}
        />
      ))}

      {availableSections.other.length > 0 && <h5 className="ext-subsection">More from the catalog</h5>}
      {availableSections.other.map((entry) => (
        <ExtensionCard
          key={entry.manifest.id}
          entry={entry}
          installed={null}
          busyId={busyId}
          onInstall={onInstall}
          onToggle={onToggle}
          onUpdate={onUpdate}
          onUninstall={onUninstall}
        />
      ))}

      {!installedSections.length && market.length === 0 && marketStatus !== 'loading'
        && !availableSections.recommended.length && !availableSections.popular.length
        && !availableSections.other.length && (
        <div className="ext-empty">
          <PuzzleIcon size={26} />
          <p className="muted">{search ? 'No extensions match your search.' : 'The catalog is empty.'}</p>
        </div>
      )}
    </div>
  );
}
