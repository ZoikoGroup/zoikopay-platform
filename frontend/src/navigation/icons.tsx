/**
 * Zoiko Pay navigation glyphs. A custom geometric set drawn on a 20-unit
 * grid with a 1.5 stroke in currentColor, so they follow the black-and-white
 * palette and invert cleanly on the active tile.
 */
import type { ReactNode, SVGProps } from "react";

export type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function Glyph({ size = 18, children, ...rest }: GlyphProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

/** Overview: a 2×2 grid with one solid cell (the summary). */
export const OverviewGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" />
    <rect x="11" y="3" width="6" height="6" rx="1" />
    <rect x="3" y="11" width="6" height="6" rx="1" />
    <rect x="11" y="11" width="6" height="6" rx="1" />
  </Glyph>
);

/** Merchants: a façade, a block with three vertical bays under a cornice. */
export const MerchantsGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M3 7.5h14" />
    <path d="M4 7.5 5.5 3.5h9L16 7.5" />
    <path d="M4.5 7.5v9h11v-9" />
    <path d="M8 16.5v-4.5h4v4.5" />
  </Glyph>
);

/** Payment Operations: two nodes and the movement between them. */
export const PaymentsGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <circle cx="5" cy="10" r="2.25" />
    <circle cx="15" cy="10" r="2.25" fill="currentColor" />
    <path d="M7.5 10h5" />
    <path d="M10.5 8 12.5 10l-2 2" />
  </Glyph>
);

/** Routing: one source splitting into two paths. */
export const RoutingGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <circle cx="4.5" cy="10" r="1.75" fill="currentColor" />
    <path d="M6.25 10H9l3-5h2.5" />
    <path d="M9 10l3 5h2.5" />
    <circle cx="16" cy="5" r="1.5" />
    <circle cx="16" cy="15" r="1.5" />
  </Glyph>
);

/** Partners: two overlapping squares, an agreement between two parties. */
export const PartnersGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <rect x="3" y="3" width="9" height="9" rx="1.5" />
    <rect x="8" y="8" width="9" height="9" rx="1.5" />
    <path d="M8 8h4v4H8z" fill="currentColor" stroke="none" />
  </Glyph>
);

/** Refunds & Disputes: a return arc. */
export const RefundsGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M6 6.5h6.5a4 4 0 0 1 0 8H5" />
    <path d="M8.5 3.5 5.5 6.5l3 3" />
  </Glyph>
);

/** Finance: a ledger, columns of balanced lines. */
export const FinanceGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <rect x="3" y="3" width="14" height="14" rx="1.5" />
    <path d="M10 3v14" />
    <path d="M5.5 7h2.5M5.5 10h2.5M12 7h2.5M12 10h2.5" />
    <path d="M5.5 13.5h9" strokeWidth={2} />
  </Glyph>
);

/** Payouts: value leaving a container. */
export const PayoutsGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M10 3.5v8" />
    <path d="M7 6.5l3-3 3 3" />
    <path d="M3.5 11v4.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V11" />
    <path d="M7.5 14h5" />
  </Glyph>
);

/** Risk & Compliance: a diamond boundary with a checked core. */
export const RiskGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M10 2.5 17.5 10 10 17.5 2.5 10Z" />
    <path d="M7.25 10 9.25 12l3.5-4" />
  </Glyph>
);

/** Developers: brackets around a slash. */
export const DevelopersGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M6.5 5.5 2.5 10l4 4.5" />
    <path d="M13.5 5.5l4 4.5-4 4.5" />
    <path d="M11.25 4.5 8.75 15.5" />
  </Glyph>
);

/** Audits: a page of entries under a lens. */
export const AuditsGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M12 17H4.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v4.5" />
    <path d="M6 6.5h5M6 9.5h3" />
    <circle cx="13.5" cy="13" r="2.75" />
    <path d="M15.5 15l2 2" />
  </Glyph>
);

/** QA & Release: a gate, two posts and a bar, with the step through it. */
export const ReleaseGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M4 17V4M16 17V4" />
    <path d="M4 7h12" />
    <path d="M7 12.5 9 14.5l4-4.5" />
  </Glyph>
);

/** Brand monogram: a Z cut from a square. */
/** Access: a key whose bow is a person, granting a role to someone. */
export const AccessGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <circle cx="7" cy="7" r="3.5" />
    <path d="M9.6 9.6 16.5 16.5M13.5 13.5l2-2M15.5 15.5l1.5-1.5" />
  </Glyph>
);

/** Exceptional access: an hourglass inside a frame, time-limited access. */
export const ExceptionalGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <rect x="3" y="3" width="14" height="14" rx="2" />
    <path d="M7 6.5h6M7 13.5h6M7.5 6.5c0 2 5 2 5 3.5s-5 1.5-5 3.5M12.5 6.5c0 2-5 2-5 3.5" />
  </Glyph>
);

/** Platform: a hub, one solid centre linked to four nodes (coordination, not control). */
export const PlatformGlyph = (p: GlyphProps) => (
  <Glyph {...p}>
    <rect x="7.5" y="7.5" width="5" height="5" rx="1" fill="currentColor" />
    <circle cx="4" cy="4" r="1.6" />
    <circle cx="16" cy="4" r="1.6" />
    <circle cx="4" cy="16" r="1.6" />
    <circle cx="16" cy="16" r="1.6" />
    <path d="M5.2 5.2 7.5 7.5M14.8 5.2 12.5 7.5M5.2 14.8 7.5 12.5M14.8 14.8 12.5 12.5" />
  </Glyph>
);

export const ZoikoMark = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true" focusable="false">
    <rect x="0.75" y="0.75" width="28.5" height="28.5" rx="7.25" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
    <path d="M9 9.5h12L9 20.5h12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" strokeLinejoin="miter" />
    <circle cx="22.5" cy="7.5" r="1.4" fill="currentColor" />
  </svg>
);
