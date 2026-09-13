"use client";
import { AlertCircle, RotateCcw, X } from "lucide-react";
import type { ExecutionDetail } from "@/lib/types";
import { dateTime, Modal, StatusPill } from "./ui";
export function ExecutionPanel({
  execution,
  onClose,
  onRetry,
  onCancel,
  busy,
}: {
  execution: ExecutionDetail;
  onClose: () => void;
  onRetry: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const e = execution;
  return (
    <Modal title={e.jobName} onClose={onClose} drawer>
      <div className="execution-drawer-status">
        <StatusPill status={e.status} />
        <span>
          {e.attempt
            ? `Attempt ${e.attempt} of ${e.maxAttempts}`
            : "Waiting for a worker"}
        </span>
        <span>{e.trigger} run</span>
      </div>
      {e.errorMessage && (
        <div className="failure-callout">
          <div>
            <AlertCircle size={18} />
            <strong>{e.errorCode}</strong>
          </div>
          <p>{e.errorMessage}</p>
          {e.status === "retry_wait" && (
            <p>Next attempt: {dateTime(e.availableAt)}</p>
          )}
          {e.status === "failed" && (
            <button
              className="button button-secondary button-small"
              disabled={busy}
              onClick={onRetry}
            >
              <RotateCcw size={14} /> Retry with current settings
            </button>
          )}
        </div>
      )}
      {["queued", "retry_wait"].includes(e.status) && (
        <button
          className="button button-secondary button-small cancel-action"
          disabled={busy}
          onClick={onCancel}
        >
          <X size={14} /> Cancel queued run
        </button>
      )}
      <div className="detail-metrics">
        <div>
          <small>Last attempt</small>
          <b>{e.durationMs === null ? "—" : `${e.durationMs}ms`}</b>
        </div>
        <div>
          <small>Response</small>
          <b>{e.responseCode ?? "—"}</b>
        </div>
        <div>
          <small>Worker</small>
          <b title={e.workerId || ""}>{e.workerId || "Unclaimed"}</b>
        </div>
      </div>
      <div className="drawer-section">
        <h3>Attempts</h3>
        {e.attempts.length ? (
          e.attempts.map((a) => (
            <div className="attempt-detail" key={a.number}>
              <b>
                #{a.number} · {a.outcome || "Running"}
              </b>
              <span>{a.workerId}</span>
              <small>
                {dateTime(a.startedAt)}
                {a.durationMs !== null ? ` · ${a.durationMs}ms` : ""}
              </small>
            </div>
          ))
        ) : (
          <p className="drawer-muted">
            The run is saved. A worker will claim it next.
          </p>
        )}
      </div>
      <div className="drawer-section">
        <h3>Event log</h3>
        <div className="event-log">
          {e.logs.map((l) => (
            <div className={`event-row event-${l.level}`} key={l.id}>
              <span className="event-line" />
              <div>
                <b>{l.message}</b>
                <small>{dateTime(l.createdAt)}</small>
              </div>
            </div>
          ))}
        </div>
      </div>
      {e.output && (
        <div className="drawer-section">
          <h3>Output</h3>
          <pre className="output-block">{e.output}</pre>
        </div>
      )}
      <div className="drawer-footer">
        <span>Queued {dateTime(e.queuedAt)}</span>
        <span>
          {e.finishedAt
            ? `Finished ${dateTime(e.finishedAt)}`
            : "Live updates every 2 seconds"}
        </span>
      </div>
      <p className="execution-id">Run ID: {e.id}</p>
    </Modal>
  );
}
