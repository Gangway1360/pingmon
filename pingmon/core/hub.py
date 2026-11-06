"""Diffusion temps reel vers les navigateurs (Server-Sent Events)."""
import json
import queue
import threading


class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = set()

    def subscribe(self):
        q = queue.Queue(maxsize=2000)
        with self.lock:
            self.clients.add(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.clients.discard(q)

    @staticmethod
    def encode(event, data):
        return ("event: %s\ndata: %s\n\n" % (event, json.dumps(data, separators=(",", ":")))).encode()

    def publish(self, event, data):
        msg = self.encode(event, data)
        with self.lock:
            clients = list(self.clients)
        for q in clients:
            try:
                q.put_nowait(msg)
            except queue.Full:   # client trop lent : il rechargera a la reconnexion
                pass


HUB = Hub()
