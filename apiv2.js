export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 1. CORS Preflight Handling
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': '*',
                }
            });
        }

        // ==============================================================================
        // 🕳️ The Bot Trap — for the record, this catches casual/mid-tier scrapers
        // (raw curl, python-requests, naive scrapy jobs, link-following crawlers that
        // don't render CSS). It does NOT stop someone running curl_cffi with a real
        // TLS fingerprint, or actual Playwright/Chromium driving a real browser engine
        // — those are indistinguishable from a real visitor at this layer, full stop.
        // This raises the floor, it doesn't raise a wall. Layer it with the Referer
        // check + domain allowlist already in place; don't rely on this alone.
        // ==============================================================================
        function getClientIP(req) { return req.headers.get('CF-Connecting-IP') || 'unknown'; }
        function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

        // A handful of dead giveaways for unsophisticated scripted clients. Deliberately
        // NOT blocking generic "bot"/"crawler"/"spider" substrings here — that would
        // also catch Googlebot/Bingbot on your public pages, which you probably still
        // want indexing the site. This list only fires on the sensitive /api/* routes,
        // never on the plain video page itself.
        function looksLikeBot(request) {
            const ua = (request.headers.get('User-Agent') || '').toLowerCase();
            if (!ua) return true; // real browsers never omit User-Agent
            const signatures = ['python-requests', 'curl/', 'scrapy', 'okhttp', 'go-http-client', 'libwww-perl', 'wget/', 'axios/', 'node-fetch', 'headlesschrome', 'phantomjs', 'aiohttp'];
            return signatures.some(function (sig) { return ua.includes(sig); });
        }

        async function isBanned(ip, env) {
            if (!env.VIDARA_KV || ip === 'unknown') return false;
            const hit = await env.VIDARA_KV.get('trap:' + ip);
            return !!hit;
        }
        function banIP(ip, env, ctx) {
            if (!env.VIDARA_KV || ip === 'unknown') return;
            ctx.waitUntil(env.VIDARA_KV.put('trap:' + ip, '1', { expirationTtl: 86400 }));
        }

        // First offense: an immediate, theatrical "gotcha" — fast feedback, maximum
        // comedy, zero technical detail about what tripped it.
        function gotchaResponse() {
            const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Congratulations, you found it 🕳️</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:radial-gradient(circle at 50% 20%,#2a0808 0%,#0a0000 60%,#000 100%); color:#ffb3a7; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; text-align:center; padding:24px; }
  .card { max-width:520px; }
  .flames { font-size:60px; margin-bottom:8px; animation:pulse 1.2s infinite alternate; }
  @keyframes pulse { from{transform:scale(1);} to{transform:scale(1.08);} }
  h1 { font-size:24px; color:#ff6a3d; margin:0 0 14px; }
  p { font-size:15px; line-height:1.7; color:#e0a89c; }
  .tag { display:inline-block; margin-top:18px; font-size:13px; color:#ff8a5c; border:1px solid rgba(255,120,60,0.4); border-radius:999px; padding:6px 16px; background:rgba(255,90,0,0.08); }
</style></head>
<body><div class="card">
  <div class="flames">🕳️😈🔥</div>
  <h1>Congratulations, you found the one link no human would ever click.</h1>
  <p>Every request you make from here for the next while is going to get... interesting. Nothing personal — well, actually, kind of personal.</p>
  <div class="tag">we are all going to hell together, you're just going first</div>
</div></body></html>`;
            return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        }

        // Repeat offenses: a slow-drip tarpit. Time spent waiting on setTimeout doesn't
        // burn Workers CPU-time quota (only actual computation does), so this costs us
        // almost nothing while it sits there wasting the scraper's connection/thread for
        // real. Real users never see this — it only serves IPs already caught above.
        async function tarpitResponse() {
            const encoder = new TextEncoder();
            const lines = [
                "still loading, i promise",
                "any second now",
                "definitely not stuck on purpose",
                "we are all going to hell together",
                "this is fine 🔥",
                "your scraper's timeout is our best friend"
            ];
            const stream = new ReadableStream({
                async start(controller) {
                    controller.enqueue(encoder.encode('<!DOCTYPE html><html><head><title>Loading…</title></head><body><h1>Almost there…</h1>'));
                    for (let i = 0; i < 30; i++) {
                        await sleep(1000);
                        controller.enqueue(encoder.encode('<!-- ' + lines[i % lines.length] + ' -->\n'));
                    }
                    controller.enqueue(encoder.encode('</body></html>'));
                    controller.close();
                }
            });
            return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        }

        const HONEYPOT_PATH = '/api/void-walker';
        const clientIP = getClientIP(request);

        if (url.pathname === HONEYPOT_PATH) {
            banIP(clientIP, env, ctx);
            return gotchaResponse();
        }
        if (await isBanned(clientIP, env)) {
            return tarpitResponse();
        }
        if ((url.pathname.startsWith('/api/custom-hls/') || url.pathname === '/api/refetch') && looksLikeBot(request)) {
            banIP(clientIP, env, ctx);
            return gotchaResponse();
        }

        // ==============================================================================
        // Security helpers — the /api/* routes below were fully open: anyone who found
        // or guessed a URL could call them directly (hotlink your stream bypass, force
        // repeated re-parses, spam your D1 writes, or wipe your page cache on demand).
        // ==============================================================================

        // Same-origin check: real requests come from your own player page's JS (HLS.js,
        // the refetch/purge fetch calls), which the browser tags with a Referer/Origin
        // matching this worker's own hostname. A direct call typed into a browser bar,
        // curl, or another site embedding the .m3u8 URL will NOT have that header set
        // correctly, so it gets rejected. Note: this is not bulletproof — a scripted
        // client can fake headers — pair it with the Cloudflare Rate Limiting rule
        // mentioned in chat for real abuse protection.
        function isSameOriginRequest(request, url) {
            const ref = request.headers.get('Referer') || request.headers.get('Origin') || '';
            try {
                return new URL(ref).hostname === url.hostname;
            } catch (e) {
                return false;
            }
        }

        // Optional stream-domain allowlist. The `domain` query param is fetched
        // server-side (POST to `${domain}/api/stream`) — without a check here, anyone
        // can pass ANY url and make your worker send requests to it on your dime
        // (classic SSRF / open-relay risk). Set ALLOWED_STREAM_DOMAINS as a comma
        // separated env var (Settings → Variables) to lock this down; if it's unset,
        // this check is skipped so nothing breaks before you configure it.
        function isAllowedStreamDomain(domain, env) {
            if (!env.ALLOWED_STREAM_DOMAINS) return true;
            const allowed = env.ALLOWED_STREAM_DOMAINS.split(',').map(function (d) { return d.trim(); }).filter(Boolean);
            try {
                const host = new URL(domain).hostname;
                return allowed.some(function (d) { return host === d || host.endsWith('.' + d); });
            } catch (e) {
                return false;
            }
        }

        // Playful "you shouldn't be here" page for anyone who opens these endpoints
        // directly in a browser (the whole reason this happens: same-origin check
        // failed). Real script/fetch calls from our own player never hit this in
        // normal operation, but as a safety net we still content-negotiate: a browser
        // tab asks for text/html, our own fetch() calls ask for */* — so scripts still
        // get a clean JSON error and won't break trying to parse HTML.
        const HELL_LINES = {
            'no-referer': {
                title: "Sorry, you are not invited to hell.",
                sub: "This one's members only. You came in through the wrong door."
            },
            'bad-domain': {
                title: "Where am I?",
                sub: "Not somewhere you were supposed to end up. Turn back."
            },
            'no-admin-key': {
                title: "Where am I?",
                sub: "Not somewhere you were supposed to end up. Turn back."
            }
        };
        function forbiddenResponse(request, message, reasonKey) {
            const wantsHtml = (request.headers.get('Accept') || '').includes('text/html');
            if (!wantsHtml) {
                return new Response(JSON.stringify({ error: message || 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            const copy = HELL_LINES[reasonKey] || { title: "We are all going to hell together 😈", sub: message || "You don't have access to this, and honestly, neither do we half the time." };
            const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>403 — Denied, with style</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at 50% 20%, #2a0808 0%, #0a0000 60%, #000 100%);
    color: #ffb3a7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    text-align: center; padding: 24px; overflow: hidden;
  }
  .card { max-width: 480px; }
  .flames { font-size: 56px; margin-bottom: 8px; filter: drop-shadow(0 0 20px rgba(255,90,0,0.6)); animation: flicker 1.6s infinite alternate; }
  @keyframes flicker { from { opacity: 1; transform: scale(1); } to { opacity: 0.85; transform: scale(1.05); } }
  h1 { font-size: 22px; margin: 0 0 12px; color: #ff6a3d; text-shadow: 0 0 12px rgba(255,80,20,0.5); }
  p { font-size: 15px; line-height: 1.6; color: #e0a89c; margin: 0 0 20px; }
  .tag { display: inline-block; font-size: 13px; letter-spacing: 0.5px; color: #ff8a5c; border: 1px solid rgba(255,120,60,0.4); border-radius: 999px; padding: 6px 16px; background: rgba(255,90,0,0.08); }
  .code { margin-top: 24px; font-size: 12px; color: #7a4a3f; font-family: monospace; }
</style>
</head>
<body>
  <div class="card">
    <div class="flames">🔥😈🔥</div>
    <h1>${copy.title}</h1>
    <p>${copy.sub}</p>
    <div class="tag">we are all going to hell together</div>
    <div class="code">403 · access-denied</div>
  </div>
</body>
</html>`;
            return new Response(html, {
                status: 403,
                headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Access-Control-Allow-Origin': '*' }
            });
        }

        // ==============================================================================
        // 1.5 Segment list compaction (cuts D1 storage per video by ~70-80%)
        // ==============================================================================
        // A raw segments_json array repeats the full CDN URL on every single segment
        // (~90-150 bytes each x hundreds of segments = 50-100KB/video). Almost all of
        // that is one shared directory URL, and most segments in a CBR stream share the
        // exact same duration. So instead we store:
        //   { base: "<shared URL prefix>", d: <most common duration>,
        //     f: [ "<filename only>", ... ], e: { "<index>": <duration>, ... } }
        // f[i] is joined back onto base to rebuild the full URL; e only holds the
        // segments whose duration differs from the default d. Duration is rounded to
        // 2 decimals (sub-10ms, imperceptible for playback) to keep numbers short.
        // decompressSegments also accepts the old plain-array format unchanged, so
        // rows written before this change keep working with zero migration needed.
        function compressSegments(segments) {
            let prefix = segments[0].url;
            for (let i = 1; i < segments.length; i++) {
                const u = segments[i].url;
                let j = 0;
                while (j < prefix.length && j < u.length && prefix[j] === u[j]) j++;
                prefix = prefix.slice(0, j);
            }
            const slashIdx = prefix.lastIndexOf('/');
            const base = slashIdx >= 0 ? prefix.slice(0, slashIdx + 1) : '';

            const counts = {};
            for (const s of segments) {
                const d = Math.round(s.duration * 100) / 100;
                counts[d] = (counts[d] || 0) + 1;
            }
            let defaultDuration = Math.round(segments[0].duration * 100) / 100;
            let bestCount = 0;
            for (const key in counts) {
                if (counts[key] > bestCount) { bestCount = counts[key]; defaultDuration = Number(key); }
            }

            const filenames = segments.map(function (s) {
                return base ? s.url.slice(base.length) : s.url;
            });
            const exceptions = {};
            segments.forEach(function (s, i) {
                const d = Math.round(s.duration * 100) / 100;
                if (d !== defaultDuration) exceptions[i] = d;
            });

            // Max optimization: fold "prefix000.ts, prefix001.ts, ..." naming into
            // prefix+pad+ext+count, dropping the `f` array entirely (the single
            // biggest chunk of the JSON). Only applies when every filename matches
            // "<same prefix><zero-padded index><same ext>" for index = 0..count-1.
            const m0 = filenames[0].match(/^(.*?)(\d+)(\.[a-z0-9]+)$/i);
            let patternOk = !!m0;
            if (patternOk) {
                const fPrefix = m0[1], pad = m0[2].length, ext = m0[3];
                for (let i = 0; i < filenames.length; i++) {
                    if (filenames[i] !== fPrefix + String(i).padStart(pad, '0') + ext) { patternOk = false; break; }
                }
                if (patternOk) {
                    return { base: base, d: defaultDuration, e: exceptions,
                        prefix: fPrefix, pad: pad, ext: ext, count: filenames.length };
                }
            }

            // Fallback for irregular naming: keep the literal filename list.
            return { base: base, d: defaultDuration, f: filenames, e: exceptions };
        }

        function decompressSegments(parsed) {
            if (Array.isArray(parsed)) return parsed; // legacy uncompressed rows
            if (parsed.count !== undefined) {          // pattern-folded format
                const out = [];
                for (let i = 0; i < parsed.count; i++) {
                    const file = parsed.prefix + String(i).padStart(parsed.pad, '0') + parsed.ext;
                    out.push({
                        duration: parsed.e[i] !== undefined ? parsed.e[i] : parsed.d,
                        url: parsed.base ? parsed.base + file : file
                    });
                }
                return out;
            }
            return parsed.f.map(function (file, i) {  // older f-array format
                return {
                    duration: parsed.e[i] !== undefined ? parsed.e[i] : parsed.d,
                    url: parsed.base ? parsed.base + file : file
                };
            });
        }

        // ==============================================================================
        // 2. HLS Bypass & Segment Extractor API (Cloudflare D1 SQL Database)
        // ==============================================================================
        if (url.pathname.startsWith('/api/custom-hls/')) {
            if (!isSameOriginRequest(request, url)) return forbiddenResponse(request, 'Access denied.', 'no-referer');
            // Ad-gate enforcement at the media layer: the HTML page check alone isn't
            // enough, since this endpoint is what actually serves the stream — anyone
            // with this URL directly (DevTools network tab, a shared link, etc.) could
            // otherwise skip the ad page entirely. Same token, same rules, just checked
            // again here. The token carries its own videoId as its first '.'-segment
            // (see generateAccessToken), so there's no separate videoId param to trust.
            if (env.AD_GATE_SECRET) {
                const hlsToken = url.searchParams.get('token');
                const hlsTokenVideoId = hlsToken ? hlsToken.split('.')[0] : '';
                const hlsTokenOk = hlsTokenVideoId && await verifyAccessToken(hlsToken, hlsTokenVideoId, clientIP, env.AD_GATE_SECRET);
                if (!hlsTokenOk) return forbiddenResponse(request, 'Ad verification required.', 'no-ad-token');
            }
            const filecode = url.pathname.split('/').pop().replace('.m3u8', '');
            const domain = url.searchParams.get('domain');
            if (domain && !isAllowedStreamDomain(domain, env)) return forbiddenResponse(request, 'Domain not allowed.', 'bad-domain');
            const db = env.DB;
            let originalStreamingUrl = "";

            try {
                // Step 1: Check the D1 cache FIRST (external_direct_links & hls_videos). If we already parsed this video's
                // segments before, we can build the manifest straight from the DB and
                // skip the origin server entirely.
                let videoRecord = null;
                if (db) {
                    try {
                        const directRow = await db.prepare('SELECT target_duration, segments_json FROM external_direct_links WHERE filecode = ? AND segments_json IS NOT NULL').bind(filecode).first();
                        if (directRow && directRow.segments_json) {
                            videoRecord = directRow;
                        }
                    } catch (e) {
                        console.error('[custom-hls] external_direct_links SELECT failed:', e.message);
                    }

                    if (!videoRecord) {
                        try {
                            const hlsRow = await db.prepare('SELECT target_duration, segments_json FROM hls_videos WHERE filecode = ? AND segments_json IS NOT NULL').bind(filecode).first();
                            if (hlsRow && hlsRow.segments_json) {
                                videoRecord = hlsRow;
                            }
                        } catch (e) {
                            console.error('[custom-hls] hls_videos SELECT failed:', e.message);
                        }
                    }
                }

                // Step 2: Cache miss (or no DB bound) — now, and only now, do we need to
                // ask the origin server for the real stream URL.
                if (!videoRecord) {
                    if (!domain) throw new Error("Missing domain parameter");

                    const streamJson = await getStreamData(domain, filecode, env, ctx);
                    if (!streamJson) throw new Error("Failed to get stream from domain");
                    originalStreamingUrl = streamJson.streaming_url;

                    if (!originalStreamingUrl) throw new Error("No streaming_url returned from origin");

                    // SILENT FALLBACK: If user hasn't bound the DB, redirect to original stream seamlessly
                    if (!db) return Response.redirect(originalStreamingUrl, 302);

                    const m3u8Resp = await fetch(originalStreamingUrl);
                    if (!m3u8Resp.ok) throw new Error("Failed to fetch original HLS");
                    const text = await m3u8Resp.text();

                    let indexText = text;
                    let baseUrl = originalStreamingUrl.substring(0, originalStreamingUrl.lastIndexOf('/') + 1);

                    // If it's a Master Playlist, resolve to the first Index Playlist
                    if (text.includes('#EXT-X-STREAM-INF')) {
                        const lines = text.split('\n');
                        let nextLineIsIndex = false;
                        for (let line of lines) {
                            if (line.startsWith('#EXT-X-STREAM-INF')) {
                                nextLineIsIndex = true;
                            } else if (nextLineIsIndex && line.trim() && !line.startsWith('#')) {
                                const indexUrl = line.trim().startsWith('http') ? line.trim() : baseUrl + line.trim();
                                const indexResp = await fetch(indexUrl);
                                indexText = await indexResp.text();
                                baseUrl = indexUrl.substring(0, indexUrl.lastIndexOf('/') + 1);
                                break;
                            }
                        }
                    }

                    // Parse Segments
                    const lines = indexText.split('\n');
                    let segments = [];
                    let currentDuration = 0;
                    let targetDuration = 10;
                    
                    for (let line of lines) {
                        line = line.trim();
                        if (!line) continue;
                        
                        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                            targetDuration = parseInt(line.split(':')[1], 10);
                        } else if (line.startsWith('#EXTINF:')) {
                            currentDuration = parseFloat(line.split(':')[1].split(',')[0]);
                        } else if (line.endsWith('.ts') || line.includes('.ts?')) {
                            const directSegmentUrl = line.startsWith('http') ? line : baseUrl + line;
                            const cleanSegmentUrl = directSegmentUrl.split('?')[0]; // Removing token!
                            
                            segments.push({
                                duration: currentDuration,
                                url: cleanSegmentUrl
                            });
                        }
                    }

                    if (segments.length === 0) throw new Error("No segments found");

                    const segmentsJson = JSON.stringify(compressSegments(segments));
                    const calculatedCustomHlsUrl = `${url.origin}/api/custom-hls/${filecode}.m3u8?domain=${encodeURIComponent(domain)}`;
                    
                    // Step 3: Insert location data into DB (both external_direct_links and hls_videos)
                    try {
                        await db.prepare(
                            `UPDATE external_direct_links SET target_duration = ?, segments_json = ?, custom_hls_url = ?, updated_at = ? WHERE filecode = ?`
                        ).bind(targetDuration, segmentsJson, calculatedCustomHlsUrl, Date.now(), filecode).run();
                    } catch (e) {
                        // ignore if table or row doesn't exist yet
                    }

                    try {
                        await db.prepare(
                            `INSERT INTO hls_videos (filecode, target_duration, segments_json, updated_at)
                             VALUES (?, ?, ?, ?)
                             ON CONFLICT(filecode) DO UPDATE SET
                                target_duration = excluded.target_duration,
                                segments_json = excluded.segments_json,
                                updated_at = excluded.updated_at`
                        ).bind(filecode, targetDuration, segmentsJson, Date.now()).run();
                    } catch (e) {
                        console.error('[custom-hls] segments INSERT failed:', e.message);
                    }

                    videoRecord = { target_duration: targetDuration, segments_json: segmentsJson };
                }

                // Step 4: Build fresh custom manifest dynamically
                const segmentsData = decompressSegments(JSON.parse(videoRecord.segments_json));
                
                let customManifest = `#EXTM3U\n`;
                customManifest += `#EXT-X-VERSION:3\n`;
                customManifest += `#EXT-X-TARGETDURATION:${videoRecord.target_duration}\n`;
                customManifest += `#EXT-X-MEDIA-SEQUENCE:0\n`;
                
                for (let seg of segmentsData) {
                    customManifest += `#EXTINF:${seg.duration},\n`;
                    customManifest += `${seg.url}\n`;
                }
                customManifest += `#EXT-X-ENDLIST\n`;

                return new Response(customManifest, {
                    headers: {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'public, max-age=3600' 
                    }
                });

            } catch (err) {
                // Log so DB/schema failures are visible in the D1/Workers dashboard log
                // stream instead of vanishing behind the seamless fallback below.
                console.error('[custom-hls] failed for filecode=' + filecode + ':', err.message);
                // ULTIMATE SEAMLESS FALLBACK: If anything crashes (e.g., db error, parsing error),
                // redirect silently to the original tokenized URL so the user player never breaks!
                if (originalStreamingUrl) {
                    return Response.redirect(originalStreamingUrl, 302);
                }
                return new Response(JSON.stringify({ error: err.message }), { 
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }


        // ==============================================================================
        // 3. Stream Refetch Endpoint
        // ==============================================================================
        if (url.pathname === '/api/refetch') {
            if (!isSameOriginRequest(request, url)) return forbiddenResponse(request, 'Access denied.', 'no-referer');
            const filecode = url.searchParams.get('filecode');
            const domain = url.searchParams.get('domain') || 'https://vidara.so';
            if (!isAllowedStreamDomain(domain, env)) return forbiddenResponse(request, 'Domain not allowed.', 'bad-domain');

            if (!filecode) {
                return new Response(JSON.stringify({ error: 'Missing filecode' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }

            try {
                // Delete DB cache for this video to force a fresh parse!
                if (env.DB) {
                    await env.DB.prepare('DELETE FROM hls_videos WHERE filecode = ?').bind(filecode).run();
                }

                // Return our custom HLS url directly to the frontend player
                let customHlsUrl = `${url.origin}/api/custom-hls/${filecode}.m3u8?domain=${encodeURIComponent(domain)}`;
                const passthroughToken = url.searchParams.get('token');
                if (passthroughToken) customHlsUrl += `&token=${encodeURIComponent(passthroughToken)}`;
                return new Response(JSON.stringify({ streaming_url: customHlsUrl }), {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        // ==============================================================================
        // 4. Cache Purge Endpoint
        // ==============================================================================
        if (url.pathname === '/api/purge') {
            // Admin-only: this deletes cache on demand, so it needs a secret, not just a
            // same-origin check. Set ADMIN_SECRET as a Worker secret (Settings →
            // Variables → Encrypt), then call this with ?key=YOUR_SECRET. Until
            // ADMIN_SECRET is configured, this endpoint stays closed (fails safe).
            if (!env.ADMIN_SECRET || url.searchParams.get('key') !== env.ADMIN_SECRET) {
                return forbiddenResponse(request, 'Missing or invalid admin key.', 'no-admin-key');
            }
            const kv = env.VIDARA_KV;
            const db = env.DB;
            const targetId = url.searchParams.get('videoId');
            let purgedSources = 0;
            if (targetId) {
                if (kv) {
                    const purgeUrl = new URL(request.url);
                    purgeUrl.pathname = '/' + targetId;
                    purgeUrl.search = '';
                    await kv.delete('page:' + purgeUrl.toString());
                    purgeUrl.searchParams.set('format', 'json');
                    await kv.delete('page:' + purgeUrl.toString());
                }
                // The KV page cache is just the rendered HTML — the real source of truth
                // is the permanent D1 rows (see getVideoMetadata/getStreamData above).
                // Wiping only the page cache would leave stale video_meta/hls_videos rows
                // in place, so the "purge" would just regenerate the same stale HTML.
                // Wrapped defensively: if the schema isn't set up yet, purge still works
                // for the KV part above instead of 500ing.
                if (db) {
                    try {
                        const metaRow = await db.prepare('SELECT links_json FROM video_meta WHERE video_id = ?').bind(targetId).first();
                        if (metaRow && metaRow.links_json) {
                            const links = JSON.parse(metaRow.links_json);
                            for (const link of links) {
                                try {
                                    const cleanLink = link.replace(/[^a-zA-Z0-9:/\.\-_]/g, '');
                                    const fileCode = new URL(cleanLink).pathname.split('/').pop();
                                    await db.prepare('DELETE FROM hls_videos WHERE filecode = ?').bind(fileCode).run();
                                    purgedSources++;
                                } catch (e) {}
                            }
                        }
                        await db.prepare('DELETE FROM video_meta WHERE video_id = ?').bind(targetId).run();
                    } catch (e) {
                        console.error('[purge] D1 cleanup failed for videoId=' + targetId + ':', e.message);
                    }
                }
            }
            return new Response(JSON.stringify({ purged: !!targetId, purgedSources }), {
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        // ==============================================================================
        // 4.5 Ad-Gate Verification System
        // ==============================================================================
        // Server-side, per-IP, per-video, time-limited access token. A visitor must pass
        // through /verify/:videoId first; that page mints the token and redirects here.
        // Requesting the main page directly (no token, wrong video, wrong IP, or expired
        // token) bounces back to /verify/:videoId, which mints a fresh one.
        //
        // Set AD_GATE_SECRET as a Worker secret (wrangler secret put AD_GATE_SECRET) with a
        // long random string. Until it's set, the gate is skipped entirely (fails OPEN) so
        // the site doesn't break before you've configured it — flip this once it's ready.

        async function generateAccessToken(videoId, clientIP, secret) {
            const expiresAt = Date.now() + 30 * 60 * 1000; // 30 minutes
            const nonce = crypto.randomUUID();
            const payload = `${videoId}.${clientIP}.${expiresAt}.${nonce}`;

            const key = await crypto.subtle.importKey(
                'raw', new TextEncoder().encode(secret),
                { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
            );
            const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
            const sigHex = [...new Uint8Array(sigBuffer)].map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');

            return `${videoId}.${expiresAt}.${nonce}.${sigHex}`;
        }

        async function verifyAccessToken(token, videoId, clientIP, secret) {
            if (!token) return false;
            const parts = token.split('.');
            if (parts.length !== 4) return false;

            const [tokenVideoId, expiresAtStr, nonce, sigHex] = parts;
            if (tokenVideoId !== videoId) return false;
            if (Date.now() > Number(expiresAtStr)) return false;

            const payload = `${tokenVideoId}.${clientIP}.${expiresAtStr}.${nonce}`;
            const key = await crypto.subtle.importKey(
                'raw', new TextEncoder().encode(secret),
                { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
            );
            const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g).map(function (b) { return parseInt(b, 16); }));
            return await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload));
        }

        // --- Permanent, D1-backed lookups for the two external calls every video view
        // needs (video metadata + a given source's stream data). Once resolved, the
        // result is stored in D1 and every future request is served straight from the
        // row, with zero origin request. Origin is only hit again via /api/purge or
        // /api/refetch, or when D1 isn't bound (falls back to short-TTL KV).
        //
        // CRITICAL: every db.prepare(...).first() / .run() below is wrapped in its own
        // try/catch. A missing table or column must NEVER throw up into the caller —
        // worst case this just behaves exactly as if no DB were bound (always refetch
        // from origin, never persist), instead of taking the whole page down with a
        // "no such column" 500. Fix the schema on your own time; the site stays up
        // either way.
        //
        // One-time D1 setup (D1 Console, run once):
        //   CREATE TABLE IF NOT EXISTS video_meta (
        //     video_id TEXT PRIMARY KEY, title TEXT, thumbnail TEXT,
        //     thumbnails_url TEXT, links_json TEXT, updated_at INTEGER
        //   );
        //   CREATE TABLE IF NOT EXISTS hls_videos (
        //     filecode TEXT PRIMARY KEY, title TEXT, thumbnail TEXT,
        //     subtitles_json TEXT, streaming_url TEXT,
        //     target_duration INTEGER, segments_json TEXT, updated_at INTEGER
        //   );
        //   CREATE TABLE IF NOT EXISTS external_direct_links (
        //     link_hash TEXT PRIMARY KEY, original_url TEXT, domain TEXT,
        //     filecode TEXT, title TEXT, thumbnail TEXT, subtitles_json TEXT,
        //     streaming_url TEXT, custom_hls_url TEXT, target_duration INTEGER,
        //     segments_json TEXT, created_at INTEGER, updated_at INTEGER
        //   );
        // If tables already exist in a different shape, run
        // `PRAGMA table_info(table_name);` and add whatever's missing with `ALTER TABLE ... ADD COLUMN ...`.

        async function safeDbRead(promise, label) {
            try { return await promise; } catch (e) { console.error('[db read failed] ' + label + ':', e.message); return null; }
        }
        function safeDbWrite(promise, label) {
            return promise.catch(function (e) { console.error('[db write failed] ' + label + ':', e.message); });
        }

        function parseDirectLink(inputUrl) {
            if (!inputUrl || typeof inputUrl !== 'string') return null;
            try {
                let clean = inputUrl.trim();
                if (clean.includes('%3A%2F%2F') || clean.includes('%2F')) {
                    try { clean = decodeURIComponent(clean); } catch (e) {}
                }
                if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
                    if (clean.includes('.') || clean.startsWith('vidara')) {
                        clean = 'https://' + clean;
                    } else {
                        return null;
                    }
                }
                const u = new URL(clean);
                const domain = u.origin;
                const parts = u.pathname.split('/').filter(Boolean);
                if (parts.length === 0) return null;
                const fileCode = parts[parts.length - 1].replace(/\.(m3u8|mp4|html)$/i, '');
                const isVidaraV = (domain.includes('vidara.so') || domain.includes('vidara')) && parts.includes('v');
                return {
                    domain,
                    fileCode,
                    originalUrl: clean,
                    linkHash: `${domain}:${fileCode}`,
                    isVidaraV,
                    videoId: isVidaraV ? fileCode : null
                };
            } catch (e) {
                return null;
            }
        }

        async function getDirectLinkData(directInfo, env, ctx, appOrigin) {
            const db = env.DB;
            const kv = env.VIDARA_KV;
            const { domain, fileCode, originalUrl, linkHash, isVidaraV, videoId } = directInfo;
            const originBase = appOrigin || '';
            const calculatedCustomHlsUrl = `${originBase}/api/custom-hls/${fileCode}.m3u8?domain=${encodeURIComponent(domain)}`;

            // If vidara.so/v/ID link is passed, resolve via backend if available
            if (isVidaraV && videoId) {
                try {
                    const vData = await getVideoMetadata(videoId, env, ctx);
                    if (vData && vData.links && vData.links.length > 0) {
                        return {
                            title: vData.title || `Video ${videoId}`,
                            thumbnail: vData.thumbnail || '',
                            vtt: vData.vtt || vData.thumbnails || vData.storyboard || '',
                            links: vData.links,
                            custom_hls_url: calculatedCustomHlsUrl,
                            isDirect: true
                        };
                    }
                } catch (e) {
                    console.error('[direct vidara.so/v/] fetch error:', e.message);
                }
            }

            // 1. Check external_direct_links table in D1 (if bound)
            if (db) {
                const row = await safeDbRead(db.prepare(
                    'SELECT title, thumbnail, subtitles_json, streaming_url, custom_hls_url, target_duration, segments_json FROM external_direct_links WHERE link_hash = ? OR filecode = ?'
                ).bind(linkHash, fileCode).first(), 'external_direct_links SELECT link_hash=' + linkHash);

                if (row && (row.streaming_url || row.custom_hls_url)) {
                    return {
                        title: row.title || `Video (${fileCode})`,
                        thumbnail: row.thumbnail || '',
                        subtitles: row.subtitles_json ? JSON.parse(row.subtitles_json) : [],
                        streaming_url: row.streaming_url || '',
                        custom_hls_url: row.custom_hls_url || calculatedCustomHlsUrl,
                        target_duration: row.target_duration || 10,
                        segments_json: row.segments_json || null,
                        domain: domain,
                        filecode: fileCode,
                        original_url: originalUrl,
                        isDirect: true
                    };
                }
            } else if (kv) {
                const cached = await kv.get('direct:' + linkHash);
                if (cached) {
                    try {
                        const parsed = JSON.parse(cached);
                        if (!parsed.custom_hls_url) parsed.custom_hls_url = calculatedCustomHlsUrl;
                        return parsed;
                    } catch (e) {}
                }
            }

            // 2. Direct origin fetch — NO DATABASE REQUIRED (Database-free processing)
            let streamData = null;
            try {
                const streamResp = await fetch(`${domain}/api/stream`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filecode: fileCode, device: 'web' })
                });
                if (streamResp.ok) {
                    streamData = await streamResp.json();
                }
            } catch (e) {
                console.error('[direct /api/stream fetch failed]:', e.message);
            }

            const result = {
                title: (streamData && streamData.title) || `Video (${fileCode})`,
                thumbnail: (streamData && streamData.thumbnail) || '',
                subtitles: (streamData && Array.isArray(streamData.subtitles)) ? streamData.subtitles : [],
                streaming_url: (streamData && streamData.streaming_url) || '',
                custom_hls_url: calculatedCustomHlsUrl,
                domain: domain,
                filecode: fileCode,
                original_url: originalUrl,
                isDirect: true
            };

            // 3. Save into separate external_direct_links table asynchronously
            if (db && (result.streaming_url || result.custom_hls_url)) {
                ctx.waitUntil(safeDbWrite(db.prepare(
                    `INSERT INTO external_direct_links (link_hash, original_url, domain, filecode, title, thumbnail, subtitles_json, streaming_url, custom_hls_url, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(link_hash) DO UPDATE SET
                        original_url = excluded.original_url,
                        domain = excluded.domain,
                        filecode = excluded.filecode,
                        title = excluded.title,
                        thumbnail = excluded.thumbnail,
                        subtitles_json = excluded.subtitles_json,
                        streaming_url = excluded.streaming_url,
                        custom_hls_url = excluded.custom_hls_url,
                        updated_at = excluded.updated_at`
                ).bind(
                    linkHash,
                    originalUrl,
                    domain,
                    fileCode,
                    result.title,
                    result.thumbnail,
                    JSON.stringify(result.subtitles),
                    result.streaming_url,
                    result.custom_hls_url,
                    Date.now(),
                    Date.now()
                ).run(), 'external_direct_links INSERT link_hash=' + linkHash));
            } else if (kv && result.streaming_url) {
                ctx.waitUntil(kv.put('direct:' + linkHash, JSON.stringify(result), { expirationTtl: 300 }));
            }

            return result;
        }

        async function getVideoMetadata(videoId, env, ctx) {
            const db = env.DB;
            const kv = env.VIDARA_KV;

            if (db) {
                const row = await safeDbRead(db.prepare(
                    'SELECT title, thumbnail, thumbnails_url, links_json FROM video_meta WHERE video_id = ?'
                ).bind(videoId).first(), 'video_meta SELECT video_id=' + videoId);
                if (row && row.links_json) {
                    return { title: row.title, thumbnail: row.thumbnail, vtt: row.thumbnails_url, links: JSON.parse(row.links_json) };
                }
            } else if (kv) {
                const cached = await kv.get('meta:' + videoId);
                if (cached) { try { return JSON.parse(cached); } catch (e) {} }
            }

            const apiResp = await fetch(`https://vidara-so.onrender.com/v/${videoId}`);
            if (!apiResp.ok) throw new Error("Failed to fetch video details from server");
            const apiData = await apiResp.json();
            const thumbsUrl = apiData.vtt || apiData.thumbnails || apiData.storyboard || null;

            if (db) {
                ctx.waitUntil(safeDbWrite(db.prepare(
                    `INSERT INTO video_meta (video_id, title, thumbnail, thumbnails_url, links_json, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(video_id) DO UPDATE SET
                        title = excluded.title, thumbnail = excluded.thumbnail,
                        thumbnails_url = excluded.thumbnails_url, links_json = excluded.links_json,
                        updated_at = excluded.updated_at`
                ).bind(videoId, apiData.title || null, apiData.thumbnail || null, thumbsUrl, JSON.stringify(apiData.links || []), Date.now()).run(),
                'video_meta INSERT video_id=' + videoId));
            } else if (kv) {
                ctx.waitUntil(kv.put('meta:' + videoId, JSON.stringify(apiData), { expirationTtl: 600 }));
            }
            return apiData;
        }

        async function getStreamData(domain, fileCode, env, ctx) {
            const db = env.DB;
            const kv = env.VIDARA_KV;

            if (db) {
                const row = await safeDbRead(db.prepare(
                    'SELECT title, thumbnail, subtitles_json, streaming_url FROM hls_videos WHERE filecode = ?'
                ).bind(fileCode).first(), 'hls_videos SELECT filecode=' + fileCode);
                if (row && row.streaming_url) {
                    return {
                        title: row.title || undefined,
                        thumbnail: row.thumbnail || undefined,
                        subtitles: row.subtitles_json ? JSON.parse(row.subtitles_json) : [],
                        streaming_url: row.streaming_url
                    };
                }
            } else if (kv) {
                const cached = await kv.get('stream:' + domain + ':' + fileCode);
                if (cached) { try { return JSON.parse(cached); } catch (e) {} }
            }

            const streamResp = await fetch(`${domain}/api/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filecode: fileCode, device: 'web' })
            });
            const data = streamResp.ok ? await streamResp.json() : null;

            if (data) {
                if (db) {
                    ctx.waitUntil(safeDbWrite(db.prepare(
                        `INSERT INTO hls_videos (filecode, title, thumbnail, subtitles_json, streaming_url, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?)
                         ON CONFLICT(filecode) DO UPDATE SET
                            title = excluded.title, thumbnail = excluded.thumbnail,
                            subtitles_json = excluded.subtitles_json, streaming_url = excluded.streaming_url,
                            updated_at = excluded.updated_at`
                    ).bind(fileCode, data.title || null, data.thumbnail || null, JSON.stringify(data.subtitles || []), data.streaming_url || null, Date.now()).run(),
                    'hls_videos INSERT filecode=' + fileCode));
                } else if (kv) {
                    ctx.waitUntil(kv.put('stream:' + domain + ':' + fileCode, JSON.stringify(data), { expirationTtl: 240 }));
                }
            }
            return data;
        }

        // Mirrors the same two-step lookup the main page (and the Vidara ExtractorApi) use:
        // 1) videoId -> base title/thumbnail/links from our own backend
        // 2) first link's domain -> POST /api/stream {filecode, device:'web'} -> title/thumbnail/subtitles
        async function fetchGateMetadata(videoId, env, ctx) {
            const result = { title: 'Video Player', thumbnail: '', subtitles: [] };

            let apiData;
            try {
                apiData = await getVideoMetadata(videoId, env, ctx);
            } catch (e) {
                return result;
            }
            result.title = apiData.title || result.title;
            result.thumbnail = apiData.thumbnail || '';

            const rawLinks = apiData.links || [];
            if (!rawLinks.length) return result;

            try {
                const cleanLink = rawLinks[0].replace(/[^a-zA-Z0-9:/\.\-_]/g, '');
                const linkUrlObj = new URL(cleanLink);
                const domain = linkUrlObj.origin;
                const fileCode = linkUrlObj.pathname.split('/').pop();

                const streamJson = await getStreamData(domain, fileCode, env, ctx);

                if (streamJson) {
                    if (streamJson.title) result.title = streamJson.title;
                    if (streamJson.thumbnail) result.thumbnail = streamJson.thumbnail;
                    if (Array.isArray(streamJson.subtitles)) {
                        result.subtitles = streamJson.subtitles
                            .map(function (s) { return { url: s.file_path, language: s.language || 'Unknown' }; })
                            .filter(function (s) { return !!s.url; });
                    }
                }
            } catch (e) {
                // stream endpoint failing still leaves step-1's title/thumbnail intact
            }

            return result;
        }

        // AD_SLOT_HTML is read from an env var so the ad network's script/markup can be
        // configured and changed (Settings → Variables) without touching this file.
        // Leave it unset for now — the gate page below will just show an empty dashed box.
        function renderGatePage(videoId, meta, appOrigin, adSlotHtml, timerSeconds) {
            const confirmUrl = `${appOrigin}/verify/${videoId}/confirm`;
            const subtitleNote = meta.subtitles.length
                ? `<p class="sub-note">${meta.subtitles.length}টা সাবটাইটেল ভাষা উপলব্ধ (${meta.subtitles.map(function (s) { return s.language; }).join(', ')})</p>`
                : '';

            return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${meta.title.replace(/"/g, '&quot;')} — যাচাই করা হচ্ছে</title>
<style>
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
           background:#0f1115; color:#e8eaed; min-height:100vh; display:flex; flex-direction:column;
           align-items:center; padding:24px 16px; }
    .preview { max-width:480px; width:100%; background:#171a21; border:1px solid #2a2f3a;
               border-radius:12px; overflow:hidden; margin-bottom:20px; }
    .preview img { width:100%; display:block; aspect-ratio:16/9; object-fit:cover; }
    .preview .info { padding:14px 16px; }
    .preview .info h1 { font-size:1rem; margin:0; }
    .sub-note { font-size:0.8rem; color:#8a8f9c; margin:6px 0 0; }
    .ad-slot { max-width:480px; width:100%; background:#171a21; border:1px dashed #2a2f3a;
               border-radius:10px; min-height:250px; display:flex; align-items:center;
               justify-content:center; padding:12px; margin-bottom:20px; overflow-x:auto; }
    #continueBtn { padding:12px 32px; border-radius:999px; border:none; background:#4f8cff;
                   color:#fff; font-size:0.95rem; font-weight:600; cursor:not-allowed;
                   opacity:0.5; transition:opacity .2s; }
    #continueBtn.ready { cursor:pointer; opacity:1; }
</style>
</head>
<body>

    <div class="preview">
        ${meta.thumbnail ? `<img src="${meta.thumbnail}" alt="">` : ''}
        <div class="info">
            <h1>${meta.title.replace(/</g, '&lt;')}</h1>
            ${subtitleNote}
        </div>
    </div>

    <div class="ad-slot">${adSlotHtml || ''}</div>

    <button id="continueBtn" disabled>অপেক্ষা করুন... (<span id="timer">${timerSeconds}</span>)</button>

    <script>
        let secondsLeft = ${timerSeconds};
        const btn = document.getElementById('continueBtn');
        const timerEl = document.getElementById('timer');
        const iv = setInterval(function () {
            secondsLeft -= 1;
            if (secondsLeft <= 0) {
                clearInterval(iv);
                btn.disabled = false;
                btn.classList.add('ready');
                btn.textContent = 'ভিডিওতে যান →';
            } else {
                timerEl.textContent = secondsLeft;
            }
        }, 1000);
        btn.addEventListener('click', function () {
            if (btn.classList.contains('ready')) window.location.href = ${JSON.stringify(confirmUrl)};
        });
    </script>

</body>
</html>`;
        }

        if (url.pathname.startsWith('/verify/')) {
            const verifyParts = url.pathname.split('/').filter(Boolean); // ['verify', videoId, 'confirm'?]
            const gateVideoId = verifyParts[1];
            const isConfirm = verifyParts[2] === 'confirm';

            if (!gateVideoId) return new Response('Not Found', { status: 404 });

            if (!env.AD_GATE_SECRET) {
                // Gate not configured yet — send straight through instead of dead-ending here.
                return Response.redirect(`${url.origin}/${gateVideoId}`, 302);
            }

            if (isConfirm) {
                const token = await generateAccessToken(gateVideoId, clientIP, env.AD_GATE_SECRET);
                return Response.redirect(`${url.origin}/${gateVideoId}?token=${token}`, 302);
            }

            const meta = await fetchGateMetadata(gateVideoId, env, ctx);
            const timerSeconds = Number(env.AD_GATE_TIMER_SECONDS) > 0 ? Number(env.AD_GATE_TIMER_SECONDS) : 15;
            const html = renderGatePage(gateVideoId, meta, url.origin, env.AD_SLOT_HTML, timerSeconds);
            return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        }

        // ==============================================================================
        // 5. Main Player Page Generator
        // ==============================================================================
        const directParam = url.searchParams.get('url') || url.searchParams.get('link') || url.searchParams.get('direct');
        let directInfo = directParam ? parseDirectLink(directParam) : null;
        if (!directInfo && url.pathname.startsWith('/direct')) {
            const rawAfterDirect = url.pathname.replace(/^\/direct\/?/, '');
            if (rawAfterDirect) directInfo = parseDirectLink(rawAfterDirect);
        }
        if (!directInfo && url.pathname.startsWith('/e/')) {
            const dom = url.searchParams.get('domain') || 'https://vidara.so';
            directInfo = parseDirectLink(dom + url.pathname);
        }

        const pathSegments = url.pathname.split('/').filter(Boolean);
        let videoId = pathSegments.pop();
        if (!directInfo && videoId && (videoId.startsWith('http://') || videoId.startsWith('https://') || videoId.includes('.'))) {
            directInfo = parseDirectLink(videoId);
        }

        if (request.method !== 'GET' || videoId === 'favicon.ico' || videoId === 'api') {
            return new Response('Not Found', { status: 404 });
        }

        if (!videoId && !directInfo) {
            const rootHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stream Player & API</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; max-width: 580px; width: 100%; padding: 32px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        h1 { font-size: 22px; font-weight: 700; margin-bottom: 12px; color: #38bdf8; }
        p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin-bottom: 24px; }
        .input-group { display: flex; gap: 8px; margin-bottom: 24px; }
        input { flex: 1; padding: 12px 16px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 14px; outline: none; }
        input:focus { border-color: #38bdf8; }
        button { background: #0284c7; color: #fff; border: none; border-radius: 8px; padding: 12px 20px; font-weight: 600; cursor: pointer; transition: 0.2s; }
        button:hover { background: #0369a1; }
        .examples { border-top: 1px solid #334155; padding-top: 18px; font-size: 13px; color: #64748b; }
        .examples code { display: block; background: #0f172a; color: #38bdf8; padding: 8px 12px; border-radius: 6px; margin-top: 6px; word-break: break-all; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Direct Stream Player</h1>
        <p>যেকোনো সাপোর্টেড ডোমেইন বা vidara লিংক দিয়ে সরাসরি ভিডিও প্লে করুন বা এপিআই কল করুন।</p>
        <form onsubmit="event.preventDefault(); const val = document.getElementById('urlInput').value.trim(); if(val) window.location.href = '/?url=' + encodeURIComponent(val);">
            <div class="input-group">
                <input id="urlInput" type="text" placeholder="https://vidara.so/e/xxxxxx" required />
                <button type="submit">Play</button>
            </div>
        </form>
        <div class="examples">
            <div>URL Parameter Format:</div>
            <code>${url.origin}/?url=https://vidara.so/e/FILECODE</code>
            <div style="margin-top: 10px;">JSON API Format:</div>
            <code>${url.origin}/?url=https://vidara.so/e/FILECODE&format=json</code>
        </div>
    </div>
</body>
</html>`;
            return new Response(rootHtml, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        }

        if (directInfo) {
            videoId = directInfo.fileCode;
        }

        // Ad-gate check: no valid token for THIS video from THIS IP -> bounce to /verify/:id.
        // Skipped entirely while AD_GATE_SECRET is unset (see note above).
        if (env.AD_GATE_SECRET && videoId) {
            const incomingToken = url.searchParams.get('token');
            const tokenOk = await verifyAccessToken(incomingToken, videoId, clientIP, env.AD_GATE_SECRET);
            if (!tokenOk) {
                return Response.redirect(`${url.origin}/verify/${videoId}`, 302);
            }
        }

        const bypassCache = url.searchParams.has('nocache') || url.searchParams.has('v');
        const kv = env.VIDARA_KV;
        // Cache key deliberately excludes token/nocache/v: the per-visitor ad-gate token
        // is checked separately above and shouldn't fragment the page cache — otherwise
        // every visitor computes a unique key and the cache never HITs.
        const cacheKeyUrl = new URL(request.url);
        cacheKeyUrl.searchParams.delete('token');
        cacheKeyUrl.searchParams.delete('nocache');
        cacheKeyUrl.searchParams.delete('v');
        const cacheKey = 'page:' + cacheKeyUrl.toString();

        if (!bypassCache && kv) {
            const cachedRaw = await kv.get(cacheKey);
            if (cachedRaw) {
                try {
                    const cached = JSON.parse(cachedRaw);
                    return new Response(cached.body, {
                        headers: {
                            'Content-Type': cached.contentType,
                            'Cache-Control': 'public, max-age=600',
                            'Access-Control-Allow-Origin': '*',
                            'X-Cache': 'HIT'
                        }
                    });
                } catch (e) {}
            }
        }

        try {
            let apiData = null;
            let posterUrl = '';
            let thumbnailsUrl = '';
            let sources = [];

            if (directInfo) {
                // Process direct link directly without requiring database or onrender.com lookup
                const directData = await getDirectLinkData(directInfo, env, ctx, url.origin);
                posterUrl = directData.thumbnail || '';
                thumbnailsUrl = directData.vtt || '';
                apiData = {
                    title: directData.title || `Video (${directInfo.fileCode})`,
                    thumbnail: posterUrl,
                    vtt: thumbnailsUrl,
                    links: [directInfo.originalUrl]
                };

                const directEmbedUrl = `${directInfo.domain}/e/${directInfo.fileCode}`;
                const customHlsUrl = directData.custom_hls_url || `${url.origin}/api/custom-hls/${directInfo.fileCode}.m3u8?domain=${encodeURIComponent(directInfo.domain)}`;

                const subs = Array.isArray(directData.subtitles)
                    ? directData.subtitles.map(function (s) { return { url: s.file_path || s.url, language: s.language || 'Unknown' }; }).filter(function (s) { return !!s.url; })
                    : [];

                if (directData.streaming_url) {
                    // PRIMARY: Custom Bypassed URL
                    sources.push({
                        html: `Direct Source (Fast Stream)`,
                        url: customHlsUrl,
                        isEmbed: false,
                        filecode: directInfo.fileCode,
                        domain: directInfo.domain,
                        subtitles: subs,
                        thumbnail: directData.thumbnail || posterUrl
                    });

                    // BACKUP: Original direct streaming URL
                    sources.push({
                        html: `Direct Source (Backup Stream)`,
                        url: directData.streaming_url,
                        isEmbed: false,
                        filecode: directInfo.fileCode,
                        domain: directInfo.domain,
                        subtitles: subs,
                        thumbnail: directData.thumbnail || posterUrl
                    });
                }

                // FALLBACK: Direct embed page
                sources.push({
                    html: `Direct Source (Embed Fallback)`,
                    url: directEmbedUrl,
                    isEmbed: true,
                    filecode: directInfo.fileCode,
                    domain: directInfo.domain
                });
            } else {
                // Fetch video metadata (shared D1 cache with /verify — see getVideoMetadata above)
                apiData = await getVideoMetadata(videoId, env, ctx);

                posterUrl = apiData.thumbnail || '';
                thumbnailsUrl = apiData.vtt || apiData.thumbnails || apiData.storyboard || '';
                const rawLinks = apiData.links || [];

                // Process Links
                for (let i = 0; i < rawLinks.length; i++) {
                    const cleanLink = rawLinks[i].replace(/[^a-zA-Z0-9:/\.\-_]/g, '');

                    try {
                        const linkUrlObj = new URL(cleanLink);
                        const domain = linkUrlObj.origin;
                        const fileCode = linkUrlObj.pathname.split('/').pop();
                        const directEmbedUrl = `${domain}/e/${fileCode}`;

                        const customHlsUrl = `${url.origin}/api/custom-hls/${fileCode}.m3u8?domain=${encodeURIComponent(domain)}`;

                        const streamJson = await getStreamData(domain, fileCode, env, ctx);

                        if (streamJson) {
                            if (streamJson.streaming_url) {
                                // The origin's /api/stream response can include a `subtitles`
                                // array (file_path + language per track) — previously this was
                                // fetched and silently discarded. Now it rides along on the
                                // source object so the player can offer subtitle tracks.
                                const subs = Array.isArray(streamJson.subtitles)
                                    ? streamJson.subtitles.map(function (s) { return { url: s.file_path, language: s.language || 'Unknown' }; }).filter(function (s) { return !!s.url; })
                                    : [];

                                // PRIMARY: Add our Custom Bypassed URL first
                                sources.push({
                                    html: `Source ${i + 1} (Direct Stream - Fast)`,
                                    url: customHlsUrl,
                                    isEmbed: false,
                                    filecode: fileCode,
                                    domain: domain,
                                    subtitles: subs,
                                    thumbnail: streamJson.thumbnail || posterUrl
                                });

                                // BACKUP: Add original API stream link just in case
                                sources.push({
                                    html: `Source ${i + 1} (Backup Stream)`,
                                    url: streamJson.streaming_url,
                                    isEmbed: false,
                                    filecode: fileCode,
                                    domain: domain,
                                    subtitles: subs,
                                    thumbnail: streamJson.thumbnail || posterUrl
                                });
                            }
                        }

                        sources.push({
                            html: `Source ${i + 1} (Embed Fallback)`,
                            url: directEmbedUrl,
                            isEmbed: true,
                            filecode: fileCode,
                            domain: domain
                        });

                    } catch (e) {
                        console.error("Link parsing error:", e);
                    }
                }
            }

            // Remove duplicates
            sources = sources.filter((v, idx, self) =>
                idx === self.findIndex((t) => t.url === v.url && t.html === v.html)
            );

            // Return JSON payload if requested
            if (url.searchParams.get('format') === 'json') {
                const jsonBody = JSON.stringify({
                    videoId,
                    title: apiData.title || 'Video Player',
                    poster: posterUrl,
                    thumbnails: thumbnailsUrl,
                    sources
                });
                if (!bypassCache && kv) {
                    ctx.waitUntil(kv.put(cacheKey, JSON.stringify({ contentType: 'application/json', body: jsonBody }), { expirationTtl: 600 }));
                }
                return new Response(jsonBody, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'public, max-age=600',
                        'Access-Control-Allow-Origin': '*',
                        'X-Cache': bypassCache ? 'BYPASS' : (kv ? 'MISS' : 'NO-KV')
                    }
                });
            }

            // Generate HTML Payload
            const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${(apiData.title || "Video Player").replace(/"/g, '&quot;')}</title>
    <!-- Open connections to both CDNs as early as possible -- this is pure
         DNS+TLS handshake time (can be 100-300ms per origin on a cold
         connection) shaved off before any of the library requests below
         even start. -->
    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
    <link rel="preconnect" href="https://cdn.vidstack.io" crossorigin>
    <!-- These libraries are only needed inside the inline script near the end
         of <body>, but we start fetching them immediately here so the
         download happens in parallel with the rest of the page parsing/
         painting instead of blocking it. The matching <script src> tags
         right before that inline script (unchanged, still synchronous) will
         already be warm in cache by the time the parser reaches them, so
         execution order and timing semantics for the rest of the page are
         untouched -- this only removes the network wait from the critical
         rendering path. -->
    <link rel="preload" as="script" href="https://cdn.jsdelivr.net/npm/artplayer/dist/artplayer.js">
    <link rel="preload" as="script" href="https://cdn.jsdelivr.net/npm/hls.js">
    <link rel="modulepreload" href="https://cdn.jsdelivr.net/npm/@videojs/html/cdn/video.js">
    <!-- Using the "video.js" packaged-skin bundle (registers <video-player> + <video-skin>).
         Deliberately NOT "video-ui.js" + hand-typed <media-container>/<media-controls> markup:
         @videojs/html is still a beta package (10.0.0-beta.x), and that ejected-markup approach
         has already broken once before when an unversioned beta update changed the internal
         component structure -- symptom was a wall of "Cannot read properties of null/undefined"
         console errors (play-button-core.js, tooltip-element.ts, etc.) and a black box with zero
         controls, exactly like this issue. <video-skin> builds its own internal DOM at runtime
         from whatever build actually loaded, so it can't drift out of sync the way hand-typed
         ejected markup can. Self-contained bundle -- no separate stylesheet link needed. -->
    <!-- Vidstack assets: warmed up here (non-blocking) regardless of which engine
         is initially active, so switching to/starting on Vidstack never hits a
         cold network fetch. ensureVidstackAssets() still awaits the real
         load/error events before building the player -- this is a speed
         optimization on top of that correctness guarantee, not a replacement
         for it. -->
    <link rel="preload" as="style" href="https://cdn.vidstack.io/player/theme.css">
    <link rel="preload" as="style" href="https://cdn.vidstack.io/player/video.css">
    <link rel="modulepreload" href="https://cdn.vidstack.io/player">
    <link rel="modulepreload" href="https://cdn.vidstack.io/icons">
    <style>
        /* App-level wrapper styles for the MediaChrome (video-ui.js) engine */
        .mediachrome-app { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: none; }
        .mediachrome-app video-player { width: 100%; height: 100%; }
        .media-sr-only {
            position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
            overflow: hidden; white-space: nowrap; border: 0; clip: rect(0, 0, 0, 0);
        }
        /* Tooltips/popovers are hidden by the UA [popover] rules; if the runtime hasn't
           upgraded them yet they would otherwise sit inline in the control bar as stray
           slivers between the buttons. */
        .media-default-skin .media-tooltip:not([data-open]),
        .media-default-skin .media-popover:not([data-open]) { display: none; }

        /* The skin draws its own rounded surface; the wrapper already clips it. */
        .mediachrome-app media-container { border-radius: 0 !important; }
        /* No poster URL => <img> with no src renders as a broken-image glyph. */
        .mediachrome-app media-poster img:not([src]),
        .mediachrome-app media-poster img[src=""] { display: none; }

        /* ---- Mobile / touch layout for the video-ui skin ---- */
        @media (max-width: 640px), (pointer: coarse) {
            .mediachrome-app .media-controls--primary {
                inset-inline: 4px;
                bottom: 4px;
                padding: 4px;
                gap: 4px;
            }
            /* Keep the top-right group hugging its buttons; stretching it edge to edge
               leaves a large empty translucent slab across the top of the video. */
            .mediachrome-app .media-controls--secondary {
                top: 4px;
                right: 4px;
                left: auto;
                width: auto;
                padding: 4px;
                gap: 4px;
            }
            .mediachrome-app .media-button-group { gap: 2px; min-width: 0; }
            .mediachrome-app .media-button--icon {
                width: 34px;
                height: 34px;
                flex: 0 0 auto;
            }
            .mediachrome-app .media-time {
                font-size: 11px;
                flex: 0 0 auto;
                min-width: 0;
                font-variant-numeric: tabular-nums;
            }
            /* The time slider must be the only element that flexes, otherwise the
               bar overflows the player on narrow screens. */
            .mediachrome-app media-time-slider { flex: 1 1 0; min-width: 40px; }
            /* Hover-only affordances are unusable on touch and eat horizontal space. */
            .mediachrome-app .media-slider__preview,
            .mediachrome-app .media-tooltip,
            .mediachrome-app .media-button--cast,
            .mediachrome-app .media-button--airplay { display: none !important; }

            /* Volume is handled by the device on touch; the popover slider is fiddly. */
            .mediachrome-app .media-popover--volume { display: none !important; }
            /* Settings menu should never exceed the player box. */
            .mediachrome-app .media-menu--settings {
                max-width: calc(100vw - 24px);
                max-height: 60vh;
                overflow: auto;
            }
        }
    </style>

    <style>
        * { box-sizing: border-box; }
        :root {
            --glass-accent-1: #64748b;
            --glass-accent-2: #64748b;
            --glass-accent-3: #64748b;
            --glass-bg: rgba(255, 255, 255, 0.06);
            --glass-border: rgba(255, 255, 255, 0.14);
            --glass-blur: blur(22px) saturate(180%);
        }
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            min-height: 100%;
            background:
                radial-gradient(circle at 15% 0%, rgba(100, 116, 139, 0.18) 0%, transparent 45%),
                radial-gradient(circle at 85% 10%, rgba(100, 116, 139, 0.14) 0%, transparent 45%),
                radial-gradient(circle at 50% 100%, rgba(100, 116, 139, 0.10) 0%, transparent 50%),
                #07070c;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: flex-start;
            justify-content: center;
        }

        .main-container {
            width: 100%;
            max-width: 900px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 10px;
        }

        .embed-chrome-overlay {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        /* Embed mode: video fills the frame by default. The title/source bar
           and the player-selection bar start collapsed (as absolute overlays
           on top of the video, not removed) -- a small toggle button lets
           the viewer bring them back whenever they want. Triggered
           client-side, see the inline script right after <body>. */
        html.embed-mode .main-container {
            position: relative;
            max-width: 100%;
            gap: 0;
            padding: 0;
        }
        html.embed-mode .player-wrapper {
            border-radius: 0;
            border: none;
            box-shadow: none;
            width: 100vw;
            height: 100vh;
            height: 100dvh;
            aspect-ratio: auto;
        }
        html.embed-mode .embed-chrome-overlay {
            position: absolute;
            top: 10px;
            left: 10px;
            right: 54px;
            z-index: 30;
            display: flex;
            flex-direction: column;
            gap: 8px;
            opacity: 0;
            pointer-events: none;
            transform: translateY(-6px);
            transition: opacity 0.18s ease, transform 0.18s ease;
        }
        html.embed-mode.chrome-open .embed-chrome-overlay {
            opacity: 1;
            pointer-events: auto;
            transform: translateY(0);
        }
        .embed-chrome-toggle {
            display: none;
        }
        html.embed-mode .embed-chrome-toggle {
            display: flex;
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 31;
            width: 34px;
            height: 34px;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            background: rgba(10, 10, 16, 0.55);
            border: 1px solid rgba(255,255,255,0.18);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            color: #fff;
            cursor: pointer;
        }
        .embed-chrome-toggle svg {
            transition: transform 0.18s ease;
        }
        html.embed-mode.chrome-open .embed-chrome-toggle svg {
            transform: rotate(180deg);
        }

        .top-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            background: linear-gradient(135deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02));
            padding: 12px 16px;
            border-radius: 14px;
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
            border: 1px solid var(--glass-border);
            box-shadow: 0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08);
        }

        .video-title-text {
            font-size: 13px;
            font-weight: 700;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 65%;
            letter-spacing: 0.1px;
            background: linear-gradient(90deg, #f1f5f9, #cbd5e1 60%, #94a3b8);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }

        .source-select-dropdown {
            appearance: none;
            -webkit-appearance: none;
            background:
                linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02)),
                url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2394a3b8' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 10px center, right 10px center;
            background-size: auto, 10px 6px;
            color: #e0f2fe;
            border: 1px solid var(--glass-border);
            backdrop-filter: blur(10px);
            padding: 7px 26px 7px 12px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            outline: none;
            cursor: pointer;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
            transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .source-select-dropdown:hover {
            border-color: rgba(100, 116, 139, 0.5);
            box-shadow: 0 0 0 3px rgba(100, 116, 139, 0.12), inset 0 1px 0 rgba(255,255,255,0.08);
        }
        .source-select-dropdown option {
            background: #12141c;
            color: #e2e8f0;
        }

        /* Player engine switcher — always visible segmented control */
        .engine-switch-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            background: linear-gradient(135deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02));
            padding: 8px 10px;
            border-radius: 14px;
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
            border: 1px solid var(--glass-border);
            box-shadow: 0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08);
        }
        .engine-switch-label {
            font-size: 10px;
            font-weight: 800;
            letter-spacing: 1.4px;
            text-transform: uppercase;
            color: #64748b;
            padding-left: 4px;
            flex-shrink: 0;
        }
        .engine-switch {
            display: flex;
            align-items: center;
            gap: 4px;
            flex: 1 1 auto;
            min-width: 0;
            background: rgba(0,0,0,0.35);
            border: 1px solid var(--glass-border);
            border-radius: 999px;
            padding: 3px;
        }
        .engine-switch.loading {
            opacity: 0.6;
            pointer-events: none;
            cursor: wait;
        }
        .engine-opt {
            flex: 1 1 0;
            min-width: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            background: transparent;
            color: #94a3b8;
            border: 0;
            padding: 8px 10px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.2px;
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
        }
        .engine-opt::before {
            content: '';
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: currentColor;
            opacity: 0.45;
            flex-shrink: 0;
        }
        .engine-opt:hover {
            color: #e2e8f0;
            background: rgba(255,255,255,0.06);
        }
        .engine-opt:active { transform: scale(0.97); }
        .engine-opt[aria-pressed="true"] {
            color: #e0f2fe;
            background: linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.04));
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 0 0 1px var(--glass-border);
        }
        .engine-opt[aria-pressed="true"]::before {
            opacity: 1;
            background: linear-gradient(135deg, var(--glass-accent-1), var(--glass-accent-3));
        }

        @media (max-width: 560px) {
            .top-bar { flex-wrap: wrap; }
            .video-title-text { max-width: 100%; flex: 1 1 100%; }
            .source-select-dropdown { flex: 1 1 auto; min-width: 0; }
            .engine-switch-label { display: none; }
            .engine-opt { font-size: 11px; padding: 8px 6px; }
        }


        /* Remember-source-choice toggle */
        .remember-source-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02));
            color: #94a3b8;
            border: 1px solid var(--glass-border);
            backdrop-filter: blur(10px);
            width: 30px;
            height: 30px;
            border-radius: 999px;
            font-size: 13px;
            line-height: 1;
            cursor: pointer;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
            transition: border-color 0.15s ease, box-shadow 0.15s ease, color 0.15s ease, transform 0.1s ease;
            flex-shrink: 0;
        }
        .remember-source-btn:hover {
            border-color: rgba(100, 116, 139, 0.5);
            box-shadow: 0 0 0 3px rgba(100, 116, 139, 0.12), inset 0 1px 0 rgba(255,255,255,0.08);
        }
        .remember-source-btn:active {
            transform: scale(0.92);
        }
        .remember-source-btn.active {
            color: #ffffff;
            border-color: rgba(100, 116, 139, 0.6);
            background: linear-gradient(135deg, var(--glass-accent-2), var(--glass-accent-1));
            box-shadow: 0 0 0 3px rgba(100, 116, 139, 0.18), inset 0 1px 0 rgba(255,255,255,0.15);
        }

        .vidstack-app {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: none;
        }
        .vidstack-app media-player {
            width: 100%;
            height: 100%;
        }
        /* Vidstack buffering spinner: speed up rotation, strip any scale/opacity
           "bounce" pulsing. Vidstack doesn't publish exact class names for its
           bundled default-theme CSS, so this targets the component broadly with
           !important. If it doesn't fully take effect, inspect the live element
           in DevTools (right-click the spinner -> Inspect) and send a screenshot
           of its class name so this can be targeted precisely. */
        media-buffering-indicator, media-buffering-indicator * {
            animation-duration: 0.5s !important;
            animation-timing-function: linear !important;
            animation-iteration-count: infinite !important;
        }
        media-buffering-indicator svg,
        media-buffering-indicator svg * {
            transform-box: fill-box;
            transform-origin: center;
        }

        /* History overlay */
        .history-overlay {
            position: absolute;
            top: 12px;
            left: 12px;
            z-index: 9999;
        }

        .history-grid {
            display: grid;
            gap: 10px;
        }

        .inline-history-section {
            width: 100%;
            margin-top: 8px;
        }

        .inline-history-title {
            font-size: 14px;
            font-weight: 600;
            opacity: 0.75;
            margin-bottom: 12px;
        }

        /* Iframe/embed pages never show the inline history block — they keep
           the popup history button on the player instead (see .history-overlay). */
        html.embed-mode .inline-history-section {
            display: none !important;
        }

        .inline-history-section:has(#inline-history-grid:empty) {
            display: none;
        }

        .history-pager {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            padding: 10px 0 4px;
        }

        .history-pager-btn {
            background: rgba(255,255,255,0.08);
            border: none;
            color: inherit;
            width: 28px;
            height: 28px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
        }

        .history-pager-btn:disabled {
            opacity: 0.3;
            cursor: default;
        }

        .history-pager-btn:not(:disabled):hover {
            background: rgba(255,255,255,0.16);
        }

        .history-pager-label {
            font-size: 12px;
            opacity: 0.7;
        }

        .history-btn {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border-radius: 999px;
            background: linear-gradient(135deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03));
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: #f1f5f9;
            cursor: pointer;
            backdrop-filter: blur(10px) saturate(180%);
            -webkit-backdrop-filter: blur(10px) saturate(180%);
            box-shadow: 0 4px 18px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15);
            transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
        }
        .history-btn::before {
            content: '';
            position: absolute;
            inset: -1px;
            border-radius: 999px;
            padding: 1px;
            background: linear-gradient(135deg, var(--glass-accent-1), var(--glass-accent-2), var(--glass-accent-3));
            -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
            -webkit-mask-composite: xor;
            mask-composite: exclude;
            opacity: 0;
            transition: opacity 0.2s ease;
            pointer-events: none;
        }
        .history-btn:hover {
            transform: scale(1.08);
            box-shadow: 0 6px 24px rgba(100, 116, 139, 0.35), inset 0 1px 0 rgba(255,255,255,0.2);
        }
        .history-btn:hover::before {
            opacity: 1;
        }
        .history-btn.active {
            border-color: transparent;
            box-shadow: 0 0 0 3px rgba(100, 116, 139, 0.25), 0 6px 24px rgba(100, 116, 139, 0.3);
        }
        .history-btn.active::before {
            opacity: 1;
        }

        .history-panel {
            position: absolute;
            top: calc(100% + 10px);
            left: 0;
            width: 290px;
            max-height: 0;
            overflow: hidden;
            opacity: 0;
            background: linear-gradient(160deg, rgba(30, 20, 45, 0.65), rgba(10, 10, 16, 0.75));
            backdrop-filter: blur(24px) saturate(180%);
            -webkit-backdrop-filter: blur(24px) saturate(180%);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 16px;
            box-shadow: 0 24px 60px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.1);
            z-index: 9999;
            transform: translateY(-8px) scale(0.96);
            transform-origin: top left;
            transition: max-height 0.3s ease, opacity 0.22s ease, transform 0.24s cubic-bezier(0.2, 0.8, 0.3, 1.2);
        }
        .history-panel::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 2px;
            background: linear-gradient(90deg, var(--glass-accent-1), var(--glass-accent-2), var(--glass-accent-3));
            border-radius: 16px 16px 0 0;
        }
        .history-panel.open {
            max-height: 350px;
            opacity: 1;
            transform: translateY(0) scale(1);
            overflow-y: auto;
        }
        .history-panel-title {
            font-size: 10.5px;
            font-weight: 800;
            letter-spacing: 0.8px;
            text-transform: uppercase;
            background: linear-gradient(90deg, #e2e8f0, #94a3b8);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            padding: 14px 16px 8px;
            position: sticky;
            top: 0;
            background-color: transparent;
        }
        .history-empty {
            padding: 20px 16px 24px;
            font-size: 12.5px;
            color: #94a3b8;
            text-align: center;
        }
        .history-item {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 0;
            margin: 0;
            border-radius: 12px;
            text-decoration: none;
            color: inherit;
            transition: transform 0.15s ease;
        }
        .history-item:hover {
            transform: translateY(-2px);
        }
        .history-item-thumb-wrap {
            position: relative;
            width: 100%;
            aspect-ratio: 16 / 9;
        }
        .history-item-thumb {
            width: 100%;
            height: 100%;
            object-fit: cover;
            border-radius: 10px;
            background: #1e293b;
            border: 1px solid rgba(255,255,255,0.1);
            display: block;
        }
        .history-item-badge {
            position: absolute;
            right: 6px;
            bottom: 6px;
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
            padding: 3px 6px;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.8);
            color: #f1f5f9;
            letter-spacing: 0.2px;
        }
        .history-item-progress-track {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 3px;
            background: rgba(0,0,0,0.4);
            border-radius: 0 0 10px 10px;
            overflow: hidden;
        }
        .history-item-progress-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--glass-accent-3), var(--glass-accent-1));
        }
        .history-item-info {
            display: flex;
            flex-direction: column;
            gap: 3px;
            min-width: 0;
            padding: 0 2px;
        }
        .history-item-title {
            font-size: 13px;
            font-weight: 600;
            color: #f1f5f9;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            line-height: 1.35;
        }
        .history-item-meta {
            font-size: 11px;
            color: #94a3b8;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .history-item-dot {
            width: 2px;
            height: 2px;
            border-radius: 50%;
            background: #64748b;
            flex-shrink: 0;
        }

        .player-wrapper {
            position: relative;
            width: 100%;
            aspect-ratio: 16 / 9;
            background: #000;
            border-radius: 14px;
            overflow: hidden;
            box-shadow: 0 20px 50px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.06);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        /* Portrait/vertical source (TikTok, YouTube Shorts style 9:16 clips):
           reshape the box to the video's real aspect ratio instead of forcing
           it into the 16:9 frame. --video-ar is set by JS once the active
           engine reports real dimensions. Without this, the video renders
           tiny and pillarboxed inside a landscape box, which is what breaks
           each engine's control-bar layout differently. */
        .player-wrapper.is-portrait {
            align-self: center;
            width: auto;
            height: min(80vh, 80dvh);
            max-width: 100%;
            aspect-ratio: var(--video-ar, 9 / 16);
        }
        /* Force the actual <video> element in every engine to fill its
           custom-element container exactly, regardless of the video's own
           intrinsic pixel size. This is what stops a portrait video's real
           dimensions from pushing any engine's control bar below/outside the
           clipped, clickable player box. */
        .mediachrome-app video-player video,
        .vidstack-app media-player video,
        #artplayer-app video {
            width: 100% !important;
            height: 100% !important;
            object-fit: contain !important;
        }
        /* Mobile Chrome/Android draws its own default tap-highlight flash and a
           blue focus ring on any tappable/focusable element -- including the
           <media-player> custom element and the buttons inside its default
           layout. Neither is part of our design, and since they only appear
           on tap/focus (not always-on), they show up as an intermittent
           "stray mark" on top of the video that isn't in any of our own
           rules. Kill both across the whole player area. */
        .player-wrapper,
        .player-wrapper *,
        .player-wrapper *::before,
        .player-wrapper *::after {
            -webkit-tap-highlight-color: transparent;
        }
        .player-wrapper media-player,
        .player-wrapper media-player *:focus,
        .player-wrapper media-player *:focus-visible {
            outline: none !important;
        }

        #artplayer-app {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            border: none !important;
            margin: 0 !important;
        }

        .embed-fallback-box {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 14px;
            background: radial-gradient(circle at center, #151823 0%, #090a0f 100%);
            z-index: 10;
        }
        .embed-fallback-box.active {
            display: flex;
        }
        .embed-open-btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: linear-gradient(135deg, var(--glass-accent-1), var(--glass-accent-3));
            color: #fff;
            font-weight: 700;
            font-size: 14px;
            padding: 12px 22px;
            border-radius: 999px;
            border: 1px solid rgba(255,255,255,0.25);
            cursor: pointer;
            box-shadow: 0 10px 30px rgba(100, 116, 139, 0.4);
            transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .embed-open-btn:hover {
            box-shadow: 0 12px 36px rgba(100, 116, 139, 0.45);
        }
        .embed-open-btn:active {
            transform: scale(0.97);
        }
        .embed-fallback-note {
            color: #8a93a6;
            font-size: 12px;
            text-align: center;
            max-width: 260px;
        }

        .skip-btn {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            cursor: pointer;
            opacity: 0.9;
            transition: opacity 0.15s ease, transform 0.15s ease;
        }
        .skip-btn:hover {
            opacity: 1;
            transform: scale(1.08);
        }
        .skip-btn .skip-icon {
            width: 22px;
            height: 22px;
            fill: none;
            stroke: #ffffff;
            stroke-width: 1.8;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        .skip-btn.forward .skip-icon {
            transform: scaleX(-1);
        }
        .skip-btn .skip-label {
            position: absolute;
            top: 52%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 8.5px;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: -0.3px;
            pointer-events: none;
        }
    </style>
</head>
<body>
    <script>
        // Embed mode: pass ?embed=1 on the URL to force it, or it's auto-detected
        // when this page is loaded inside an iframe (e.g. an <iframe> embed on
        // another site). Runs before the rest of <body> paints so the
        // title/source bar and player-switch bar never flash on screen first.
        window.__isEmbed = false;
        (function () {
            try {
                var params = new URLSearchParams(window.location.search);
                var forceEmbed = params.get('embed');
                var isEmbed = (forceEmbed === '1' || forceEmbed === 'true')
                    || (forceEmbed !== '0' && forceEmbed !== 'false' && window.self !== window.top);
                window.__isEmbed = isEmbed;
                if (isEmbed) document.documentElement.classList.add('embed-mode');
            } catch (e) { /* noop */ }
        })();
    </script>
    <div class="main-container">
        <button id="embed-chrome-toggle" class="embed-chrome-toggle" type="button" title="Show/hide title and player options" aria-label="Show/hide title and player options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="embed-chrome-overlay">
        <div class="top-bar">
            <span class="video-title-text">${(apiData.title || "Video Player").replace(/</g, '&lt;')}</span>
            <select id="top-source-select" class="source-select-dropdown" onchange="switchSourceFromDropdown(this.value)">
                ${sources.map((s, idx) => `<option value="${idx}">${s.html}</option>`).join('')}
            </select>
            <button id="remember-source-btn" class="remember-source-btn" type="button" title="Remember this source choice">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.5c0-.5-.3-1-.8-1.2L16 12.5V6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1v6.5l-2.2 1.8c-.5.2-.8.7-.8 1.2V17z"/></svg>
            </button>
        </div>

        <div class="engine-switch-bar">
            <span class="engine-switch-label">Player</span>
            <div id="player-engine-switch" class="engine-switch" role="group" aria-label="Switch player engine">
                <button class="engine-opt" type="button" data-engine="mediachrome" aria-pressed="false">Player.js</button>
                <button class="engine-opt" type="button" data-engine="artplayer" aria-pressed="false">ArtPlayer</button>
                <button class="engine-opt" type="button" data-engine="vidstack" aria-pressed="false">Vidstack</button>
            </div>
        </div>
        </div>


        <a href="/api/void-walker" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;" tabindex="-1" aria-hidden="true" rel="nofollow">do not follow this link</a>

        <div class="player-wrapper">
            <div id="artplayer-app"></div>
            <div id="vidstack-app" class="vidstack-app"></div>
            <div id="mediachrome-app" class="mediachrome-app"></div>
            <div id="embed-fallback-box" class="embed-fallback-box">
                <button class="embed-open-btn" id="embed-open-btn" type="button">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    Watch on Source
                </button>
                <span class="embed-fallback-note">Opens in a new tab — direct stream unavailable for this source</span>
            </div>
            <div class="history-overlay">
                <button id="history-btn" class="history-btn" type="button" title="Watch History" aria-label="Watch History">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
                </button>
                <div id="history-panel" class="history-panel">
                    <div class="history-panel-title">Recently Watched</div>
                </div>
            </div>
        </div>

        <div id="inline-history-section" class="inline-history-section">
            <div class="inline-history-title">Recently Watched</div>
            <div id="inline-history-grid" class="history-grid"></div>
            <div id="inline-history-pager"></div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/artplayer/dist/artplayer.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/hls.js"></script>
    <script type="module" src="https://cdn.jsdelivr.net/npm/@videojs/html/cdn/video.js"></script>
    <script>
        let sources = ${JSON.stringify(sources)};
        let posterImage = ${JSON.stringify(posterUrl || '')};
        let thumbnailsUrl = ${JSON.stringify(thumbnailsUrl)};
        let videoId = ${JSON.stringify(videoId)};
        let videoTitle = ${JSON.stringify(apiData.title || "Video Player")};

        // ---- Ad-gate media token ----
        // The page itself was only reachable because of a valid ?token= in this exact
        // URL (see the ad-gate check in the Worker). The /api/custom-hls/ endpoint that
        // actually serves the stream enforces the SAME token separately (it doesn't trust
        // "you were able to load this HTML" on its own) — otherwise someone with just the
        // stream URL could skip the ad page entirely. This snippet reads the token back out
        // of our own address bar and stamps it onto every custom-hls URL before use, and
        // onto every /api/refetch call so refreshed stream links carry it forward too.
        window.__adGateToken = new URLSearchParams(window.location.search).get('token') || '';
        (function stampAdGateToken() {
            if (!window.__adGateToken) return;
            sources = sources.map(function (s) {
                if (s && s.url && s.url.indexOf('/api/custom-hls/') !== -1) {
                    const sep = s.url.indexOf('?') === -1 ? '?' : '&';
                    s.url = s.url + sep + 'token=' + encodeURIComponent(window.__adGateToken);
                }
                return s;
            });
        })();

        // ---- Watch History (localStorage) ----
        // Hidden entirely when this page is loaded inside an <iframe> embed —
        // history is a feature of the direct/normal page only.
        const HISTORY_KEY = 'vidara_watch_history';
        const HISTORY_LIMIT = 20;

        // Single place to control both the pagination page-size and the grid
        // column count — set both to whatever number you want per page/row.
        const HISTORY_PAGE_SIZE = 6;   // items shown per page
        const HISTORY_GRID_COLS = 3;   // items per row (grid-template-columns)
        let historyPage = 0;           // 0-indexed current page

        function loadHistory() {
            try {
                const raw = localStorage.getItem(HISTORY_KEY);
                const list = raw ? JSON.parse(raw) : [];
                return Array.isArray(list) ? list : [];
            } catch (e) {
                return [];
            }
        }

        function saveHistory(list) {
            try {
                localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
            } catch (e) { /* noop */ }
        }

        function recordHistory() {
            if (!videoId) return;
            const existing = loadHistory().find(function (item) { return item.id === videoId; });
            let list = loadHistory().filter(function (item) { return item.id !== videoId; });
            list.unshift({
                id: videoId,
                title: videoTitle,
                poster: posterImage,
                ts: Date.now(),
                position: existing ? (existing.position || 0) : 0,
                duration: existing ? (existing.duration || 0) : 0
            });
            if (list.length > HISTORY_LIMIT) list = list.slice(0, HISTORY_LIMIT);
            saveHistory(list);
        }

        let lastProgressSaveTs = 0;
        function updateHistoryProgress(position, duration) {
            if (!videoId || !duration) return;
            const now = Date.now();
            if (now - lastProgressSaveTs < 4000) return;
            lastProgressSaveTs = now;
            const list = loadHistory();
            const idx = list.findIndex(function (item) { return item.id === videoId; });
            if (idx === -1) return;
            list[idx].position = position;
            list[idx].duration = duration;
            saveHistory(list);
        }

        function timeAgo(ts) {
            const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
            if (diffSec < 60) return 'Just now';
            if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
            if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
            return Math.floor(diffSec / 86400) + 'd ago';
        }

        function formatTime(sec) {
            sec = Math.max(0, Math.floor(sec || 0));
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
            const ss = String(s).padStart(2, '0');
            return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
        }

        function escapeHtml(str) {
            return String(str || '').replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }

        function buildHistoryRows(list) {
            return list.map(function (item) {
                const thumb = item.poster
                    ? '<img class="history-item-thumb" src="' + escapeHtml(item.poster) + '" onerror="this.style.display=\\'none\\'">'
                    : '<div class="history-item-thumb"></div>';

                const hasProgress = item.duration > 0;
                const pct = hasProgress ? Math.min(100, Math.round((item.position / item.duration) * 100)) : 0;
                const badge = hasProgress
                    ? '<span class="history-item-badge">' + formatTime(item.position) + '</span>'
                    : '';
                const progressBar = hasProgress
                    ? '<div class="history-item-progress-track"><div class="history-item-progress-fill" style="width:' + pct + '%"></div></div>'
                    : '';
                const metaText = hasProgress
                    ? formatTime(item.position) + ' / ' + formatTime(item.duration)
                    : 'Not started';
                const resumeParam = hasProgress && pct < 95 ? '?t=' + Math.floor(item.position) : '';

                return '<a class="history-item" href="./' + encodeURIComponent(item.id) + resumeParam +
                    '" data-video-id="' + escapeHtml(item.id) + '" data-resume="' + (hasProgress ? Math.floor(item.position) : 0) + '">' +
                    '<div class="history-item-thumb-wrap">' +
                        thumb +
                        badge +
                        progressBar +
                    '</div>' +
                    '<div class="history-item-info">' +
                        '<span class="history-item-title">' + escapeHtml(item.title) + '</span>' +
                        '<span class="history-item-meta">' +
                            '<span>' + metaText + '</span>' +
                            '<span class="history-item-dot"></span>' +
                            '<span>' + timeAgo(item.ts) + '</span>' +
                        '</span>' +
                    '</div>' +
                '</a>';
            }).join('');
        }

        function buildHistoryPager(totalPages) {
            if (totalPages <= 1) return '';
            return '<div class="history-pager">' +
                '<button type="button" class="history-pager-btn" id="history-prev" ' + (historyPage === 0 ? 'disabled' : '') + '>‹</button>' +
                '<span class="history-pager-label">' + (historyPage + 1) + ' / ' + totalPages + '</span>' +
                '<button type="button" class="history-pager-btn" id="history-next" ' + (historyPage === totalPages - 1 ? 'disabled' : '') + '>›</button>' +
              '</div>';
        }

        function wirePagerButtons(renderFn) {
            const prevBtn = document.getElementById('history-prev');
            const nextBtn = document.getElementById('history-next');
            if (prevBtn) prevBtn.addEventListener('click', function () { historyPage--; renderFn(); });
            if (nextBtn) nextBtn.addEventListener('click', function () { historyPage++; renderFn(); });
        }

        // Embed pages: popup panel triggered by the history button on the player.
        function renderHistoryPanel() {
            const panel = document.getElementById('history-panel');
            if (!panel) return;
            const fullList = loadHistory().filter(function (item) { return item.id !== videoId; });

            if (!fullList.length) {
                panel.innerHTML = '<div class="history-panel-title">Recently Watched</div><div class="history-empty">No other videos watched yet</div>';
                return;
            }

            const totalPages = Math.max(1, Math.ceil(fullList.length / HISTORY_PAGE_SIZE));
            if (historyPage >= totalPages) historyPage = totalPages - 1;
            if (historyPage < 0) historyPage = 0;
            const start = historyPage * HISTORY_PAGE_SIZE;
            const list = fullList.slice(start, start + HISTORY_PAGE_SIZE);

            panel.innerHTML = '<div class="history-panel-title">Recently Watched</div>' +
                '<div class="history-grid" style="grid-template-columns:1fr">' + buildHistoryRows(list) + '</div>' +
                buildHistoryPager(totalPages);

            wirePagerButtons(renderHistoryPanel);
        }

        // Direct/normal page: always-visible grid below the player, no popup.
        function renderInlineHistory() {
            const section = document.getElementById('inline-history-section');
            const grid = document.getElementById('inline-history-grid');
            const pagerEl = document.getElementById('inline-history-pager');
            if (!section || !grid) return;

            const fullList = loadHistory().filter(function (item) { return item.id !== videoId; });
            if (!fullList.length) {
                grid.innerHTML = '';
                pagerEl.innerHTML = '';
                return;
            }

            const totalPages = Math.max(1, Math.ceil(fullList.length / HISTORY_PAGE_SIZE));
            if (historyPage >= totalPages) historyPage = totalPages - 1;
            if (historyPage < 0) historyPage = 0;
            const start = historyPage * HISTORY_PAGE_SIZE;
            const list = fullList.slice(start, start + HISTORY_PAGE_SIZE);

            grid.style.gridTemplateColumns = 'repeat(' + HISTORY_GRID_COLS + ', 1fr)';
            grid.innerHTML = buildHistoryRows(list);
            pagerEl.innerHTML = buildHistoryPager(totalPages);

            wirePagerButtons(renderInlineHistory);
            // No click override here — history-item is a plain <a href="./videoId">,
            // so clicking it does a real page navigation (full reload), not an
            // internal loadVideo() switch. That's what makes the new video's own
            // page URL/history get recorded correctly.
        }

        recordHistory();

        const historyBtnEl = document.getElementById('history-btn');
        const historyPanelEl = document.getElementById('history-panel');
        let historyOpen = false;

        if (window.__isEmbed) {
            // Embed pages: history stays behind the popup button on the player.
            function setHistoryOpen(open) {
                historyOpen = open;
                historyBtnEl.classList.toggle('active', open);
                historyPanelEl.classList.toggle('open', open);
                if (open) { historyPage = 0; renderHistoryPanel(); }
            }

            historyBtnEl.addEventListener('click', function (e) {
                e.stopPropagation();
                setHistoryOpen(!historyOpen);
            });
            historyPanelEl.addEventListener('click', function (e) {
                e.stopPropagation();
                const link = e.target.closest('.history-item');
                if (!link) return;
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                const id = link.getAttribute('data-video-id');
                if (!id) return;
                e.preventDefault();
                const resumeAt = parseFloat(link.getAttribute('data-resume')) || 0;
                setHistoryOpen(false);
                loadVideo(id, { resumeAt: resumeAt });
            });
            document.addEventListener('click', function () {
                if (historyOpen) setHistoryOpen(false);
            });
            document.addEventListener('keydown', function (e) {
                if (historyOpen && e.key === 'Escape') setHistoryOpen(false);
            });
        } else {
            // Direct/normal page: always-visible grid below the player, no popup needed.
            renderInlineHistory();
        }

        // ---- Remembered theme color ----
        const THEME_KEY = 'vidara_theme_color';
        function getSavedThemeColor() {
            try { return localStorage.getItem(THEME_KEY) || '#00b3ff'; } catch (e) { return '#00b3ff'; }
        }
        function saveThemeColor(color) {
            try { localStorage.setItem(THEME_KEY, color); } catch (e) { /* noop */ }
        }
        const savedThemeColor = getSavedThemeColor();

        // ---- Remembered player engine + preferences ----
        const PREFS_KEY = 'vidara_player_prefs';
        function loadPrefs() {
            try {
                const raw = localStorage.getItem(PREFS_KEY);
                const p = raw ? JSON.parse(raw) : {};
                return {
                    engine: (p.engine === 'vidstack' || p.engine === 'artplayer' || p.engine === 'mediachrome') ? p.engine : 'mediachrome',
                    autoplay: p.autoplay !== undefined ? !!p.autoplay : true,
                    loop: !!p.loop,
                    flip: !!p.flip,
                    miniProgressBar: p.miniProgressBar !== false,
                    muted: !!p.muted,
                    volume: p.volume !== undefined ? p.volume : 1,
                    playbackRate: [0.5, 0.75, 1, 1.25, 1.5, 2].includes(p.playbackRate) ? p.playbackRate : 1,
                    rememberSource: !!p.rememberSource,
                    preferredSourceLabel: p.preferredSourceLabel || null
                };
            } catch (e) {
                return { engine: 'mediachrome', autoplay: true, loop: false, flip: false, miniProgressBar: true, muted: false, volume: 1, playbackRate: 1, rememberSource: false, preferredSourceLabel: null };
            }
        }
        function savePrefs(patch) {
            const current = loadPrefs();
            const next = Object.assign(current, patch);
            try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch (e) { /* noop */ }
            return next;
        }
        const savedPrefs = loadPrefs();

        let currentSourceIndex = sources.findIndex(s => !s.isEmbed);
        if (currentSourceIndex === -1) currentSourceIndex = 0;

        if (savedPrefs.rememberSource && savedPrefs.preferredSourceLabel) {
            const rememberedIdx = sources.findIndex(function (s) { return s.html === savedPrefs.preferredSourceLabel; });
            if (rememberedIdx !== -1) currentSourceIndex = rememberedIdx;
        }

        let currentSource = sources[currentSourceIndex];
        let hlsInstance = null;
        let isRetrying = false;
        let hlsErrorCount = 0; // consecutive recoverable errors since the last good fragment
        let hlsErrorResetTimer = null;
        let artReadyForVolumeSave = false;
        let vidstackReadyForVolumeSave = false;
        let mediachromeReadyForVolumeSave = false;
        let mediachromeHlsInstance = null;
        let skipSeconds = 10;

        function seekBy(delta) {
            if (!window.art) return;
            const duration = art.duration || 0;
            let target = art.currentTime + delta;
            if (target < 0) target = 0;
            if (duration && target > duration) target = duration;
            art.currentTime = target;
        }

        function updateSkipLabels() {
            document.querySelectorAll('.skip-label').forEach(function (el) {
                el.textContent = skipSeconds;
            });
        }

        const artplayerAppEl = document.getElementById('artplayer-app');
        const vidstackAppEl = document.getElementById('vidstack-app');
        const mediachromeAppEl = document.getElementById('mediachrome-app');
        const embedFallbackBoxEl = document.getElementById('embed-fallback-box');
        const embedOpenBtnEl = document.getElementById('embed-open-btn');
        const playerToggleBtnEl = document.getElementById('player-engine-switch');
        function markActiveEngineButton(engine) {
            if (!playerToggleBtnEl) return;
            const opts = playerToggleBtnEl.querySelectorAll('.engine-opt');
            for (let i = 0; i < opts.length; i++) {
                opts[i].setAttribute('aria-pressed', String(opts[i].getAttribute('data-engine') === engine));
            }
        }
        const rememberSourceBtnEl = document.getElementById('remember-source-btn');
        const embedChromeToggleBtnEl = document.getElementById('embed-chrome-toggle');
        if (embedChromeToggleBtnEl) {
            embedChromeToggleBtnEl.addEventListener('click', function () {
                document.documentElement.classList.toggle('chrome-open');
            });
        }

        document.getElementById('top-source-select').value = currentSourceIndex;

        // --- "Remember this source" toggle ---
        function updateRememberBtnUI() {
            const isActive = !!savedPrefs.rememberSource;
            rememberSourceBtnEl.classList.toggle('active', isActive);
            rememberSourceBtnEl.title = isActive
                ? 'Remembering "' + (currentSource ? currentSource.html : '') + '" — click to stop remembering'
                : 'Remember this source choice';
        }
        rememberSourceBtnEl.addEventListener('click', function () {
            const next = !savedPrefs.rememberSource;
            savedPrefs.rememberSource = next;
            savedPrefs.preferredSourceLabel = next ? currentSource.html : savedPrefs.preferredSourceLabel;
            savePrefs({ rememberSource: next, preferredSourceLabel: savedPrefs.preferredSourceLabel });
            updateRememberBtnUI();
            if (window.art) art.notice.show = next ? 'Will remember this source next time' : 'Source choice will not be remembered';
        });
        updateRememberBtnUI();

        function destroyHls() {
            if (hlsInstance) {
                try { hlsInstance.destroy(); } catch (e) { /* noop */ }
                hlsInstance = null;
            }
            if (hlsErrorResetTimer) { clearTimeout(hlsErrorResetTimer); hlsErrorResetTimer = null; }
            hlsErrorCount = 0;
        }

        // --- Fullscreen preservation ---
        let switchingSource = false;
        let fullscreenBeforeSwitch = false;
        let switchGuardTimer = null;

        function isPlayerFullscreen() {
            if (activePlayerEngine === 'vidstack' && vidstackEl) {
                return (vidstackEl.state && vidstackEl.state.fullscreen) || !!document.fullscreenElement;
            }
            if (activePlayerEngine === 'mediachrome') {
                return !!document.fullscreenElement;
            }
            return !!(window.art && (art.fullscreen || art.fullscreenWeb));
        }

        function beginSourceSwitch() {
            switchingSource = true;
            fullscreenBeforeSwitch = isPlayerFullscreen();
            clearTimeout(switchGuardTimer);
            switchGuardTimer = setTimeout(finishSourceSwitch, 1500);
        }

        function finishSourceSwitch() {
            if (!switchingSource) return;
            switchingSource = false;
            clearTimeout(switchGuardTimer);
            if (fullscreenBeforeSwitch) {
                lockLandscape();
                if (!isPlayerFullscreen()) {
                    if (activePlayerEngine === 'vidstack' && vidstackEl) {
                        try { if (vidstackEl.enterFullscreen) vidstackEl.enterFullscreen(); } catch (e) {}
                    } else if (activePlayerEngine === 'mediachrome' && mediachromePlayerEl) {
                        try { if (mediachromePlayerEl.requestFullscreen) mediachromePlayerEl.requestFullscreen(); } catch (e) {}
                    } else if (window.art) {
                        try { art.fullscreen = true; } catch (e) {}
                    }
                }
            }
        }

        // --- Portrait/vertical video handling (TikTok/Shorts-style 9:16 clips) ---
        // The player box defaults to a fixed 16:9 landscape frame. Forcing a
        // portrait video into that frame is what causes each engine's control
        // bar to break in its own way (Artplayer's controls compress into each
        // other, Media Chrome's control bar renders below the visible/clickable
        // area, Vidstack mis-sizes its layout) -- the underlying video content
        // is tiny and pillarboxed inside a box shaped for something else. The
        // fix is to reshape .player-wrapper itself to match the real video once
        // we know its dimensions, so every engine renders controls against a
        // frame that actually matches its content.
        function getElVideoDims(el) {
            if (!el) return { w: 0, h: 0 };
            if (el.videoWidth && el.videoHeight) return { w: el.videoWidth, h: el.videoHeight };
            var inner = el.querySelector && el.querySelector('video');
            if (inner && inner.videoWidth && inner.videoHeight) return { w: inner.videoWidth, h: inner.videoHeight };
            return { w: 0, h: 0 };
        }
        function applyVideoAspectRatio(w, h) {
            var wrapper = document.querySelector('.player-wrapper');
            if (!wrapper || !w || !h) return;
            if (h > w) {
                wrapper.style.setProperty('--video-ar', w + ' / ' + h);
                wrapper.classList.add('is-portrait');
            } else {
                wrapper.classList.remove('is-portrait');
                wrapper.style.removeProperty('--video-ar');
            }
        }
        function resetVideoAspectRatio() {
            var wrapper = document.querySelector('.player-wrapper');
            if (wrapper) wrapper.classList.remove('is-portrait');
        }

        // --- Vidstack ---
        let activePlayerEngine = savedPrefs.engine; 
        let vidstackEl = null;
        let vidstackReadyPromise = null;

        function ensureVidstackAssets() {
            if (vidstackReadyPromise) return vidstackReadyPromise;

            function loadStylesheet(id, href) {
                const existing = document.getElementById(id);
                if (existing) {
                    if (existing.dataset.loaded === '1') return Promise.resolve();
                    return new Promise(function (resolve) {
                        existing.addEventListener('load', resolve, { once: true });
                        existing.addEventListener('error', resolve, { once: true });
                    });
                }
                return new Promise(function (resolve) {
                    const l = document.createElement('link');
                    l.id = id; l.rel = 'stylesheet'; l.href = href;
                    l.addEventListener('load', function () { l.dataset.loaded = '1'; resolve(); }, { once: true });
                    l.addEventListener('error', resolve, { once: true }); // don't hang forever if it 404s/blocks
                    document.head.appendChild(l);
                });
            }

            const cssReady = Promise.all([
                loadStylesheet('vidstack-theme-css', 'https://cdn.vidstack.io/player/theme.css'),
                loadStylesheet('vidstack-video-css', 'https://cdn.vidstack.io/player/video.css')
            ]);

            if (!document.getElementById('vidstack-script')) {
                const s = document.createElement('script'); s.id = 'vidstack-script'; s.type = 'module'; s.src = 'https://cdn.vidstack.io/player'; document.head.appendChild(s);
            }
            if (!document.getElementById('vidstack-icons-script')) {
                const s2 = document.createElement('script'); s2.id = 'vidstack-icons-script'; s2.type = 'module'; s2.src = 'https://cdn.vidstack.io/icons'; document.head.appendChild(s2);
            }

            vidstackReadyPromise = Promise.all([
                customElements.whenDefined('media-player'),
                customElements.whenDefined('media-video-layout'),
                cssReady
            ]);
            return vidstackReadyPromise;
        }

        function buildVidstackElIfNeeded() {
            if (vidstackEl) return vidstackEl;
            vidstackEl = document.createElement('media-player');
            vidstackEl.setAttribute('title', videoTitle);
            vidstackEl.setAttribute('crossorigin', '');
            vidstackEl.setAttribute('playsinline', '');
            if (posterImage) vidstackEl.setAttribute('poster', posterImage);
            
            if (savedPrefs.autoplay) vidstackEl.setAttribute('autoplay', '');
            if (savedPrefs.loop) vidstackEl.setAttribute('loop', '');
            if (savedPrefs.muted) vidstackEl.setAttribute('muted', '');
            vidstackEl.volume = savedPrefs.volume;
            vidstackEl.playbackRate = savedPrefs.playbackRate;

            const provider = document.createElement('media-provider');
            if (savedPrefs.flip) provider.style.transform = 'scaleX(-1)';

            const layout = document.createElement('media-video-layout');
            layout.colorScheme = 'dark'; // force dark theme regardless of system/browser color-scheme preference
            if (thumbnailsUrl) layout.setAttribute('thumbnails', thumbnailsUrl);

            vidstackEl.appendChild(provider);
            vidstackEl.appendChild(layout);
            vidstackAppEl.appendChild(vidstackEl);
            syncVidstackTracks();

            vidstackEl.addEventListener('time-update', function () { updateHistoryProgress(vidstackEl.currentTime, vidstackEl.duration || 0); });
            vidstackEl.addEventListener('pause', function () { updateHistoryProgress(vidstackEl.currentTime, vidstackEl.duration || 0); lastProgressSaveTs = 0; });
            vidstackEl.addEventListener('volume-change', function () {
                if (!vidstackReadyForVolumeSave) return;
                savePrefs({ muted: vidstackEl.muted, volume: vidstackEl.volume });
            });
            vidstackEl.addEventListener('rate-change', function () {
                if (!vidstackReadyForVolumeSave) return;
                savePrefs({ playbackRate: vidstackEl.playbackRate });
            });
            vidstackEl.addEventListener('can-play', function onFirstCanPlay() {
                vidstackEl.muted = savedPrefs.muted; vidstackEl.volume = savedPrefs.volume; vidstackEl.playbackRate = savedPrefs.playbackRate;
                vidstackReadyForVolumeSave = true; vidstackEl.removeEventListener('can-play', onFirstCanPlay);
            });
            vidstackEl.addEventListener('fullscreen-change', function (e) {
                const isFullscreen = e.detail; 
                if (isFullscreen) { lockLandscape(); moveHistoryOverlayIntoVidstack(); } else { moveHistoryOverlayHome(); if (!switchingSource) unlockOrientation(); }
            });
            vidstackEl.addEventListener('loaded-metadata', function () {
                if (activePlayerEngine !== 'vidstack') return;
                var dims = getElVideoDims(vidstackEl);
                applyVideoAspectRatio(dims.w, dims.h);
            });
            return vidstackEl;
        }

        function showVidstackSource(url) {
            vidstackAppEl.style.display = 'block';
            playerToggleBtnEl.classList.add('loading');
            resetVideoAspectRatio();

            beginSourceSwitch();
            ensureVidstackAssets().then(function () {
                const el = buildVidstackElIfNeeded();
                syncVidstackTracks();
                const onCanPlay = function () {
                    finishSourceSwitch();
                    if (savedPrefs.autoplay) el.play().catch(function(){});
                    el.removeEventListener('can-play', onCanPlay);
                };
                el.addEventListener('can-play', onCanPlay);

                el.type = 'application/x-mpegurl';
                el.src = url;

                if (savedPrefs.autoplay) el.setAttribute('autoplay', '');
                else el.removeAttribute('autoplay');

                playerToggleBtnEl.classList.remove('loading');
            }).catch(finishSourceSwitch);
        }

        function pauseVidstackIfActive() {
            if (vidstackEl && typeof vidstackEl.pause === 'function') {
                try { vidstackEl.pause(); } catch (e) {}
            }
        }

        // --- MediaChrome (video-ui.js custom-element player) ---
        let mediachromeVideoEl = null;
        let mediachromePlayerEl = null;

        function buildMediaChromeElIfNeeded() {
            if (mediachromeVideoEl) return mediachromeVideoEl;

            mediachromeAppEl.innerHTML =
                '<video-player>' +
                '<video-skin>' +
                '<video playsinline></video>' +
                '</video-skin>' +
                '</video-player>';


            mediachromePlayerEl = mediachromeAppEl.querySelector('video-player');
            mediachromeVideoEl = mediachromeAppEl.querySelector('video');
            if (posterImage && mediachromeVideoEl) mediachromeVideoEl.poster = posterImage;


            if (savedPrefs.autoplay) mediachromeVideoEl.setAttribute('autoplay', '');
            if (savedPrefs.loop) mediachromeVideoEl.setAttribute('loop', '');
            mediachromeVideoEl.muted = savedPrefs.muted;
            mediachromeVideoEl.volume = savedPrefs.volume;
            mediachromeVideoEl.playbackRate = savedPrefs.playbackRate;
            if (savedPrefs.flip) mediachromeVideoEl.style.transform = 'scaleX(-1)';

            syncMediaChromeTracks();

            mediachromeVideoEl.addEventListener('timeupdate', function () { updateHistoryProgress(mediachromeVideoEl.currentTime, mediachromeVideoEl.duration || 0); });
            mediachromeVideoEl.addEventListener('pause', function () { updateHistoryProgress(mediachromeVideoEl.currentTime, mediachromeVideoEl.duration || 0); lastProgressSaveTs = 0; });
            mediachromeVideoEl.addEventListener('volumechange', function () {
                if (!mediachromeReadyForVolumeSave) return;
                savePrefs({ muted: mediachromeVideoEl.muted, volume: mediachromeVideoEl.volume });
            });
            mediachromeVideoEl.addEventListener('ratechange', function () {
                if (!mediachromeReadyForVolumeSave) return;
                savePrefs({ playbackRate: mediachromeVideoEl.playbackRate });
            });
            mediachromeVideoEl.addEventListener('canplay', function onFirstCanPlay() {
                mediachromeVideoEl.muted = savedPrefs.muted; mediachromeVideoEl.volume = savedPrefs.volume; mediachromeVideoEl.playbackRate = savedPrefs.playbackRate;
                mediachromeReadyForVolumeSave = true; mediachromeVideoEl.removeEventListener('canplay', onFirstCanPlay);
            });
            mediachromeVideoEl.addEventListener('loadedmetadata', function () {
                if (activePlayerEngine !== 'mediachrome') return;
                applyVideoAspectRatio(mediachromeVideoEl.videoWidth, mediachromeVideoEl.videoHeight);
            });
            document.addEventListener('fullscreenchange', function () {
                if (activePlayerEngine !== 'mediachrome') return;
                if (document.fullscreenElement) { lockLandscape(); moveHistoryOverlayIntoMediaChrome(); } else { moveHistoryOverlayHome(); if (!switchingSource) unlockOrientation(); }
            });

            return mediachromeVideoEl;
        }

        function loadMediaChromeHlsSource(video, url) {
            if (mediachromeHlsInstance) { try { mediachromeHlsInstance.destroy(); } catch (e) {} mediachromeHlsInstance = null; }
            if (window.Hls && Hls.isSupported()) {
                // Same tuning as the Artplayer engine's Hls instance below --
                // this one was previously created with zero config, which
                // meant it ran on hls.js's defaults: no enableWorker (demuxing
                // competes with page JS on the main thread), a lower default
                // buffer window, and no capLevelToPlayerSize (can fetch a
                // higher resolution than the player is displayed at). All of
                // that shows up as extra stalling/buffering specifically on
                // this engine.
                mediachromeHlsInstance = new Hls({
                    enableWorker: true,
                    maxBufferLength: 60,
                    maxMaxBufferLength: 120,
                    backBufferLength: 30,
                    maxBufferHole: 0.5,
                    capLevelToPlayerSize: true
                });
                mediachromeHlsInstance.loadSource(url);
                mediachromeHlsInstance.attachMedia(video);
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = url;
            } else {
                video.src = url;
            }
        }

        function showMediaChromeSource(url) {
            mediachromeAppEl.style.display = 'block';
            playerToggleBtnEl.classList.add('loading');
            resetVideoAspectRatio();

            beginSourceSwitch();
            const video = buildMediaChromeElIfNeeded();
            syncMediaChromeTracks();

            const onCanPlay = function () {
                finishSourceSwitch();
                if (savedPrefs.autoplay) video.play().catch(function () {});
                video.removeEventListener('canplay', onCanPlay);
            };
            video.addEventListener('canplay', onCanPlay);

            if (/\\.m3u8($|\\?)/i.test(url)) {
                loadMediaChromeHlsSource(video, url);
            } else {
                video.src = url;
            }

            playerToggleBtnEl.classList.remove('loading');
        }

        function pauseMediaChromeIfActive() {
            if (mediachromeVideoEl && typeof mediachromeVideoEl.pause === 'function') {
                try { mediachromeVideoEl.pause(); } catch (e) {}
            }
        }

        function syncMediaChromeTracks() {
            if (!mediachromeVideoEl) return;
            Array.prototype.slice.call(mediachromeVideoEl.querySelectorAll('track')).forEach(function (t) { t.remove(); });
            const subs = (currentSource && currentSource.subtitles) || [];
            subs.forEach(function (s, idx) {
                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.src = s.url;
                track.srclang = (s.language || 'und').slice(0, 2).toLowerCase();
                track.label = s.language || ('Track ' + (idx + 1));
                mediachromeVideoEl.appendChild(track);
            });
            if (thumbnailsUrl) {
                const thumbTrack = document.createElement('track');
                thumbTrack.kind = 'metadata';
                thumbTrack.label = 'thumbnails';
                thumbTrack.src = thumbnailsUrl;
                mediachromeVideoEl.appendChild(thumbTrack);
            }
        }

        function exitAnyFullscreen() {
            try { if (window.art && (art.fullscreen || art.fullscreenWeb)) art.fullscreen = false; } catch (e) {}
            try { if (activePlayerEngine === 'vidstack' && vidstackEl && vidstackEl.exitFullscreen) vidstackEl.exitFullscreen(); } catch (e) {}
            try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
        }

        function currentEngineTime() {
            if (activePlayerEngine === 'artplayer' && window.art) return art.currentTime || 0;
            if (activePlayerEngine === 'vidstack' && vidstackEl) return vidstackEl.currentTime || 0;
            if (activePlayerEngine === 'mediachrome' && mediachromeVideoEl) return mediachromeVideoEl.currentTime || 0;
            return 0;
        }
        function currentEngineWasPlaying() {
            if (activePlayerEngine === 'artplayer' && window.art) return !art.paused;
            if (activePlayerEngine === 'vidstack' && vidstackEl) return !vidstackEl.paused;
            if (activePlayerEngine === 'mediachrome' && mediachromeVideoEl) return !mediachromeVideoEl.paused;
            return false;
        }

        const ENGINE_LABELS = { artplayer: 'ArtPlayer', vidstack: 'Vidstack', mediachrome: 'Player.js' };
        const ENGINE_ORDER = ['mediachrome', 'artplayer', 'vidstack'];

        function pauseAllEngines() {
            if (window.art) { try { art.pause(); } catch (e) {} }
            pauseVidstackIfActive();
            pauseMediaChromeIfActive();
        }

        function hideAllEngineContainers() {
            artplayerAppEl.style.display = 'none';
            vidstackAppEl.style.display = 'none';
            mediachromeAppEl.style.display = 'none';
        }

        function setPlayerEngine(nextEngine) {
            if (!nextEngine || ENGINE_ORDER.indexOf(nextEngine) === -1) return;
            if (nextEngine === activePlayerEngine) return;
            if (currentSource.isEmbed) {
                if (window.art) art.notice.show = 'Pick a direct-stream source first';
                return;
            }
            exitAnyFullscreen();
            const resumeAt = currentEngineTime();
            const wasPlaying = currentEngineWasPlaying();

            pauseAllEngines();
            activePlayerEngine = nextEngine; savePrefs({ engine: nextEngine });
            markActiveEngineButton(nextEngine);
            hideAllEngineContainers();

            if (nextEngine === 'vidstack') {
                showVidstackSource(currentSource.url);
                ensureVidstackAssets().then(function () {
                    const el = vidstackEl;
                    const onReady = function () {
                        el.currentTime = resumeAt;
                        if (wasPlaying || savedPrefs.autoplay) el.play().catch(function () {});
                        el.removeEventListener('can-play', onReady);
                    };
                    el.addEventListener('can-play', onReady);
                });
            } else if (nextEngine === 'mediachrome') {
                showMediaChromeSource(currentSource.url);
                const el = mediachromeVideoEl;
                const onReady = function () {
                    el.currentTime = resumeAt;
                    if (wasPlaying || savedPrefs.autoplay) el.play().catch(function () {});
                    el.removeEventListener('canplay', onReady);
                };
                el.addEventListener('canplay', onReady);
            } else {
                artplayerAppEl.style.display = 'block';
                if (window.art) {
                    resetVideoAspectRatio();
                    beginSourceSwitch();
                    art.once('video:loadeddata', finishSourceSwitch);
                    Promise.resolve(art.switchUrl(currentSource.url)).then(function () {
                        finishSourceSwitch();
                        art.currentTime = resumeAt;
                        if (wasPlaying) art.play();
                    }).catch(finishSourceSwitch);
                }
            }
        }

        function togglePlayerEngine() {
            setPlayerEngine(ENGINE_ORDER[(ENGINE_ORDER.indexOf(activePlayerEngine) + 1) % ENGINE_ORDER.length]);
        }

        if (playerToggleBtnEl) {
            playerToggleBtnEl.addEventListener('click', function (e) {
                const btn = e.target && e.target.closest ? e.target.closest('.engine-opt') : null;
                if (!btn) return;
                setPlayerEngine(btn.getAttribute('data-engine'));
            });
        }


        function showEmbed(url) {
            pauseAllEngines();
            destroyHls();
            hideAllEngineContainers();
            embedFallbackBoxEl.classList.add('active');
            embedOpenBtnEl.onclick = function () { window.open(url, '_blank', 'noopener'); };
        }

        function showActiveEnginePlayer(url) {
            embedFallbackBoxEl.classList.remove('active');
            if (activePlayerEngine === 'vidstack') {
                showVidstackSource(url);
                return;
            }
            if (activePlayerEngine === 'mediachrome') {
                showMediaChromeSource(url);
                return;
            }
            vidstackAppEl.style.display = 'none';
            mediachromeAppEl.style.display = 'none';
            artplayerAppEl.style.display = 'block';
            if (window.art) {
                resetVideoAspectRatio();
                beginSourceSwitch();
                art.once('video:loadeddata', finishSourceSwitch);
                Promise.resolve(art.switchUrl(url)).then(finishSourceSwitch).catch(finishSourceSwitch);
            }
        }

        function buildSubtitleSelector() {
            const subs = (currentSource && currentSource.subtitles) || [];
            const list = [{ html: 'Off', value: '', default: true }];
            subs.forEach(function (s) { list.push({ html: s.language || 'Unknown', value: s.url }); });
            return list;
        }
        function syncArtSubtitleSetting() {
            try {
                if (window.art && art.setting) {
                    art.setting.update({ html: 'Subtitles', tooltip: 'Off', selector: buildSubtitleSelector() });
                }
            } catch (e) { /* noop */ }
        }
        function syncVidstackTracks() {
            if (!vidstackEl) return;
            Array.prototype.slice.call(vidstackEl.querySelectorAll('track')).forEach(function (t) { t.remove(); });
            const subs = (currentSource && currentSource.subtitles) || [];
            subs.forEach(function (s, idx) {
                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.src = s.url;
                track.srclang = (s.language || 'und').slice(0, 2).toLowerCase();
                track.label = s.language || ('Track ' + (idx + 1));
                vidstackEl.appendChild(track);
            });
        }

        function switchSourceFromDropdown(index) {
            const selectedIdx = parseInt(index, 10);
            currentSourceIndex = selectedIdx;
            currentSource = sources[selectedIdx];
            if (savedPrefs.rememberSource) {
                savedPrefs.preferredSourceLabel = currentSource.html;
                savePrefs({ preferredSourceLabel: currentSource.html });
            }
            if (typeof updateRememberBtnUI === 'function') updateRememberBtnUI();
            syncArtSubtitleSetting();

            if (currentSource.thumbnail) {
                posterImage = currentSource.thumbnail;
                if (window.art) art.poster = posterImage;
                if (vidstackEl) vidstackEl.setAttribute('poster', posterImage);
            }

            if (currentSource.isEmbed) {
                showEmbed(currentSource.url);
            } else {
                showActiveEnginePlayer(currentSource.url);
            }
        }

        let isLoadingVideo = false;
        function idFromPath(pathname) {
            const segs = pathname.split('/').filter(Boolean);
            return segs.length ? decodeURIComponent(segs[segs.length - 1]) : null;
        }

        function loadVideo(id, opts) {
            opts = opts || {};
            if (!id || id === videoId || isLoadingVideo) return;
            isLoadingVideo = true;
            if (window.art) art.notice.show = 'Loading video...';

            fetch('./' + encodeURIComponent(id) + '?format=json')
                .then(function (res) { if (!res.ok) throw new Error('Failed to load video'); return res.json(); })
                .then(function (data) {
                    videoId = data.videoId || id; videoTitle = data.title || 'Video Player'; posterImage = data.poster || ''; thumbnailsUrl = data.thumbnails || ''; sources = data.sources || [];
                    currentSourceIndex = sources.findIndex(function (s) { return !s.isEmbed; });
                    if (currentSourceIndex === -1) currentSourceIndex = 0;
                    if (savedPrefs.rememberSource && savedPrefs.preferredSourceLabel) {
                        const rememberedIdx = sources.findIndex(function (s) { return s.html === savedPrefs.preferredSourceLabel; });
                        if (rememberedIdx !== -1) currentSourceIndex = rememberedIdx;
                    }
                    currentSource = sources[currentSourceIndex];
                    if (typeof updateRememberBtnUI === 'function') updateRememberBtnUI();

                    document.title = videoTitle;
                    const titleEl = document.querySelector('.video-title-text');
                    if (titleEl) titleEl.textContent = videoTitle;
                    const topSelectEl = document.getElementById('top-source-select');
                    if (topSelectEl) {
                        topSelectEl.innerHTML = sources.map(function (s, idx) { return '<option value="' + idx + '">' + escapeHtml(s.html) + '</option>'; }).join('');
                        topSelectEl.value = currentSourceIndex;
                    }
                    try { if (window.art && art.setting) { art.setting.update({ html: 'Source Selector', tooltip: currentSource ? currentSource.html : 'None', selector: sources.map(function (s, idx) { return { html: s.html, url: s.url, index: idx, isEmbed: s.isEmbed, default: idx === currentSourceIndex }; }) }); } } catch (e) {}
                    syncArtSubtitleSetting();
                    if (vidstackEl) syncVidstackTracks();

                    if (window.art) {
                        art.poster = (currentSource && currentSource.thumbnail) || posterImage;
                        if (thumbnailsUrl) art.option.thumbnails = { url: thumbnailsUrl };
                        else art.option.thumbnails = {};
                    }
                    if (vidstackEl) {
                        const activePoster = (currentSource && currentSource.thumbnail) || posterImage;
                        if (activePoster) vidstackEl.setAttribute('poster', activePoster); else vidstackEl.removeAttribute('poster');
                        vidstackEl.setAttribute('title', videoTitle);
                        const layout = vidstackEl.querySelector('media-video-layout');
                        if (layout) { if (thumbnailsUrl) layout.setAttribute('thumbnails', thumbnailsUrl); else layout.removeAttribute('thumbnails'); }
                    }
                    if (mediachromeVideoEl) {
                        const activePoster = (currentSource && currentSource.thumbnail) || posterImage;
                        mediachromeVideoEl.poster = activePoster || '';
                    }

                    lastProgressSaveTs = 0; recordHistory(); renderHistoryPanel();
                    if (opts.pushState !== false) { try { history.pushState({ videoId: videoId }, '', './' + encodeURIComponent(videoId)); } catch (e) {} }

                    const resumeAt = opts.resumeAt || 0;
                    function applyResume() {
                        if (activePlayerEngine === 'vidstack' && vidstackEl) {
                            const onCanPlay = function () {
                                if (resumeAt > 0 && vidstackEl.duration && resumeAt < vidstackEl.duration - 2) vidstackEl.currentTime = resumeAt;
                                if (savedPrefs.autoplay) vidstackEl.play().catch(function(){}); 
                                vidstackEl.removeEventListener('can-play', onCanPlay);
                            };
                            vidstackEl.addEventListener('can-play', onCanPlay);
                        } else if (activePlayerEngine === 'mediachrome' && mediachromeVideoEl) {
                            const onCanPlay = function () {
                                if (resumeAt > 0 && mediachromeVideoEl.duration && resumeAt < mediachromeVideoEl.duration - 2) mediachromeVideoEl.currentTime = resumeAt;
                                if (savedPrefs.autoplay) mediachromeVideoEl.play().catch(function(){});
                                mediachromeVideoEl.removeEventListener('canplay', onCanPlay);
                            };
                            mediachromeVideoEl.addEventListener('canplay', onCanPlay);
                        } else if (window.art && resumeAt > 0) {
                            art.once('video:loadedmetadata', function () { if (art.duration && resumeAt < art.duration - 2) art.currentTime = resumeAt; });
                        }
                    }

                    if (currentSource.isEmbed) { showEmbed(currentSource.url); } else { showActiveEnginePlayer(currentSource.url); applyResume(); }
                })
                .catch(function (e) { console.error('loadVideo error:', e); if (window.art) art.notice.show = 'Failed to load video'; })
                .finally(function () { isLoadingVideo = false; });
        }

        window.addEventListener('popstate', function () { const id = idFromPath(location.pathname); if (id) loadVideo(id, { pushState: false }); });

        if (currentSource.isEmbed) {
            markActiveEngineButton(activePlayerEngine);
            showEmbed(currentSource.url);
        } else if (activePlayerEngine === 'vidstack') {
            embedFallbackBoxEl.classList.remove('active'); markActiveEngineButton('vidstack');
            artplayerAppEl.style.display = 'none'; mediachromeAppEl.style.display = 'none';
            showVidstackSource(currentSource.url);
        } else if (activePlayerEngine === 'mediachrome') {
            embedFallbackBoxEl.classList.remove('active'); markActiveEngineButton('mediachrome');
            artplayerAppEl.style.display = 'none'; vidstackAppEl.style.display = 'none';
            showMediaChromeSource(currentSource.url);
        } else {
            embedFallbackBoxEl.classList.remove('active'); markActiveEngineButton('artplayer');
            vidstackAppEl.style.display = 'none'; mediachromeAppEl.style.display = 'none';
            artplayerAppEl.style.display = 'block';
        }

        // --- Refetch Logic ---
        async function refetchStream(filecode, domain) {
            if (!filecode) return false;
            if (window.art) art.notice.show = 'Refreshing stream link...';
            try {
                const res = await fetch(\`/api/refetch?filecode=\${filecode}&domain=\${encodeURIComponent(domain)}&token=\${encodeURIComponent(window.__adGateToken || '')}\`);
                const json = await res.json();
                if (json.streaming_url) {
                    currentSource.url = json.streaming_url;
                    if (window.art) art.notice.show = 'Stream refreshed! Playing...';

                    if (activePlayerEngine === 'vidstack' && vidstackEl) {
                        beginSourceSwitch(); vidstackEl.src = json.streaming_url; vidstackEl.play().catch(function(){}); finishSourceSwitch(); return true;
                    }

                    if (hlsInstance) {
                        beginSourceSwitch(); hlsInstance.loadSource(json.streaming_url); art.play(); finishSourceSwitch();
                    } else if (window.art) {
                        beginSourceSwitch(); art.once('video:loadeddata', finishSourceSwitch); Promise.resolve(art.switchUrl(json.streaming_url)).then(finishSourceSwitch).catch(finishSourceSwitch);
                    }
                    return true;
                }
            } catch (e) { console.error("Refetch error:", e); }
            if (window.art) art.notice.show = 'Refresh failed. Try Embed Fallback.';
            return false;
        }

        // --- Artplayer Init ---
        let artConfig = {
            container: '#artplayer-app',
            url: currentSource.isEmbed ? '' : currentSource.url,
            type: 'm3u8', poster: posterImage, theme: savedThemeColor, autoSize: true, fullscreen: true, fullscreenWeb: true, pip: true, screenshot: false, setting: true,
            autoplay: savedPrefs.autoplay, loop: savedPrefs.loop, flip: false, playbackRate: true, aspectRatio: false, miniProgressBar: savedPrefs.miniProgressBar, muted: savedPrefs.muted, volume: savedPrefs.volume, lock: true, fastForward: true,
            subtitle: { type: 'vtt', escape: false },
            customType: {
                m3u8: function (video, url, art) {
                    destroyHls();
                    if (Hls.isSupported()) {
                        hlsInstance = new Hls({
                            // enableWorker moves segment demuxing off the main thread —
                            // this alone is usually the biggest single fix for "choppy"
                            // playback, since UI/scroll/other JS no longer competes with
                            // video decoding on the same thread.
                            enableWorker: true,
                            // Hold more buffer ahead so a brief network dip doesn't empty
                            // it and cause a visible stall. Defaults (30s) are on the low
                            // side for a segment-varying, non-adaptive source like this one.
                            maxBufferLength: 60,
                            maxMaxBufferLength: 120,
                            backBufferLength: 30,
                            maxBufferHole: 0.5,
                            // Don't fetch a higher resolution than the player is actually
                            // displayed at — saves bandwidth, which is itself a common
                            // cause of stutter on slower connections.
                            capLevelToPlayerSize: true
                        });
                        hlsInstance.loadSource(url);
                        hlsInstance.attachMedia(video);

                        // A fragment loading successfully means the stream is healthy
                        // again, so the error counter resets.
                        hlsInstance.on(Hls.Events.FRAG_LOADED, function () {
                            hlsErrorCount = 0;
                        });

                        hlsInstance.on(Hls.Events.ERROR, function (event, data) {
                            if (!data.fatal) return; // non-fatal errors are routine; HLS.js already handles them internally

                            // Previously EVERY fatal error immediately tore the player down
                            // and did a full refetchStream() — a fresh /api/stream call plus
                            // a brand new HLS init. That's a visible restart/stutter for
                            // errors HLS.js can usually recover from on its own. Now we try
                            // its built-in recovery first, and only escalate to a full
                            // refetch after repeated failures in a short window.
                            hlsErrorCount++;
                            if (hlsErrorResetTimer) clearTimeout(hlsErrorResetTimer);
                            hlsErrorResetTimer = setTimeout(function () { hlsErrorCount = 0; }, 15000);

                            if (hlsErrorCount > 3) {
                                if (!isRetrying) {
                                    isRetrying = true;
                                    hlsErrorCount = 0;
                                    refetchStream(currentSource.filecode, currentSource.domain).then(function () { isRetrying = false; });
                                }
                                return;
                            }

                            switch (data.type) {
                                case Hls.ErrorTypes.NETWORK_ERROR:
                                    console.warn('HLS network error, retrying load...', data);
                                    hlsInstance.startLoad();
                                    break;
                                case Hls.ErrorTypes.MEDIA_ERROR:
                                    console.warn('HLS media error, attempting recovery...', data);
                                    hlsInstance.recoverMediaError();
                                    break;
                                default:
                                    if (!isRetrying) {
                                        isRetrying = true;
                                        refetchStream(currentSource.filecode, currentSource.domain).then(function () { isRetrying = false; });
                                    }
                                    break;
                            }
                        });
                    } else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; }
                    video.muted = savedPrefs.muted; video.volume = savedPrefs.volume;
                }
            },
            controls: [
                { position: 'left', index: 1, html: '<div class="skip-btn"><svg class="skip-icon" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/></svg><span class="skip-label">10</span></div>', tooltip: 'Rewind', click: function () { seekBy(-skipSeconds); } },
                { position: 'left', index: 2, html: '<div class="skip-btn forward"><svg class="skip-icon" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/></svg><span class="skip-label">10</span></div>', tooltip: 'Forward', click: function () { seekBy(skipSeconds); } },
                { position: 'right', html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>', tooltip: 'Re-fetch stream link if unplayable', click: function () { if (currentSource && currentSource.filecode) { refetchStream(currentSource.filecode, currentSource.domain); } else { art.notice.show = 'No filecode available'; } } }
            ],
            settings: [
                {
                    width: 260, html: 'Source Selector', tooltip: currentSource ? currentSource.html : 'None',
                    selector: sources.map((s, idx) => ({ html: s.html, url: s.url, index: idx, isEmbed: s.isEmbed, default: idx === currentSourceIndex })),
                    onSelect: function (item) { document.getElementById('top-source-select').value = item.index; switchSourceFromDropdown(item.index); return item.html; }
                },
                {
                    width: 220, html: 'Subtitles', tooltip: 'Off',
                    selector: buildSubtitleSelector(),
                    onSelect: function (item) {
                        try {
                            if (!item.value) { art.subtitle.hide(); return 'Off'; }
                            art.subtitle.switch(item.value, { name: item.html, type: 'vtt' });
                            art.subtitle.show();
                        } catch (e) { /* noop */ }
                        return item.html;
                    }
                },
                {
                    width: 200, html: 'Theme Color', tooltip: (function () { const names = { '#00b3ff': 'Blue', '#ff0055': 'Red', '#00ff66': 'Green', '#ffcc00': 'Yellow', '#a100ff': 'Purple', '#ffffff': 'White' }; return names[savedThemeColor] || 'Blue'; })(),
                    selector: [ { html: 'Blue', value: '#00b3ff' }, { html: 'Red', value: '#ff0055' }, { html: 'Green', value: '#00ff66' }, { html: 'Yellow', value: '#ffcc00' }, { html: 'Purple', value: '#a100ff' }, { html: 'White', value: '#ffffff' } ].map(function (c) { c.default = (c.value === savedThemeColor); return c; }),
                    onSelect: function (item) { art.theme = item.value; saveThemeColor(item.value); return item.html; }
                },
                {
                    width: 200, html: 'Skip Duration', tooltip: '10s',
                    selector: [ { html: '10 seconds', value: 10, default: true }, { html: '15 seconds', value: 15 }, { html: '20 seconds', value: 20 }, { html: '30 seconds', value: 30 } ],
                    onSelect: function (item) { skipSeconds = item.value; updateSkipLabels(); return item.html; }
                },
                { html: 'Auto Play', switch: savedPrefs.autoplay, onSwitch: function (item) { art.option.autoplay = !item.switch; savePrefs({ autoplay: !item.switch }); if (vidstackEl) { if (!item.switch) { vidstackEl.setAttribute('autoplay', ''); vidstackEl.play().catch(function(){}); } else { vidstackEl.removeAttribute('autoplay'); } } if (mediachromeVideoEl) { if (!item.switch) { mediachromeVideoEl.setAttribute('autoplay', ''); mediachromeVideoEl.play().catch(function(){}); } else { mediachromeVideoEl.removeAttribute('autoplay'); } } return !item.switch; } },
                { html: 'Loop', switch: savedPrefs.loop, onSwitch: function (item) { art.option.loop = !item.switch; savePrefs({ loop: !item.switch }); if (vidstackEl) { if (!item.switch) vidstackEl.setAttribute('loop', ''); else vidstackEl.removeAttribute('loop'); } if (mediachromeVideoEl) { if (!item.switch) mediachromeVideoEl.setAttribute('loop', ''); else mediachromeVideoEl.removeAttribute('loop'); } return !item.switch; } },
                { html: 'Mute', switch: savedPrefs.muted, onSwitch: function (item) { art.muted = !item.switch; savePrefs({ muted: !item.switch }); if (vidstackEl) { vidstackEl.muted = !item.switch; } if (mediachromeVideoEl) { mediachromeVideoEl.muted = !item.switch; } return !item.switch; } },
                { html: 'Flip Video', switch: savedPrefs.flip, onSwitch: function (item) { art.flip = !item.switch ? 'horizontal' : 'normal'; savePrefs({ flip: !item.switch }); if (vidstackEl) { const provider = vidstackEl.querySelector('media-provider'); if (provider) provider.style.transform = !item.switch ? 'scaleX(-1)' : ''; } if (mediachromeVideoEl) { mediachromeVideoEl.style.transform = !item.switch ? 'scaleX(-1)' : ''; } return !item.switch; } },
                { html: 'Mini Progress', switch: savedPrefs.miniProgressBar, onSwitch: function (item) { art.option.miniProgressBar = !item.switch; savePrefs({ miniProgressBar: !item.switch }); return !item.switch; } }
            ]
        };

        if (thumbnailsUrl) artConfig.thumbnails = { url: thumbnailsUrl };
        var art = new Artplayer(artConfig);

        art.on('video:volumechange', function () { if (!artReadyForVolumeSave) return; savePrefs({ muted: art.muted, volume: art.volume }); });
        art.on('video:ratechange', function () { if (!artReadyForVolumeSave) return; savePrefs({ playbackRate: art.playbackRate }); });
        art.on('video:loadedmetadata', function () {
            if (activePlayerEngine !== 'artplayer') return;
            var dims = getElVideoDims(art.video || (art.template && art.template.$video));
            applyVideoAspectRatio(dims.w, dims.h);
        });
        art.on('video:timeupdate', function () { updateHistoryProgress(art.currentTime, art.duration); });
        art.on('pause', function () { updateHistoryProgress(art.currentTime, art.duration); lastProgressSaveTs = 0; });

        (function applyResumeFromLink() {
            const resumeAt = parseFloat(new URLSearchParams(window.location.search).get('t'));
            if (!resumeAt || resumeAt <= 0) return;
            art.once('video:loadedmetadata', function () { if (art.duration && resumeAt < art.duration - 2) { art.currentTime = resumeAt; } });
            if (activePlayerEngine === 'vidstack') {
                ensureVidstackAssets().then(function() {
                    const el = buildVidstackElIfNeeded();
                    const onCanPlay = function () { if (el.duration && resumeAt < el.duration - 2) { el.currentTime = resumeAt; } if (savedPrefs.autoplay) el.play().catch(function(){}); el.removeEventListener('can-play', onCanPlay); };
                    el.addEventListener('can-play', onCanPlay);
                });
            } else if (activePlayerEngine === 'mediachrome') {
                const el = buildMediaChromeElIfNeeded();
                const onCanPlay = function () { if (el.duration && resumeAt < el.duration - 2) { el.currentTime = resumeAt; } if (savedPrefs.autoplay) el.play().catch(function(){}); el.removeEventListener('canplay', onCanPlay); };
                el.addEventListener('canplay', onCanPlay);
            }
        })();

        function lockLandscape() { if (screen.orientation && screen.orientation.lock) { screen.orientation.lock('landscape').catch(function () {}); } }
        function unlockOrientation() { if (screen.orientation && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch (e) {} } }

        var historyOverlayEl = document.querySelector('.history-overlay');
        var historyOverlayHomeParent = historyOverlayEl ? historyOverlayEl.parentNode : null;
        function moveHistoryOverlayIntoArtplayer() { if (!historyOverlayEl) return; var playerRoot = (art.template && art.template.$player) || document.getElementById('artplayer-app'); if (playerRoot && historyOverlayEl.parentNode !== playerRoot) { playerRoot.appendChild(historyOverlayEl); } }
        function moveHistoryOverlayIntoVidstack() { if (!historyOverlayEl || !vidstackEl) return; if (historyOverlayEl.parentNode !== vidstackEl) { vidstackEl.appendChild(historyOverlayEl); } }
        function moveHistoryOverlayIntoMediaChrome() { if (!historyOverlayEl || !mediachromePlayerEl) return; if (historyOverlayEl.parentNode !== mediachromePlayerEl) { mediachromePlayerEl.appendChild(historyOverlayEl); } }
        function moveHistoryOverlayHome() { if (!historyOverlayEl || !historyOverlayHomeParent) return; if (historyOverlayEl.parentNode !== historyOverlayHomeParent) { historyOverlayHomeParent.appendChild(historyOverlayEl); } }

        art.on('fullscreen', function (state) { if (state) { lockLandscape(); moveHistoryOverlayIntoArtplayer(); } else { moveHistoryOverlayHome(); if (!switchingSource) unlockOrientation(); } });
        art.on('fullscreenWeb', function (state) { if (state) { lockLandscape(); moveHistoryOverlayIntoArtplayer(); } else { moveHistoryOverlayHome(); if (!switchingSource) unlockOrientation(); } });

        function swapSiblings(a, b) { if (!a || !b || a.parentNode !== b.parentNode) return; var parent = a.parentNode; var aNext = a.nextSibling === b ? a : a.nextSibling; parent.insertBefore(a, b); parent.insertBefore(b, aNext); }
        art.on('ready', function () {
            try { var pipEl = art.controls['pip']; var fsEl = art.controls['fullscreen'] || art.controls['fullscreenWeb']; swapSiblings(pipEl, fsEl); } catch (e) {}
            if (savedPrefs.flip) { try { art.flip = 'horizontal'; } catch (e) {} }
            try { art.muted = savedPrefs.muted; art.volume = savedPrefs.volume; art.playbackRate = savedPrefs.playbackRate; } catch (e) {}
            artReadyForVolumeSave = true;
        });
    </script>
</body>
</html>
            `;

            if (!bypassCache && kv) {
                ctx.waitUntil(kv.put(cacheKey, JSON.stringify({ contentType: 'text/html;charset=UTF-8', body: html }), { expirationTtl: 600 }));
            }
            return new Response(html, {
                headers: {
                    'Content-Type': 'text/html;charset=UTF-8',
                    'Cache-Control': 'public, max-age=600',
                    'Access-Control-Allow-Origin': '*',
                    'X-Cache': bypassCache ? 'BYPASS' : (kv ? 'MISS' : 'NO-KV')
                }
            });

        } catch (error) {
            return new Response(`Error: ${error.message}`, {
                status: 500,
                headers: { 'Access-Control-Allow-Origin': '*' }
            });
        }
    }
}
