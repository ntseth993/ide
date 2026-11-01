import { useState, useEffect } from 'react';
import { client } from '../../services/novaClient';

/**
 * Persistent badge shown in the status bar when the user is enrolled in a
 * classroom. Displays "Monitored by [teacher]" and allows unenrolling.
 * Cannot be hidden by CSS alone — it renders outside the workspace.
 */
export default function ClassroomBadge() {
  const [status, setStatus] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [unenrolling, setUnenrolling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Guard against both a missing preload bridge (browser-mode tests, or a
    // stale install that predates the classroom IPC channels) and a rejected
    // promise. `requireDesktop()` inside the client wrapper throws
    // synchronously, so the try/catch is required in addition to `.catch()`.
    try {
      const promise = client.novalinkLiveClassroomStatus?.();
      if (promise && typeof promise.then === 'function') {
        promise.then((result) => {
          if (!cancelled) setStatus(result);
        }).catch(() => { /* offline / not enrolled */ });
      }
    } catch { /* desktop bridge unavailable */ }
    return () => { cancelled = true; };
  }, []);

  if (!status?.enrolled) return null;

  const enrollment = status.status || {};

  async function handleUnenroll() {
    setUnenrolling(true);
    try {
      await client.novalinkLiveClassroomUnenroll();
      setStatus({ enrolled: false });
      setShowDialog(false);
    } catch { /* keep showing */ }
    setUnenrolling(false);
  }

  return (
    <>
      <button
        type="button"
        className="classroom-badge"
        onClick={() => setShowDialog(true)}
        title={`Enrolled in "${enrollment.className || 'Class'}"`}
        aria-label={`Monitored by ${enrollment.className || 'a class'}. Click for details.`}
      >
        <span className="classroom-badge-dot" aria-hidden="true" />
        Monitored
      </button>
      {showDialog ? (
        <div className="classroom-dialog-overlay" role="dialog" aria-modal="true" aria-label="Classroom info" onClick={() => setShowDialog(false)}>
          <div className="classroom-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Classroom Monitor</h3>
            <dl>
              <dt>Class</dt>
              <dd>{enrollment.className || 'Unknown'}</dd>
              <dt>Enrolled</dt>
              <dd>{enrollment.enrolledAt ? new Date(enrollment.enrolledAt).toLocaleDateString() : 'Unknown'}</dd>
              <dt>Device</dt>
              <dd>{enrollment.joinCode || ''}</dd>
            </dl>
            <p className="classroom-dialog-note">
              Your teacher can see your active file, editor content, terminal commands, and AI prompts in real time.
            </p>
            <div className="classroom-dialog-actions">
              <button type="button" onClick={() => setShowDialog(false)}>Close</button>
              <button
                type="button"
                className="classroom-unenroll-btn"
                onClick={handleUnenroll}
                disabled={unenrolling}
              >
                {unenrolling ? 'Unenrolling...' : 'Unenroll'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
