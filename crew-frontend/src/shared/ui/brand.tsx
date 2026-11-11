import { Icon } from './icon';

export function Brand() {
  return <span className="brand">
    <span className="brand-mark"><Icon name="truck" size={21} /></span>
    <span className="brand-name">MOHD<span className="brand-divider" aria-hidden="true" /><span className="brand-crew">Crew</span></span>
  </span>;
}
