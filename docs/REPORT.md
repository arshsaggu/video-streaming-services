# Technical Report: Video Streaming System

CIT3495 Project 1, option 2. This report contains the engineering evidence required by the brief: security, reliability, optimisation, performance, persistence and CI/CD.

> **How to read the numbers.** Results marked **[measured]** were produced while building this project. The services ran as native processes (Python and Node.js) on a 2-vCPU / 8 GB Linux VM, driven by the same k6 script used in the Docker setup. MySQL was replaced by an in-memory store because no MySQL server was available in that build environment. Results marked **[run in Docker]** can only be produced with Docker and the base images, so they are filled in by running the listed script. Each script writes its table into `results/`; the Docker optimisation and vulnerability scan results below were produced this way.

---

## 1. Architecture

![Architecture](architecture.png)

| Component | Tech | Responsibility | Network(s) | Host port |
|---|---|---|---|---|
| upload-web | Node.js 22 (standard library + `mysql2`) | Login UI, upload form, admin account creation; streams uploads to the file service; writes metadata to MySQL | frontend, backend | 8081 |
| streaming-web | Node.js 22 (standard library + `mysql2`) | Login UI, catalogue (MySQL), video playback through an HTTP Range proxy | frontend, backend | 8082 |
| auth-service | Python 3.12, Flask, gunicorn, PyJWT, PyMySQL | Users, roles, scrypt password hashes, JWT issue and verify, login lockout | backend | none |
| file-service | Node.js 22, standard library only (no npm dependencies) | Atomic writes and Range reads of video files on a volume | backend | none |
| mysql | MySQL 8.4 | `auth.users`, `media.videos` | backend | none |

### Data flow

**Upload:**
1. The browser POSTs the raw file with its title and description in headers.
2. upload-web verifies the session cookie with auth-service (`/verify`) and checks the role is uploader or admin.
3. It validates the metadata, then streams the body through a magic-byte check to `file-service PUT /files/{uuid}`. The file service writes to a temp file, fsyncs, and renames atomically.
4. upload-web INSERTs the metadata (including the sha256 returned by the file service).
5. If the INSERT fails, the stored file is deleted (a compensating action), so storage and metadata never disagree.

**Watch:**
1. streaming-web lists videos from MySQL.
2. The `<video>` element requests `/api/videos/{id}/stream` with a `Range` header.
3. streaming-web verifies the session, looks up the content type, and forwards `Range`/`If-Range` to the file service.
4. The 206 response is piped back with backpressure. If the viewer seeks or closes the tab, the upstream request is torn down.

The uploaded video never passes through memory as a whole: it is streamed end to end.

### Why these choices

- **Two languages.** Node.js runs the three I/O-bound services (both web apps and the file service): its streams give backpressure for uploads and Range downloads, and the file service needs no npm packages at all, so its image has no third-party code. Python runs the auth service because of its mature JWT and password-hashing libraries.
- **Tokens are verified by calling the auth service** instead of sharing the JWT signing key with every web app. Only auth-service holds `jwt_secret`, and disabling an account takes effect immediately (bounded by the 30 s verify cache, §6).
- **Shared code** for the two web apps lives in `services/web-common`. Both are built with `./services` as their Docker context.

---

## 2. Docker and images

| Practice | Where |
|---|---|
| One Dockerfile per service, one `docker-compose.yml` | `services/*/Dockerfile`, `docker-compose.yml` |
| Appropriate bases | `python:3.12-slim`, `node:22-alpine` for the web apps, and `gcr.io/distroless/nodejs22-debian12:nonroot` for the file service (no shell, no package manager, no npm) |
| Multi-stage builds (all four images we build; MySQL uses the official image) | build/deps stage → `test` stage → minimal `runtime` stage |
| Layer order for caching | dependency manifests (`requirements.txt`, `package*.json`) are copied and installed before the source, so a code edit does not reinstall dependencies; BuildKit cache mounts for pip and npm |
| `.dockerignore` | per service; the Node apps use per-Dockerfile allow-lists (`Dockerfile.dockerignore`) |
| Multi-architecture | CI builds `linux/amd64,linux/arm64` with buildx (QEMU for the arm64 build steps). Every base image is published for both architectures, and all dependencies are pure Python or pure JavaScript, so nothing needs compiling per architecture. |
| Smaller runtime | Node images delete npm/yarn (not needed at runtime); Python uses `--no-compile` and no pip cache; the file service has zero npm dependencies |
| Health checks in the image | Node: `node healthcheck.js` (distroless has no shell or curl, so the file service runs `/nodejs/bin/node /app/src/healthcheck.js`). Python: `urllib`. |

### Optimisation evidence: before vs after **[measured in Docker]**

The baselines `services/file-service/Dockerfile.naive` and `services/upload-web/Dockerfile.naive` are deliberately naive: single stage, the full Debian-based `node:22` image, `COPY . .` before installing dependencies, running as root. `./scripts/measure-images.sh` builds each pair with `--no-cache` (cold), edits one source line, rebuilds (warm), and records the image size.

Measured on 2026-10-22 with `./scripts/measure-images.sh` (Windows, Docker Desktop, x86_64). Sizes are compressed image size; `docker image ls` shows the unpacked on-disk size (204–246 MB for the optimised images).

| Service | Image | Size (MB) | Cold build (s) | Rebuild after code edit (s) | Runs as |
|---|---|---:|---:|---:|---|
| file-service | naive | 408.9 | 4.0 | 4.3 | root |
| file-service | optimised | **52.6** | 4.2 | **3.2** | 65532 |
| upload-web | naive | 412.6 | 4.4 | 4.4 | root |
| upload-web | optimised | **62.4** | 6.3 | **2.5** | node |

**Result:** images are **85–87% smaller** and run as non-root. Rebuilding after a code edit is **26% faster** (file-service) and **43% faster** (upload-web), because the optimised Dockerfiles install dependencies before copying source. Cold build times are within noise (4–6 s) because the services have very few dependencies; the optimised upload-web cold build is slightly slower because the multi-stage build has more steps.

Why:
- **file-service:** the naive image is the full Debian `node:22` image (compilers, npm, a shell: ~409 MB compressed, about 1 GB unpacked); the optimised one is distroless Node with only the runtime and our source.
- **upload-web:** `node:22` (Debian, ~1 GB) vs `node:22-alpine` minus npm.
- **Warm rebuild:** the naive file re-runs `npm install` after any code edit because the source is copied first. The optimised file reuses the dependency layer.

---

## 3. Networking

- Two networks. `frontend` (bridge) holds the two web apps and is the only network with published ports. `backend` is declared `internal: true`: Docker gives it no gateway, so services on it **cannot be reached from the host and cannot reach the internet**.
- MySQL, auth-service and file-service are attached **only** to `backend` and publish no ports. The two web apps join both networks because they are the bridge.
- Containers talk to each other by service-name DNS (`http://auth-service:8000`, `mysql:3306`).

Verified by `scripts/e2e.sh`:
- From the host, ports 3306, 8000 and 8080 refuse connections, while 8081 and 8082 answer.
- From a container on `frontend`, the names `file-service`, `auth-service` and `mysql` do not resolve (`CHECK_ISOLATION=1` checks in `tests/e2e/smoke.mjs`).

---

## 4. Persistence

| Data | Stored in | Volume |
|---|---|---|
| Users, password hashes, roles | MySQL `auth.users` | `vss_mysql-data` → `/var/lib/mysql` |
| Video metadata | MySQL `media.videos` | `vss_mysql-data` |
| Video files | file-service `/data/videos/<uuid>` | `vss_video-data` → `/data` |

The file-service image pre-creates `/data/videos` owned by the distroless nonroot user (uid 65532). A new named volume inherits that ownership, so no root step is needed. Every other container root filesystem is read-only, with `tmpfs` where scratch space is needed.

**Persistence test** (`./scripts/persistence-test.sh`): creates a user, uploads a 1 MB file and records its sha256, then runs `docker compose rm --stop --force mysql file-service` followed by `docker compose up -d`. It then checks that:
1. the user can still log in;
2. the metadata is still listed;
3. the streamed bytes have the **same sha256**.

**Demonstrated in Docker (2026-10-22, Windows / Docker Desktop):** uploaded a video as admin and registered `viewer1`, then ran `docker compose down` (all containers removed; `docker compose ps` empty) and `docker compose up -d --wait`. After recreation, `viewer1` could still log in and the video was still listed and played, so users, metadata and video bytes all survived via the `mysql-data` and `video-data` volumes. `./scripts/persistence-test.sh` automates the same check (with a sha256 comparison) and runs in the CI e2e job.

---

## 5. Health checks and recovery

| Service | Health check | What "healthy" means |
|---|---|---|
| mysql | `mysql -e 'SELECT 1 FROM media.videos'` | Server up **and** init scripts finished (schema exists), not just "process alive" |
| auth-service | `GET /healthz` | Process serving (liveness) |
| file-service | `/file-service -healthcheck` → `GET /healthz` | Process serving |
| upload-web, streaming-web | `node healthcheck.js` → `GET /healthz` | Process serving |

Each service also exposes `/readyz`, which checks its dependencies (MySQL, auth and file-service for the web apps; MySQL for auth; disk writability for the file service). **Docker health uses liveness, not readiness, on purpose.** If the web apps' health checks included MySQL, a database outage would turn every container unhealthy and cascade restarts across services that are actually fine. `/readyz` is what an operator or load balancer reads to see *why* something is degraded.

Start-up order uses `depends_on: condition: service_healthy`. All services use `restart: unless-stopped`. The apps never crash on a dependency error: they return 503 with a clear message, and their connection pools (`pool_pre_ping`-style `ping(reconnect=True)` in Python, mysql2's pool in Node) reconnect on their own.

### Failure tests

`./scripts/failure-test.sh` **[run in Docker]** runs these three scenarios and times recovery. The same behaviour was **[measured]** on the native processes:

| Situation | Catalogue | Stream | Login | `/readyz` | Recovery |
|---|---|---|---|---|---|
| All up | 200 | 206 | 401 (wrong pw) | ok | n/a |
| **Auth service down** | 200 | 206 | **503** | degraded, auth down | Signed-in users keep working (verify cache, ≤ 30 s); new logins get a clear 503 |
| **Auth + file service down** | 200 | **503** | 503 | degraded, auth + file down | Catalogue still works (graceful degradation) |
| File service restarted | 200 | 206 | 503 | degraded, auth down | Streaming back within 1 s, **no web-app restart needed** |

Docker scenarios in the script:
1. **MySQL stopped:** catalogue and login return 503 with "video database unavailable"; liveness stays green; after `docker compose start mysql` the catalogue recovers with no app restart. The script prints the recovery time.
2. **File service stopped:** streaming and upload return 503 while the catalogue works. Restarting it restores streaming, and the bytes are intact.
3. **Auth process crash** (PID 1 terminated): Docker's restart policy restarts it, and the `RestartCount` increments. Logins return 503 for the few seconds it takes; signed-in sessions are unaffected.

Example log lines produced during the native auth outage (secrets never appear):

```json
{"level":"error","service":"streaming-web","msg":"auth service unreachable","rid":"8b522af1-699e-4a","err":"ECONNREFUSED"}
{"level":"error","service":"streaming-web","msg":"request failed","rid":"b060d0f0-59e5-47","path":"/api/login","status":503,"err":"authentication service unavailable"}
```

**Demonstrated in Docker (2026-10-22):** with the stack running, `docker compose stop file-service` left the catalogue on `:8082` working while playback returned **503** (seen in the browser's Network tab; tested in an incognito window to avoid the browser cache). After `docker compose start file-service` the service returned to `(healthy)` within about 10 s and playback resumed **without restarting either web app**.

**Known limitation:** plain Docker (not Swarm or Kubernetes) does not restart a container just because it is *unhealthy*, only when it exits. That is why the apps are written to recover in-process rather than relying on restarts.

---

## 6. Security

| Requirement | Implementation |
|---|---|
| **No hard-coded secrets** | Seven random secrets are generated by `scripts/init-secrets.sh` into `./secrets/` (git-ignored, dir mode 700). They are passed as Compose **secrets** (files at `/run/secrets/*`) and read by the apps through `*_FILE` variables. They are not in env vars (which would show in `docker inspect`), images or Git. CI generates throwaway secrets per run and pushes with the per-run `GITHUB_TOKEN`. |
| **Least privilege: DB** | One MySQL account per service (`db/init/01-users.sh`): `auth_svc` SELECT/INSERT/UPDATE on `auth.users`; `upload_svc` SELECT/INSERT/DELETE on `media.videos`; `stream_svc` **SELECT only**. No service has DDL or access to the other database. |
| **Least privilege: containers** | All app containers run as non-root (uid 10001, `node`, 65532), `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, with a `pids` limit. App code is owned by root, so the process cannot modify it. |
| **Private internal services** | §3: `internal: true` network with no published ports. The file service additionally requires a shared `X-Internal-Token` (constant-time compare), so another compromised container on the network still cannot read or write files. |
| **Access control** | Roles: viewer (stream), uploader (+upload), admin (+create accounts). Self-registration can only create viewers; the role field is ignored (unit-tested). Every API call is checked server-side; verified returns 401 (no or invalid session) and 403 (wrong role). |
| **Authentication** | scrypt password hashes (memory-hard). JWT HS256 with `iss`, `exp`, `jti`; the algorithm is pinned, so `alg:none` and forged tokens are rejected (unit-tested). Tokens live only in an **HttpOnly, SameSite=Strict** cookie that page JavaScript never sees. |
| **Brute force** | 5 failed logins per IP+username in 5 minutes → 429. Unknown users are checked against a dummy hash, so response time does not reveal which usernames exist. |
| **CSRF** | SameSite=Strict, plus state-changing requests require `X-Requested-With: fetch`. A cross-site form cannot set that header without a CORS preflight, which is never granted. |
| **Input validation** | Usernames `^[A-Za-z0-9_.-]{3,32}$`, passwords 8–128 characters, JSON bodies capped at 4 KB. Video: MIME allow-list (mp4/webm/ogg/quicktime), **magic-byte check of the actual content** (an `.exe` renamed to `.mp4` is rejected with 415), size limit enforced twice (upload-web via Content-Length, file-service by counting bytes). Title 1–120 characters with no control characters; description ≤ 1000. IDs must be UUIDs, which also blocks path traversal. Range header syntax is validated. All SQL is parameterised. |
| **Output safety** | The UI renders user data with `textContent` only. Strict CSP (`default-src 'self'`, no inline script), plus `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy`. |
| **Error hygiene** | Validation errors return field *names* only. FastAPI-style echoing of submitted values (passwords) was deliberately avoided and is unit-tested. 500s return "internal error" with details only in logs. |

### Vulnerability scan **[measured in Docker]**

CI runs Trivy on every image on every push. The SARIF report goes to the GitHub Security tab, and **any fixable CRITICAL finding fails the build**. Locally, `./scripts/scan.sh --with-naive` writes `results/scan-summary.md`:

Scanned on 2026-10-22 with `./scripts/scan.sh --with-naive` (Trivy 0.56.2):

| Image | Critical | High | Medium | Low |
|---|---:|---:|---:|---:|
| `vss-upload-web` (optimised) | **0** | **0** | **0** | **0** |
| `vss-streaming-web` (optimised) | **0** | **0** | **0** | **0** |
| `vss-auth-service` (optimised) | 0 | 44 | 68 | 63 |
| `vss-file-service` (optimised) | 1 | 6 | 35 | 27 |
| `vss-upload-web:naive` | 31 | 627 | 2034 | 1795 |
| `vss-file-service:naive` | 31 | 627 | 2034 | 1795 |

**Review of the findings:**
- **Naive vs optimised:** the naive images (full Debian `node:22`) carry ~4,500 findings including 31 Critical. Switching to Alpine and removing npm takes both web apps to **zero**.
- **file-service, 1 Critical:** `libssl3` (OpenSSL), CVE-2026-31789, from the distroless Debian 12 base layer. Installed 3.0.18, fixed in 3.0.19. It is a heap overflow that affects **32-bit systems only**; our images are amd64/arm64, the file service does not use TLS, and it is only reachable on the internal network. **Status: fixed upstream**, so a rebuild picks it up once distroless publishes the patched image. Because it is fixable, the CI gate (fail on fixable CRITICAL) blocks this job until then, which is the intended behaviour.
- **auth-service, 44 High:** all in Debian OS packages from `python:3.12-slim` (`util-linux`, `mount`, `libmount1`, `libblkid1`, `libuuid1`, `libsmartcols1`, `bsdutils`, `login`, `ncurses`, `libsystemd0`, `libudev1`, `perl-base`). All are **`affected` (no fix available)**, with one `fix_deferred`. The application never runs these tools. **Accepted risk**, mitigated by a non-root, read-only container with all capabilities dropped on an internal network. **Planned improvement:** move auth-service to a distroless or Alpine Python base to remove these packages entirely.

Additional notes:
- **file-service** (distroless Node: no shell, no package manager, no npm, zero dependencies) should be close to 0; any findings come from the Node runtime or the glibc base.
- **Alpine Node** images are small because npm was removed.
- Any remaining findings will mostly sit in OS base packages. Explain whether each is fixed upstream (rebuild picks it up) or unfixed (accepted, with the reason), and compare with the naive Debian-based images, which typically carry far more.

---

## 7. Resource limits

| Service | CPU | Memory | Justification |
|---|---:|---:|---|
| mysql | 1.0 | 768 MB (reserve 512 MB) | 256 MB InnoDB buffer pool + connections; the dataset is metadata only |
| auth-service | 1.0 | 256 MB | scrypt (N=32768) uses ~32 MB and is CPU-bound per login; 2 workers × ~40 MB RSS **[measured: 41–61 MB peak per process]** |
| file-service | 1.0 | 192 MB | Streams through fixed-size buffers, so memory does not grow with file size **[measured: 100–120 MB peak with 8 parallel full-file downloads; the first 128 MB limit was raised after this measurement]** |
| upload-web | 0.5 | 192 MB | Uploads are streamed, never buffered; mostly idle |
| streaming-web | 1.0 | 256 MB | Busiest service (catalogue + byte proxy) **[measured: 85–127 MB peak under load, for both apps in one process]** |

All app containers also have `pids: 100`, which protects against fork bombs and runaway threads. Logs rotate (`json-file`, 3 × 10 MB) so they cannot fill the disk.

---

## 8. Logs and observability

- **Structured JSON**, one line per event, on stdout (`docker compose logs`). Fields: `ts`, `level`, `service`, `msg`, `rid`, `method`, `path`, `status`, `ms`, `user`.
- **Request IDs**: the web apps generate a `rid` and pass it as `X-Request-ID` to auth and file services, so one user action can be followed across all services with `docker compose logs | grep <rid>` **[measured]**.
- **No secrets**: logs record the path only (no query strings, bodies, cookies or Authorization headers). The Node logger also redacts any field named like password, token, secret, cookie or authorization. **[measured]**: every value in `./secrets/` was grepped across all service logs after the e2e and load runs, with 0 matches.
- Failures name the dependency and error code (`"auth service unreachable","err":"ECONNREFUSED"`). Dependency status: `GET /readyz`. File-service counters: `GET /stats` (internal).

---

## 9. Performance

**Method.** `tests/load/stream.js` (k6) simulates viewers. Each iteration does the following:
- loads a catalogue page (auth verify + MySQL);
- fetches a random **256 KB Range** of one of three 8 MB videos (auth verify + metadata lookup + file-service proxy).

There is a 10 s ramp, a steady phase, and a 5 s ramp-down. `scripts/loadtest.sh` seeds identical data, then runs the same script once per configuration (exactly one change per step) while sampling CPU and memory per container. Running it again repeats the same measurement.

### Improvement 1: cache successful token verifications in the web apps (30 s TTL)

Before, *every* request made a network round trip to auth-service plus a user lookup. A video player issues many Range requests per minute, so auth was on the hot path of every byte served. The cache is bounded (10k entries), never outlives the token's own `exp`, and is short enough that disabling an account revokes access within 30 s. That trade-off is documented here and was chosen deliberately.

### Improvement 2: HTTP keep-alive connection pools to internal services

Before, each call to auth or the file service opened a new TCP connection. Now a shared `http.Agent({keepAlive:true})` reuses connections.

### Improvement 3: larger read buffer in the file service

Node's file streams read in 64 KiB chunks by default. Every chunk costs a read call, a callback and a socket write, so an 8 MB video takes 128 trips through the event loop. The file service now reads 1 MiB at a time (`READ_BUFFER_KB`, default 1024): 16× fewer chunks for the same bytes. Memory stays bounded because streams apply backpressure.

### Results **[measured]**: 30 virtual users, realistic think time (0.2 s)

| Run | Req/s | Errors | Avg latency | p95 latency | p95 catalogue | p95 range | auth CPU | web CPU |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 239.0 | 0 % | 3.92 ms | 8.65 ms | 6.10 ms | 10.26 ms | 26 % | 24 % |
| + verify cache | 244.7 | 0 % | **1.29 ms** | **3.11 ms** | 0.99 ms | 3.82 ms | **0 %** | 16 % |
| + keep-alive | 244.6 | 0 % | 1.34 ms | 3.30 ms | 1.36 ms | 4.07 ms | 0 % | 15 % |

With think time, throughput is capped by the users' pacing, so the gain shows up as latency.
- The cache cut **average latency by 67 % and p95 by 64 %**, and auth CPU fell from 26 % to ~0 %.
- At this light load keep-alive made no measurable difference (the change is within run-to-run noise). Its benefit appears under saturation.

### Results **[measured]**: saturation, 30 VUs, no think time (maximum throughput)

| Run | Req/s | Errors | Avg latency | p95 latency | Data out | auth CPU | web CPU | file-svc CPU |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 611 | 0 % | 38.2 ms | 59.0 ms | 645 Mbit/s | 63 % | 47 % | 23 % |
| + verify cache | 1 576 | 0 % | 14.7 ms | 34.8 ms | 1.7 Gbit/s | 0 % | 60 % | 42 % |
| + keep-alive | **1 861** | 0 % | **12.5 ms** | **26.4 ms** | 2.0 Gbit/s | 0 % | 61 % | 41 % |

- The **baseline bottleneck** was the Python auth service (a single process at 63 % CPU, limited by the GIL).
- The cache removed it: **2.6× throughput**.
- Keep-alive then gave another **+18 %** and cut p95 latency by a further 24 %, because the web process spends less time on TCP setup per request.
- Total: **3.0× throughput, average latency −67 %, zero errors**.
- Memory stayed flat in every run (web ≤ 127 MB, auth ≤ 61 MB, file service ≤ 113 MB).

### Results **[measured]**: improvement 3, 8 VUs downloading the full 8 MB file directly from the file service

| Read buffer | Req/s | Throughput | Avg latency | file-service CPU | Peak RSS |
|---|---:|---:|---:|---:|---:|
| 64 KiB (Node default) | 161 | 10.8 Gbit/s | 49.5 ms | 106 % | 106 MB |
| 256 KiB | 221 | 14.8 Gbit/s | 36.1 ms | 104 % | 103 MB |
| **1 MiB (chosen)** | **278** | **18.6 Gbit/s** | **28.6 ms** | 101 % | 120 MB |

- The file service is CPU-bound in all three runs (one Node event loop at ~100 %).
- The larger buffer lets that same CPU move **73 % more data** at **42 % lower latency**.
- Memory barely changes, because peak memory is dominated by socket buffers and the runtime, not the read buffer.
- This measurement is also why the file-service memory limit was raised from 128 MB to 192 MB (§7).

Raw k6 summaries and resource samples: `docs/evidence/native-perf/`.

### Repeat in Docker **[run in Docker]**

```bash
./scripts/loadtest.sh                       # think time 0.2 s, 50 VUs
THINK=0 VUS=30 ./scripts/loadtest.sh        # saturation
RUNS="keepalive workers1" ./scripts/loadtest.sh   # gunicorn 2 workers vs 1 (auth login path)
```

Each run writes `results/perf-summary.md` with throughput, errors, latency, data rate and the **average CPU / peak memory per container** taken from `docker stats`. Expect lower absolute numbers than the native ones (container networking, real MySQL, CPU limits), but the same direction.

---

## 10. CI/CD

`.github/workflows/ci.yml`:

1. **test**: Python unittest (13 tests) and Node `--test` (file service 7, upload 10, streaming 5).
2. **image** (matrix over the 4 images we build; MySQL uses the official `mysql:8.4` image):
   1. builds the Dockerfile's **test stage** (tests run inside the image);
   2. builds amd64 and loads it;
   3. runs a **Trivy scan** (SARIF to the Security tab; gate on fixable CRITICAL);
   4. records the image size in the job summary;
   5. logs in to GHCR with the run's `GITHUB_TOKEN`;
   6. does a **multi-arch build (amd64 + arm64) and push** with SBOM and provenance attestations.
   - **Tags:** `sha-<7>` (immutable, traceable to the commit), the branch name, `pr-N` on PRs (built, not pushed), `1.2.3` / `1.2` on `v*` git tags, and `latest` on main.
3. **e2e**: brings the full stack up with Compose and runs `e2e.sh`, `persistence-test.sh` and `failure-test.sh` against real MySQL. It uploads `results/` as a build artifact.

**Repository:** https://github.com/arshsaggu/video-streaming-services. The pipeline runs on every push to `main`.

**Evidence:** see the Actions tab for the run history, the Packages page for the published `vss-*` images with their `sha-…` and `latest` tags (amd64 + arm64), and the Security tab for the uploaded Trivy results. *(Add a screenshot of the latest run here.)* If the `image (file-service)` job is red, that is the Trivy gate blocking the fixable OpenSSL Critical described in §6 until the distroless base image is republished.

---

## 11. Testing summary

| Level | What | Count | Status |
|---|---|---:|---|
| Unit: auth | login, lockout, validation without echo, role rules, forged / expired / `alg:none` tokens, disabled users, DB outage → 503 | 13 | ✅ pass [measured] |
| Unit: file-service | upload/download, Range (open-ended, suffix, 416), If-Range, HEAD, token required, traversal/invalid IDs, size limit for declared and chunked uploads leaves no partial file, no overwrite on duplicate, delete, readiness | 7 (all pass as a non-root user) | ✅ pass [measured] |
| Unit: upload-web | roles 401/403, CSRF, type/title/size/magic bytes, rollback on DB failure, file/auth outages, cookie flags, admin-only user creation | 10 | ✅ pass [measured] |
| Unit: streaming-web | auth required, pagination clamping, full + Range proxying, invalid ID/range, outages + recovery | 5 | ✅ pass [measured] |
| End-to-end | 17 checks across all real service processes (smoke test) | 17 | ✅ pass [measured, native]; runs in Docker via `e2e.sh` |
| Browser | Chromium (Playwright): log in → upload a real WebM → play → seek (Range) | 1 flow | ✅ pass [measured]; screenshots in `docs/evidence/screenshots/` |

---

## 12. Defence notes: likely questions

- **Why not validate JWTs locally in each web app?** It would mean sharing the signing secret with more services (larger blast radius) and losing instant revocation. The 30 s cache gives most of the speed of local validation; see the performance results.
- **Why is the file service written in Node.js?** It is I/O-bound: it moves bytes between disk and sockets. Node streams handle that with backpressure, and with no npm dependencies its image contains no third-party code to patch.
- **Why is the file service behind a token if the network is already private?** Defence in depth: if any container on `backend` were compromised, it still could not read or overwrite videos.
- **What happens if the upload succeeds but the DB insert fails?** The file is deleted (compensating transaction), and the user gets 503 "upload rolled back". Unit-tested.
- **What if MySQL restarts mid-operation?** In-flight requests get 503. Pools reconnect on the next call; no restart is needed (failure-test.sh, scenario 1).
- **How would this scale?** The web apps and the file service are stateless apart from the volume. Scale the web apps behind a load balancer (`docker compose up --scale streaming-web=3` with an nginx front), move video storage to object storage (S3/MinIO) behind the same file-service API, and move the login limiter to Redis.
- **What would you do in production?** TLS termination (then `COOKIE_SECURE=true`), Swarm/K8s secrets, automatic restart on unhealthy, centralised logs, and video transcoding (HLS) instead of serving originals.
