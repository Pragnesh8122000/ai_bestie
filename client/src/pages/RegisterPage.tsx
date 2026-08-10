import { useState, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuthStore } from '../stores/authStore';
import VoiceOrb from '../components/VoiceOrb';

export default function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const { register, isLoading, error, clearError } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      useAuthStore.setState({ error: 'Passwords do not match' });
      return;
    }
    try {
      await register({ name, email, password });
      navigate('/');
    } catch {
      // Error is set in the store
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <div className="mb-8 flex flex-col items-center gap-5 text-center">
        <VoiceOrb state="idle" size={120} showGlow />
        <div>
          <h1 className="font-display text-4xl tracking-tight text-linen sm:text-5xl">
            AI Bestie
          </h1>
          <p className="mt-3 font-mono text-[12px] uppercase tracking-[0.25em] text-linen-dim/70">
            · meet your bestie ·
          </p>
        </div>
      </div>

      <motion.form
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut', delay: 0.15 }}
        onSubmit={handleSubmit}
        className="w-full max-w-lg rounded-[40px] border border-line/70 bg-clay/25 p-8 shadow-2xl backdrop-blur-sm sm:p-10"
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

        <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 }} className="mb-5">
          <label htmlFor="name" className="mb-3 block font-sans text-[15px] font-medium text-linen">
            Your name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clearError();
            }}
            required
            autoComplete="name"
            placeholder="What should we call you?"
            className="w-full rounded-2xl border border-line/70 bg-ink-2/80 px-5 py-4 text-[16px] text-linen placeholder-linen-dim/40 transition-colors duration-150 hover:border-line focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/30"
          />
        </motion.div>

        <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 }} className="mb-5">
          <label htmlFor="email" className="mb-3 block font-sans text-[15px] font-medium text-linen">
            Email
          </label>
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
            className="w-full rounded-2xl border border-line/70 bg-ink-2/80 px-5 py-4 text-[16px] text-linen placeholder-linen-dim/40 transition-colors duration-150 hover:border-line focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/30"
          />
        </motion.div>

        <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 }} className="mb-7">
          <label htmlFor="password" className="mb-3 block font-sans text-[15px] font-medium text-linen">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              clearError();
            }}
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className="w-full rounded-2xl border border-line/70 bg-ink-2/80 px-5 py-4 text-[16px] text-linen placeholder-linen-dim/40 transition-colors duration-150 hover:border-line focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/30"
          />
        </motion.div>

        <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.35 }} className="mb-7">
          <label htmlFor="confirmPassword" className="mb-3 block font-sans text-[15px] font-medium text-linen">
            One more time
          </label>
          <input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              clearError();
            }}
            required
            autoComplete="new-password"
            placeholder="••••••••"
            className="w-full rounded-2xl border border-line/70 bg-ink-2/80 px-5 py-4 text-[16px] text-linen placeholder-linen-dim/40 transition-colors duration-150 hover:border-line focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/30"
          />
        </motion.div>

        <motion.button
          type="submit"
          disabled={isLoading}
          whileHover={{ scale: 1.02, y: -2 }}
          whileTap={{ scale: 0.98 }}
          className="w-full rounded-full bg-gradient-to-br from-ember to-ember-soft px-6 py-4.5 font-sans text-[15px] font-semibold text-ink shadow-xl shadow-ember/25 transition-all duration-150 hover:brightness-105 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? 'Setting up…' : 'Create account'}
        </motion.button>
      </motion.form>

      <p className="mt-8 flex items-center justify-center gap-2 text-center font-sans text-[15px] text-linen-dim">
        <span>Already on the line?</span>
        <Link to="/login" className="font-medium text-ember transition-colors hover:text-ember-soft">
          Sign in
        </Link>
      </p>
    </div>
  );
}