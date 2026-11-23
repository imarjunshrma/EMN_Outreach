/* eslint-disable @next/next/no-img-element */
// Outvexa brand: the paper-plane mark and the full logo. Files live in /public/brand (transparent PNGs cut from the
// master logo). The full logo has a navy wordmark for light backgrounds and a white one for dark backgrounds.

export const BRAND = { name: 'Outvexa', tagline: 'Research-led cold email', purple: '#4F26FC', ink: '#070C1C' } as const;

const LOGO_RATIO = 1396 / 268; // width / height of the full logo files
const MARK_RATIO = 347 / 268;

/** The paper-plane mark on its own (sidebars, compact headers). Height in px. */
export function BrandMark({ height = 28, className = '' }: { height?: number; className?: string }) {
  return <img src="/brand/outvexa-mark.png" alt="" aria-hidden width={Math.round(height * MARK_RATIO)} height={height} className={`shrink-0 select-none ${className}`} draggable={false} />;
}

/**
 * Full logo (mark + "Outvexa"). `tone`: 'auto' follows light/dark mode, 'light' forces the navy wordmark,
 * 'dark' forces the white wordmark (for always-dark panels).
 */
export function BrandLogo({ height = 28, tone = 'auto', className = '' }: { height?: number; tone?: 'auto' | 'light' | 'dark'; className?: string }) {
  const w = Math.round(height * LOGO_RATIO);
  const img = (src: string, cls: string) => <img src={src} alt={BRAND.name} width={w} height={height} className={`select-none ${cls} ${className}`} draggable={false} />;
  if (tone === 'light') return img('/brand/outvexa-logo.png', '');
  if (tone === 'dark') return img('/brand/outvexa-logo-white.png', '');
  return <>{img('/brand/outvexa-logo.png', 'dark:hidden')}{img('/brand/outvexa-logo-white.png', 'hidden dark:block')}</>;
}
