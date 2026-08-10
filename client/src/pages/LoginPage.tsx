import { useState, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuthStore } from '../stores/authStore';
import VoiceOrb from '../components/VoiceOrb';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const { login, isLoading, error, clearError } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login({ email, password });
      navigate('/');
    } catch {
      // Error is set in the store
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <div className="mb-12 flex flex-col items-center gap-5 text-center">
        <VoiceOrb state="idle" size={120} showGlow />
        <div>
          <h1 className="font-display text-4xl tracking-tight text-linen sm:text-5xl">
            AI Bestie
          </h1>
          <p className="mt-3 font-mono text-[12px] uppercase tracking-[0.25em] text-linen-dim/70">
            · come back to the line ·
          </p>
        </div>
      </div>

      <motion.form
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut', delay: 0.15 }}
        onSubmit={handleSubmit}
        className="w-full max-w-xl rounded-[40px] border border-line/70 bg-clay/25 p-10 shadow-2xl backdrop-blur-sm sm:p-12"
        style={{ boxShadow: 'var(--shadow-ember-inner)' }}
      >
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="mb-6 rounded-2xl border border-ember/40 bg-ember/10 px-5 py-4 font-sans text-sm text-ember-soft"
          >
            {error}
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
          className="mb-16"
        >
          <label htmlFor="email" className="mb-3 block font-sans text-[15px] font-medium text-linen">
            Email
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-5 flex items-center text-linen-dim/60">
              <MailIcon />
            </span>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearError();
              }}
              required
              autoComplete="email"
              placeholder="you@example.com"
              className="h-14 w-full rounded-2xl border border-line/70 bg-ink-2/80 pl-[58px] pr-5 text-base text-linen placeholder-linen-dim/40 transition-colors duration-150 hover:border-line focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/30"
            />
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.25 }}
          className="mb-10"
        >
          <label htmlFor="password" className="mb-3 block font-sans text-[15px] font-medium text-linen">
            Password
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-5 flex items-center text-linen-dim/60">
              <LockIcon size={18} />
            </span>
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearError();
              }}
              required
              autoComplete="current-password"
              placeholder="••••••••"
              className="h-14 w-full rounded-2xl border border-line/70 bg-ink-2/80 pl-[58px] pr-[58px] text-base text-linen placeholder-linen-dim/40 transition-colors duration-150 hover:border-line focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/30"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-5 flex items-center text-linen-dim/60 transition-colors hover:text-linen"
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </motion.div>

        <motion.button
          type="submit"
          disabled={isLoading}
          whileHover={{ scale: 1.02, y: -2 }}
          whileTap={{ scale: 0.98 }}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-ember to-ember-soft px-6 font-sans text-base font-semibold text-ink shadow-xl shadow-ember/25 transition-all duration-150 hover:brightness-105 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? 'Connecting…' : (
            <>
              Sign in
              <ArrowIcon />
            </>
          )}
        </motion.button>
      </motion.form>

      <p className="mt-10 flex items-center justify-center gap-2 text-center font-sans text-[15px] text-linen-dim">
        <span>New here?</span>
        <Link to="/register" className="font-medium text-ember transition-colors hover:text-ember-soft">
          Make a bestie
        </Link>
      </p>

      <div className="mt-10 flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.14em] text-linen-dim/60">
        <span className="flex items-center gap-1.5">
          <ShieldIcon />
          Your data is safe
        </span>
        <span className="h-3 w-px bg-line" />
        <span className="flex items-center gap-1.5">
          <BoltIcon />
          Fast &amp; private
        </span>
        <span className="h-3 w-px bg-line" />
        <span className="flex items-center gap-1.5">
          <LockIcon />
          Secure login
        </span>
      </div>
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 6-10 7L2 6" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}