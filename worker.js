/**
 * RFID RC522 Live Relay Hub — Cloudflare Worker + Durable Object
 *
 * Full JSON API + WebSocket Hibernation + 20-Char RFID Key Encryption:
 *
 * Security & Validation:
 * - Only valid RFID keys/UIDs are allowed to be transferred.
 * - Server encrypts each RFID key into a 20-character discriminant string using AUTH_PASSWORD from .env.
 * - Deterministic: same card always produces the same unique 20-character key discriminant.
 * - NodeMCU scans the full hardware UID, and server performs the encryption before routing to nodes.
 *
 * JSON APIs:
 * - POST /host?auth=xxx   : Host sends raw RFID UID as JSON: {"uid": "DB:23:03:07"}
 *                           Server validates, encrypts into 20-char key, routes to nodes.
 * - GET  /host?auth=xxx   : Host status JSON.
 * - GET  /node?auth=xxx&wait=true : Live Long-Polling JSON API. Waits for next card scan, returns JSON immediately.
 * - GET  /node?auth=xxx&stream=true : SSE Stream returning real-time JSON events.
 * - POST /node?auth=xxx   : Node sends command JSON back to hosts.
 * - WSS  /host & WSS /node : Real-time 2-way WebSockets with keepalive.
 */

/**
 * Validate that input string is strictly a valid RFID key/UID format:
 * - 4-byte UID (e.g. "DB:23:03:07" or "DB230307")
 * - 7-byte UID (e.g. "04:12:34:56:78:9A:BC" or "04123456789ABC")
 * - 10-byte UID (e.g. "04:12:34:56:78:9A:BC:DE:F0:12")
 */
function isValidRfidKey(str) {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  // Formatted hex with colons/dashes: 4 to 10 bytes
  if (/^([0-9A-Fa-f]{2}[:-]){3,9}[0-9A-Fa-f]{2}$/.test(trimmed)) return true;
  // Contiguous hex string: 8 to 20 hex characters, even length
  if (/^[0-9A-Fa-f]{8,20}$/.test(trimmed) && trimmed.length % 2 === 0) return true;
  return false;
}

/**
 * Encrypt each RFID key into a 20-character string discriminant using AUTH_PASSWORD from .env
 * Uses HMAC-SHA256 keyed hash for deterministic, secure 20-character pseudonymization.
 */
async function encryptRfidKey(rawUid, password) {
  const cleanUid = rawUid.toUpperCase().trim();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(cleanUid));
  const hex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.substring(0, 20).toUpperCase();
}

export class RfidRelayHub {
  constructor(state, env) {
    this.ctx = state;
    this.state = state;
    this.env = env;
    this.hosts = new Set();
    this.nodes = new Set();
    this.waitingHttpNodes = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const password = (this.env && this.env.AUTH_PASSWORD) || '00000000';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    // Auth verification
    if (!this._isAuthed(request, password)) {
      return corsJson({ error: 'Unauthorized: Invalid auth password' }, 401);
    }

    // /health
    if (pathname === '/health' || pathname === '/status') {
      return corsJson({
        status: 'online',
        service: 'RFID RC522 Relay Hub (Encrypted 20-Char Keys)',
        activeHosts: this._getHostCount(),
        activeNodes: this._getNodeCount(),
        timestamp: new Date().toISOString()
      });
    }

    // /host
    if (pathname === '/host') {
      return this._handleHost(request, password);
    }

    // /node
    if (pathname === '/node') {
      return this._handleNode(request);
    }

    return corsJson({ error: 'Endpoint not found' }, 404);
  }

  // ═══════════════════════════════════════════════════════════════
  // HOST HANDLER (/host)
  // ═══════════════════════════════════════════════════════════════
  async _handleHost(request, password) {
    const upgrade = request.headers.get('Upgrade');

    // 1. WebSocket Upgrade from NodeMCU
    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

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

      server.addEventListener('message', async (evt) => {
        await this.webSocketMessage(server, evt.data, password);
      });
      server.addEventListener('close', () => { this.hosts.delete(server); });
      server.addEventListener('error', () => { this.hosts.delete(server); });

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

        const rawUid = payload.uid || payload.rfid || payload.tag;
        if (!rawUid) {
          return corsJson({ error: 'Missing RFID key in JSON payload' }, 400);
        }

        // Validate strictly: only allow valid RFID keys
        if (!isValidRfidKey(rawUid)) {
          return corsJson({
            error: 'Invalid RFID key format. Only valid RFID keys are allowed to be transferred.'
          }, 400);
        }

        // Encrypt RFID key into 20-character discriminant
        const encryptedKey = await encryptRfidKey(rawUid, password);

        const routedCount = this._broadcastRfidScan(rawUid, encryptedKey, payload);
        return corsJson({
          success: true,
          action: routedCount > 0 ? 'routed' : 'dropped',
          reason: routedCount > 0 ? undefined : 'no_nodes_connected',
          connectedNodes: routedCount,
          rawUid: rawUid,
          encryptedKey: encryptedKey,
          discriminant: encryptedKey,
          length: encryptedKey.length,
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
      message: 'Send full RFID key via HTTP POST {"uid":"..."}. Server encrypts to 20-char discriminant.',
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

    // 1. WebSocket Upgrade from Node listener
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

      server.addEventListener('message', async (evt) => {
        await this.webSocketMessage(server, evt.data, (this.env && this.env.AUTH_PASSWORD) || '00000000');
      });
      server.addEventListener('close', () => { this.nodes.delete(server); });
      server.addEventListener('error', () => { this.nodes.delete(server); });

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
    if (url.searchParams.get('wait') === 'true' || url.searchParams.get('poll') === 'true') {
      return new Promise((resolve) => {
        const entry = { resolve, timeoutId: null };
        this.waitingHttpNodes.add(entry);

        entry.timeoutId = setTimeout(() => {
          this.waitingHttpNodes.delete(entry);
          resolve(corsJson({
            status: 'timeout',
            message: 'No card scanned within window. Re-poll to continue listening.',
            timestamp: Date.now()
          }));
        }, 25000);
      });
    }

    // 4. HTTP GET with stream=true (SSE JSON Stream)
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

    // 5. Plain HTTP GET status
    return corsJson({
      endpoint: '/node',
      status: 'ready',
      activeHosts: this._getHostCount(),
      activeNodes: this._getNodeCount(),
      usage: {
        longPolling: 'GET /node?auth=xxx&wait=true',
        webSocket: 'WSS /node?auth=xxx',
        postCommand: 'POST /node?auth=xxx'
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // WEBSOCKET MESSAGE HANDLER
  // ═══════════════════════════════════════════════════════════════
  async webSocketMessage(ws, message, password) {
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { text: text };
      }

      if (payload.type === 'ping') {
        this._safeSend(ws, { type: 'pong', time: Date.now() });
        return;
      }

      const rawUid = payload.uid || payload.rfid || payload.tag;
      if (rawUid) {
        // Validate strictly: only allow valid RFID keys
        if (!isValidRfidKey(rawUid)) {
          this._safeSend(ws, { type: 'error', message: 'Rejected: Only valid RFID keys are allowed.' });
          return;
        }

        const encryptedKey = await encryptRfidKey(rawUid, password);
        const routed = this._broadcastRfidScan(rawUid, encryptedKey, payload);

        this._safeSend(ws, {
          type: 'ack',
          status: routed > 0 ? 'routed' : 'dropped',
          reason: routed > 0 ? undefined : 'no_nodes_connected',
          nodes: routed,
          rawUid: rawUid,
          encryptedKey: encryptedKey
        });
        return;
      }

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
  // BROADCASTING ENCRYPTED 20-CHAR RFID KEYS TO ALL NODES
  // ═══════════════════════════════════════════════════════════════
  _broadcastRfidScan(rawUid, encryptedKey, extra = {}) {
    const timestamp = Date.now();
    const scanJson = {
      type: 'rfid',
      discriminant: encryptedKey,
      encryptedKey: encryptedKey,
      uid: encryptedKey, // Primary 20-char encrypted key discriminant
      rawUid: rawUid,    // Full scanned hardware RFID key
      length: encryptedKey.length,
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
      for (const ws of this.ctx.getWebSockets('node')) {
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

    if (p === '/host' || p === '/node' || p === '/health' || p === '/status') {
      if (env.RELAY_HUB) {
        const id = env.RELAY_HUB.idFromName('global_rfid_hub');
        const hub = env.RELAY_HUB.get(id);
        return hub.fetch(request);
      }
    }

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
