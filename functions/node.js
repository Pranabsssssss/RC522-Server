/**
 * Cloudflare Pages Function: /node
 * Handles listening Node connections via WebSocket or SSE stream
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

export async function onRequest(context) {
  const { request, env } = context;

  // Preflight
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

  // Auth
  if (!checkAuth(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Invalid auth password' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    globalThis.rfidNodes.add(server);

    server.send(JSON.stringify({
      type: 'welcome',
      role: 'node',
      message: 'Listening for real-time RFID scans'
    }));

    // Handle 2-way message from node back to hosts
    server.addEventListener('message', (event) => {
      try {
        const data = event.data;
        for (const hostSocket of globalThis.rfidHosts) {
          try {
            hostSocket.send(JSON.stringify({
              type: 'node_message',
              data: data
            }));
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
  }

  return new Response('Expected WebSocket upgrade to connect as a listening node', { status: 426 });
}
