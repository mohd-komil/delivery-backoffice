'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, type PointerEvent } from 'react';
import { Button } from '@/shared/ui/button';
import { Icon } from '@/shared/ui/icon';
import {
  extendSignatureStroke, signatureExtent, signatureHasInk, signaturePoint, startSignatureStroke,
  type SignatureStrokes,
} from '../model/signature';

type PadProps = {
  role: 'customer' | 'crew';
  strokes: SignatureStrokes;
  disabled: boolean;
  error: string | null;
  update: (transform: (strokes: SignatureStrokes) => SignatureStrokes) => void;
};

export function SignaturePad({ role, strokes, disabled, error, update }: PadProps) {
  const t = useTranslations('crew');
  const id = useId();
  const pointer = useRef<number | null>(null);
  const title = t(role === 'customer' ? 'signatureCustomer' : 'signatureCrew');
  const signed = signatureHasInk(strokes);

  function point(event: PointerEvent<HTMLDivElement>) {
    return signaturePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
  }

  function begin(event: PointerEvent<HTMLDivElement>) {
    if (disabled || pointer.current !== null || !event.isPrimary || event.button !== 0) return;
    const position = point(event);
    if (!position) return;
    const next = startSignatureStroke(strokes, position);
    if (next === strokes) return;

    pointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    update((previous) => startSignatureStroke(previous, position));
  }

  function draw(event: PointerEvent<HTMLDivElement>) {
    if (disabled || pointer.current !== event.pointerId) return;
    const position = point(event);
    if (position) update((previous) => extendSignatureStroke(previous, position));
  }

  function end(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    draw(event);
    end(event);
  }

  return <section className="signature-pad-panel" aria-labelledby={`${id}-heading`}>
    <div className="signature-pad-header">
      <h4 id={`${id}-heading`}>{title}</h4>
      <span role="status" className={signed ? 'signature-captured' : 'text-muted'}>
        {signed ? <Icon name="check" size={14} /> : null}{t(signed ? 'signatureCaptured' : 'signatureAwaiting')}
      </span>
    </div>
    <div className="signature-surface" data-signature-pad={role} role="img" aria-label={title}
      aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
      tabIndex={disabled ? -1 : 0} data-invalid={Boolean(error) || undefined} data-disabled={disabled || undefined}
      onPointerDown={begin} onPointerMove={draw} onPointerUp={finish} onPointerCancel={end} onLostPointerCapture={end}>
      {strokes.length === 0 ? <span className="signature-placeholder" aria-hidden="true">{t('signatureSignHere')}</span> : null}
      <svg aria-hidden="true" viewBox={`0 0 ${signatureExtent} ${signatureExtent}`} preserveAspectRatio="none">
        {strokes.map((stroke, index) => {
          const first = stroke[0];
          return stroke.length === 1 && first ? <circle key={index} cx={first.x} cy={first.y} r={6} fill="currentColor" />
            : <polyline key={index} points={stroke.map(({ x, y }) => `${x},${y}`).join(' ')} fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
    </div>
    <div className="signature-pad-footer">
      <p id={`${id}-hint`} className="text-muted">{t('signatureDrawHint')}</p>
      <Button variant="ghost" disabled={disabled || strokes.length === 0} aria-label={t(role === 'customer' ? 'signatureClearCustomer' : 'signatureClearCrew')}
        onClick={() => { pointer.current = null; update(() => []); }}>{t('signatureClear')}</Button>
    </div>
    {error ? <p id={`${id}-error`} className="field-error" role="alert">{error}</p> : null}
  </section>;
}
