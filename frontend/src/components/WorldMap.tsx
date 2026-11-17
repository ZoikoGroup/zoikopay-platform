import dots from "../assets/world-dots.svg";
import pins from "../assets/world-pins.json";

/**
 * Subtle dotted world map with the two fixture legal cells marked. Purely
 * decorative: it is hidden from assistive technology and conveys no data that
 * is not also stated in text.
 */
export function WorldMap() {
  const vb = pins.viewBox.split(" ").map(Number);
  const [, , w = 111, h = 56] = vb;
  const uk = pins.pins.uk;
  const eu = pins.pins.eu;
  // A gentle arc between the two cells.
  const mx = (uk.x + eu.x) / 2;
  const my = Math.min(uk.y, eu.y) - 4;
  return (
    <div className="welcome-map" aria-hidden="true" style={{ aspectRatio: `${w} / ${h}` }}>
      <img src={dots} alt="" />
      <svg viewBox={pins.viewBox} preserveAspectRatio="xMidYMid meet">
        <path d={`M${uk.x},${uk.y} Q${mx},${my} ${eu.x},${eu.y}`} fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="0.18" strokeDasharray="0.6 0.5" />
        {[uk, eu].map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="1.6" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="0.12" />
            <circle cx={p.x} cy={p.y} r="0.55" fill="#fff" />
          </g>
        ))}
      </svg>
    </div>
  );
}
