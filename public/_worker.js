/**
 * Cloudflare Pages Advanced Mode Universal Worker (_worker.js)
 * 
 * Handles all routing for rfid.pranab.space:
 * - /host   : WebSocket & HTTP POST for ESP8266 NodeMCU RC522 reader
 * - /node   : WebSocket & SSE live stream for listening nodes/apps
 * - /health : Health check
 * - /       : Passes through to static public/index.html
 */

globalThis.rfidNodes = globalThis.rfidNodes || new Set();
globalThis.rfidHosts = globalThis.rfidHosts || new Set();

function checkAuth(request, env) {
  const expectedPassword = (env && env.AUTH_PASSWORD) || '00000000';
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle CORS Preflight
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

    // Health check endpoint
    if (pathname === '/health' || pathname === '/status') {
      return new Response(JSON.stringify({
        status: 'online',
        service: 'RFID RC522 Relay Hub',
        connectedNodes: globalThis.rfidNodes.size,
        connectedHosts: globalThis.rfidHosts.size,
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // =========================================================================
    // /host ENDPOINT (NodeMCU ESP8266 RFID Reader)
    // =========================================================================
    if (pathname === '/host') {
      // Validate Authorization
      if (!checkAuth(request, env)) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: 'Invalid or missing auth password in ?auth= parameter or headers'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const upgradeHeader = request.headers.get('Upgrade');

      // 1. WebSocket Upgrade from NodeMCU
      if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        try {
          const { 0: client, 1: server } = new WebSocketPair();
          server.accept();
          globalThis.rfidHosts.add(server);

          try {
            server.send(JSON.stringify({
              type: 'welcome',
              role: 'host',
              connectedNodes: globalThis.rfidNodes.size
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
                // Drop immediately if no nodes connected (zero persistence)
                if (globalThis.rfidNodes.size === 0) {
                  server.send(JSON.stringify({ type: 'ack', status: 'dropped', reason: 'no_nodes_connected', uid }));
                  return;
                }

                // Broadcast live to all connected nodes
                const msg = JSON.stringify({
                  type: 'rfid',
                  uid,
                  timestamp: Date.now()
                });

                for (const node of globalThis.rfidNodes) {
                  try {
                    node.send(msg);
                  } catch (e) {
                    globalThis.rfidNodes.delete(node);
                  }
                }

                server.send(JSON.stringify({
                  type: 'ack',
                  status: 'routed',
                  nodes: globalThis.rfidNodes.size,
                  uid
                }));
              }
            } catch (err) {
              console.error('Host msg err:', err);
            }
          });

          server.addEventListener('close', () => {
            globalThis.rfidHosts.delete(server);
          });

          return new Response(null, {
            status: 101,
            webSocket: client
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
      }

      // 2. HTTP POST scan from NodeMCU or testing tools
      if (request.method === 'POST') {
        try {
          const bodyText = await request.text();
          let payload;
          try { payload = JSON.parse(bodyText); } catch { payload = { uid: bodyText.trim() }; }

          const uid = payload.uid || payload.rfid || payload.tag;
          if (!uid) {
            return new Response(JSON.stringify({ error: 'Missing UID in request body' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }

          let routedCount = 0;
          if (globalThis.rfidNodes.size > 0) {
            const msg = JSON.stringify({
              type: 'rfid',
              uid,
              timestamp: Date.now()
            });

            for (const node of globalThis.rfidNodes) {
              try {
                node.send(msg);
                routedCount++;
              } catch (e) {
                globalThis.rfidNodes.delete(node);
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
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      // 3. HTTP GET in browser: Return friendly status instead of 404
      return new Response(JSON.stringify({
        endpoint: '/host',
        status: 'authorized',
        message: 'RFID Host endpoint is active and listening for NodeMCU connections.',
        connectedNodes: globalThis.rfidNodes.size,
        usage: {
          websocket: 'ws(s)://rfid.pranab.space/host?auth=<password>',
          httpPost: 'POST /host?auth=<password> with JSON body {"uid": "YOUR_TAG_UID"}'
        }
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // =========================================================================
    // /node ENDPOINT (Listening Applications / Web Dashboard)
    // =========================================================================
    if (pathname === '/node') {
      // Validate Authorization
      if (!checkAuth(request, env)) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: 'Invalid or missing auth password in ?auth= parameter or headers'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const upgradeHeader = request.headers.get('Upgrade');

      // 1. WebSocket Upgrade from Node listener
      if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        try {
          const { 0: client, 1: server } = new WebSocketPair();
          server.accept();
          globalThis.rfidNodes.add(server);

          try {
            server.send(JSON.stringify({
              type: 'welcome',
              role: 'node',
              message: 'Connected as live listening node (0 latency)',
              hostsActive: globalThis.rfidHosts.size
            }));
          } catch (e) {}

          // 2-way message from node back to hosts
          server.addEventListener('message', (event) => {
            try {
              const data = event.data;
              for (const hostSocket of globalThis.rfidHosts) {
                try {
                  hostSocket.send(JSON.stringify({ type: 'node_message', data: data }));
                } catch (e) {
                  globalThis.rfidHosts.delete(hostSocket);
                }
              }
            } catch (err) {}
          });

          server.addEventListener('close', () => {
            globalThis.rfidNodes.delete(server);
          });

          return new Response(null, {
            status: 101,
            webSocket: client
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
      }

      // 2. Server-Sent Events (SSE) Stream
      if (url.searchParams.get('stream') === 'true' || request.headers.get('Accept') === 'text/event-stream') {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sseListener = {
          send: (str) => {
            try {
              writer.write(encoder.encode(`data: ${str}\n\n`));
            } catch (e) {
              globalThis.rfidNodes.delete(sseListener);
            }
          }
        };

        globalThis.rfidNodes.add(sseListener);
        writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'welcome', role: 'node-sse', message: 'Connected via Live Stream' })}\n\n`));

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // 3. HTTP GET: Return friendly node status
      return new Response(JSON.stringify({
        endpoint: '/node',
        status: 'authorized',
        message: 'Connect via WebSocket or ?stream=true to stream RFID scans live.',
        activeHosts: globalThis.rfidHosts.size,
        activeNodes: globalThis.rfidNodes.size
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // =========================================================================
    // Static assets fallback (public/index.html, CSS, JS, etc.)
    // =========================================================================
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
