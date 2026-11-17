'use client';

import { Combobox } from '@/shared/ui/combobox';


import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import type { VisitDetail } from '@/shared/api/contracts';
import { Button } from '@/shared/ui/button';
import { Icon } from '@/shared/ui/icon';
import { maxFinishPhotoCount, maxFinishPhotoMiB, photoAccept, selectFinishPhotos } from '../model/photo';
import { visitItemLabel } from '../model/item-reference';

export type FinishPhoto = { file: File; previewUrl: string; sourceLineId?: number };

export function usePhotoPreviews() {
  const previewUrls = useRef(new Set<string>());
  useEffect(() => {
    const owned = previewUrls.current;
    return () => { for (const url of owned) URL.revokeObjectURL(url); owned.clear(); };
  }, []);
  return {
    create(file:File) { const url=URL.createObjectURL(file); previewUrls.current.add(url); return url; },
    remove(url:string) { URL.revokeObjectURL(url); previewUrls.current.delete(url); },
  };
}

export function FinishPhotos({ items, photos, requiredError, onChange, previews, fixedLineId }: {
  items: VisitDetail['items'];
  photos: readonly FinishPhoto[];
  requiredError: boolean;
  onChange: (next: FinishPhoto[]) => void;
  previews:ReturnType<typeof usePhotoPreviews>;
  fixedLineId?:number;
}) {
  const t = useTranslations('crew');
  const id = useId();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ReturnType<typeof selectFinishPhotos>['error']>(null);
  const [target, setTarget] = useState('');
  const itemsById = new Map(items.map((item) => [String(item.sourceLineId), item]));
  const targetId = fixedLineId??itemsById.get(target)?.sourceLineId;
  const displayedPhotos=fixedLineId===undefined?photos:photos.filter((photo)=>photo.sourceLineId===fixedLineId);
  const missingScope = photos.some(({ sourceLineId }) => sourceLineId !== undefined && !itemsById.has(String(sourceLineId)));
  const failure = error ?? (requiredError ? 'photoRequired' : missingScope ? 'finishPhotoScopeRequired' : null);
  const describedBy = `${id}-hint${failure ? ` ${id}-error` : ''}`;
  const scopeOptions = <>
    <option value="">{t('finishPhotoGeneral')}</option>
    {items.map((item) => <option key={item.sourceLineId} value={item.sourceLineId}>
      {visitItemLabel(item,(line)=>t('productLine',{line}))}
    </option>)}
  </>;

  function choosePhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = event.currentTarget.files;
    if (!files?.length) return;
    const { added, error: selectionError } = selectFinishPhotos(photos.map(({ file }) => file), files);
    event.currentTarget.value = '';
    setError(selectionError);
    if (!added.length) return;

    const next = added.map((file) => {
      const previewUrl = previews.create(file);
      return { file, previewUrl, sourceLineId: targetId };
    });
    onChange([...photos, ...next]);
  }

  function removePhoto(previewUrl: string) {
    previews.remove(previewUrl);
    setError(null);
    onChange(photos.filter((photo) => photo.previewUrl !== previewUrl));
  }

  function changeScope(previewUrl: string, value: string) {
    setError(null);
    const sourceLineId = itemsById.get(value)?.sourceLineId;
    onChange(photos.map((photo) => photo.previewUrl === previewUrl ? { ...photo, sourceLineId } : photo));
  }

  return <div className="photo-field" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
    <h3 id={`${id}-label`}>{t(fixedLineId===undefined?'finishPhotos':'finishLinePhotos')}</h3>
    <p id={`${id}-hint`} className="text-muted">{fixedLineId===undefined?t('finishPhotoHint', { count: maxFinishPhotoCount, total: maxFinishPhotoMiB }):t('finishLinePhotoHint',{line:fixedLineId})}</p>
    {items.length > 0 && fixedLineId===undefined ? <label className="field">
      <span>{t('finishPhotoTarget')}</span>
      <Combobox value={targetId ?? ''} onChange={(event) => setTarget(event.currentTarget.value)} data-finish-photo-scope>{scopeOptions}</Combobox>
    </label> : null}
    <div className="photo-actions">
      <input ref={camera} type="file" hidden accept={photoAccept} capture="environment" onChange={choosePhotos} />
      <input ref={picker} type="file" hidden accept={photoAccept} multiple onChange={choosePhotos} />
      <Button variant="secondary" data-finish-photo-action onClick={() => camera.current?.click()} aria-describedby={describedBy}>
        <Icon name="camera" size={16} />{t('takePhoto')}
      </Button>
      <Button variant="secondary" onClick={() => picker.current?.click()} aria-describedby={describedBy}>
        {t('finishChoosePhotos')}
      </Button>
    </div>
    <p className="text-muted" role="status">{t('finishPhotoCount', { count: displayedPhotos.length })}</p>
    {displayedPhotos.length ? <ul className="plain-list grid gap-2">
      {displayedPhotos.map(({ file, previewUrl, sourceLineId }, index) => {
        const unavailable = sourceLineId !== undefined && !itemsById.has(String(sourceLineId));
        return <li key={previewUrl} className="selected-photo justify-between">
          <div className="flex min-w-0 items-center gap-2 py-1">
            <Image className="size-12 shrink-0 rounded object-cover" src={previewUrl} width={48} height={48} alt="" unoptimized />
            <span className="min-w-0 wrap-anywhere">{file.name}</span>
          </div>
          <Button variant="ghost" aria-label={t('finishPhotoRemove', { name: file.name, number: index + 1 })}
            onClick={() => removePhoto(previewUrl)}>{t('removePhoto')}</Button>
          {fixedLineId===undefined&&(items.length > 0 || unavailable) ? <label className="field w-full pb-1">
            <span>{t('finishPhotoProduct')}</span>
            <Combobox value={sourceLineId ?? ''} aria-label={t('finishPhotoProductFor', { name: file.name, number: index + 1 })}
              aria-invalid={unavailable || undefined} aria-describedby={unavailable ? `${id}-error` : undefined}
              data-finish-photo-scope data-finish-photo-unavailable={unavailable || undefined}
              onChange={(event) => changeScope(previewUrl, event.currentTarget.value)}>
              {unavailable ? <option value={sourceLineId} disabled>{t('productLine', { line: sourceLineId })}</option> : null}
              {scopeOptions}
            </Combobox>
          </label> : null}
        </li>;
      })}
    </ul> : null}
    {failure ? <p id={`${id}-error`} className="field-error" role="alert">
      {t(failure, { count: maxFinishPhotoCount, total: maxFinishPhotoMiB })}
    </p> : null}
  </div>;
}
