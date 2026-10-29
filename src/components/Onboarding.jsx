/**
 * First-run onboarding tour.
 *
 * A full-screen, multi-step wizard shown before the user reaches the app. Each
 * step is one instruction; click Next (or press Enter / →) to advance, Back /
 * ← to review, and the final step's "Enter NovaCode" dismisses the tour. Steps
 * slide direction-aware (forward slides in from the right, back from the left),
 * the whole thing honours the app's reduced-motion setting, and completion is
 * persisted by the caller so it only interrupts on first launch. It can be
 * replayed anytime from the Command Palette ("Help: Replay Tour").
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NovaMarkIcon,
  FolderPlusIcon,
  SparkleIcon,
  TerminalIcon,
  PuzzleIcon,
  CommandIcon,
  CheckIcon,
  CloseIcon,
} from './Icons';

const STEPS = [
  {
    id: 'welcome',
    icon: NovaMarkIcon,
    eyebrow: 'Welcome',
    title: 'Welcome to NovaCode',
    body: 'An offline-first desktop IDE with an AI assistant built in. Take a quick tour — click Next to move through each step, and you\'ll be coding in seconds.',
    accent: 'violet',
  },
  {
    id: 'project',
    icon: FolderPlusIcon,
    eyebrow: 'Step 1 · Your project',
    title: 'Open a folder to begin',
    body: 'Start by opening an existing folder or creating a new project. NovaCode edits your files directly on disk — nothing is ever uploaded to run the editor.',
    tip: 'Tip: press Ctrl+P for the Command Palette and quick open.',
    accent: 'cyan',
  },
  {
    id: 'assistant',
    icon: SparkleIcon,
    eyebrow: 'Step 2 · AI assistant',
    title: 'Agent mode & Ask mode',
    body: 'Agent mode plans a change and can run commands or edit files for you — every command asks for your approval first, and edits show a diff to review. Ask mode just explains code. Inline AI suggests completions while you type.',
    tip: 'Tip: open the assistant on the right · Ctrl+Shift+A.',
    accent: 'violet',
  },
  {
    id: 'terminal',
    icon: TerminalIcon,
    eyebrow: 'Step 3 · Terminal',
    title: 'A real terminal, built in',
    body: 'Run shell commands without leaving the editor, and the AI agent can execute them for you — you approve each one before it runs, always confined to your workspace.',
    tip: 'Tip: Ctrl+` toggles the terminal panel.',
    accent: 'amber',
  },
  {
    id: 'more',
    icon: PuzzleIcon,
    eyebrow: 'Step 4 · Extensions & history',
    title: 'Extend it, and stay safe',
    body: 'Add languages and themes from the marketplace, and review every AI edit in Change History so any accepted change can be restored with one click.',
    tip: 'Tip: F5 runs the current file.',
    accent: 'cyan',
  },
  {
    id: 'ready',
    icon: CommandIcon,
    eyebrow: 'You\'re all set',
    title: 'Ready when you are',
    body: 'That\'s the tour. Open a folder and start building. You can replay this guide anytime from the Command Palette — search for "Replay Tour".',
    final: true,
    accent: 'violet',
  },
];

// Decorative backdrop props. Values are fixed (not random) so the animation
// stays stable across re-renders; per-item variation is passed via CSS vars.
const BUBBLES = [
  { size: 40, left: 8, delay: 0, dur: 19, sway: 26 },
  { size: 18, left: 18, delay: 5, dur: 14, sway: -18 },
  { size: 64, left: 27, delay: 2, dur: 24, sway: 34 },
  { size: 12, left: 38, delay: 8, dur: 12, sway: -12 },
  { size: 30, left: 47, delay: 1, dur: 17, sway: 22 },
  { size: 22, left: 58, delay: 6, dur: 15, sway: -20 },
  { size: 52, left: 68, delay: 3, dur: 22, sway: 30 },
  { size: 16, left: 79, delay: 9, dur: 13, sway: -14 },
  { size: 34, left: 87, delay: 4, dur: 18, sway: 24 },
  { size: 10, left: 93, delay: 7, dur: 11, sway: -10 },
];

const CODE_TOKENS = [
  { text: 'const x = 42', top: 12, left: 6, x: 360, y: -140, delay: 0, dur: 20, size: 0.92 },
  { text: '=> { }', top: 24, left: 74, x: -300, y: 120, delay: 3, dur: 17, size: 1.05 },
  { text: '</>', top: 72, left: 12, x: 260, y: -180, delay: 6, dur: 22, size: 1.15 },
  { text: 'npm run dev', top: 82, left: 66, x: -240, y: -90, delay: 1, dur: 19, size: 0.85 },
  { text: 'if (!ok) throw', top: 18, left: 40, x: 300, y: 150, delay: 8, dur: 24, size: 0.8 },
  { text: 'async/await', top: 62, left: 82, x: -320, y: -120, delay: 4, dur: 18, size: 0.95 },
  { text: 'git push', top: 40, left: 4, x: 380, y: 60, delay: 10, dur: 21, size: 0.88 },
  { text: 'fn main()', top: 88, left: 28, x: 220, y: -160, delay: 2, dur: 16, size: 0.9 },
  { text: '{ flex: 1 }', top: 8, left: 58, x: -260, y: 140, delay: 12, dur: 23, size: 0.82 },
  { text: 'print("hi")', top: 54, left: 22, x: 320, y: -70, delay: 5, dur: 20, size: 0.86 },
  { text: 'SELECT *', top: 34, left: 90, x: -340, y: 100, delay: 9, dur: 25, size: 0.8 },
  { text: 'return ok', top: 68, left: 48, x: 240, y: 130, delay: 14, dur: 19, size: 0.9 },
];

export default function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState('next');
  const [leaving, setLeaving] = useState(false);
  const shellRef = useRef(null);
  const total = STEPS.length;
  const current = STEPS[step];
  const isLast = step === total - 1;

  const finish = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    // Let the exit animation play before unmounting the overlay.
    setTimeout(() => onDone?.(), 220);
  }, [leaving, onDone]);

  const goTo = useCallback((index, dir) => {
    setDirection(dir);
    setStep(Math.max(0, Math.min(total - 1, index)));
  }, [total]);

  const next = useCallback(() => {
    if (isLast) finish();
    else goTo(step + 1, 'next');
  }, [isLast, step, finish, goTo]);

  const back = useCallback(() => {
    if (step > 0) goTo(step - 1, 'back');
  }, [step, goTo]);

  // Keyboard navigation for the whole tour.
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        back();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, finish]);

  // Focus the shell on mount so Enter/arrows work immediately.
  useEffect(() => {
    shellRef.current?.focus?.();
  }, []);

  const Icon = current.icon;

  return (
    <div className={`onboarding-overlay${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-label="NovaCode tour">
      <div className="onboarding-aurora" aria-hidden="true">
        <span className="blob blob-a" />
        <span className="blob blob-b" />
        <span className="blob blob-c" />
      </div>

      {/* rising bubbles */}
      <div className="onboarding-bubbles" aria-hidden="true">
        {BUBBLES.map((b, i) => (
          <span
            key={i}
            className="onboarding-bubble"
            style={{
              '--b-size': `${b.size}px`,
              '--b-left': `${b.left}%`,
              '--b-delay': `${b.delay}s`,
              '--b-dur': `${b.dur}s`,
              '--b-sway': `${b.sway}px`,
            }}
          />
        ))}
      </div>

      {/* drifting code snippets */}
      <div className="onboarding-codefield" aria-hidden="true">
        {CODE_TOKENS.map((c, i) => (
          <code
            key={i}
            className="onboarding-flycode"
            style={{
              '--c-top': `${c.top}%`,
              '--c-left': `${c.left}%`,
              '--c-x': `${c.x}px`,
              '--c-y': `${c.y}px`,
              '--c-delay': `${c.delay}s`,
              '--c-dur': `${c.dur}s`,
              '--c-size': `${c.size}rem`,
            }}
          >
            {c.text}
          </code>
        ))}
      </div>

      <div className="onboarding-shell" ref={shellRef} tabIndex={-1} data-accent={current.accent}>
        <button type="button" className="onboarding-skip" onClick={finish} aria-label="Skip tour">
          <CloseIcon size={16} />
          <span>Skip</span>
        </button>

        {/* progress rail */}
        <div className="onboarding-progress">
          <div className="onboarding-track" role="presentation">
            <div className="onboarding-fill" style={{ width: `${((step + 1) / total) * 100}%` }} />
          </div>
          <span className="onboarding-count">Step {step + 1} of {total}</span>
        </div>

        {/* step card — keyed by step so it re-animates on every change */}
        <div className={`onboarding-stage dir-${direction}`} key={current.id}>
          <span className="onboarding-icon" aria-hidden="true">
            <Icon size={30} />
          </span>
          <p className="onboarding-eyebrow">{current.eyebrow}</p>
          <h2 className="onboarding-title">{current.title}</h2>
          <p className="onboarding-body">{current.body}</p>
          {current.tip && <p className="onboarding-tip">{current.tip}</p>}
          {current.final && (
            <div className="onboarding-final-badge" aria-hidden="true">
              <CheckIcon size={16} /> Tour complete
            </div>
          )}
        </div>

        {/* controls */}
        <div className="onboarding-controls">
          <div className="onboarding-dots" role="tablist" aria-label="Tour steps">
            {STEPS.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={index === step}
                aria-label={`Go to step ${index + 1}`}
                className={`onboarding-dot${index === step ? ' active' : ''}${index < step ? ' done' : ''}`}
                onClick={() => goTo(index, index >= step ? 'next' : 'back')}
              />
            ))}
          </div>

          <div className="onboarding-buttons">
            {step > 0 && (
              <button type="button" className="onboarding-back" onClick={back}>
                Back
              </button>
            )}
            <button type="button" className={`onboarding-next${isLast ? ' finish' : ''}`} onClick={next}>
              {isLast ? (
                <>
                  <CheckIcon size={16} /> Enter NovaCode
                </>
              ) : (
                <>Next</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
