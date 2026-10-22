"""Structured JSON logs to stdout. Never logs request bodies, passwords, tokens or cookies."""
import json
import logging
import sys
import time


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "service": "auth-service",
            "msg": record.getMessage(),
        }
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            entry.update(extra)
        if record.exc_info:
            entry["error"] = self.formatException(record.exc_info).splitlines()[-1]
        return json.dumps(entry)


def setup_logging(level: str = "INFO") -> logging.Logger:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    # Accept "info"/"INFO"/"Info" (compose passes lowercase); fall back to INFO for unknown values
    # instead of crashing the service on a typo.
    name = str(level).strip().upper()
    root.setLevel(name if name in logging.getLevelNamesMapping() else logging.INFO)
    # gunicorn/werkzeug access logs would duplicate ours (and log query strings); silence them.
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    logging.getLogger("gunicorn.access").disabled = True
    return logging.getLogger("auth")
