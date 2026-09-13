"use client";
import { useState } from "react";
import { LoaderCircle, Plus, Save, TriangleAlert } from "lucide-react";
import type { Job } from "@/lib/types";
import { api, Modal } from "./ui";
const templates = [
  ["demo://success", "Simple health check"],
  ["demo://failure", "Failure investigation"],
  ["demo://flaky", "Recover after two failures"],
  ["demo://timeout", "Timeout test"],
  ["demo://slow", "Slower background task"],
];
export function JobForm({
  job,
  onClose,
  onSaved,
}: {
  job?: Job;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(job?.name || "Simple health check");
  const [description, setDescription] = useState(job?.description || "");
  const [endpoint, setEndpoint] = useState(job?.endpoint || "demo://success");
  const [type, setType] = useState(job?.type || "http");
  const [method, setMethod] = useState(job?.method || "GET");
  const [schedule, setSchedule] = useState(job?.schedule || "Manual only");
  const [retryLimit, setRetryLimit] = useState(job?.retryLimit ?? 2);
  const [timeoutMs, setTimeoutMs] = useState(job?.timeoutMs ?? 5000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(job ? `/api/jobs/${job.id}` : "/api/jobs", {
        method: job ? "PATCH" : "POST",
        body: JSON.stringify({
          name,
          description,
          endpoint,
          type,
          method,
          schedule,
          retryLimit,
          timeoutMs,
          ...(job ? { version: job.version } : { status: "active" }),
        }),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={job ? "Edit job" : "Create a job"} onClose={onClose}>
      <form className="job-form" onSubmit={submit}>
        <div className="form-grid">
          <label className="span-two">
            Job name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={80}
            />
          </label>
          <label>
            Job type
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                if (e.target.value === "webhook") setMethod("POST");
              }}
            >
              <option value="http">HTTP request</option>
              <option value="webhook">Webhook</option>
            </select>
          </label>
          <label className="span-two">
            Example target
            <select
              value={endpoint.startsWith("demo://") ? endpoint : "custom"}
              onChange={(e) => {
                const t = templates.find((t) => t[0] === e.target.value);
                setEndpoint(t?.[0] || "");
                if (t && !job) setName(t[1]);
              }}
            >
              {templates.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              <option value="custom">Custom HTTPS URL</option>
            </select>
          </label>
          <label>
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option>GET</option>
              <option>POST</option>
            </select>
          </label>
          <label className="span-two">
            Target endpoint
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              required
              placeholder="https://example.com/health"
              maxLength={500}
            />
            <small className="field-help">
              External hosts need the server owner's allowlist. Examples work
              without setup. POST sends the execution ID as JSON.
            </small>
          </label>
          <label>
            Timeout
            <select
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
            >
              <option value={1000}>1 second</option>
              <option value={5000}>5 seconds</option>
              <option value={10000}>10 seconds</option>
              <option value={15000}>15 seconds</option>
            </select>
          </label>
          <label className="span-two">
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should this job do?"
              maxLength={240}
              rows={2}
            />
          </label>
          <label>
            Retries
            <select
              value={retryLimit}
              onChange={(e) => setRetryLimit(Number(e.target.value))}
            >
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n === 0
                    ? "No retries"
                    : `${n} ${n === 1 ? "retry" : "retries"}`}
                </option>
              ))}
            </select>
          </label>
          <label className="span-two">
            Schedule (UTC)
            <select
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            >
              <option>Manual only</option>
              <option>Every 15 minutes</option>
              <option>Every hour</option>
              <option>Daily at 02:00</option>
            </select>
          </label>
        </div>
        {job && (
          <p className="field-help">
            An existing run keeps the settings it started with. Changes apply to
            future runs.
          </p>
        )}
        {error && (
          <div className="form-error" role="alert">
            <TriangleAlert size={16} />
            {error}
          </div>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button button-primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : job ? (
              <Save size={16} />
            ) : (
              <Plus size={16} />
            )}{" "}
            {busy ? "Saving…" : job ? "Save changes" : "Create job"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
