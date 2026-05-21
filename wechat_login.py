#!/usr/bin/env python3
"""
WeChat iLink QR login helper for agent-gateway.

Flow:
  1. Fetch a QR code from iLink (GET ilink/bot/get_bot_qrcode)
  2. Open the QR image URL in your browser — scan it with WeChat
  3. Poll for confirmation (GET ilink/bot/get_qrcode_status)
  4. On success, write WECHAT_TOKEN, WECHAT_ILINK_BOT_ID, WECHAT_BASE_URL
     into data/.env

Usage:
  pip install aiohttp          # only dependency
  python wechat_login.py
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
import struct
import secrets
import sys
import webbrowser
from pathlib import Path

try:
    import aiohttp
except ImportError:
    sys.exit("ERROR: aiohttp is required.  Run:  pip install aiohttp")

# ── iLink constants (mirrors weixin.py) ──────────────────────────────────────

ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"
ILINK_APP_ID = "bot"
CHANNEL_VERSION = "2.2.0"
ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0  # 2.2.0 packed

EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode"
EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status"

QR_TIMEOUT_MS = 35_000
LOGIN_TIMEOUT_SECONDS = 480  # 8 minutes total
BOT_TYPE = "3"

# ── Paths ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
ENV_FILE = SCRIPT_DIR / "data" / ".env"

# ── Helpers ───────────────────────────────────────────────────────────────────


def _random_wechat_uin() -> str:
    value = struct.unpack(">I", secrets.token_bytes(4))[0]
    return base64.b64encode(str(value).encode("utf-8")).decode("ascii")


def _ilink_headers() -> dict[str, str]:
    return {
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": str(ILINK_APP_CLIENT_VERSION),
        "X-WECHAT-UIN": _random_wechat_uin(),
    }


async def _api_get(session: aiohttp.ClientSession, *, base_url: str, endpoint: str) -> dict:
    url = f"{base_url.rstrip('/')}/{endpoint}"
    timeout = aiohttp.ClientTimeout(total=QR_TIMEOUT_MS / 1000)
    async with session.get(url, headers=_ilink_headers(), timeout=timeout) as resp:
        raw = await resp.text()
        if not resp.ok:
            raise RuntimeError(f"iLink GET {endpoint} HTTP {resp.status}: {raw[:200]}")
        import json
        return json.loads(raw)


def _update_env_file(path: Path, updates: dict[str, str]) -> None:
    """Write/update key=value lines in an .env file, preserving other lines."""
    lines: list[str] = []
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()

    written: set[str] = set()
    result: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            result.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            result.append(f"{key}={updates[key]}")
            written.add(key)
        else:
            result.append(line)

    # Append any keys that were not already in the file
    for key, value in updates.items():
        if key not in written:
            result.append(f"{key}={value}")

    path.write_text("\n".join(result) + "\n", encoding="utf-8")


# ── Main login flow ───────────────────────────────────────────────────────────


async def qr_login() -> None:
    print("Connecting to iLink...")

    async with aiohttp.ClientSession(trust_env=True) as session:
        # Step 1: fetch QR code
        try:
            qr_resp = await _api_get(
                session,
                base_url=ILINK_BASE_URL,
                endpoint=f"{EP_GET_BOT_QR}?bot_type={BOT_TYPE}",
            )
        except Exception as exc:
            sys.exit(f"ERROR: failed to fetch QR code: {exc}")

        qrcode_value = str(qr_resp.get("qrcode") or "").strip()
        qrcode_url = str(qr_resp.get("qrcode_img_content") or "").strip()

        if not qrcode_value:
            sys.exit("ERROR: iLink response missing qrcode field")

        # Step 2: open QR in browser
        login_url = qrcode_url or qrcode_value
        print(f"\nOpening WeChat QR code in your browser:\n  {login_url}\n")
        webbrowser.open(login_url)
        print("Scan the QR code with WeChat, then confirm in the app.")
        print("Waiting", end="", flush=True)

        # Step 3: poll for confirmation
        import time
        deadline = time.time() + LOGIN_TIMEOUT_SECONDS
        current_base_url = ILINK_BASE_URL
        refresh_count = 0

        while time.time() < deadline:
            await asyncio.sleep(1)
            try:
                status_resp = await _api_get(
                    session,
                    base_url=current_base_url,
                    endpoint=f"{EP_GET_QR_STATUS}?qrcode={qrcode_value}",
                )
            except asyncio.TimeoutError:
                print(".", end="", flush=True)
                continue
            except Exception as exc:
                print(f"\nWARN: poll error: {exc}")
                continue

            status = str(status_resp.get("status") or "wait")

            if status == "wait":
                print(".", end="", flush=True)

            elif status == "scaned":
                print("\nScanned — please confirm in WeChat...", end="", flush=True)

            elif status == "scaned_but_redirect":
                redirect_host = str(status_resp.get("redirect_host") or "").strip()
                if redirect_host:
                    current_base_url = f"https://{redirect_host}"

            elif status == "expired":
                refresh_count += 1
                if refresh_count > 3:
                    sys.exit("\nERROR: QR code expired too many times. Please retry.")
                print(f"\nQR code expired, refreshing... ({refresh_count}/3)")
                try:
                    qr_resp = await _api_get(
                        session,
                        base_url=ILINK_BASE_URL,
                        endpoint=f"{EP_GET_BOT_QR}?bot_type={BOT_TYPE}",
                    )
                    qrcode_value = str(qr_resp.get("qrcode") or "").strip()
                    qrcode_url = str(qr_resp.get("qrcode_img_content") or "").strip()
                    login_url = qrcode_url or qrcode_value
                    print(f"New QR code:\n  {login_url}")
                    webbrowser.open(login_url)
                    print("Waiting", end="", flush=True)
                except Exception as exc:
                    sys.exit(f"\nERROR: QR refresh failed: {exc}")

            elif status == "confirmed":
                bot_token = str(status_resp.get("bot_token") or "").strip()
                ilink_bot_id = str(status_resp.get("ilink_bot_id") or "").strip()
                base_url = str(status_resp.get("baseurl") or ILINK_BASE_URL).strip().rstrip("/")

                if not bot_token or not ilink_bot_id:
                    sys.exit("\nERROR: Login confirmed but credential payload was incomplete.")

                print(f"\n\nLogin confirmed!")
                print(f"  ilink_bot_id : {ilink_bot_id}")
                print(f"  base_url     : {base_url}")
                print(f"  bot_token    : {bot_token[:12]}...")

                # Step 4: write to data/.env
                updates = {
                    "WECHAT_TOKEN": bot_token,
                    "WECHAT_ILINK_BOT_ID": ilink_bot_id,
                    "WECHAT_BASE_URL": base_url,
                }
                _update_env_file(ENV_FILE, updates)
                print(f"\nWritten to {ENV_FILE}")
                print("You can now start the gateway:  cd packages/gateway && pnpm dev")
                return

        sys.exit("\nERROR: Login timed out after 8 minutes.")


if __name__ == "__main__":
    asyncio.run(qr_login())
