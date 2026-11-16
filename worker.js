/**
 * Cloudflare Worker: RFID RC522 Live Relay Hub with Durable Objects
 * 
 * Uses a Global Singleton Durable Object so that all connections to /host
 * (ESP8266 NodeMCU) and /node (browsers, listening apps) share the EXACT SAME
 * in-memory state across all Cloudflare edge data centers.
 */

export class RfidRelayHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.hosts = new Set();
    this.nodes = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const expectedPassword = (this.env && this.env.AUTH_PASSWORD) || '00000000';

    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-auth-token'
        }
      });
    }

    // Auth validation
    const queryAuth = url.searchParams.get('auth');
    const headerAuth = request.headers.get('x-auth-token') || request.headers.get('x-auth-password');
    const authHeader = request.headers.get('authorization');
    const isAuthed = (queryAuth === expectedPassword) ||
                     (headerAuth === expectedPassword) ||
                     (authHeader === expectedPassword || authHeader === `Bearer ${expectedPassword}`);

    if (!isAuthed) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid auth password' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // =========================================================================
    // /host ENDPOINT (ESP8266 NodeMCU RFID Reader)
    // =========================================================================
    if (pathname === '/host') {
      const upgradeHeader = request.headers.get('Upgrade');

      // 1. WebSocket Upgrade from NodeMCU
      if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();
        this.hosts.add(server);

        try {
          server.send(JSON.stringify({
            type: 'welcome',
            role: 'host',
            connectedNodes: this.nodes.size
          }));
        } catch (e) {}

        server.addEventListener('message', (event) => {
          try {
            let payload;
            try { payload = JSON.parse(event.data); } catch { payload = { uid: String(event.data).trim() }; }

            if (payload.type === 'ping') {
              server.send(JSON.stringify({ type: 'pong', time: Date.now() }));
              return;
            }

            const uid = payload.uid || payload.rfid || payload.tag;
            if (uid) {
              // Zero storage: if no nodes connected, drop immediately
              if (this.nodes.size === 0) {
                server.send(JSON.stringify({ type: 'ack', status: 'dropped', reason: 'no_nodes_connected', uid }));
                return;
              }

              // Broadcast live to all connected nodes
              const msg = JSON.stringify({
                type: 'rfid',
                uid,
                timestamp: Date.now()
              });

              for (const node of this.nodes) {
                try {
                  node.send(msg);
                } catch (e) {
                  this.nodes.delete(node);
                }
              }

              server.send(JSON.stringify({
                type: 'ack',
                status: 'routed',
                nodes: this.nodes.size,
                uid
              }));
            }
          } catch (err) {
            console.error('Host error:', err);
          }
        });

        server.addEventListener('close', () => { this.hosts.delete(server); });
        server.addEventListener('error', () => { this.hosts.delete(server); });

        return new Response(null, { status: 101, webSocket: client });
      }

      // 2. HTTP POST from NodeMCU
      if (request.method === 'POST') {
        const bodyText = await request.text();
        let payload;
        try { payload = JSON.parse(bodyText); } catch { payload = { uid: bodyText.trim() }; }
        const uid = payload.uid || payload.rfid || payload.tag;

        let routedCount = 0;
        if (this.nodes.size > 0 && uid) {
          const msg = JSON.stringify({ type: 'rfid', uid, timestamp: Date.now() });
          for (const node of this.nodes) {
            try {
              node.send(msg);
              routedCount++;
            } catch (e) {
              this.nodes.delete(node);
            }
          }
        }

        return new Response(JSON.stringify({
          success: true,
          action: routedCount > 0 ? 'routed' : 'dropped',
          connectedNodes: routedCount,
          uid: uid,
          timestamp: new Date().toISOString()
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // 3. HTTP GET status
      return new Response(JSON.stringify({
        endpoint: '/host',
        status: 'authorized',
        connectedNodes: this.nodes.size,
        activeHosts: this.hosts.size
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // =========================================================================
    // /node ENDPOINT (Listening Applications / Web Dashboard)
    // =========================================================================
    if (pathname === '/node') {
      const upgradeHeader = request.headers.get('Upgrade');

      // 1. WebSocket Upgrade from Node
      if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();
        this.nodes.add(server);

        try {
          server.send(JSON.stringify({
            type: 'welcome',
            role: 'node',
            message: 'Connected as live listening node (0 latency)',
            hostsActive: this.hosts.size
          }));
        } catch (e) {}

        // Notify hosts of updated node count
        const updateMsg = JSON.stringify({ type: 'nodes_updated', count: this.nodes.size });
        for (const host of this.hosts) {
          try { host.send(updateMsg); } catch (e) { this.hosts.delete(host); }
        }

        // 2-Way communication: Node sends command back to hosts
        server.addEventListener('message', (event) => {
          const data = event.data;
          for (const host of this.hosts) {
            try {
              host.send(JSON.stringify({ type: 'node_message', data }));
            } catch (e) {
              this.hosts.delete(host);
            }
          }
        });

        server.addEventListener('close', () => {
          this.nodes.delete(server);
        });

        server.addEventListener('error', () => {
          this.nodes.delete(server);
        });

        return new Response(null, { status: 101, webSocket: client });
      }

      // 2. HTTP GET status
      return new Response(JSON.stringify({
        endpoint: '/node',
        status: 'authorized',
        hostsActive: this.hosts.size,
        nodesActive: this.nodes.size
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Route /host, /node, /health to the Global Singleton Durable Object
    if (pathname === '/host' || pathname === '/node' || pathname === '/health') {
      if (env.RELAY_HUB) {
        const id = env.RELAY_HUB.idFromName("global_rfid_hub");
        return env.RELAY_HUB.get(id).fetch(request);
      }
    }

    // Static assets fallback (public/index.html)
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
