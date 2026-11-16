/**
 * Cloudflare Pages Function: /health
 */
export async function onRequest(context) {
  const { env } = context;
  return new Response(JSON.stringify({
    status: 'online',
    platform: 'Cloudflare Pages Functions',
    timestamp: new Date().toISOString()
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
