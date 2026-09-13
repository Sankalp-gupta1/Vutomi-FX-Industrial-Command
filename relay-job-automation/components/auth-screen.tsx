"use client";
import { useState } from "react";
import {
  Activity,
  ArrowUpRight,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { api, Logo } from "./ui";
export type User = { id: string; name: string; email: string };
export function AuthScreen({
  onAuthenticated,
}: {
  onAuthenticated: (u: User) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ user: User }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(
          mode === "register" ? { name, email, password } : { email, password },
        ),
      });
      onAuthenticated(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <Logo />
        <div className="story-copy">
          <div className="eyebrow">
            <span className="eyebrow-pulse" />
            JOB AUTOMATION
          </div>
          <h1>
            Keep the work moving.
            <br />
            <em>Know what happened.</em>
          </h1>
          <p>
            Create a job, follow each attempt, and get a clear answer when
            something fails.
          </p>
        </div>
        <div className="story-points">
          <div>
            <span className="point-icon point-teal">
              <ShieldCheck size={17} />
            </span>
            <div>
              <strong>One run. A clear history.</strong>
              <small>
                Every attempt has a worker, a result, and a timestamp.
              </small>
            </div>
          </div>
          <div>
            <span className="point-icon point-purple">
              <Zap size={17} />
            </span>
            <div>
              <strong>Failures have a next step</strong>
              <small>
                Retry temporary errors and inspect the ones that need attention.
              </small>
            </div>
          </div>
          <div>
            <span className="point-icon point-amber">
              <Activity size={17} />
            </span>
            <div>
              <strong>Start with an example</strong>
              <small>
                Try success, failure, timeout, or recovery in your own
                workspace.
              </small>
            </div>
          </div>
        </div>
        <div className="auth-quote">
          <p>Small automations still deserve a dependable place to run.</p>
          <small>Built by Sankalp Gupta</small>
        </div>
      </section>
      <section className="auth-panel-wrap">
        <div className="auth-panel">
          <div className="auth-mobile-brand">
            <Logo />
          </div>
          <div className="auth-heading">
            <div>
              <h2>
                {mode === "register" ? "Your first workspace" : "Welcome back"}
              </h2>
              <p>
                {mode === "register"
                  ? "Create an account to try Relay."
                  : "Sign in to see your jobs."}
              </p>
            </div>
          </div>
          <div className="auth-tabs">
            <button
              onClick={() => {
                setMode("register");
                setError("");
              }}
              className={mode === "register" ? "active" : ""}
            >
              Create account
            </button>
            <button
              onClick={() => {
                setMode("login");
                setError("");
              }}
              className={mode === "login" ? "active" : ""}
            >
              Sign in
            </button>
          </div>
          <form className="auth-form" onSubmit={submit}>
            {mode === "register" && (
              <label>
                Full name
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={2}
                  maxLength={60}
                />
              </label>
            )}
            <label>
              Email address
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={120}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={10}
                maxLength={128}
              />
            </label>
            {mode === "register" && (
              <small className="field-help">
                At least 10 characters. Use a password just for this demo.
              </small>
            )}
            {error && (
              <div className="form-error" role="alert">
                <TriangleAlert size={16} />
                {error}
              </div>
            )}
            <button
              className="button button-primary auth-submit"
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ArrowUpRight size={17} />
              )}{" "}
              {busy
                ? "Please wait…"
                : mode === "register"
                  ? "Create workspace"
                  : "Open workspace"}
            </button>
          </form>
          <p className="auth-legal">
            Your workspace is separate from other users. Email verification and
            password reset are not included in this demo.
          </p>
        </div>
        <div className="auth-footer">
          <span>relay. / v1.0</span>
          <a href="/api/docs">API documentation ↗</a>
        </div>
      </section>
    </main>
  );
}
