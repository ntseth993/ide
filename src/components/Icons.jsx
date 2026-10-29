/** Inline SVG icon set (no icon-font or emoji dependencies). Each icon is exported exactly once. */

function Svg({ children, size = 16, viewBox = '0 0 24 24', ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const HistoryIcon = (props) => (
  <Svg {...props}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 3" />
  </Svg>
);

export const PuzzleIcon = (props) => (
  <Svg {...props}>
    <path d="M4 20V8h6a2.5 2.5 0 1 1 5 0h5v5a2.5 2.5 0 1 0 0 5v2H4z" />
  </Svg>
);

export const FilesIcon = (props) => (
  <Svg {...props}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);

export const SearchIcon = (props) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);

export const TerminalIcon = (props) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M12 15h5" />
  </Svg>
);

export const SparkleIcon = (props) => (
  <Svg {...props}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
  </Svg>
);

export const GearIcon = (props) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </Svg>
);

export const ChevronIcon = ({ open, ...props }) => (
  <Svg {...props} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s ease' }}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

export const CloseIcon = (props) => (
  <Svg {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const PlayIcon = (props) => (
  <Svg {...props}>
    <path d="m7 4 13 8-13 8z" />
  </Svg>
);

export const StopIcon = (props) => (
  <Svg {...props}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Svg>
);

export const TrashIcon = (props) => (
  <Svg {...props}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />
  </Svg>
);

export const PencilIcon = (props) => (
  <Svg {...props}>
    <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
  </Svg>
);

export const RefreshIcon = (props) => (
  <Svg {...props}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
  </Svg>
);

export const FolderPlusIcon = (props) => (
  <Svg {...props}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2zM12 11v6M9 14h6" />
  </Svg>
);

export const FilePlusIcon = (props) => (
  <Svg {...props}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 12v6M9 15h6" />
  </Svg>
);

export const CommandIcon = (props) => (
  <Svg {...props}>
    <path d="M15 6a3 3 0 1 1 3 3h-3zM9 6a3 3 0 1 0-3 3h3zM15 18a3 3 0 1 0 3-3h-3zM9 18a3 3 0 1 1-3-3h3zM9 9h6v6H9z" />
  </Svg>
);

export const PanelLeftIcon = (props) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Svg>
);

export const PanelBottomIcon = (props) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 15h18" />
  </Svg>
);

export const CheckIcon = (props) => (
  <Svg {...props}>
    <path d="m4 12 6 6L20 6" />
  </Svg>
);

export const SendIcon = (props) => (
  <Svg {...props}>
    <path d="m22 2-7 20-4-9-9-4z" />
    <path d="M22 2 11 13" />
  </Svg>
);

export const ArrowUpIcon = (props) => (
  <Svg {...props}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);

export const InfinityIcon = (props) => (
  <Svg {...props}>
    <path d="M12 12c-2-2.7-3.5-4-5.5-4a4 4 0 0 0 0 8c2 0 3.5-1.3 5.5-4Zm0 0c2 2.7 3.5 4 5.5 4a4 4 0 0 0 0-8c-2 0-3.5 1.3-5.5 4Z" />
  </Svg>
);

export const MoreIcon = (props) => (
  <Svg {...props}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const PlusIcon = (props) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const UserIcon = (props) => (
  <Svg {...props}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Svg>
);

export const SignOutIcon = (props) => (
  <Svg {...props}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </Svg>
);

export const MaximizeIcon = (props) => (
  <Svg {...props}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
  </Svg>
);

export const MinimizeIcon = (props) => (
  <Svg {...props}>
    <path d="M8 3v5a1 1 0 0 1-1 1H3M16 3v5a1 1 0 0 0 1 1h4M21 16h-4a1 1 0 0 0-1 1v4M3 16h4a1 1 0 0 1 1 1v4" />
  </Svg>
);

export const ChevronDownIcon = (props) => (
  <Svg {...props}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const MicIcon = (props) => (
  <Svg {...props}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);

/* NovaCode assistant mark — a soft leaf/orbit glyph for the hero. */
export const NovaMarkIcon = (props) => (
  <Svg {...props} strokeWidth="1.6">
    <path d="M12 3c4 3 6 6 6 9a6 6 0 0 1-12 0c0-1.5.6-3 1.8-4.4" />
    <path d="M12 21c-3-2-4.5-4.5-4.5-7.5A7.5 7.5 0 0 1 12 4" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

/* NovaLink — two peers linked by a peer-to-peer channel. */
export const NovaLinkIcon = (props) => (
  <Svg {...props}>
    <circle cx="5.5" cy="6" r="2.4" />
    <circle cx="18.5" cy="6" r="2.4" />
    <circle cx="12" cy="18" r="2.4" />
    <path d="M7.6 7.3 10.3 16M16.4 7.3 13.7 16M8 6h8" />
  </Svg>
);

/* NovaDB — a database cylinder (stacked disks) for the Database workspace. */
export const DatabaseIcon = (props) => (
  <Svg {...props}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
  </Svg>
);

export const BluetoothIcon = (props) => (
  <Svg {...props}>
    <path d="m7 7 10 10-5 4V3l5 4L7 17" />
  </Svg>
);

export const NetworkIcon = (props) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18" />
  </Svg>
);

export const ShareIcon = (props) => (
  <Svg {...props}>
    <circle cx="18" cy="5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="19" r="2.5" />
    <path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" />
  </Svg>
);

/* Foreign-key / relationship marker — a small key glyph. */
export const KeyIcon = (props) => (
  <Svg {...props}>
    <circle cx="7.5" cy="15.5" r="3.5" />
    <path d="m10 13 8-8M15 5l3 3M18 8l2-2" />
  </Svg>
);

/* Code / developer-integration marker — angle brackets with a slash. */
export const CodeIcon = (props) => (
  <Svg {...props}>
    <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />
  </Svg>
);

/* Deploy — a rocket lifting off (build & ship the user's project). */
export const RocketIcon = (props) => (
  <Svg {...props}>
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z" />
    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </Svg>
);
