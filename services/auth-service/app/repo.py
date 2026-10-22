"""User storage. MySQL in production; an in-memory version is used by the unit tests."""
import queue
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Protocol


@dataclass
class User:
    id: int
    username: str
    password_hash: str
    role: str
    is_active: bool


class UserExists(Exception):
    pass


class UserRepo(Protocol):
    def get(self, username: str) -> User | None: ...
    def create(self, username: str, password_hash: str, role: str) -> User: ...
    def ping(self) -> None: ...


class MySQLUserRepo:
    """Tiny thread-safe connection pool over PyMySQL.

    Connections are checked with ping(reconnect=True) on checkout, so the service
    recovers on its own after MySQL restarts. All queries are parameterised.
    """

    def __init__(self, host: str, port: int, user: str, password: str, database: str, pool_size: int = 5):
        import pymysql  # imported lazily so unit tests don't need the driver

        self._pymysql = pymysql
        self._kwargs = dict(host=host, port=port, user=user, password=password, database=database,
                            charset="utf8mb4", connect_timeout=3, read_timeout=5, write_timeout=5,
                            autocommit=True, cursorclass=pymysql.cursors.DictCursor)
        self._pool: queue.LifoQueue = queue.LifoQueue(maxsize=pool_size)
        self._sem = threading.BoundedSemaphore(pool_size)

    @contextmanager
    def _conn(self):
        if not self._sem.acquire(timeout=5):
            raise TimeoutError("database pool exhausted")
        conn = None
        try:
            try:
                conn = self._pool.get_nowait()
                conn.ping(reconnect=True)
            except queue.Empty:
                conn = self._pymysql.connect(**self._kwargs)
            yield conn
        except Exception:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
                conn = None
            raise
        finally:
            if conn is not None:
                self._pool.put_nowait(conn)
            self._sem.release()

    def ping(self) -> None:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1")

    def get(self, username: str) -> User | None:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT id, username, password_hash, role, is_active FROM users WHERE username = %s",
                        (username,))
            row = cur.fetchone()
        if row is None:
            return None
        return User(row["id"], row["username"], row["password_hash"], row["role"], bool(row["is_active"]))

    def create(self, username: str, password_hash: str, role: str) -> User:
        try:
            with self._conn() as conn, conn.cursor() as cur:
                cur.execute("INSERT INTO users (username, password_hash, role) VALUES (%s, %s, %s)",
                            (username, password_hash, role))
                new_id = cur.lastrowid
        except self._pymysql.err.IntegrityError as exc:
            raise UserExists(username) from exc
        return User(new_id, username, password_hash, role, True)


class InMemoryUserRepo:
    def __init__(self):
        self.users: dict[str, User] = {}
        self.available = True
        self._lock = threading.Lock()

    def ping(self) -> None:
        if not self.available:
            raise ConnectionError("database unavailable")

    def get(self, username: str) -> User | None:
        self.ping()
        return self.users.get(username)

    def create(self, username: str, password_hash: str, role: str) -> User:
        self.ping()
        with self._lock:
            if username in self.users:
                raise UserExists(username)
            user = User(len(self.users) + 1, username, password_hash, role, True)
            self.users[username] = user
        return user
