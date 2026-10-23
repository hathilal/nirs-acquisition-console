
import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";

export default function AuthGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingUp, setSigningUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setMessage(error.message);
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      if (signingUp) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (error) throw error;

        setMessage(
          data.session
            ? "Account created. You are signed in."
            : "Account created. Check your email for a confirmation link, then sign in."
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Authentication failed."
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setMessage("");
    const { error } = await supabase.auth.signOut();
    if (error) setMessage(error.message);
  }

  if (loading) {
    return <main style={{ padding: 32 }}>Checking sign-in…</main>;
  }

  if (session) {
    return (
      <>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 12,
            padding: "8px 16px",
            fontSize: 13,
          }}
        >
          <span>{session.user.email}</span>
          <button type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
        {message && <p role="status">{message}</p>}
        {children}
      </>
    );
  }

  return (
    <main
      style={{
        maxWidth: 420,
        margin: "8vh auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>NIRS Acquisition Console</h1>
      <h2>{signingUp ? "Create account" : "Sign in"}</h2>
      <p>Sign in to access your NIRS workspace.</p>

      <form onSubmit={handleSubmit}>
        <label htmlFor="auth-email">Email</label>
        <input
          id="auth-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          style={{ display: "block", width: "100%", margin: "6px 0 16px", padding: 10 }}
        />

        <label htmlFor="auth-password">Password</label>
        <input
          id="auth-password"
          type="password"
          autoComplete={signingUp ? "new-password" : "current-password"}
          minLength={6}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          style={{ display: "block", width: "100%", margin: "6px 0 16px", padding: 10 }}
        />

        <button type="submit" disabled={busy}>
          {busy
            ? "Please wait…"
            : signingUp
              ? "Create account"
              : "Sign in"}
        </button>
      </form>

      <p>
        {signingUp ? "Already registered?" : "New to NIRS Console?"}{" "}
        <button
          type="button"
          onClick={() => {
            setSigningUp((value) => !value);
            setMessage("");
          }}
        >
          {signingUp ? "Sign in" : "Create an account"}
        </button>
      </p>

      {message && <p role="status">{message}</p>}
    </main>
  );
}
