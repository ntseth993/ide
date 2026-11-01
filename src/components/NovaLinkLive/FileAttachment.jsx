/**
 * File attachment chip.
 *
 * Renders an incoming or outgoing attachment: name, size, download action.
 * Uploads show progress while in-flight; downloads stream bytes back through
 * `novalinkLiveDownloadFile` (25 MB cap enforced by the main process).
 *
 * We never write the file to the workspace on click — the user is asked where
 * to save it via the existing save dialog. In preview mode (jsdom / tests) the
 * download simply resolves with the metadata so the chip still renders.
 */
import { useCallback, useState } from 'react';
import { client, toUserMessage } from '../../services/novaClient';

const UNITS = ['B', 'KB', 'MB', 'GB'];

function human(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let n = bytes;
  let idx = 0;
  while (n >= 1024 && idx < UNITS.length - 1) { n /= 1024; idx += 1; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${UNITS[idx]}`;
}

function iconFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
  if (['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes(ext)) return 'archive';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'php', 'rb', 'sh'].includes(ext)) return 'code';
  if (['md', 'txt', 'rst', 'log'].includes(ext)) return 'doc';
  if (['pdf'].includes(ext)) return 'pdf';
  return 'file';
}

export default function FileAttachment({ attachment, outgoing, onNotify, progress }) {
  const [busy, setBusy] = useState(false);
  const name = attachment.fileName || attachment.name || 'attachment';
  const size = attachment.size ?? attachment.bytes ?? null;
  const icon = iconFor(name);
  const inFlight = outgoing && typeof progress === 'number' && progress < 100;

  const download = useCallback(async () => {
    if (!attachment.id) return;
    setBusy(true);
    try {
      const result = await client.novalinkLiveDownloadFile(attachment.id);
      // Hand off to the browser save flow: build an object URL from the bytes
      // the main process returned. We deliberately do not touch the workspace
      // filesystem without an explicit save dialog.
      const bytes = result?.bytes || new Uint8Array();
      const blob = new Blob([bytes], { type: result?.mimeType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (caught) {
      onNotify?.({ tone: 'error', message: toUserMessage(caught, 'Download failed.') });
    } finally {
      setBusy(false);
    }
  }, [attachment, name, onNotify]);

  return (
    <div className={`novalink-attachment ${outgoing ? 'outgoing' : 'incoming'} ${inFlight ? 'in-flight' : ''}`}>
      <span className={`novalink-attachment-icon tone-${icon}`} aria-hidden="true" />
      <div className="novalink-attachment-body">
        <span className="novalink-attachment-name" title={name}>{name}</span>
        <span className="novalink-attachment-meta">
          {size != null ? human(size) : 'pending'}
          {inFlight ? ` · uploading ${Math.round(progress)}%` : null}
        </span>
      </div>
      {attachment.id && !inFlight ? (
        <button type="button" className="ghost tiny" onClick={download} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      ) : null}
    </div>
  );
}
