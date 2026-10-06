import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

# Connect the real TUI to a PTY; the browser only renders its terminal bytes.
# 将实际 TUI 接入 PTY；浏览器仅渲染终端输出字节。
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", int(sys.argv[1]), int(sys.argv[2]), 0, 0))
env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"}
child = subprocess.Popen(sys.argv[3:], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
os.close(slave)

def stop(*_):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
pending = b""
try:
    while child.poll() is None:
        ready, _, _ = select.select([master, sys.stdin.buffer], [], [], 0.1)
        if master in ready:
            try:
                output = os.read(master, 65536)
            except OSError:
                break
            os.write(sys.stdout.fileno(), output)
        if sys.stdin.buffer in ready:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                message, pending = pending.split(b"\n", 1)
                os.write(master, json.loads(message).encode("utf-8"))
finally:
    stop()
    child.wait()
    os.close(master)
