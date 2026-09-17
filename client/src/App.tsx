import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from './stores/authStore';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ChatPage from './pages/ChatPage';
import GuestChatPage from './pages/GuestChatPage';
import CreatePersonaPage from './pages/CreatePersonaPage';

function App() {
  const { initialize, isAuthenticated, isGuest, isLoading } = useAuthStore();

  useEffect(() => {
    initialize();
  }, [initialize]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink">
        <div className="flex flex-col items-center gap-4">
          <div className="h-3 w-3 animate-pulse rounded-full bg-ember" />
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-linen-dim">
            connecting
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink">
      <Routes>
        {/* Public routes */}
        <Route
          path="/login"
          element={
            isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />
          }
        />
        <Route
          path="/register"
          element={
            isAuthenticated ? <Navigate to="/" replace /> : <RegisterPage />
          }
        />

        <Route
          path="/create-persona"
          element={
            isAuthenticated ? <CreatePersonaPage /> : <Navigate to="/login" replace />
          }
        />

        {/* Signed-in users get the full chat experience; guests get a
            read-only preview; everyone else is sent to sign in. */}
        <Route
          path="/"
          element={
            isAuthenticated ? (
              <ChatPage />
            ) : isGuest ? (
              <GuestChatPage />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

export default App;