import Link from "next/link";
import { openapi } from "@/lib/openapi";
export default function ApiDocs() {
  const endpoints = Object.entries(openapi.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([m]) => ["get", "post", "patch", "delete"].includes(m))
      .map(([method, detail]) => ({
        path,
        method,
        summary: (detail as { summary: string }).summary,
      })),
  );
  return (
    <main className="docs-page">
      <article className="docs-card">
        <div className="eyebrow">RELAY API · V1</div>
        <h1>Jobs, runs, and the details between.</h1>
        <p>
          Sign in to create jobs. API requests use the same session cookie as
          the workspace.
        </p>
        <div className="endpoint-list">
          {endpoints.map((e) => (
            <div className="endpoint-row" key={e.method + e.path}>
              <span className={`method method-${e.method}`}>
                {e.method.toUpperCase()}
              </span>
              <code>/api{e.path}</code>
              <span>{e.summary}</span>
            </div>
          ))}
        </div>
        <p className="docs-explanation">
          A run request returns 202 when the queue accepts it. Poll the
          execution endpoint to follow progress. Send an{" "}
          <code>idempotencyKey</code> with run and retry requests; reuse it
          after a network error. Job edits and archive requests require the
          current <code>version</code>, and return 409 if another edit won
          first.
        </p>
        <div className="docs-links">
          <Link href="/api/openapi">Download OpenAPI JSON ↗</Link>
          <Link href="/">← Back to workspace</Link>
        </div>
      </article>
    </main>
  );
}
