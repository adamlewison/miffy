type P = { size?: number };
const base = (size = 28) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });

export const PhoneIcon = ({ size }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2Z" />
  </svg>
);
export const HangupIcon = ({ size }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none" style={{ transform: "rotate(135deg)" }}>
    <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2Z" />
  </svg>
);
export const MicIcon = ({ size, off }: P & { off?: boolean }) => (
  <svg {...base(size)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    {off && <path d="M4 4l16 16" />}
  </svg>
);
export const CameraIcon = ({ size, off }: P & { off?: boolean }) => (
  <svg {...base(size)}>
    <rect x="3" y="7" width="13" height="10" rx="2" />
    <path d="M16 11l5-3v8l-5-3" />
    {off && <path d="M3 4l17 17" />}
  </svg>
);
export const CaptionsIcon = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3" />
  </svg>
);
