"""gunicorn settings. Worker count is configurable so its effect can be measured (see report, perf #3)."""
import os

bind = "0.0.0.0:8000"
# Password hashing (scrypt) is CPU-bound and holds the GIL, so throughput on
# /login scales with *processes*, not threads.
workers = int(os.getenv("AUTH_WORKERS", "2"))
worker_class = "gthread"
threads = int(os.getenv("AUTH_THREADS", "4"))
timeout = 30
graceful_timeout = 10
keepalive = 30
# The container root filesystem is read-only; gunicorn's heartbeat files go to tmpfs.
worker_tmp_dir = "/dev/shm"
accesslog = None          # the app writes its own structured access log
errorlog = "-"
loglevel = os.getenv("LOG_LEVEL", "info").lower()
