import { motion } from "motion/react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "./icons.js";

type Session = { username: string };

async function readSession(): Promise<Session | null> {
  const res = await fetch("/api/auth/session", { credentials: "include" });
  if (!res.ok) return null;
  const data = (await res.json()) as { ok?: boolean; username?: string };
  return data.ok && data.username ? { username: data.username } : null;
}

export function DemoGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState("preview");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void readSession()
      .then((next) => {
        if (live) setSession(next);
      })
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; username?: string };
      if (!res.ok) {
        setError(data.error || "Could not sign in.");
        return;
      }
      setSession({ username: data.username || username });
      setPassword("");
    } catch {
      setError("Memories couldn’t reach the sign-in server.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setSession(null);
  }

  if (!ready) {
    return (
      <div className="signin-boot" role="status">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
        </span>
        Opening Memories…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="signin-bg">
        <motion.form
          className="signin"
          onSubmit={onSubmit}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", duration: 0.55, bounce: 0.18 }}
          aria-labelledby="signin-title"
        >
          <div className="signin-brand">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
            </span>
            <span>Memories</span>
          </div>
          <h1 id="signin-title">Private preview</h1>
          <p>This sample cabinet is for feedback only. Sign in with the preview account you were given.</p>
          <label className="field">
            <span>Email or username</span>
            <input
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error ? (
            <p className="signin-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </motion.form>
      </div>
    );
  }

  return (
    <DemoSession username={session.username} onSignOut={() => void signOut()}>
      {children}
    </DemoSession>
  );
}

function DemoSession({ username, onSignOut, children }: { username: string; onSignOut: () => void; children: ReactNode }) {
  return (
    <div className="demo-session">
      {children}
      <div className="demo-session-bar">
        <span>
          Signed in as <strong>{username}</strong>
          <span className="demo-session-sep">·</span>
          Sample preview
        </span>
        <button type="button" className="btn btn-quiet" onClick={onSignOut}>
          <Icon name="close" size={14} />
          Sign out
        </button>
      </div>
    </div>
  );
}
