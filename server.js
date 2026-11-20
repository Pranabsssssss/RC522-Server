

require('dotenv').config();
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;

if (!AUTH_PASSWORD) {
  console.error('AUTH_PASSWORD is required. Copy .env.example to .env and set a secure value.');
  process.exit(1);
}

const connectedHosts = new Set();
const connectedNodes = new Set();
const waitingHttpClients = new Set();


function isValidRfidKey(str) {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (/^([0-9A-Fa-f]{2}[:-]){3,9}[0-9A-Fa-f]{2}$/.test(trimmed)) return true;
  if (/^[0-9A-Fa-f]{8,20}$/.test(trimmed) && trimmed.length % 2 === 0) return true;
  return false;
}


function encryptRfidKey(rawUid, password) {
  const cleanUid = rawUid.toUpperCase().trim();
  return crypto.createHmac('sha256', password).update(cleanUid).digest('hex').substring(0, 20).toUpperCase();
}


function isAuthorized(req, queryAuth) {
  if (queryAuth && queryAuth === AUTH_PASSWORD) return true;

  const headerToken = req.headers['x-auth-token'] || req.headers['x-auth-password'];
  if (headerToken && headerToken === AUTH_PASSWORD) return true;

  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[1] === AUTH_PASSWORD) return true;
    if (authHeader === AUTH_PASSWORD) return true;
  }

  return false;
}


const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const query = Object.fromEntries(reqUrl.searchParams.entries());

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-auth-token, x-auth-password');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/health' || pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      service: 'RFID RC522 Relay Server',
      hostsCount: connectedHosts.size,
      nodesCount: connectedNodes.size,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  if (pathname === '/host' && req.method === 'POST') {
    if (!isAuthorized(req, query.auth)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid auth credentials' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = { uid: body.trim() };
        }

        const rawUid = payload.uid || payload.rfid || payload.tag;
        if (!rawUid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing RFID UID in payload' }));
          return;
        }

        if (!isValidRfidKey(rawUid)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid RFID key format. Only valid RFID keys are allowed.' }));
          return;
        }

        const result = routeRfidScan(rawUid, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          action: result.action,
          connectedNodes: connectedNodes.size + waitingHttpClients.size,
          rawUid: rawUid,
          encryptedKey: result.encryptedKey,
          discriminant: result.encryptedKey,
          length: result.encryptedKey.length,
          timestamp: new Date().toISOString()
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/node' && req.method === 'GET') {
    if (!isAuthorized(req, query.auth)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid auth credentials' }));
      return;
    }

    if (query.wait === 'true' || query.poll === 'true') {
      const entry = { res, timeoutId: null };
      waitingHttpClients.add(entry);

      entry.timeoutId = setTimeout(() => {
        waitingHttpClients.delete(entry);
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'timeout', message: 'No card scanned, re-poll' }));
        }
      }, 25000);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      endpoint: '/node',
      status: 'ready',
      connectedNodes: connectedNodes.size + waitingHttpClients.size,
      activeHosts: connectedHosts.size
    }));
    return;
  }

  if (pathname === '/node' && req.method === 'POST') {
    if (!isAuthorized(req, query.auth)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid auth credentials' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        let payload;
        try { payload = JSON.parse(body); } catch { payload = { command: body.trim() }; }

        let count = 0;
        const msg = JSON.stringify({ type: 'node_message', data: payload, timestamp: Date.now() });
        for (const h of connectedHosts) {
          if (h.readyState === WebSocket.OPEN) { h.send(msg); count++; }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, forwardedToHosts: count, data: payload }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(indexPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found', endpoints: ['/host', '/node', '/health'] }));
    }
  }
});


function routeRfidScan(rawUid, extraData = {}) {
  const timestamp = Date.now();
  const timeISO = new Date(timestamp).toISOString();
  const totalNodes = connectedNodes.size + waitingHttpClients.size;

  const encryptedKey = encryptRfidKey(rawUid, AUTH_PASSWORD);

  if (totalNodes === 0) {
    console.log(`[RFID ${timeISO}] Key received: ${rawUid} -> Encrypted: ${encryptedKey} -> NO NODES CONNECTED. Dropping.`);
    return { action: 'dropped', reason: 'no_nodes_connected', rawUid, encryptedKey };
  }

  console.log(`[RFID ${timeISO}] Key received: ${rawUid} -> Encrypted: ${encryptedKey} -> Routing to ${totalNodes} node(s).`);
  const messageObj = {
    type: 'rfid',
    discriminant: encryptedKey,
    encryptedKey: encryptedKey,
    uid: encryptedKey,
    rawUid: rawUid,
    length: encryptedKey.length,
    timestamp: timestamp,
    timeISO: timeISO,
    extra: extraData
  };
  const message = JSON.stringify(messageObj);

  let sentCount = 0;

  for (const client of waitingHttpClients) {
    try {
      clearTimeout(client.timeoutId);
      if (!client.res.writableEnded) {
        client.res.writeHead(200, { 'Content-Type': 'application/json' });
        client.res.end(message);
        sentCount++;
      }
    } catch {}
  }
  waitingHttpClients.clear();

  for (const nodeSocket of connectedNodes) {
    if (nodeSocket.readyState === WebSocket.OPEN) {
      nodeSocket.send(message);
      sentCount++;
    }
  }

  return { action: 'routed', nodesCount: sentCount, rawUid, encryptedKey };
}


const wssHost = new WebSocketServer({ noServer: true });
const wssNode = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const reqUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const queryAuth = reqUrl.searchParams.get('auth');

  if (!isAuthorized(request, queryAuth)) {
    console.warn(`[AUTH] Unauthorized WebSocket attempt on ${pathname} from ${request.socket.remoteAddress}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (pathname === '/host') {
    wssHost.handleUpgrade(request, socket, head, (ws) => {
      wssHost.emit('connection', ws, request);
    });
  } else if (pathname === '/node') {
    wssNode.handleUpgrade(request, socket, head, (ws) => {
      wssNode.emit('connection', ws, request);
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});


wssHost.on('connection', (ws, req) => {
  connectedHosts.add(ws);
  const clientIp = req.socket.remoteAddress;
  console.log(`[HOST] Host connected from ${clientIp}. Total hosts: ${connectedHosts.size}`);

  ws.send(JSON.stringify({
    type: 'welcome',
    role: 'host',
    message: 'Connected to RFID Relay Server',
    connectedNodes: connectedNodes.size
  }));

  ws.on('message', (data) => {
    try {
      const text = data.toString().trim();
      if (!text) return;

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { uid: text };
      }

      if (payload.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
        return;
      }

      const uid = payload.uid || payload.rfid || payload.tag;
      if (uid) {
        const routeResult = routeRfidScan(uid, payload);
        ws.send(JSON.stringify({
          type: 'ack',
          uid: uid,
          rawUid: uid,
          encryptedKey: routeResult.encryptedKey,
          discriminant: routeResult.encryptedKey,
          status: routeResult.action,
          nodes: connectedNodes.size + waitingHttpClients.size
        }));
      }
    } catch (err) {
      console.error('[HOST] Error handling message:', err.message);
    }
  });

  ws.on('close', () => {
    connectedHosts.delete(ws);
    console.log(`[HOST] Host disconnected. Total hosts: ${connectedHosts.size}`);
  });

  ws.on('error', (err) => {
    console.error('[HOST] Socket error:', err.message);
  });
});


wssNode.on('connection', (ws, req) => {
  connectedNodes.add(ws);
  const clientIp = req.socket.remoteAddress;
  console.log(`[NODE] Node connected from ${clientIp}. Total nodes: ${connectedNodes.size}`);

  ws.send(JSON.stringify({
    type: 'welcome',
    role: 'node',
    message: 'Listening for RFID card scans in real time (0 latency)',
    hostsActive: connectedHosts.size
  }));

  const nodeCountUpdate = JSON.stringify({
    type: 'nodes_updated',
    count: connectedNodes.size
  });
  for (const hostSocket of connectedHosts) {
    if (hostSocket.readyState === WebSocket.OPEN) {
      hostSocket.send(nodeCountUpdate);
    }
  }

  ws.on('message', (data) => {
    try {
      const text = data.toString().trim();
      if (!text) return;

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }

      if (payload.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
        return;
      }

      console.log(`[NODE -> HOSTS] Relaying message from node:`, payload);
      const forwardMsg = JSON.stringify({
        type: 'node_message',
        data: payload,
        timestamp: Date.now()
      });

      for (const hostSocket of connectedHosts) {
        if (hostSocket.readyState === WebSocket.OPEN) {
          hostSocket.send(forwardMsg);
        }
      }
    } catch (err) {
      console.error('[NODE] Error handling message:', err.message);
    }
  });

  ws.on('close', () => {
    connectedNodes.delete(ws);
    console.log(`[NODE] Node disconnected. Total nodes: ${connectedNodes.size}`);

    const updateMsg = JSON.stringify({
      type: 'nodes_updated',
      count: connectedNodes.size
    });
    for (const hostSocket of connectedHosts) {
      if (hostSocket.readyState === WebSocket.OPEN) {
        hostSocket.send(updateMsg);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[NODE] Socket error:', err.message);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('====================================================');
    console.log(`  RFID RC522 Sensor Relay Server running on:`);
    console.log(`  Local:   http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  Host WS: ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/host`);
    console.log(`  Node WS: ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/node`);
    console.log(`  Storage: NONE (Pure In-Memory Real-time Routing)`);
    console.log('====================================================');
  });
}

module.exports = { server, routeRfidScan, connectedHosts, connectedNodes };
