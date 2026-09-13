"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileClock,
  LoaderCircle,
  LogOut,
  Menu,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  X,
  Zap,
} from "lucide-react";
import type {
  ExecutionDetail,
  ExecutionSummary,
  Health,
  Job,
} from "@/lib/types";
import { AuthScreen, type User } from "./auth-screen";
import { ExecutionPanel } from "./execution-detail";
import { JobForm } from "./job-form";
import {
  api,
  ApiError,
  dateTime,
  Logo,
  Modal,
  StatusPill,
  timeAgo,
  TypeIcon,
  WorkspaceErrorContext,
} from "./ui";
type View = "overview" | "jobs" | "executions" | "workers";
const nav = [
  { view: "overview" as View, label: "Overview", icon: Activity },
  { view: "jobs" as View, label: "Jobs", icon: Zap },
  { view: "executions" as View, label: "Executions", icon: FileClock },
  { view: "workers" as View, label: "Workers", icon: ServerCog },
];
const isActive = (e: ExecutionSummary | null) =>
  e && ["queued", "running", "retry_wait"].includes(e.status);
export type WorkspaceSnapshot = {
  user: User;
  jobs: Job[];
  runs: ExecutionSummary[];
  health: Health;
};
export function Dashboard({
  initialData,
}: { initialData?: WorkspaceSnapshot } = {}) {
  const [user, setUser] = useState<User | null>(initialData?.user ?? null);
  const [booting, setBooting] = useState(!initialData);
  const [view, setView] = useState<View>("overview");
  const [jobs, setJobs] = useState<Job[]>(initialData?.jobs ?? []);
  const [runs, setRuns] = useState<ExecutionSummary[]>(initialData?.runs ?? []);
  const [health, setHealth] = useState<Health | null>(
    initialData?.health ?? null,
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<ExecutionDetail | null>(null);
  const [form, setForm] = useState<Job | "new" | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  const pendingKeys = useRef(new Map<string, string>());
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    api<{ user: User }>("/api/me")
      .then((r) => {
        if (alive) setUser(r.user);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setBooting(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const [j, e, h, d] = await Promise.all([
          api<{ jobs: Job[] }>("/api/jobs", { signal: controller.signal }),
          api<{ executions: ExecutionSummary[]; nextOffset: number | null }>(
            `/api/executions?status=${view === "executions" ? filter : "all"}&offset=${view === "executions" ? offset : 0}`,
            { signal: controller.signal },
          ),
          api<Health>("/api/system", { signal: controller.signal }),
          runId
            ? api<{ execution: ExecutionDetail }>(`/api/executions/${runId}`, {
                signal: controller.signal,
              })
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        setJobs(j.jobs);
        setRuns(e.executions);
        setHealth(h);
        setNextOffset(e.nextOffset);
        if (d) setRun(d.execution);
        setError("");
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) setUser(null);
        else setError((err as Error).message);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [user, view, filter, offset, runId, tick]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  async function mutate(work: () => Promise<unknown>, message: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setActionError("");
    try {
      await work();
      setToast(message);
      setError("");
      refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function enqueueRun(id: string, retry = false) {
    const op = `${retry ? "retry" : "run"}:${id}`;
    const key = pendingKeys.current.get(op) || crypto.randomUUID();
    pendingKeys.current.set(op, key);
    await mutate(async () => {
      const r = await api<{
        execution: ExecutionDetail;
        deduplicated: boolean;
      }>(retry ? `/api/executions/${id}/retry` : `/api/jobs/${id}/run`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: key }),
      });
      pendingKeys.current.delete(op);
      setJobId(null);
      setRun(r.execution);
      setRunId(r.execution.id);
    }, "Run saved. You can follow its progress here.");
  }
  function navigate(v: View) {
    setView(v);
    setNavOpen(false);
    setFilter("all");
    setOffset(0);
    setJobId(null);
    setRunId(null);
    setRun(null);
  }
  async function openRun(e: ExecutionSummary) {
    setRun(null);
    setRunId(e.id);
  }
  const selectedJob = jobs.find((j) => j.id === jobId);
  const online =
    health?.workers.filter((w) => w.status !== "offline").length ?? 0;
  const terminal = (health?.succeeded ?? 0) + (health?.failed ?? 0);
  const successRate = terminal
    ? Math.round((health!.succeeded / terminal) * 100)
    : null;
  const visibleJobs = jobs.filter(
    (j) =>
      `${j.name} ${j.description} ${j.endpoint}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (view !== "jobs" || filter === "all" || j.status === filter),
  );
  if (booting)
    return (
      <div className="boot-screen">
        <Logo />
        <LoaderCircle className="spin" size={22} />
        <span>Opening your workspace…</span>
      </div>
    );
  if (!user)
    return (
      <AuthScreen
        onAuthenticated={(u) => {
          setUser(u);
          setError("");
        }}
      />
    );
  return (
    <WorkspaceErrorContext.Provider value={actionError || error}>
      <div className="app-shell">
        <aside className={`sidebar ${navOpen ? "sidebar-open" : ""}`}>
          <div className="sidebar-top">
            <Logo />
            <button
              className="mobile-close"
              aria-label="Close navigation"
              onClick={() => setNavOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="workspace-switcher">
            <span className="workspace-avatar">{user.name[0]}</span>
            <span>
              <b>{user.name}'s workspace</b>
              <small>Personal account</small>
            </span>
          </div>
          <nav className="nav-block" aria-label="Main navigation">
            <p className="nav-label">Workspace</p>
            {nav.map((n) => (
              <button
                key={n.view}
                className={`nav-item ${view === n.view ? "active" : ""}`}
                aria-current={view === n.view ? "page" : undefined}
                onClick={() => navigate(n.view)}
              >
                <n.icon size={17} />
                <span>{n.label}</span>
                {n.view === "jobs" && (
                  <span className="nav-count">{health?.totalJobs ?? 0}</span>
                )}
              </button>
            ))}
            <p className="nav-label nav-label-spaced">Resources</p>
            <a
              className="nav-item"
              href="/api/docs"
              target="_blank"
              rel="noreferrer"
            >
              <BookOpen size={17} />
              <span>API documentation</span>
              <ArrowUpRight size={13} />
            </a>
          </nav>
          <div className="sidebar-bottom">
            <div className="worker-mini-card">
              <div className="worker-mini-head">
                <span className={online ? "live-dot" : "offline-dot"} />
                Worker pool<span>{online} online</span>
              </div>
              <small>
                {online
                  ? "Listening for queued work"
                  : "Waiting for a worker connection"}
              </small>
            </div>
            <div className="user-mini">
              <span className="user-avatar">{user.name[0]}</span>
              <span>
                <b>{user.name}</b>
                <small>{user.email}</small>
              </span>
              <button
                aria-label="Sign out"
                onClick={() =>
                  void mutate(async () => {
                    await api("/api/auth/logout", { method: "POST" });
                    setUser(null);
                    setJobs([]);
                    setRuns([]);
                    setHealth(null);
                    setRunId(null);
                    setRun(null);
                  }, "Signed out.")
                }
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </aside>
        <section className="workspace">
          <header className="topbar">
            <button
              className="mobile-menu"
              aria-label="Open navigation"
              onClick={() => setNavOpen(true)}
            >
              <Menu size={19} />
            </button>
            <div className="breadcrumbs">
              <span>Personal workspace</span>
              <ChevronRight size={13} />
              <b>{nav.find((n) => n.view === view)?.label}</b>
            </div>
            <div className="topbar-actions">
              {(view === "jobs" || view === "overview") && (
                <label className="top-search">
                  <Search size={16} />
                  <input
                    aria-label="Search jobs"
                    placeholder="Search jobs"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              )}
              <button
                className="icon-button"
                aria-label="Refresh workspace"
                onClick={refresh}
              >
                <RefreshCw size={17} />
              </button>
              <span className="top-avatar">{user.name[0]}</span>
            </div>
          </header>
          <main className="main-content">
            {(error || actionError) && (
              <div className="form-error workspace-error" role="alert">
                <AlertCircle size={17} />
                <span>{actionError || error}</span>
                <button
                  onClick={() => {
                    setActionError("");
                    refresh();
                  }}
                >
                  Try again
                </button>
              </div>
            )}
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  {view === "overview"
                    ? "WORKSPACE OVERVIEW"
                    : view === "jobs"
                      ? "JOB CATALOG"
                      : view === "executions"
                        ? "EXECUTION HISTORY"
                        : "RUNTIME STATUS"}
                </div>
                <h1>
                  {view === "overview"
                    ? `Welcome, ${user.name.split(" ")[0]}.`
                    : view === "jobs"
                      ? "Your jobs"
                      : view === "executions"
                        ? "Every run has a story."
                        : "Worker pool"}
                </h1>
                <p>
                  {view === "overview"
                    ? "Here is what has run and what needs your attention."
                    : view === "jobs"
                      ? "Set the target, choose a schedule, and decide how failures should be handled."
                      : view === "executions"
                        ? "Open a run to see the result, attempts, and event log."
                        : "Live heartbeats from the processes working through your queue."}
                </p>
              </div>
              {(view === "jobs" || view === "overview") && (
                <button
                  className="button button-primary"
                  onClick={() => setForm("new")}
                >
                  <Plus size={17} />
                  New job
                </button>
              )}
            </div>
            {view === "overview" && (
              <>
                <div className="insight-banner">
                  <div className="insight-icon">
                    {health?.attentionCount ? (
                      <AlertCircle size={19} />
                    ) : (
                      <CheckCircle2 size={19} />
                    )}
                  </div>
                  <div>
                    <strong>
                      {health?.attentionCount
                        ? `${health.attentionCount} ${health.attentionCount === 1 ? "job needs" : "jobs need"} attention.`
                        : jobs.length
                          ? "Your jobs are ready."
                          : "Start with a simple health check."}
                    </strong>
                    <p>
                      {health?.attentionCount
                        ? "Open the failed run to see what happened and decide whether to retry."
                        : "The example targets let you try a complete run without connecting another service."}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      health?.attentionCount
                        ? navigate("executions")
                        : setForm("new")
                    }
                  >
                    {health?.attentionCount ? "View history" : "Create a job"}
                    <ArrowUpRight size={15} />
                  </button>
                </div>
                <div className="stats-grid">
                  <Metric
                    icon={<Zap size={17} />}
                    label="Active jobs"
                    value={String(health?.activeJobs ?? 0)}
                    note={`${health?.totalJobs ?? 0} configured`}
                    tone="purple"
                  />
                  <Metric
                    icon={<CheckCircle2 size={17} />}
                    label="Success rate"
                    value={successRate === null ? "—" : `${successRate}%`}
                    note={`${terminal} finished runs`}
                    tone="teal"
                  />
                  <Metric
                    icon={<Clock3 size={17} />}
                    label="In the queue"
                    value={String(health?.queueDepth ?? 0)}
                    note="Queued or waiting for retry"
                    tone="amber"
                  />
                  <Metric
                    icon={<ServerCog size={17} />}
                    label="Workers online"
                    value={String(online)}
                    note="Heartbeat within 45 seconds"
                    tone="blue"
                  />
                </div>
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Recent executions</h2>
                      <p>Latest runs across your workspace</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("executions")}
                    >
                      View all
                      <ChevronRight size={15} />
                    </button>
                  </div>
                  <RunsTable runs={runs.slice(0, 6)} onSelect={openRun} />
                </section>
                <div className="section-gap" />
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Your jobs</h2>
                      <p>Open a job to run it or adjust its settings.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("jobs")}
                    >
                      Manage jobs
                      <ChevronRight size={15} />
                    </button>
                  </div>
                  <div className="job-cards">
                    {visibleJobs.slice(0, 3).map((j) => (
                      <JobCard
                        key={j.id}
                        job={j}
                        busy={busy}
                        onOpen={() => setJobId(j.id)}
                        onRun={() => void enqueueRun(j.id)}
                      />
                    ))}
                    {!visibleJobs.length && (
                      <Empty
                        title={query ? "No matching jobs" : "No jobs yet"}
                        text="Create your first job using one of the example targets."
                      />
                    )}
                  </div>
                </section>
              </>
            )}
            {view === "jobs" && (
              <>
                <div className="toolbar">
                  <div className="filter-tabs">
                    {["all", "active", "paused"].map((f) => (
                      <button
                        key={f}
                        className={filter === f ? "active" : ""}
                        onClick={() => setFilter(f)}
                      >
                        {f === "all"
                          ? "All jobs"
                          : f === "active"
                            ? "Active"
                            : "Paused"}
                      </button>
                    ))}
                  </div>
                  <span className="toolbar-note">
                    {visibleJobs.length} shown · schedules use UTC
                  </span>
                </div>
                <section className="panel">
                  <div className="job-list">
                    {visibleJobs.map((j) => (
                      <JobCard
                        key={j.id}
                        job={j}
                        busy={busy}
                        onOpen={() => setJobId(j.id)}
                        onRun={() => void enqueueRun(j.id)}
                      />
                    ))}
                    {!visibleJobs.length && (
                      <Empty
                        title="No jobs here yet"
                        text="Try another filter or create a new job."
                      />
                    )}
                  </div>
                </section>
              </>
            )}
            {view === "executions" && (
              <>
                <div className="toolbar">
                  <div className="filter-tabs execution-filters">
                    {[
                      "all",
                      "succeeded",
                      "failed",
                      "running",
                      "retry_wait",
                      "queued",
                      "cancelled",
                    ].map((s) => (
                      <button
                        key={s}
                        className={filter === s ? "active" : ""}
                        onClick={() => {
                          setFilter(s);
                          setOffset(0);
                        }}
                      >
                        {s === "retry_wait"
                          ? "Retry waiting"
                          : s.charAt(0).toUpperCase() + s.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <section className="panel">
                  <RunsTable runs={runs} onSelect={openRun} />
                </section>
                <div className="pagination">
                  <button
                    className="button button-secondary button-small"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 50))}
                  >
                    <ChevronLeft size={15} />
                    Previous
                  </button>
                  <span>
                    {runs.length
                      ? `${offset + 1}–${offset + runs.length}`
                      : "No runs"}{" "}
                    · newest first
                  </span>
                  <button
                    className="button button-secondary button-small"
                    disabled={nextOffset === null}
                    onClick={() => setOffset(nextOffset!)}
                  >
                    Next
                    <ChevronRight size={15} />
                  </button>
                </div>
              </>
            )}
            {view === "workers" && (
              <>
                <div className="insight-banner">
                  <div className="insight-icon">
                    <ServerCog size={19} />
                  </div>
                  <div>
                    <strong>
                      {online
                        ? `${online} ${online === 1 ? "worker is" : "workers are"} online.`
                        : "No worker is reporting yet."}
                    </strong>
                    <p>
                      {online
                        ? "Each worker claims one run at a time. Jobs remain in the queue until a worker is ready."
                        : "Your runs stay saved. They will start when a worker connects."}
                    </p>
                  </div>
                </div>
                <div className="worker-grid">
                  {health?.workers.map((w) => (
                    <div className="panel worker-card" key={w.id}>
                      <div className="worker-card-head">
                        <div className="worker-avatar">
                          <ServerCog size={18} />
                        </div>
                        <div>
                          <b>{w.id}</b>
                          <small>{w.completed} attempts completed</small>
                        </div>
                        <StatusPill status={w.status} />
                      </div>
                      <div className="worker-load">
                        <div>
                          <span>Current slot</span>
                          <b>
                            {w.status === "busy"
                              ? "Running a job"
                              : w.status === "offline"
                                ? "Offline"
                                : "Available"}
                          </b>
                        </div>
                        <div className="load-track">
                          <i style={{ width: `${w.load}%` }} />
                        </div>
                      </div>
                      <div className="worker-card-foot">
                        <span>
                          {w.status === "offline"
                            ? "No recent heartbeat"
                            : "Connected"}
                        </span>
                        <span>{timeAgo(w.lastHeartbeat)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>When a worker stops</h2>
                      <p>
                        Runs use a 45-second lease, renewed while an attempt is
                        active.
                      </p>
                    </div>
                  </div>
                  <p className="runtime-note">
                    If the lease expires, another worker records the
                    interruption and retries when the job's attempt budget
                    allows it. A timed-out request may still have reached the
                    target; check its result before manually retrying an
                    operation with side effects.
                  </p>
                </section>
              </>
            )}
          </main>
        </section>
        {form && (
          <JobForm
            job={form === "new" ? undefined : form}
            onClose={() => setForm(null)}
            onSaved={() => {
              setForm(null);
              setToast("Job saved.");
              refresh();
            }}
          />
        )}
        {selectedJob && (
          <Modal title={selectedJob.name} drawer onClose={() => setJobId(null)}>
            <div className="drawer-status-row">
              <StatusPill status={selectedJob.status} />
              <span>
                <Clock3 size={14} />
                {selectedJob.schedule}
              </span>
            </div>
            <p className="drawer-description">
              {selectedJob.description || "No description added."}
            </p>
            <div className="drawer-actions">
              <button
                className="button button-primary button-small"
                disabled={
                  busy ||
                  selectedJob.status === "paused" ||
                  !!isActive(selectedJob.latestExecution)
                }
                onClick={() => void enqueueRun(selectedJob.id)}
              >
                <Play size={14} />
                Run now
              </button>
              <button
                className="button button-secondary button-small"
                onClick={() => {
                  setForm(selectedJob);
                  setJobId(null);
                }}
              >
                <Pencil size={14} />
                Edit
              </button>
              <button
                className="button button-secondary button-small"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    () =>
                      api(`/api/jobs/${selectedJob.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({
                          status:
                            selectedJob.status === "active"
                              ? "paused"
                              : "active",
                          version: selectedJob.version,
                        }),
                      }),
                    "Job updated.",
                  )
                }
              >
                <Pause size={14} />
                {selectedJob.status === "active" ? "Pause" : "Activate"}
              </button>
            </div>
            <div className="drawer-section">
              <h3>Target</h3>
              <div className="target-box">
                <b className="target-method">{selectedJob.method}</b>
                <code title={selectedJob.endpoint}>{selectedJob.endpoint}</code>
              </div>
            </div>
            <div className="detail-metrics">
              <div>
                <small>Retries</small>
                <b>{selectedJob.retryLimit}</b>
              </div>
              <div>
                <small>Timeout</small>
                <b>{selectedJob.timeoutMs}ms</b>
              </div>
              <div>
                <small>Version</small>
                <b>{selectedJob.version}</b>
              </div>
            </div>
            <div className="drawer-section">
              <h3>Next scheduled run</h3>
              <p className="drawer-muted">{dateTime(selectedJob.nextRunAt)}</p>
              <h3>Latest execution</h3>
              {selectedJob.latestExecution ? (
                <button
                  className="execution-open"
                  onClick={() => {
                    void openRun(selectedJob.latestExecution!);
                    setJobId(null);
                  }}
                >
                  <StatusPill status={selectedJob.latestExecution.status} />
                  <span>{timeAgo(selectedJob.latestExecution.queuedAt)}</span>
                  <ChevronRight size={16} />
                </button>
              ) : (
                <p className="drawer-muted">This job has not run yet.</p>
              )}
            </div>
            <div className="drawer-footer">
              <span>Created {dateTime(selectedJob.createdAt)}</span>
            </div>
            <button
              className="button button-secondary archive-button"
              disabled={busy}
              onClick={() =>
                void mutate(async () => {
                  await api(`/api/jobs/${selectedJob.id}`, {
                    method: "DELETE",
                    body: JSON.stringify({ version: selectedJob.version }),
                  });
                  setJobId(null);
                }, "Job archived. Execution history is preserved.")
              }
            >
              <Archive size={15} />
              Archive job
            </button>
            <p className="field-help">
              Archiving stops future runs. Existing queued work and history are
              kept.
            </p>
          </Modal>
        )}
        {runId &&
          (run ? (
            <ExecutionPanel
              execution={run}
              busy={busy}
              onClose={() => {
                setRunId(null);
                setRun(null);
              }}
              onRetry={() => void enqueueRun(run.id, true)}
              onCancel={() =>
                void mutate(
                  () =>
                    api(`/api/executions/${run.id}/cancel`, {
                      method: "POST",
                      body: "{}",
                    }),
                  "Run cancelled.",
                )
              }
            />
          ) : (
            <Modal
              title="Execution details"
              drawer
              onClose={() => setRunId(null)}
            >
              <div className="table-empty">
                <LoaderCircle className="spin" size={20} />
                Loading run…
              </div>
            </Modal>
          ))}
        {toast && (
          <div className="toast" role="status">
            <CheckCircle2 size={17} />
            <span>{toast}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() => setToast("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
      </div>
    </WorkspaceErrorContext.Provider>
  );
}
function Metric({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note: string;
  tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`stat-icon stat-${tone}`}>{icon}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-meta">{note}</div>
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Zap size={20} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function JobCard({
  job: j,
  busy,
  onOpen,
  onRun,
}: {
  job: Job;
  busy: boolean;
  onOpen: () => void;
  onRun: () => void;
}) {
  return (
    <article className="job-card">
      <div className="job-card-top">
        <span className={`job-type-icon job-type-${j.type}`}>
          <TypeIcon type={j.type} />
        </span>
        <button className="job-card-name job-name-button" onClick={onOpen}>
          <b>{j.name}</b>
          <small>
            {j.method} · {j.endpoint}
          </small>
        </button>
        <button
          className="icon-button"
          aria-label={`Open ${j.name}`}
          onClick={onOpen}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="job-card-bottom">
        <StatusPill
          status={
            j.status === "paused"
              ? "paused"
              : j.latestExecution?.status || "active"
          }
        />
        <span className="schedule-label" title={j.schedule}>
          <Clock3 size={13} />
          {j.schedule}
        </span>
        <button
          className="run-button"
          disabled={
            busy || j.status === "paused" || !!isActive(j.latestExecution)
          }
          onClick={onRun}
        >
          <Play size={13} />
          {isActive(j.latestExecution) ? "In progress" : "Run now"}
        </button>
      </div>
    </article>
  );
}
function RunsTable({
  runs,
  onSelect,
}: {
  runs: ExecutionSummary[];
  onSelect: (e: ExecutionSummary) => void;
}) {
  if (!runs.length)
    return (
      <Empty
        title="No executions in this view"
        text="Run a job and its status, attempts, and result will appear here."
      />
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Status</th>
            <th>Trigger</th>
            <th>Duration</th>
            <th>When</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((e) => (
            <tr key={e.id}>
              <td>
                <div className="table-job">
                  <span className="table-job-icon">
                    <Zap size={14} />
                  </span>
                  <button
                    className="table-job-button"
                    onClick={() => onSelect(e)}
                  >
                    <b>{e.jobName}</b>
                    <small>
                      {e.attempt
                        ? `Attempt ${e.attempt}/${e.maxAttempts}`
                        : "Waiting for a worker"}
                    </small>
                  </button>
                </div>
              </td>
              <td>
                <StatusPill status={e.status} />
              </td>
              <td>
                <span className="trigger-label">
                  <span className={`trigger-dot trigger-${e.trigger}`} />
                  {e.trigger}
                </span>
              </td>
              <td>
                <span className="muted-value">
                  {e.durationMs === null ? "—" : `${e.durationMs}ms`}
                </span>
              </td>
              <td>
                <span className="muted-value" title={dateTime(e.queuedAt)}>
                  {timeAgo(e.queuedAt)}
                </span>
              </td>
              <td>
                <button
                  className="row-chevron"
                  aria-label={`Open run for ${e.jobName}`}
                  onClick={() => onSelect(e)}
                >
                  <ChevronRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
