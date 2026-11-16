/**
 * Cloudflare Pages Function: /host
 * Handles NodeMCU / Host connections via WebSocket or HTTP POST
 */

// In-isolate WebSocket registries
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

export async function onRequest(context) {
  const { request, env } = context;

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

  // Auth Verification
  if (!checkAuth(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Invalid auth password' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Check if WebSocket upgrade
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    globalThis.rfidHosts.add(server);

    server.send(JSON.stringify({
      type: 'welcome',
      role: 'host',
      nodes: globalThis.rfidNodes.size
    }));

    server.addEventListener('message', (event) => {
      try {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          payload = { uid: String(event.data).trim() };
        }

        const uid = payload.uid || payload.rfid || payload.tag;
        if (uid) {
          // If no nodes, drop key immediately
          if (globalThis.rfidNodes.size === 0) {
            server.send(JSON.stringify({ type: 'ack', status: 'dropped', uid }));
            return;
          }

          // Broadcast to connected nodes
          const msg = JSON.stringify({
            type: 'rfid',
            uid,
            timestamp: Date.now()
          });

          for (const nodeSocket of globalThis.rfidNodes) {
            try {
              nodeSocket.send(msg);
            } catch (e) {
              globalThis.rfidNodes.delete(nodeSocket);
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
        console.error('Host msg error:', err);
      }
    });

    server.addEventListener('close', () => {
      globalThis.rfidHosts.delete(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  // Handle HTTP POST
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
        return new Response(JSON.stringify({ error: 'Missing UID' }), {
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
        for (const nodeSocket of globalThis.rfidNodes) {
          try {
            nodeSocket.send(msg);
            routedCount++;
          } catch (e) {
            globalThis.rfidNodes.delete(nodeSocket);
          }
        }
      }

      return new Response(JSON.stringify({
        success: true,
        action: routedCount > 0 ? 'routed' : 'dropped',
        connectedNodes: routedCount
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

  return new Response('Method not allowed or expected WebSocket', { status: 400 });
}
