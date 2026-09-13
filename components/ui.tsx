"use client";
import { createContext, useContext, useEffect, useRef } from "react";
import { Globe2, Webhook, X } from "lucide-react";
export const WorkspaceErrorContext = createContext("");
export function Logo() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <span />
        <span />
        <span />
      </span>
      <span className="brand-word">
        relay<span>.</span>
      </span>
    </div>
  );
}
export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="status-dot" />
      {status === "retry_wait"
        ? "Retry waiting"
        : status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
export function TypeIcon({ type }: { type: string }) {
  return type === "webhook" ? <Webhook size={17} /> : <Globe2 size={17} />;
}
export function timeAgo(value: string | null) {
  if (!value) return "Not run yet";
  const s = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  return s < 60
    ? "Just now"
    : s < 3600
      ? `${Math.floor(s / 60)}m ago`
      : s < 86400
        ? `${Math.floor(s / 3600)}h ago`
        : `${Math.floor(s / 86400)}d ago`;
}
export function dateTime(value: string | null) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      })
    : "—";
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    cache: "no-store",
  });
  const payload = await response
    .json()
    .catch(() => ({ error: "The server returned an unreadable response." }));
  if (!response.ok)
    throw new ApiError(payload.error || "Request failed.", response.status);
  return payload as T;
}
export function Modal({
  title,
  onClose,
  children,
  drawer = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const error = useContext(WorkspaceErrorContext);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={drawer ? "native-dialog drawer-dialog" : "native-dialog"}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <section className={drawer ? "drawer" : "modal"}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">RELAY WORKSPACE</div>
            <h2>{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {children}
      </section>
    </dialog>
  );
}
