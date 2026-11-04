import { Ambient } from './Ambient';

export default function PhosphorBackdrop() {
  return <><Ambient /><div className="phosphor-fog" aria-hidden="true" /><div className="phosphor-raster" aria-hidden="true" /><div className="phosphor-glass" aria-hidden="true" /></>;
}
