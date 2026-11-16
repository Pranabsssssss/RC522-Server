/**
 * RFID RC522 Live Relay Hub — Cloudflare Worker + Durable Object
 *
 * Full JSON API + WebSocket Hibernation:
 *
 * JSON APIs:
 * - POST /host?auth=xxx   : Host (NodeMCU/app) sends scanned RFID UID as JSON: {"uid": "..."}
 *                           Returns JSON: {"success": true, "action": "routed"|"dropped", "nodes": N}
 * - GET  /host?auth=xxx   : Host status JSON: {"endpoint": "/host", "activeNodes": N, ...}
 * - GET  /node?auth=xxx   : Without wait: returns node status JSON.
 * - GET  /node?auth=xxx&wait=true : LONG-POLLING API. Waits for next card scan, returns JSON immediately:
 *                           {"success": true, "type": "rfid", "uid": "...", "timestamp": N}
 * - GET  /node?auth=xxx&stream=true : SSE Stream returning real-time JSON events.
 * - POST /node?auth=xxx   : Node sends command JSON back to hosts: {"command": "beep"}
 * - GET  /health          : Health check JSON
 *
 * WebSockets:
 * - WSS /host?auth=xxx    : Real-time 2-way WebSocket for NodeMCU
 * - WSS /node?auth=xxx    : Real-time 2-way WebSocket for listening apps / web dashboard
 */

export class RfidRelayHub {
  constructor(state, env) {
    this.ctx = state;
    this.state = state;
    this.env = env;
    // In-memory sets
    this.hosts = new Set();
    this.nodes = new Set();
    this.waitingHttpNodes = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const password = (this.env && this.env.AUTH_PASSWORD) || '00000000';

    // ── CORS preflight ──────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    // ── Auth verification ───────────────────────────────────────
    if (!this._isAuthed(request, password)) {
      return corsJson({ error: 'Unauthorized: Invalid auth password' }, 401);
    }

    // ── /health ─────────────────────────────────────────────────
    if (pathname === '/health' || pathname === '/status') {
      const activeNodesCount = this._getNodeCount();
      const activeHostsCount = this._getHostCount();
      return corsJson({
        status: 'online',
        service: 'RFID RC522 Relay Hub (JSON API + WebSockets)',
        activeHosts: activeHostsCount,
        activeNodes: activeNodesCount,
        timestamp: new Date().toISOString()
      });
    }

    // ── /host ENDPOINT ──────────────────────────────────────────
    if (pathname === '/host') {
      return this._handleHost(request);
    }

    // ── /node ENDPOINT ──────────────────────────────────────────
    if (pathname === '/node') {
      return this._handleNode(request);
    }

    return corsJson({ error: 'Endpoint not found' }, 404);
  }

  // ═══════════════════════════════════════════════════════════════
  // HOST HANDLER (/host)
  // ═══════════════════════════════════════════════════════════════
  async _handleHost(request) {
    const upgrade = request.headers.get('Upgrade');

    // 1. WebSocket from NodeMCU
    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      // Use Cloudflare Hibernation API if available, fallback to manual accept
      if (this.ctx && typeof this.ctx.acceptWebSocket === 'function') {
        this.ctx.acceptWebSocket(server, ['host']);
      } else {
        server.accept();
        this.hosts.add(server);
      }

      this._safeSend(server, {
        type: 'welcome',
        role: 'host',
        connectedNodes: this._getNodeCount()
      });

      // Event listener for manual mode
      server.addEventListener('message', (evt) => {
        this.webSocketMessage(server, evt.data);
      });
      server.addEventListener('close', () => {
        this.hosts.delete(server);
      });
      server.addEventListener('error', () => {
        this.hosts.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. HTTP POST from NodeMCU (JSON API)
    if (request.method === 'POST') {
      try {
        const bodyText = await request.text();
        let payload;
        try {
          payload = JSON.parse(bodyText);
        } catch {
          payload = { uid: bodyText.trim() };
        }

        const uid = payload.uid || payload.rfid || payload.tag;
        if (!uid) {
          return corsJson({ error: 'Missing RFID UID in JSON payload' }, 400);
        }

        const routedCount = this._broadcastRfidScan(uid, payload);
        return corsJson({
          success: true,
          action: routedCount > 0 ? 'routed' : 'dropped',
          reason: routedCount > 0 ? undefined : 'no_nodes_connected',
          connectedNodes: routedCount,
          uid: uid,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        return corsJson({ error: err.message }, 500);
      }
    }

    // 3. HTTP GET: Return JSON status
    return corsJson({
      endpoint: '/host',
      status: 'ready',
      message: 'Send RFID scans via HTTP POST with JSON body {"uid": "..."} or connect via WebSocket',
      connectedNodes: this._getNodeCount(),
      activeHosts: this._getHostCount()
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // NODE HANDLER (/node)
  // ═══════════════════════════════════════════════════════════════
  async _handleNode(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    // 1. WebSocket from Listening Node (Browser or CLI)
    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      if (this.ctx && typeof this.ctx.acceptWebSocket === 'function') {
        this.ctx.acceptWebSocket(server, ['node']);
      } else {
        server.accept();
        this.nodes.add(server);
      }

      this._safeSend(server, {
        type: 'welcome',
        role: 'node',
        message: 'Connected as live listening node (0 latency)',
        hostsActive: this._getHostCount()
      });

      server.addEventListener('message', (evt) => {
        this.webSocketMessage(server, evt.data);
      });
      server.addEventListener('close', () => {
        this.nodes.delete(server);
      });
      server.addEventListener('error', () => {
        this.nodes.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. HTTP POST from Node back to Hosts (2-Way Command JSON API)
    if (request.method === 'POST') {
      try {
        const bodyText = await request.text();
        let payload;
        try {
          payload = JSON.parse(bodyText);
        } catch {
          payload = { command: bodyText.trim() };
        }

        const forwardedCount = this._forwardToHosts(payload);
        return corsJson({
          success: true,
          action: 'forwarded_to_hosts',
          hostsCount: forwardedCount,
          data: payload,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        return corsJson({ error: err.message }, 500);
      }
    }

    // 3. HTTP GET with wait=true / poll=true (LONG-POLLING JSON API)
    // Client simply requests this, and the connection holds until a card is scanned!
    if (url.searchParams.get('wait') === 'true' || url.searchParams.get('poll') === 'true') {
      return new Promise((resolve) => {
        const entry = { resolve, timeoutId: null };
        this.waitingHttpNodes.add(entry);

        // 25s timeout to prevent proxy drop, client can re-request
        entry.timeoutId = setTimeout(() => {
          this.waitingHttpNodes.delete(entry);
          resolve(corsJson({
            status: 'timeout',
            message: 'No card scanned within timeout window. Re-poll to continue listening.',
            timestamp: Date.now()
          }));
        }, 25000);
      });
    }

    // 4. HTTP GET with stream=true (Server-Sent Events JSON Stream)
    if (url.searchParams.get('stream') === 'true' || request.headers.get('Accept') === 'text/event-stream') {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      const sseNode = {
        send: (text) => {
          try {
            writer.write(encoder.encode(`data: ${text}\n\n`));
          } catch {
            this.nodes.delete(sseNode);
          }
        }
      };

      this.nodes.add(sseNode);
      sseNode.send(JSON.stringify({ type: 'welcome', role: 'node_sse', message: 'Connected via Live Stream' }));

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 5. Plain HTTP GET: Return JSON status & usage
    return corsJson({
      endpoint: '/node',
      status: 'ready',
      activeHosts: this._getHostCount(),
      activeNodes: this._getNodeCount(),
      usage: {
        longPolling: 'GET /node?auth=xxx&wait=true (Returns JSON as soon as a card is scanned)',
        webSocket: 'WSS /node?auth=xxx (Persistent 0-latency stream)',
        sendCommand: 'POST /node?auth=xxx with JSON {"command":"beep"}'
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CLOUDFLARE WEBSOCKET HIBERNATION HANDLERS
  // ═══════════════════════════════════════════════════════════════
  webSocketMessage(ws, message) {
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { text: text };
      }

      // Heartbeat ping
      if (payload.type === 'ping') {
        this._safeSend(ws, { type: 'pong', time: Date.now() });
        return;
      }

      // Check if message is RFID scan from host
      const uid = payload.uid || payload.rfid || payload.tag;
      if (uid) {
        const routed = this._broadcastRfidScan(uid, payload);
        this._safeSend(ws, {
          type: 'ack',
          status: routed > 0 ? 'routed' : 'dropped',
          reason: routed > 0 ? undefined : 'no_nodes_connected',
          nodes: routed,
          uid: uid
        });
        return;
      }

      // Check if message is command from node
      this._forwardToHosts(payload);
    } catch (err) {
      console.error('WS Message error:', err);
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    this.hosts.delete(ws);
    this.nodes.delete(ws);
  }

  webSocketError(ws, error) {
    this.hosts.delete(ws);
    this.nodes.delete(ws);
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTING & BROADCASTING (0-Latency & Zero-Storage)
  // ═══════════════════════════════════════════════════════════════
  _broadcastRfidScan(uid, extra = {}) {
    const timestamp = Date.now();
    const scanJson = {
      type: 'rfid',
      uid: uid,
      timestamp: timestamp,
      timeISO: new Date(timestamp).toISOString(),
      extra: extra
    };
    const scanStr = JSON.stringify(scanJson);

    let deliveredCount = 0;

    // 1. Deliver to HTTP Long-Polling waiting nodes
    for (const entry of this.waitingHttpNodes) {
      try {
        clearTimeout(entry.timeoutId);
        entry.resolve(corsJson(scanJson));
        deliveredCount++;
      } catch {}
    }
    this.waitingHttpNodes.clear();

    // 2. Deliver to WebSockets via Hibernation API
    if (this.ctx && typeof this.ctx.getWebSockets === 'function') {
      const activeWebSockets = this.ctx.getWebSockets('node');
      for (const ws of activeWebSockets) {
        try {
          ws.send(scanStr);
          deliveredCount++;
        } catch {}
      }
    }

    // 3. Deliver to manual WebSockets / SSE
    for (const node of this.nodes) {
      try {
        node.send(scanStr);
        deliveredCount++;
      } catch {
        this.nodes.delete(node);
      }
    }

    return deliveredCount;
  }

  _forwardToHosts(data) {
    const msgStr = JSON.stringify({
      type: 'node_message',
      data: data,
      timestamp: Date.now()
    });

    let count = 0;
    if (this.ctx && typeof this.ctx.getWebSockets === 'function') {
      for (const host of this.ctx.getWebSockets('host')) {
        try { host.send(msgStr); count++; } catch {}
      }
    }
    for (const host of this.hosts) {
      try { host.send(msgStr); count++; } catch { this.hosts.delete(host); }
    }
    return count;
  }

  _getNodeCount() {
    let count = this.nodes.size + this.waitingHttpNodes.size;
    if (this.ctx && typeof this.ctx.getWebSockets === 'function') {
      count += this.ctx.getWebSockets('node').length;
    }
    return count;
  }

  _getHostCount() {
    let count = this.hosts.size;
    if (this.ctx && typeof this.ctx.getWebSockets === 'function') {
      count += this.ctx.getWebSockets('host').length;
    }
    return count;
  }

  _safeSend(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  _isAuthed(request, expectedPassword) {
    const url = new URL(request.url);
    const queryAuth = url.searchParams.get('auth');
    if (queryAuth === expectedPassword) return true;

    const headerAuth = request.headers.get('x-auth-token') || request.headers.get('x-auth-password');
    if (headerAuth === expectedPassword) return true;

    const authHeader = request.headers.get('authorization');
    if (authHeader) {
      if (authHeader === expectedPassword || authHeader === `Bearer ${expectedPassword}`) return true;
    }

    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// CLOUDFLARE WORKER ROUTER
// ═══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // Route /host, /node, /health, /status directly to the Global Durable Object
    if (p === '/host' || p === '/node' || p === '/health' || p === '/status') {
      if (env.RELAY_HUB) {
        const id = env.RELAY_HUB.idFromName('global_rfid_hub');
        const hub = env.RELAY_HUB.get(id);
        return hub.fetch(request);
      }
    }

    // Static assets fallback (public/index.html)
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return corsJson({ error: 'Not Found' }, 404);
  }
};

function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-auth-token, x-auth-password'
    }
  });
}

function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-auth-token, x-auth-password'
    }
  });
}
