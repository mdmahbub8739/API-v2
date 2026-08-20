import http from 'node:http';
import worker from './apiv2.js';

const PORT = 3000;

const server = http.createServer(async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const fullUrl = `${protocol}://${host}${req.url}`;
    const url = new URL(fullUrl);

    let body = undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else if (value !== undefined) {
        headers.set(key, value);
      }
    }

    const reqInit = {
      method: req.method,
      headers
    };
    if (body) {
      reqInit.body = body;
      reqInit.duplex = 'half';
    }

    const webRequest = new Request(url.toString(), reqInit);

    const env = {
      AD_GATE_SECRET: process.env.AD_GATE_SECRET || '',
      CUSTOM_HLS_SECRET: process.env.CUSTOM_HLS_SECRET || '',
      ...process.env
    };

    const ctx = {
      waitUntil(promise) {
        if (promise && typeof promise.catch === 'function') {
          promise.catch((e) => console.error('[waitUntil error]:', e));
        }
      },
      passThroughOnException() {}
    };

    const webResponse = await worker.fetch(webRequest, env, ctx);

    res.statusCode = webResponse.status;
    for (const [k, v] of webResponse.headers.entries()) {
      res.setHeader(k, v);
    }

    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      res.end();
    }
  } catch (err) {
    console.error('Server error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Internal Server Error: ' + err.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`API-v2 dev server running on port ${PORT}`);
});
