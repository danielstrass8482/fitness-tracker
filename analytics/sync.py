#!/usr/bin/env python3
"""Fuelofit Analyse-DB -- Sync-Job (Phase 1a).

Holt Rohdaten ueber die Cloud Function exportAnalytics (Projekt fitness-tracker-c6f97,
~/functions) und schreibt sie nach raw.* in Postgres (fuelofit_analytics). Kein Service
Account, kein Firestore-Zugriff von hier aus -- nur HTTPS gegen die Function mit einem
Secret aus einer lokalen Datei.

Aufruf:
    sync.py --mode window   (taeglich, cron 04:15)
    sync.py --mode full     (sonntags, cron 04:45)

Nur Standardbibliothek + psycopg (siehe requirements.txt). Secret wird gelesen, aber nie
geloggt oder ausgegeben. DB-Passwort kommt aus ~/.pgpass des ausfuehrenden Systemnutzers
(libpq-Standardmechanismus), steht nicht in diesem Skript und nicht in einer Env-Variable.
"""

import argparse
import fcntl
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

import psycopg

# ===== Konfiguration (per Env ueberschreibbar, sonst diese Defaults) =====
FUNCTION_URL = os.environ.get(
    "ANALYTICS_FUNCTION_URL",
    "https://us-central1-fitness-tracker-c6f97.cloudfunctions.net/exportAnalytics",
)
SECRET_FILE = os.environ.get(
    "ANALYTICS_SECRET_FILE", "/home/fuelofit-analytics/.config/analytics-export-secret"
)
LOG_FILE = os.environ.get("ANALYTICS_LOG_FILE", "/home/fuelofit-analytics/app/sync.log")
LOCK_FILE = os.environ.get("ANALYTICS_LOCK_FILE", "/home/fuelofit-analytics/app/sync.lock")
DB_CONNINFO = os.environ.get(
    "ANALYTICS_DB_CONNINFO", "host=localhost dbname=fuelofit_analytics user=fuelofit_sync"
)

WINDOW_DAYS = 14          # Fenster fuer den taeglichen Sync (Function-Default, max 31)
PAGE_LIMIT = 1000         # Max. Dokumente je Antwort (Function-Grenze)
HTTP_TIMEOUT_SEC = 60
MAX_HTTP_RETRIES = 2      # nur bei Netzwerkfehlern, nie bei 4xx

# collection (Firestore, exportAnalytics-Parameter) -> (raw-Tabelle, Fenster-faehig)
# Fenster-faehig = hat ein Datumsfeld, kann mode=window; sonst nur mode=full (siehe
# docs/datenmodell.md Abschnitt "Analytics-DB" und ~/functions/index.js ANALYTICS_WHITELIST).
COLLECTIONS = [
    ("logEntries", "log_entries", True),
    ("entries", "entries", True),
    ("oura_daily", "oura_daily", True),
    ("oura_workouts", "oura_workouts", True),
    ("garminActivities", "garmin_activities", True),
    ("garminDaily", "garmin_daily", True),
    ("ciqSteps", "ciq_steps", True),
    ("dailyCheck", "daily_check", True),
    ("dailyCheckCallLog", "daily_check_call_log", True),
    ("trainingplans", "trainingplans", True),
    ("foods", "foods", False),
    ("recipes", "recipes", False),
    ("weeklyStats", "weekly_stats", False),
    ("trainingTypes", "training_types", False),
    ("intervalTemplates", "interval_templates", False),
    ("garminLinks", "garmin_links", False),
    ("garminHidden", "garmin_hidden", False),
]

log = logging.getLogger("analytics_sync")


def setup_logging():
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    handler = logging.FileHandler(LOG_FILE)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)
    log.addHandler(logging.StreamHandler(sys.stdout))
    log.setLevel(logging.INFO)


def read_secret() -> str:
    with open(SECRET_FILE, "r", encoding="ascii") as f:
        return f.read().strip()


def fetch_page(collection: str, mode: str, secret: str, page_token: str | None) -> dict:
    params = {"collection": collection, "mode": mode, "limit": str(PAGE_LIMIT)}
    if mode == "window":
        params["days"] = str(WINDOW_DAYS)
    if page_token:
        params["pageToken"] = page_token
    url = FUNCTION_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"X-Analytics-Secret": secret})

    last_err = None
    for attempt in range(MAX_HTTP_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 401/400/5xx der Function: kein Retry, sofort melden (koennte falsches/abgelaufenes
            # Secret oder ein Programmierfehler sein -- Wiederholen wuerde das verschleiern).
            body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {e.code} fuer {collection}: {body}") from e
        except urllib.error.URLError as e:
            last_err = e
            if attempt < MAX_HTTP_RETRIES:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"Netzwerkfehler fuer {collection}: {e}") from e
    raise RuntimeError(f"Unerreichbar fuer {collection}: {last_err}")


def fetch_all(collection: str, mode: str, secret: str) -> tuple[list[dict], int]:
    docs: list[dict] = []
    reads = 0
    page_token = None
    while True:
        page = fetch_page(collection, mode, secret, page_token)
        docs.extend(page["docs"])
        reads += page["readCount"]
        page_token = page.get("nextPageToken")
        if not page_token:
            break
    return docs, reads


def upsert_docs(conn: psycopg.Connection, table: str, docs: list[dict]) -> None:
    if not docs:
        return
    sql = f"""
        INSERT INTO raw.{table} (id, day, data, synced_at, deleted_at)
        VALUES (%(id)s, %(day)s, %(data)s, now(), NULL)
        ON CONFLICT (id) DO UPDATE SET
            day = EXCLUDED.day,
            data = EXCLUDED.data,
            synced_at = now(),
            deleted_at = NULL
    """
    with conn.cursor() as cur:
        for d in docs:
            cur.execute(
                sql,
                {"id": d["id"], "day": d.get("date"), "data": json.dumps(d["data"])},
            )


def mark_deleted(conn: psycopg.Connection, table: str, mode: str, seen_ids: set[str]) -> int:
    """Markiert Zeilen, die in diesem Lauf nicht mehr geliefert wurden, als geloescht.

    window: nur innerhalb des abgefragten Zeitfensters (sonst wuerden aeltere, nicht
            mitgelieferte Tage faelschlich als geloescht markiert).
    full:   über die gesamte Tabelle.
    """
    with conn.cursor() as cur:
        if mode == "window":
            cutoff = (date.today() - timedelta(days=WINDOW_DAYS)).isoformat()
            cur.execute(
                f"""
                UPDATE raw.{table}
                SET deleted_at = now()
                WHERE deleted_at IS NULL
                  AND day IS NOT NULL
                  AND day >= %s
                  AND NOT (id = ANY(%s))
                """,
                (cutoff, list(seen_ids)),
            )
        else:
            cur.execute(
                f"""
                UPDATE raw.{table}
                SET deleted_at = now()
                WHERE deleted_at IS NULL
                  AND NOT (id = ANY(%s))
                """,
                (list(seen_ids),),
            )
        return cur.rowcount


def sync_collection(conn: psycopg.Connection, collection: str, table: str, mode: str, secret: str) -> dict:
    t0 = time.monotonic()
    docs, reads = fetch_all(collection, mode, secret)
    upsert_docs(conn, table, docs)
    deleted = mark_deleted(conn, table, mode, {d["id"] for d in docs})
    conn.commit()
    duration = time.monotonic() - t0
    return {
        "collection": collection,
        "table": table,
        "mode": mode,
        "docs": len(docs),
        "reads": reads,
        "deleted": deleted,
        "duration_sec": round(duration, 1),
    }


def run(mode: str) -> int:
    secret = read_secret()
    results = []
    with psycopg.connect(DB_CONNINFO) as conn:
        for collection, table, supports_window in COLLECTIONS:
            if mode == "window" and not supports_window:
                continue  # Collections ohne Datumsfeld nur im woechentlichen full-Lauf
            try:
                r = sync_collection(conn, collection, table, mode, secret)
                results.append(r)
                log.info(
                    "OK %-20s mode=%-6s docs=%-6d reads=%-6d deleted=%-4d dauer=%.1fs",
                    r["collection"], r["mode"], r["docs"], r["reads"], r["deleted"], r["duration_sec"],
                )
            except Exception as e:
                log.error("FEHLER bei %s: %s", collection, e)
                raise

    total_docs = sum(r["docs"] for r in results)
    total_reads = sum(r["reads"] for r in results)
    total_duration = sum(r["duration_sec"] for r in results)
    log.info(
        "Zusammenfassung mode=%s: %d Collections, %d Dokumente, %d Reads, %.1fs gesamt",
        mode, len(results), total_docs, total_reads, total_duration,
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["window", "full"], required=True)
    args = parser.parse_args()

    setup_logging()

    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    lock_fd = os.open(LOCK_FILE, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log.error("Laeuft schon ein anderer Sync (Lock %s belegt) -- Abbruch", LOCK_FILE)
        return 1

    start = datetime.now(timezone.utc)
    log.info("Start mode=%s um %s", args.mode, start.isoformat())
    try:
        rc = run(args.mode)
    except Exception as e:
        log.error("Lauf abgebrochen: %s", e)
        rc = 1
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
    return rc


if __name__ == "__main__":
    sys.exit(main())
