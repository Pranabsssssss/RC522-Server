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

  // Auth Verification
  if (!checkAuth(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Invalid auth password' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  const upgradeHeader = request.headers.get('Upgrade');
  
  // 1. WebSocket Upgrade handling
  if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
    try {
      const { 0: client, 1: server } = new WebSocketPair();

      server.accept();
      globalThis.rfidNodes.add(server);

      // Send initial welcome frame
      try {
        server.send(JSON.stringify({
          type: 'welcome',
          role: 'node',
          message: 'Connected as live node (0 latency)',
          hostsActive: globalThis.rfidHosts.size
        }));
      } catch (e) {}

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

      server.addEventListener('error', () => {
        globalThis.rfidNodes.delete(server);
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'WebSocket upgrade failed: ' + err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  // 2. Server-Sent Events (SSE) Fallback for web browsers if WebSockets are blocked
  const url = new URL(request.url);
  if (url.searchParams.get('stream') === 'true' || request.headers.get('Accept') === 'text/event-stream') {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const sendSse = async (obj) => {
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      } catch (e) {}
    };

    // Send welcome SSE event
    sendSse({
      type: 'welcome',
      role: 'node-sse',
      message: 'Listening for real-time RFID scans via SSE'
    });

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

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  return new Response(JSON.stringify({
    status: 'online',
    message: 'Connect via WebSocket or ?stream=true for SSE'
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
