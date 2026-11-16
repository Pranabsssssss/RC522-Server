/**
 * RFID RC522 Live Relay Hub — Cloudflare Worker + Durable Object
 *
 * Architecture:
 *   ESP8266 NodeMCU (RC522)
 *        │ WebSocket /host?auth=xxx
 *        ▼
 *   ┌────────────────────────────┐
 *   │ RfidRelayHub (Durable Obj) │  ← Single global instance
 *   │ hosts: Set<WebSocket>      │     shared across ALL edge locations
 *   │ nodes: Set<WebSocket>      │
 *   └────────────────────────────┘
 *        │ broadcasts to all
 *        ▼
 *   Browser / CLI / App
 *        WebSocket /node?auth=xxx
 *
 * - /host : NodeMCU connects here (WebSocket or HTTP POST)
 * - /node : Any device connects here to receive live RFID scans
 * - /     : Static HTML dashboard from public/index.html
 *
 * Zero persistence. If no nodes connected → card key is dropped.
 */

// ═══════════════════════════════════════════════════════════════════
// Durable Object: Global Singleton Hub for WebSocket state
// ═══════════════════════════════════════════════════════════════════
export class RfidRelayHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.hosts = new Set();   // WebSockets from ESP8266 NodeMCU
    this.nodes = new Set();   // WebSockets from browsers / apps
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const password = (this.env && this.env.AUTH_PASSWORD) || '00000000';

    // ── CORS preflight ──────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    // ── Auth check ──────────────────────────────────────────────
    if (!this._isAuthed(request, password)) {
      return corsJson({ error: 'Unauthorized' }, 401);
    }

    // ── /host endpoint ──────────────────────────────────────────
    if (pathname === '/host') {
      return this._handleHost(request);
    }

    // ── /node endpoint ──────────────────────────────────────────
    if (pathname === '/node') {
      return this._handleNode(request);
    }

    // ── /health ─────────────────────────────────────────────────
    if (pathname === '/health' || pathname === '/status') {
      return corsJson({
        status: 'online',
        hosts: this.hosts.size,
        nodes: this.nodes.size,
        ts: new Date().toISOString()
      });
    }

    return corsJson({ error: 'Not found' }, 404);
  }

  // ────── HOST logic ────────────────────────────────────────────
  async _handleHost(request) {
    const upgrade = request.headers.get('Upgrade');

    // WebSocket from NodeMCU
    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.hosts.add(server);

      safeSend(server, { type: 'welcome', role: 'host', nodes: this.nodes.size });

      server.addEventListener('message', (evt) => {
        let payload;
        try { payload = JSON.parse(evt.data); } catch { payload = { uid: String(evt.data).trim() }; }

        if (payload.type === 'ping') {
          safeSend(server, { type: 'pong', time: Date.now() });
          return;
        }

        const uid = payload.uid || payload.rfid || payload.tag;
        if (!uid) return;

        if (this.nodes.size === 0) {
          safeSend(server, { type: 'ack', status: 'dropped', uid });
          return;
        }

        this._broadcast(uid);
        safeSend(server, { type: 'ack', status: 'routed', nodes: this.nodes.size, uid });
      });

      server.addEventListener('close', () => this.hosts.delete(server));
      server.addEventListener('error', () => this.hosts.delete(server));

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP POST fallback
    if (request.method === 'POST') {
      const body = await request.text();
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { uid: body.trim() }; }
      const uid = payload.uid || payload.rfid || payload.tag;
      if (!uid) return corsJson({ error: 'Missing uid' }, 400);

      const routed = this._broadcast(uid);
      return corsJson({ success: true, action: routed > 0 ? 'routed' : 'dropped', nodes: routed, uid });
    }

    return corsJson({
      endpoint: '/host',
      message: 'Connect via WebSocket or send HTTP POST with {"uid":"..."}',
      nodes: this.nodes.size
    });
  }

  // ────── NODE logic ────────────────────────────────────────────
  async _handleNode(request) {
    const upgrade = request.headers.get('Upgrade');

    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.nodes.add(server);

      safeSend(server, {
        type: 'welcome',
        role: 'node',
        message: 'Connected as live listening node (0 latency)',
        hostsActive: this.hosts.size
      });

      // Notify hosts about new node count
      for (const h of this.hosts) {
        safeSend(h, { type: 'nodes_updated', count: this.nodes.size });
      }

      // 2-way: node can send commands back to hosts
      server.addEventListener('message', (evt) => {
        for (const h of this.hosts) {
          safeSend(h, { type: 'node_message', data: evt.data });
        }
      });

      server.addEventListener('close', () => {
        this.nodes.delete(server);
        for (const h of this.hosts) {
          safeSend(h, { type: 'nodes_updated', count: this.nodes.size });
        }
      });

      server.addEventListener('error', () => this.nodes.delete(server));

      return new Response(null, { status: 101, webSocket: client });
    }

    return corsJson({
      endpoint: '/node',
      message: 'Connect via WebSocket to receive live RFID scans',
      hosts: this.hosts.size,
      nodes: this.nodes.size
    });
  }

  // ────── Broadcast RFID scan to all nodes ──────────────────────
  _broadcast(uid) {
    const msg = JSON.stringify({ type: 'rfid', uid, timestamp: Date.now() });
    let count = 0;
    for (const node of this.nodes) {
      try { node.send(msg); count++; }
      catch { this.nodes.delete(node); }
    }
    return count;
  }

  // ────── Auth helper ───────────────────────────────────────────
  _isAuthed(request, pw) {
    const url = new URL(request.url);
    if (url.searchParams.get('auth') === pw) return true;
    const h = request.headers.get('x-auth-token') || request.headers.get('x-auth-password');
    if (h === pw) return true;
    const a = request.headers.get('authorization');
    if (a === pw || a === `Bearer ${pw}`) return true;
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main Worker entrypoint — routes to Durable Object or static assets
// ═══════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // Dynamic endpoints go to the single global Durable Object
    if (p === '/host' || p === '/node' || p === '/health' || p === '/status') {
      const id = env.RELAY_HUB.idFromName('global');
      const hub = env.RELAY_HUB.get(id);
      return hub.fetch(request);
    }

    // Everything else → static assets (public/index.html)
    return env.ASSETS.fetch(request);
  }
};

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════
function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-auth-token'
    }
  });
}

function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-auth-token'
    }
  });
}
