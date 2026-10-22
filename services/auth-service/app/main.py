"""Authentication Service (Python / Flask).

Issues and validates JWTs for the Upload and Streaming web apps. Internal only:
it sits on the private `backend` network and is never published to the host.

Endpoints
  POST /login      {username, password}            -> {token, role, username, expires_in}
  POST /register   {username, password}            -> creates a 'viewer'
  POST /users      {username, password, role}      -> admin only
  GET  /verify     Authorization: Bearer <token>   -> {sub, role, exp}
  GET  /healthz    liveness (no dependencies)
  GET  /readyz     readiness (checks MySQL)
"""
import logging
import os
import re
import threading
import time
import uuid
from collections import defaultdict, deque

import jwt
from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

from .config import Settings, load_settings
from .logging_setup import setup_logging
from .repo import MySQLUserRepo, UserExists, UserRepo

log = setup_logging(os.getenv("LOG_LEVEL", "INFO"))

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
ROLES = ("viewer", "uploader", "admin")
ISSUER = "vss-auth"


def describe_db_error(exc: Exception) -> str:
    """'OperationalError 1045: Access denied for user ...' - MySQL error messages name the
    user and host but never contain the password, so they are safe to log."""
    args = getattr(exc, "args", ())
    if len(args) >= 2 and isinstance(args[0], int):
        return f"{type(exc).__name__} {args[0]}: {str(args[1])[:200]}"
    return f"{type(exc).__name__}: {str(exc)[:200]}" if str(exc) else type(exc).__name__


class ApiError(Exception):
    def __init__(self, status: int, message: str, fields: list[str] | None = None):
        super().__init__(message)
        self.status, self.message, self.fields = status, message, fields


# ---------- input validation ----------
def parse_credentials(require_role: bool = False) -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError(400, "expected a JSON object body")
    bad: list[str] = []
    username, password = data.get("username"), data.get("password")
    if not isinstance(username, str) or not USERNAME_RE.fullmatch(username):
        bad.append("username")
    if not isinstance(password, str) or not (8 <= len(password) <= 128):
        bad.append("password")
    role = data.get("role", "viewer")
    if require_role and role not in ROLES:
        bad.append("role")
    if bad:
        # Only field *names* are returned - never echo submitted values (passwords).
        raise ApiError(422, "invalid input", bad)
    return {"username": username, "password": password, "role": role}


# ---------- brute-force protection ----------
class LoginLimiter:
    """Sliding-window count of failed logins per (client ip, username). Per worker process."""

    def __init__(self, max_failures: int, window_s: int):
        self.max_failures, self.window_s = max_failures, window_s
        self._fails: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def _trim(self, key: str, now: float) -> deque:
        q = self._fails[key]
        while q and now - q[0] > self.window_s:
            q.popleft()
        return q

    def blocked(self, key: str) -> bool:
        with self._lock:
            return len(self._trim(key, time.monotonic())) >= self.max_failures

    def fail(self, key: str) -> None:
        with self._lock:
            self._trim(key, time.monotonic()).append(time.monotonic())

    def reset(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)


def create_app(settings: Settings | None = None, repo: UserRepo | None = None, seed: bool = True) -> Flask:
    settings = settings or load_settings()
    repo = repo or MySQLUserRepo(settings.db_host, settings.db_port, settings.db_user,
                                 settings.db_password, settings.db_name)
    limiter = LoginLimiter(settings.login_max_failures, settings.login_window_seconds)
    # Hash of a random value: lets "unknown user" cost the same as "wrong password" (no user enumeration by timing).
    dummy_hash = generate_password_hash(uuid.uuid4().hex, method=settings.hash_method)

    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 4 * 1024  # auth bodies are tiny; reject anything larger
    app.extensions["repo"] = repo

    def hash_pw(pw: str) -> str:
        return generate_password_hash(pw, method=settings.hash_method)

    def issue_token(username: str, role: str) -> str:
        now = int(time.time())
        claims = {"sub": username, "role": role, "iss": ISSUER, "iat": now,
                  "exp": now + settings.jwt_ttl_seconds, "jti": uuid.uuid4().hex}
        return jwt.encode(claims, settings.jwt_secret, algorithm="HS256")

    def bearer_claims() -> dict:
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise ApiError(401, "missing bearer token")
        try:
            return jwt.decode(header[7:].strip(), settings.jwt_secret, algorithms=["HS256"],
                              issuer=ISSUER, options={"require": ["exp", "sub", "role"]})
        except jwt.ExpiredSignatureError:
            raise ApiError(401, "token expired")
        except jwt.InvalidTokenError:
            raise ApiError(401, "invalid token")

    def db_call(fn, *args):
        try:
            return fn(*args)
        except UserExists:
            raise
        except Exception as exc:
            log.error("database error", extra={"fields": {"rid": g.rid, "error": describe_db_error(exc)}})
            raise ApiError(503, "authentication store unavailable")

    def seed_admin() -> None:
        """Create the initial admin from the ADMIN_PASSWORD secret; retries while MySQL starts."""
        if not settings.admin_password:
            return
        for attempt in range(1, 61):
            try:
                if repo.get("admin") is None:
                    repo.create("admin", hash_pw(settings.admin_password), "admin")
                    log.info("seeded admin user")
                return
            except UserExists:
                return
            except Exception as exc:
                log.warning("admin seed waiting for database",
                            extra={"fields": {"attempt": attempt, "error": describe_db_error(exc)}})
                time.sleep(2)
        log.error("admin seed gave up; database unreachable")

    if seed:
        threading.Thread(target=seed_admin, daemon=True, name="seed-admin").start()

    # ---------- request id + access log ----------
    @app.before_request
    def _start():
        g.rid = (request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16])[:64]
        g.t0 = time.perf_counter()

    @app.after_request
    def _finish(resp):
        resp.headers["X-Request-ID"] = g.get("rid", "-")
        resp.headers["Cache-Control"] = "no-store"
        if request.path != "/healthz":
            log.info("request", extra={"fields": {
                "rid": g.get("rid"), "method": request.method, "path": request.path,
                "status": resp.status_code, "ms": round((time.perf_counter() - g.get("t0", time.perf_counter())) * 1000, 1),
            }})
        return resp

    @app.errorhandler(ApiError)
    def _api_error(err: ApiError):
        body = {"error": err.message}
        if err.fields:
            body["fields"] = err.fields
        return jsonify(body), err.status

    @app.errorhandler(HTTPException)
    def _http_error(err: HTTPException):
        return jsonify({"error": err.name.lower()}), err.code

    @app.errorhandler(Exception)
    def _unhandled(err: Exception):
        log.exception("unhandled error", extra={"fields": {"rid": g.get("rid")}})
        return jsonify({"error": "internal error"}), 500

    # ---------- health ----------
    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz():
        try:
            repo.ping()
        except Exception as exc:
            log.warning("readiness failed", extra={"fields": {"dependency": "mysql", "error": describe_db_error(exc)}})
            return {"status": "unavailable", "mysql": "down"}, 503
        return {"status": "ok", "mysql": "up"}

    # ---------- auth API ----------
    @app.post("/login")
    def login():
        body = parse_credentials()
        key = f"{request.remote_addr}:{body['username'].lower()}"
        if limiter.blocked(key):
            log.warning("login throttled", extra={"fields": {"rid": g.rid, "user": body["username"]}})
            raise ApiError(429, "too many failed attempts, try again later")
        user = db_call(repo.get, body["username"])
        ok = check_password_hash(user.password_hash if user else dummy_hash, body["password"])
        if not user or not ok or not user.is_active:
            limiter.fail(key)
            log.info("login failed", extra={"fields": {"rid": g.rid, "user": body["username"]}})
            raise ApiError(401, "invalid username or password")
        limiter.reset(key)
        log.info("login ok", extra={"fields": {"rid": g.rid, "user": user.username, "role": user.role}})
        return {"token": issue_token(user.username, user.role), "role": user.role,
                "username": user.username, "expires_in": settings.jwt_ttl_seconds}

    @app.post("/register")
    def register():
        if not settings.allow_registration:
            raise ApiError(403, "registration disabled")
        body = parse_credentials()
        try:
            db_call(repo.create, body["username"], hash_pw(body["password"]), "viewer")
        except UserExists:
            raise ApiError(409, "username already taken")
        log.info("user registered", extra={"fields": {"rid": g.rid, "user": body["username"], "role": "viewer"}})
        return {"username": body["username"], "role": "viewer"}, 201

    @app.post("/users")
    def create_user():
        claims = bearer_claims()
        if claims.get("role") != "admin":
            raise ApiError(403, "admin role required")
        body = parse_credentials(require_role=True)
        try:
            db_call(repo.create, body["username"], hash_pw(body["password"]), body["role"])
        except UserExists:
            raise ApiError(409, "username already taken")
        log.info("user created", extra={"fields": {"rid": g.rid, "user": body["username"],
                                                   "role": body["role"], "by": claims["sub"]}})
        return {"username": body["username"], "role": body["role"]}, 201

    @app.get("/verify")
    def verify():
        """Checks signature + expiry, and that the account still exists and is active."""
        claims = bearer_claims()
        user = db_call(repo.get, claims["sub"])
        if user is None or not user.is_active:
            raise ApiError(401, "account disabled")
        return {"sub": user.username, "role": user.role, "exp": claims["exp"]}

    return app
