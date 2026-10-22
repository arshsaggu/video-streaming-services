"""Unit tests for the auth service (stdlib unittest; no database needed)."""
import time
import unittest

import jwt

from app.config import Settings
from app.main import create_app
from app.repo import InMemoryUserRepo

SECRET = "test-secret-" + "x" * 40


def make_settings(**over) -> Settings:
    base = dict(db_host="-", db_port=0, db_user="-", db_password="-", db_name="-",
                jwt_secret=SECRET, jwt_ttl_seconds=60, hash_method="pbkdf2:sha256:1000",
                admin_password="admin-pass-123", allow_registration=True,
                login_max_failures=3, login_window_seconds=60)
    base.update(over)
    return Settings(**base)


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryUserRepo()
        self.app = create_app(make_settings(), self.repo, seed=False)
        self.client = self.app.test_client()
        from werkzeug.security import generate_password_hash
        self.repo.create("admin", generate_password_hash("admin-pass-123", "pbkdf2:sha256:1000"), "admin")

    def login(self, username="admin", password="admin-pass-123"):
        return self.client.post("/login", json={"username": username, "password": password})

    def test_health_and_ready(self):
        self.assertEqual(self.client.get("/healthz").status_code, 200)
        self.assertEqual(self.client.get("/readyz").status_code, 200)
        self.repo.available = False
        r = self.client.get("/readyz")
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.get_json()["mysql"], "down")

    def test_login_success_returns_valid_jwt(self):
        r = self.login()
        self.assertEqual(r.status_code, 200)
        claims = jwt.decode(r.get_json()["token"], SECRET, algorithms=["HS256"], issuer="vss-auth")
        self.assertEqual(claims["sub"], "admin")
        self.assertEqual(claims["role"], "admin")

    def test_wrong_password_and_unknown_user_look_identical(self):
        a = self.login(password="wrong-password")
        b = self.login(username="nobody", password="wrong-password")
        self.assertEqual(a.status_code, 401)
        self.assertEqual(a.get_json(), b.get_json())

    def test_bruteforce_lockout(self):
        for _ in range(3):
            self.assertEqual(self.login(password="bad-password").status_code, 401)
        # correct password is now refused too, until the window passes
        self.assertEqual(self.login().status_code, 429)

    def test_input_validation_never_echoes_password(self):
        r = self.client.post("/login", json={"username": "a b'; DROP TABLE users;--", "password": "short"})
        self.assertEqual(r.status_code, 422)
        body = r.get_json()
        self.assertEqual(body["fields"], ["username", "password"])
        self.assertNotIn("short", r.get_data(as_text=True))
        self.assertEqual(self.client.post("/login", data="not json").status_code, 400)

    def test_oversized_body_rejected(self):
        r = self.client.post("/login", json={"username": "admin", "password": "x" * 10_000})
        self.assertEqual(r.status_code, 413)

    def test_register_creates_viewer_and_rejects_duplicates(self):
        r = self.client.post("/register", json={"username": "alice", "password": "alice-pass-1"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self.repo.users["alice"].role, "viewer")
        r = self.client.post("/register", json={"username": "alice", "password": "alice-pass-1"})
        self.assertEqual(r.status_code, 409)

    def test_register_cannot_choose_role(self):
        self.client.post("/register", json={"username": "mallory", "password": "mallory-pw", "role": "admin"})
        self.assertEqual(self.repo.users["mallory"].role, "viewer")

    def test_only_admin_can_create_users(self):
        admin_token = self.login().get_json()["token"]
        r = self.client.post("/users", json={"username": "bob", "password": "bob-pass-12", "role": "uploader"},
                             headers={"Authorization": f"Bearer {admin_token}"})
        self.assertEqual(r.status_code, 201)
        bob_token = self.login("bob", "bob-pass-12").get_json()["token"]
        r = self.client.post("/users", json={"username": "eve", "password": "eve-pass-12", "role": "admin"},
                             headers={"Authorization": f"Bearer {bob_token}"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.post("/users", json={}).status_code, 401)

    def test_verify(self):
        token = self.login().get_json()["token"]
        r = self.client.get("/verify", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["role"], "admin")

    def test_verify_rejects_tampered_expired_and_foreign_tokens(self):
        now = int(time.time())
        forged = jwt.encode({"sub": "admin", "role": "admin", "iss": "vss-auth", "exp": now + 60},
                            "a-different-secret-" + "y" * 30, algorithm="HS256")
        expired = jwt.encode({"sub": "admin", "role": "admin", "iss": "vss-auth", "exp": now - 10},
                             SECRET, algorithm="HS256")
        none_alg = jwt.encode({"sub": "admin", "role": "admin", "iss": "vss-auth", "exp": now + 60},
                              None, algorithm="none")
        for tok in (forged, expired, none_alg, "garbage"):
            r = self.client.get("/verify", headers={"Authorization": f"Bearer {tok}"})
            self.assertEqual(r.status_code, 401, tok)

    def test_verify_rejects_deactivated_user(self):
        token = self.login().get_json()["token"]
        self.repo.users["admin"].is_active = False
        r = self.client.get("/verify", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(r.status_code, 401)

    def test_database_outage_returns_503_not_500(self):
        token = self.login().get_json()["token"]
        self.repo.available = False
        self.assertEqual(self.login().status_code, 503)
        r = self.client.get("/verify", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(r.status_code, 503)


class SchemaCompatibilityTests(unittest.TestCase):
    """Guards against the real MySQL schema drifting from what the code writes
    (the in-memory repo used by the other tests has no column limits)."""

    SCHEMA = __import__("pathlib").Path(__file__).resolve().parents[3] / "db" / "init" / "00-schema.sql"

    def column_size(self, column):
        import re
        if not self.SCHEMA.exists():
            self.skipTest("schema file not available (e.g. inside the image test stage)")
        m = re.search(rf"{column}\s+VARCHAR\((\d+)\)", self.SCHEMA.read_text())
        self.assertIsNotNone(m, column)
        return int(m.group(1))

    def test_production_password_hash_fits_column(self):
        from werkzeug.security import generate_password_hash
        h = generate_password_hash("x" * 128, method="scrypt:32768:8:1")
        self.assertLessEqual(len(h), self.column_size("password_hash"))

    def test_username_limit_matches_column(self):
        self.assertGreaterEqual(self.column_size("username"), 32)


class LoggingSetupTests(unittest.TestCase):
    def test_log_level_names_are_case_insensitive(self):
        import logging
        from app.logging_setup import setup_logging
        for value, expected in [("info", logging.INFO), ("DEBUG", logging.DEBUG), ("Warning", logging.WARNING),
                                ("nonsense", logging.INFO)]:
            setup_logging(value)
            self.assertEqual(logging.getLogger().level, expected, value)
        setup_logging("INFO")


if __name__ == "__main__":
    unittest.main()
