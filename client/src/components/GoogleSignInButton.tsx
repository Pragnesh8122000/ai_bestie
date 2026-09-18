import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore';

const SCRIPT_ID = 'google-identity-services';
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

let scriptPromise: Promise<void> | null = null;
let initializedClientId: string | null = null;
let activeCredentialHandler: ((response: GoogleCredentialResponse) => void) | null = null;

function loadGoogleIdentityServices(): Promise<void> {
  if (window.google?.accounts.id) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  const pending = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    let timeout: ReturnType<typeof setTimeout>;
    const cleanUp = () => {
      clearTimeout(timeout);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanUp();
      if (window.google?.accounts.id) {
        resolve();
      } else {
        script.remove();
        reject(new Error('Google Identity Services did not initialize'));
      }
    };
    const onError = () => {
      cleanUp();
      script.remove();
      reject(new Error('Google Identity Services failed to load'));
    };

    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
    timeout = setTimeout(() => {
      cleanUp();
      script.remove();
      reject(new Error('Google Identity Services timed out'));
    }, 10_000);
    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });

  scriptPromise = pending;
  return pending;
}

interface Props {
  clientId?: string;
  text?: 'signin_with' | 'signup_with' | 'continue_with';
  onSuccess?: () => void;
}

export default function GoogleSignInButton({
  clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim(),
  text = 'continue_with',
  onSuccess,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const successRef = useRef(onSuccess);
  const exchangeInFlightRef = useRef(false);
  successRef.current = onSuccess;
  const googleLogin = useAuthStore((state) => state.googleLogin);
  const clearError = useAuthStore((state) => state.clearError);
  const [status, setStatus] = useState<'loading' | 'ready' | 'signing-in' | 'error'>(
    clientId ? 'loading' : 'error',
  );

  useEffect(() => {
    if (!clientId) return;
    let active = true;

    activeCredentialHandler = async ({ credential }) => {
      if (exchangeInFlightRef.current) return;
      exchangeInFlightRef.current = true;
      clearError();
      if (active) setStatus('signing-in');
      try {
        await googleLogin(credential);
        successRef.current?.();
      } catch {
        // The store owns the user-facing server error.
      } finally {
        exchangeInFlightRef.current = false;
        if (active) setStatus('ready');
      }
    };

    loadGoogleIdentityServices()
      .then(() => {
        if (!active || !containerRef.current || !window.google) return;

        if (initializedClientId !== clientId) {
          window.google.accounts.id.initialize({
            client_id: clientId,
            ux_mode: 'popup',
            callback: (response) => activeCredentialHandler?.(response),
          });
          initializedClientId = clientId;
        }

        containerRef.current.replaceChildren();
        window.google.accounts.id.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text,
          shape: 'pill',
          width: Math.min(400, Math.max(240, containerRef.current.clientWidth || 320)),
        });
        setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('error');
      });

    return () => {
      active = false;
      activeCredentialHandler = null;
    };
  }, [clientId, clearError, googleLogin, text]);

  if (!clientId) {
    return (
      <div className="space-y-2 text-center" data-testid="google-unconfigured">
        <button
          type="button"
          disabled
          aria-describedby="google-unconfigured-help"
          className="flex h-12 w-full cursor-not-allowed items-center justify-center gap-3 rounded-full border border-line/60 bg-ink-2/40 px-5 font-sans text-sm text-linen-dim/60"
        >
          <GoogleIcon />
          Google sign-in unavailable
        </button>
        <p id="google-unconfigured-help" className="font-mono text-[10px] uppercase tracking-[0.12em] text-linen-dim/60">
          Continue with email and password
        </p>
      </div>
    );
  }

  return (
    <div className="relative min-h-12 w-full" aria-label="Sign in with Google">
      {status === 'loading' && (
        <div role="status" className="flex h-12 w-full items-center justify-center rounded-full border border-line/60 bg-ink-2/40 font-sans text-sm text-linen-dim">
          Loading Google sign-in…
        </div>
      )}
      {status === 'signing-in' && (
        <div role="status" className="flex h-12 w-full items-center justify-center rounded-full border border-ember/40 bg-ember/10 font-sans text-sm text-ember-soft">
          Signing in with Google…
        </div>
      )}
      {status === 'error' && (
        <div role="alert" className="rounded-2xl border border-ember/35 bg-ember/10 px-4 py-3 text-center font-sans text-sm text-ember-soft">
          Google sign-in could not load. Use email and password instead.
        </div>
      )}
      <div
        ref={containerRef}
        className={`flex min-h-12 w-full justify-center ${status === 'ready' ? '' : 'hidden'}`}
      />
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="currentColor" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.715v2.258h2.909c1.702-1.567 2.684-3.875 2.684-6.614Z" />
      <path fill="currentColor" opacity=".8" d="M9 18c2.43 0 4.468-.806 5.956-2.18l-2.91-2.259c-.805.54-1.835.86-3.046.86-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z" />
      <path fill="currentColor" opacity=".65" d="M3.963 10.707A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.168.281-1.707V4.961H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.039l3.007-2.332Z" />
      <path fill="currentColor" opacity=".5" d="M9 3.58c1.322 0 2.508.455 3.441 1.346l2.582-2.582C13.464.891 11.426 0 9 0A9 9 0 0 0 .956 4.961l3.007 2.332C4.672 5.164 6.656 3.58 9 3.58Z" />
    </svg>
  );
}
