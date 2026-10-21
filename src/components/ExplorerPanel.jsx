/** File explorer tree with create/rename/delete actions. */
import { ChevronIcon, PencilIcon, TrashIcon, FilePlusIcon, FolderPlusIcon, RefreshIcon } from './Icons';
import { getTypeBadge } from '../utils/language';

function TreeNode({ node, depth, activeTab, selectedPath, expanded, onToggle, onOpen, onRename, onDelete }) {
  const isFolder = node.type === 'folder';
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPath === node.path;
  const isActiveTab = activeTab === node.path;
  const badge = isFolder ? null : getTypeBadge(node.name);

  return (
    <div className="tree-node">
      <div
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={isFolder ? isOpen : undefined}
        tabIndex={-1}
        className={`tree-row${isSelected ? ' selected' : ''}${isActiveTab ? ' active-tab' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => (isFolder ? onToggle(node.path) : onOpen(node.path))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') isFolder ? onToggle(node.path) : onOpen(node.path);
        }}
      >
        {isFolder ? (
          <span className="tree-chevron">
            <ChevronIcon size={12} open={isOpen} />
          </span>
        ) : (
          <span className={`type-badge tone-${badge.tone}`}>{badge.label}</span>
        )}
        <span className="tree-name" title={node.path}>
          {node.name}
        </span>
        <span className="node-actions">
          <button
            type="button"
            className="icon-button"
            title="Rename"
            aria-label={`Rename ${node.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onRename(node);
            }}
          >
            <PencilIcon size={13} />
          </button>
          <button
            type="button"
            className="icon-button danger"
            title="Delete"
            aria-label={`Delete ${node.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(node);
            }}
          >
            <TrashIcon size={13} />
          </button>
        </span>
      </div>

      {isFolder && isOpen && node.children && node.children.length > 0 && (
        <div role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeTab={activeTab}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggle}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ExplorerPanel({
  tree,
  root,
  activeTab,
  selectedPath,
  expanded,
  onToggleFolder,
  onOpenFile,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
  onRefresh,
}) {
  return (
    <section className="side-panel" aria-label="File explorer">
      <header className="panel-header">
        <h3>{root ? root.split(/[\\/]/).pop() : 'Explorer'}</h3>
        <div className="inline-actions">
          <button type="button" className="icon-button" title="New file" aria-label="New file" onClick={onCreateFile}>
            <FilePlusIcon size={15} />
          </button>
          <button type="button" className="icon-button" title="New folder" aria-label="New folder" onClick={onCreateFolder}>
            <FolderPlusIcon size={15} />
          </button>
          <button type="button" className="icon-button" title="Refresh" aria-label="Refresh" onClick={onRefresh}>
            <RefreshIcon size={15} />
          </button>
        </div>
      </header>

      <div className="tree" role="tree">
        {tree.length === 0 ? (
          <p className="muted small-pad">This folder is empty.</p>
        ) : (
          tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              activeTab={activeTab}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggleFolder}
              onOpen={onOpenFile}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </section>
  );
}
