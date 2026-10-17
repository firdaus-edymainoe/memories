import type { MemoriesClient } from "@memories/client";
import type { CloudAdminUser, CloudProvider, CloudStatus } from "@memories/core";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

const PROVIDER_LABEL: Record<CloudProvider, string> = {
  google: "Google",
  apple: "Apple",
  microsoft: "Microsoft",
  github: "GitHub",
  facebook: "Facebook",
};

type Mode = "idle" | "sign-in" | "sign-up" | "forgot" | "browser";

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

function ago(iso: string | null) {
  if (!iso) return "Not synced yet";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  return `Synced ${new Date(iso).toLocaleDateString()}`;
}

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!on)} />
  );
}

/**
 * Optional cloud mode in Settings. The app works without an account; signing in adds catalog
 * sync and cloud storage. Admins also see the people who use Memories.
 */
export function CloudSettings({ client, onPlacesChanged }: { client: MemoriesClient; onPlacesChanged: () => void }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await client.cloudStatus());
    } catch {
      setStatus(null);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a browser sign-in is open, check back until it finishes.
  useEffect(() => {
    if (mode !== "browser") return;
    const timer = window.setInterval(() => {
      void client.cloudStatus().then((next) => {
        setStatus(next);
        if (next.user) setMode("idle");
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [client, mode]);

  async function act(work: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (mode === "sign-up") {
      await act(async () => {
        await client.cloudSignUp({ name, email, password });
        setMode("idle");
        setPassword("");
      }, "Account made. We sent you an email to confirm your address.");
    } else if (mode === "sign-in") {
      await act(async () => {
        await client.cloudSignIn({ email, password });
        setMode("idle");
        setPassword("");
      });
    } else if (mode === "forgot") {
      await act(async () => {
        await client.cloudForgotPassword(email);
        setMode("sign-in");
      }, "If there's an account for that email, a reset link is on its way.");
    }
  }

  if (!status?.available) {
    return (
      <section className="setting">
        <h2>Your privacy</h2>
        <div className="setting-row">
          <div>
            <strong>Everything stays on this computer</strong>
            <span>No account, nothing uploaded. Memories only keeps a list of what’s in your places.</span>
          </div>
        </div>
      </section>
    );
  }

  const user = status.user;

  return (
    <>
      <section className="setting cloud">
        <h2>Memories Cloud</h2>
        {!user ? (
          <div className="setting-row">
            <div>
              <strong>Memories works without an account</strong>
              <span>Everything stays on this computer. Sign in to keep your library list in the cloud and to use cloud storage.</span>
            </div>
            {mode === "idle" ? (
              <div className="cloud-actions">
                <button type="button" className="btn btn-soft" onClick={() => setMode("sign-up")}>
                  Create account
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setMode("sign-in")}>
                  Sign in
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="setting-row">
            <div>
              <strong>
                {user.name || user.email} {user.role === "admin" ? <em className="chip ok">Admin</em> : null}
              </strong>
              <span>{user.email}</span>
              {!user.emailVerified ? (
                <span>
                  Please confirm your email.{" "}
                  <button type="button" className="link" disabled={busy} onClick={() => void act(() => client.cloudResendVerification(), "Sent. Check your inbox.")}>
                    Send it again
                  </button>
                </span>
              ) : null}
            </div>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void act(() => client.cloudSignOut())}>
              Sign out
            </button>
          </div>
        )}

        {!user && mode !== "idle" ? (
          <div className="setting-row cloud-form">
            {mode === "browser" ? (
              <div>
                <strong>Finish signing in in your browser</strong>
                <span>We opened a page for you. Come back here when you’re done.</span>
                <div className="cloud-actions">
                  <button type="button" className="btn btn-quiet" onClick={() => setMode("sign-in")}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={(event) => void onSubmit(event)} aria-label={mode === "sign-up" ? "Create account" : mode === "forgot" ? "Reset password" : "Sign in"}>
                {mode === "sign-up" ? (
                  <label className="field">
                    <span>Your name</span>
                    <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
                  </label>
                ) : null}
                <label className="field">
                  <span>Email</span>
                  <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
                </label>
                {mode !== "forgot" ? (
                  <label className="field">
                    <span>Password</span>
                    <input
                      type="password"
                      value={password}
                      minLength={mode === "sign-up" ? 10 : undefined}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                      required
                    />
                  </label>
                ) : null}
                <div className="cloud-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    {mode === "sign-up" ? "Create account" : mode === "forgot" ? "Send reset link" : "Sign in"}
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={() => setMode("idle")}>
                    Not now
                  </button>
                  {mode === "sign-in" ? (
                    <button type="button" className="link" onClick={() => setMode("forgot")}>
                      Forgot password?
                    </button>
                  ) : null}
                </div>
                {status.providers.length && mode !== "forgot" ? (
                  <div className="cloud-providers" aria-label="Other ways to sign in">
                    {status.providers.map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        className="btn btn-soft"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await client.cloudSignInWith(provider);
                            setMode("browser");
                          })
                        }
                      >
                        Continue with {PROVIDER_LABEL[provider]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </form>
            )}
          </div>
        ) : null}

        {user ? (
          <>
            <div className="setting-row">
              <div>
                <strong>Keep my library list in the cloud</strong>
                <span>
                  {status.sync.enabled
                    ? status.sync.error
                      ? status.sync.error
                      : `${ago(status.sync.lastSyncedAt)}${status.sync.pending ? ` · ${status.sync.pending} waiting` : ""}`
                    : "Copies the list of your files and folders, not the files themselves."}
                </span>
              </div>
              {status.sync.enabled ? (
                <button type="button" className="btn btn-quiet" disabled={busy || status.sync.running} onClick={() => void act(() => client.cloudSyncNow())}>
                  Sync now
                </button>
              ) : null}
              <Switch
                on={status.sync.enabled}
                label="Keep my library list in the cloud"
                disabled={busy}
                onChange={(on) => void act(() => client.cloudSetSync(on))}
              />
            </div>
            <div className="setting-row">
              <div>
                <strong>Cloud storage</strong>
                <span>
                  {status.storageDriveId
                    ? "It’s in your places. Copy files or back up to it like any drive."
                    : "Add it to your places to copy files and back up to the cloud."}
                </span>
              </div>
              {status.storageDriveId ? (
                <em className="chip ok">In your places</em>
              ) : (
                <button
                  type="button"
                  className="btn btn-soft"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await client.cloudAddStorage();
                      onPlacesChanged();
                    }, "Memories Cloud is now one of your places.")
                  }
                >
                  Add to places
                </button>
              )}
            </div>
          </>
        ) : null}

        {error ? (
          <p className="signin-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="cloud-notice" role="status">
            {notice}
          </p>
        ) : null}
      </section>

      {user?.role === "admin" ? <People client={client} meId={user.id} /> : null}
    </>
  );
}

/** Admins manage everyone who uses Memories Cloud. */
function People({ client, meId }: { client: MemoriesClient; meId: string }) {
  const [users, setUsers] = useState<CloudAdminUser[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const searchRef = useRef(search);
  searchRef.current = search;

  const load = useCallback(async () => {
    try {
      const result = await client.cloudUsers(searchRef.current.trim());
      setUsers(result.users);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [client]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  async function act(userId: string, work: () => Promise<unknown>) {
    setBusy(userId);
    setError(null);
    try {
      await work();
      setConfirming(null);
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="setting people">
      <h2>People</h2>
      <label className="field people-search">
        <span>Find someone</span>
        <input type="search" value={search} placeholder="Name or email" onChange={(event) => setSearch(event.target.value)} />
      </label>
      {error ? (
        <p className="signin-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="people-list" aria-label="People">
        {(users ?? []).map((person) => {
          const me = person.id === meId;
          return (
            <li key={person.id} className="setting-row">
              <div>
                <strong>
                  {person.name || person.email} {me ? <em className="chip off">You</em> : null}{" "}
                  {person.role === "admin" ? <em className="chip ok">Admin</em> : null}{" "}
                  {person.banned ? <em className="chip go">Blocked</em> : null}
                </strong>
                <span>
                  {person.email}
                  {person.banned && person.banReason ? ` · ${person.banReason}` : ""}
                </span>
              </div>
              {me ? null : confirming === person.id ? (
                <div className="cloud-actions">
                  <span>Remove {person.name || person.email} and everything they stored?</span>
                  <button type="button" className="btn btn-danger" disabled={busy === person.id} onClick={() => void act(person.id, () => client.cloudRemoveUser(person.id))}>
                    Remove
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </div>
              ) : (
                <div className="cloud-actions">
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={busy === person.id}
                    onClick={() => void act(person.id, () => client.cloudSetRole(person.id, person.role === "admin" ? "user" : "admin"))}
                  >
                    {person.role === "admin" ? "Make user" : "Make admin"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={busy === person.id}
                    onClick={() => void act(person.id, () => (person.banned ? client.cloudUnban(person.id) : client.cloudBan(person.id)))}
                  >
                    {person.banned ? "Unblock" : "Block"}
                  </button>
                  <button type="button" className="btn btn-quiet danger" onClick={() => setConfirming(person.id)}>
                    Remove
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {users && total > users.length ? <p className="cloud-notice">Showing {users.length} of {total}. Search to find someone else.</p> : null}
      {users && users.length === 0 ? <p className="cloud-notice">No one matches “{search}”.</p> : null}
    </section>
  );
}
