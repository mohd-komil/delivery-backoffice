'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { getCrewUser, signOut } from '@/shared/api/client';
import { useCrewResource } from '@/shared/api/use-resource';
import { Brand } from '@/shared/ui/brand';
import { Button } from '@/shared/ui/button';
import { Loading } from '@/shared/ui/feedback';
import { Icon } from '@/shared/ui/icon';
import { InstallHelp, Preferences } from '@/shared/ui/preferences';
import { ResourceError } from '@/shared/ui/resource-feedback';

export function CrewWorkspace({ children }: { children: ReactNode }) {
  const t = useTranslations('crew');
  const { resource, refresh } = useCrewResource(getCrewUser);
  const [signingOut, setSigningOut] = useState(false);

  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    toast.dismiss('crew-sign-out');
    const result = await signOut();

    if (result.ok || result.status === 401) {
      window.location.replace('/login');
      return;
    }

    setSigningOut(false);
    toast.error(t('signOutError'), { id: 'crew-sign-out' });
  }

  return <div className="workspace-shell">
    <header className="workspace-header">
      <div className="workspace-header-inner">
        <Link href="/visits" prefetch={false} className="brand-link" aria-label={t('brand')}><Brand /></Link>
        {resource.state === 'ready' ? <div className="account-actions">
          <span className="account-name" title={resource.data.name}>{resource.data.name}</span>
          <Button variant="secondary" className="sign-out" disabled={signingOut} onClick={() => void logout()}>
            <Icon name="logout" size={16} />
            {signingOut ? t('signingOut') : t('signOut')}
          </Button>
        </div> : null}
      </div>
    </header>
    <main id="main-content" tabIndex={-1} className="workspace-main">
      {resource.state === 'loading' ? <Loading>{t('loading')}</Loading> : null}
      {resource.state === 'error' ? <ResourceError status={resource.status} retry={refresh} /> : null}
      {resource.state === 'ready' ? children : null}
    </main>
    <footer className="workspace-footer">
      <Preferences />
      <InstallHelp />
    </footer>
  </div>;
}
