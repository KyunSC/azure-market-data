#!/usr/bin/env python3
"""TCP tarpit: accepts connections and never replies.

Stands in for a hung Supabase so the circuit-breaker arm has a deterministic
fault to trip on. The JDBC URL carries socketTimeout=30, so each attempt that
reaches the tarpit hangs ~30s before failing -- exactly the failure mode the
breaker exists to short-circuit.

Usage: python3 tarpit.py [port]   (default 6544)
"""
import socket
import sys
import threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 6544
held = []


def hold(conn):
    # Never read, never write, never close. Just pin the socket open.
    held.append(conn)


srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT))
srv.listen(128)
print(f"tarpit listening on 127.0.0.1:{PORT}", flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=hold, args=(c,), daemon=True).start()
