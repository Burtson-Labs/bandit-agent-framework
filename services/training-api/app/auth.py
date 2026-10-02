"""AuthApi JWTs, validated here (HS256 with the AuthApi signing key), not trusted from a proxy.

Admin (``admin``/``super-user``) may do everything. The narrow ``training`` role (an
AuthApi role-scoped key, so a leaked collector key can't read the studio) may only
upload datasets and list them. Run callbacks from the worker use a per-run token
instead (see ``runs.check_run_token``).
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import jwt
from fastapi import Header, HTTPException

ADMIN_ROLES = frozenset({"admin", "super-user"})
UPLOAD_ROLE = "training"


@dataclass(frozen=True)
class Caller:
    id: str
    email: str | None
    roles: frozenset[str]

    @property
    def is_admin(self) -> bool:
        return bool(self.roles & ADMIN_ROLES)

    @property
    def owner(self) -> str:
        return self.email or self.id


class Settings:
    def __init__(self) -> None:
        self.secret = os.getenv("JWT_SECRET", "")
        self.issuer = os.getenv("JWT_ISSUER", "https://burtson.ai")
        self.audiences = [a.strip() for a in os.getenv("JWT_AUDIENCES", "gateway-api,auth-api").split(",") if a.strip()]


settings = Settings()


def decode(token: str) -> Caller:
    if not settings.secret:
        raise HTTPException(503, "JWT_SECRET is not configured")
    try:
        claims = jwt.decode(token, settings.secret, algorithms=["HS256"], issuer=settings.issuer,
                            audience=settings.audiences, options={"require": ["exp", "sub"]})
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(401, "token expired") from exc
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "invalid token") from exc
    roles = claims.get("roles") or []
    if isinstance(roles, str):
        roles = [roles]
    return Caller(id=str(claims["sub"]), email=claims.get("email"), roles=frozenset(str(r) for r in roles))


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing bearer token")
    return authorization.split(" ", 1)[1].strip()


def admin(authorization: str | None = Header(default=None)) -> Caller:
    caller = decode(_bearer(authorization))
    if not caller.is_admin:
        raise HTTPException(403, "admin only")
    return caller


def uploader(authorization: str | None = Header(default=None)) -> Caller:
    """Admin, or the narrow ``training`` role (dataset upload + list only)."""
    caller = decode(_bearer(authorization))
    if not (caller.is_admin or UPLOAD_ROLE in caller.roles):
        raise HTTPException(403, "admin or training role required")
    return caller
