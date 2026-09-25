import { CSSProperties, useMemo } from 'react';

type OrbState = 'idle' | 'thinking' | 'speaking' | 'listening';

interface VoiceOrbProps {
  state: OrbState;
  /** Pixel size of the outer orb box. Default 220px for desktop call presence. */
  size?: number;
  className?: string;
  showGlow?: boolean;
  /** Normalized live microphone/playback energy. */
  level?: number;
  /** Accessible name for the active persona or generic bestie. */
  label?: string;
}

/**
 * Sam, as a voice. A warm ember core wrapped in concentric ripple rings.
 * Now with an optional outer glow wrapper for extra presence on auth pages.
 */
export default function VoiceOrb({
  state,
  size = 220,
  className = '',
  showGlow = false,
  level = 0,
  label = 'AI Bestie',
}: VoiceOrbProps) {
  const ringCount = 3;
  const rings = useMemo(() => Array.from({ length: ringCount }, (_, i) => i), []);
  const coreSize = Math.round(size * 0.46);

  return (
    <div
      className={`orb ${className}`}
      data-state={state}
      style={
        {
          width: size,
          height: size,
          '--orb-level': Math.max(0, Math.min(1, level)),
        } as CSSProperties
      }
      role="img"
      aria-label={`${label} is ${state}`}
    >
      {showGlow && <span className="orb-glow" />}
      {rings.map((i) => (
        <span key={i} className="orb-ring" style={{ '--i': i } as CSSProperties} />
      ))}
      <span className="orb-core" style={{ width: coreSize, height: coreSize }} />
    </div>
  );
}
