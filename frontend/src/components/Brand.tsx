export function Brand({ light = false, compact = false }: { light?: boolean; compact?: boolean }) {
  return <span className={'zoiko-brand' + (light ? ' zoiko-brand-light' : '')}>
    <img src={compact ? '/brand/icon.svg' : light ? '/brand/logo-light.svg' : '/brand/logo.svg'} alt="Zoiko Pay" />
  </span>;
}
