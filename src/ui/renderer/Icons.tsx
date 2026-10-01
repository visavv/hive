/**
 * One small, consistent line-icon set (16px, 1.6 stroke, currentColor) instead
 * of emoji, which render differently on every OS and read as unfinished.
 */
type P = { size?: number; title?: string; className?: string };

function Svg({ size = 16, title, className, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      className={`icon${className ? " " + className : ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {children}
    </svg>
  );
}

export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11Z" />
    <path d="M6.5 14a1.6 1.6 0 0 0 3 0" />
  </Svg>
);
export const IconBellOff = (p: P) => (
  <Svg {...p}>
    <path d="M4 11V7a4 4 0 0 1 6.5-3.1M12 7v4l1 1.5H6" />
    <path d="M6.5 14a1.6 1.6 0 0 0 3 0M2.5 2.5l11 11" />
  </Svg>
);
export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 9.5 9.5 6.5" />
    <path d="M7 4.5 8.3 3.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.3 1.3a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" />
  </Svg>
);
export const IconScale = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.5v11M5 13.5h6M3 4.5h10" />
    <path d="M3 4.5 1.5 8.5a1.8 1.8 0 0 0 3 0L3 4.5ZM13 4.5l-1.5 4a1.8 1.8 0 0 0 3 0L13 4.5Z" />
  </Svg>
);
export const IconSpark = (p: P) => (
  <Svg {...p}>
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12" />
  </Svg>
);
export const IconTeam = (p: P) => (
  <Svg {...p}>
    <circle cx="5.5" cy="5.5" r="2" />
    <circle cx="11" cy="6.5" r="1.6" />
    <path d="M2 13c.4-2.2 1.8-3.4 3.5-3.4S8.6 10.8 9 13M9.6 11c.4-.9 1-1.4 1.9-1.4 1.3 0 2.2.9 2.5 2.6" />
  </Svg>
);
export const IconInbox = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
    <path d="m2.5 4.5 5.5 4 5.5-4" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconMenu = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </Svg>
);
export const IconColumns = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M8 3v10" />
  </Svg>
);
export const IconRows = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="2" width="8" height="12" rx="1.5" />
    <path d="M4 8h8" />
  </Svg>
);
export const IconMaximize = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </Svg>
);
export const IconExpand = (p: P) => (
  <Svg {...p}>
    <path d="M10 2.5h3.5V6M6 13.5H2.5V10" />
  </Svg>
);
export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 8 13.5 2.5 10 13.5 7.5 8.5 2.5 8Z" />
  </Svg>
);
export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);
export const IconGauge = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 11a5.5 5.5 0 1 1 11 0" />
    <path d="M8 11l2.5-3.5" />
  </Svg>
);
