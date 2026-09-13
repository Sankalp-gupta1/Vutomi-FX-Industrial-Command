# Verification record

Checked on September 13, 2026. This records observed results, not intended behavior.

| Check                                                       | Result                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Production build with Next.js 15.5.24                       | Passed                                                                       |
| TypeScript strict checking                                  | Passed                                                                       |
| Unit and database suite                                     | 34 passed; 5 native PostgreSQL concurrency tests skipped locally             |
| Migration application and repeat application                | Passed against isolated PGlite database                                      |
| Actual HTTP API with two separate worker processes          | Passed against isolated PGlite database                                      |
| Native PostgreSQL multi-session locking                     | CI configured; not run in this environment                                   |
| Docker build and Compose startup                            | Configuration provided; Docker unavailable locally                           |
| Interactive browser verification and responsive screenshots | Pending; the browser could not access the local preview under its URL policy |
| Public production deployment                                | Not completed                                                                |
| New GitHub repository                                       | Not created                                                                  |

The HTTP smoke test checked signup, login, logout, cookie attributes, validation, cross-site rejection, tenant isolation, 202 queue acceptance, idempotent submission, successful dispatch, three-attempt automatic recovery, a real timeout, optimistic edits, manual retry and persisted execution history. Two worker processes reported real heartbeats. PGlite multiplexes one backend, so this does not replace native PostgreSQL concurrency tests.

The first smoke attempt detected an empty generated Next.js routes manifest; a fresh build followed immediately by the smoke test passed. No generated build output is included in source control. A clean checkout rebuilds it.

The GitHub connection identifies `Sankalp-gupta1`, but exposes no new-repository creation action. No existing repository was repurposed. The Vercel connection returned no accessible teams, and could not list the requested team's projects. An incomplete production deployment request was rejected by automatic approval review before it could run; a verified team and complete deployment payload are required. No production database or hosted worker has been provisioned.

The remaining release gate is to grant access to the intended repository and Vercel team, configure a reachable PostgreSQL database and an always-running worker, run CI on native PostgreSQL, and verify the public application in a browser. README contains the complete local and deployment commands. A Vercel frontend alone is not a functioning job execution deployment.

`scripts/render-preview.tsx` can generate static visual fixtures under ignored `artifacts/` using the actual React components. These fixtures contain clearly synthetic data, do not create accounts or sessions, and are not live application pages. They are kept separate from production runtime behavior.
