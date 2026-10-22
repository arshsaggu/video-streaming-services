# syntax=docker/dockerfile:1.7
# ---------- Authentication Service (Python / Flask / gunicorn) ----------
# Multi-stage: dependencies are installed into a virtualenv in a build stage and
# only that venv + the app code are copied into the slim runtime image
# (no pip cache, no build tooling).

ARG PYTHON_VERSION=3.12

FROM python:${PYTHON_VERSION}-slim AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /venv
WORKDIR /build
# Copy only the requirements first so this layer is cached until dependencies change.
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    /venv/bin/pip install --no-compile -r requirements.txt

# ---------- test stage (used by CI: docker build --target test) ----------
FROM build AS test
WORKDIR /src
COPY . .
RUN /venv/bin/python -m unittest discover -s tests -t . -v

# ---------- runtime ----------
FROM python:${PYTHON_VERSION}-slim AS runtime
LABEL org.opencontainers.image.title="vss-auth-service" \
      org.opencontainers.image.description="Authentication service for the Video Streaming System"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/venv/bin:$PATH
# Dedicated unprivileged user; the code stays owned by root so the process cannot modify it.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build /venv /venv
COPY app ./app
COPY wsgi.py gunicorn.conf.py ./
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"]
CMD ["gunicorn", "-c", "gunicorn.conf.py", "wsgi:app"]
