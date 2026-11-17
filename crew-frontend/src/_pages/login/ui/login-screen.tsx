'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { signIn } from '@/shared/api/client';
import { Brand } from '@/shared/ui/brand';
import { Button } from '@/shared/ui/button';
import { Notice } from '@/shared/ui/feedback';
import { Icon } from '@/shared/ui/icon';
import { InstallHelp, Preferences } from '@/shared/ui/preferences';

export function LoginScreen() {
  const t = useTranslations('crew');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<'invalidCredentials' | 'rateLimited' | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    toast.dismiss('crew-sign-in');
    const fields = new FormData(event.currentTarget);
    const login = fields.get('login');
    const password = fields.get('password');
    if (typeof login !== 'string' || typeof password !== 'string' || !login.trim()) {
      setError('invalidCredentials');
      return;
    }

    setSubmitting(true);
    setError(null);
    const result = await signIn(login.trim(), password);
    if (result.ok) {
      window.location.replace('/visits');
      return;
    }

    if (result.status === 429) setError('rateLimited');
    else if ([400, 401, 403].includes(result.status)) setError('invalidCredentials');
    else toast.error(t('loadError'), { id: 'crew-sign-in' });
    setSubmitting(false);
  }

  return <div className="login-shell">
    <header className="login-header">
      <Brand />
      <Preferences />
    </header>
    <main id="main-content" tabIndex={-1} className="login-main">
      <div className="login-intro">
        <span className="eyebrow"><Icon name="truck" size={16} /> {t('workspace')}</span>
        <h1>{t('signInTitle')}</h1>
        <p>{t('signInDescription')}</p>
      </div>
      <form className="panel login-form" method="post" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
        {error ? <Notice>{t(error)}</Notice> : null}
        <label className="field" htmlFor="crew-login">
          <span>{t('username')}</span>
          <input id="crew-login" name="login" required autoComplete="username" autoCapitalize="none" spellCheck={false} enterKeyHint="next" maxLength={128} />
        </label>
        <div className="field">
          <label htmlFor="crew-password">{t('password')}</label>
          <div className="password-field">
            <input id="crew-password" name="password" type={showPassword ? 'text' : 'password'} required autoComplete="current-password" enterKeyHint="go" maxLength={256} />
            <Button className="password-toggle" variant="ghost" aria-label={showPassword ? t('hidePassword') : t('showPassword')} onClick={() => setShowPassword((visible) => !visible)}>
              <Icon name={showPassword ? 'eyeOff' : 'eye'} />
            </Button>
          </div>
        </div>
        <Button type="submit" className="login-submit" disabled={submitting}>
          {submitting ? t('signingIn') : t('signIn')}
          <Icon name="arrowRight" size={17} />
        </Button>
        <p className="login-help">{t('signInHelp')}</p>
      </form>
      <InstallHelp />
    </main>
  </div>;
}
