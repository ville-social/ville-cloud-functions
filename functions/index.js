/**
 *  Cloud Functions – ville.social
 *  Node 18  (upgrade to 20 before 2025-10-31)
 *  ─────────────────────────────────────────────────────────────────────
 *  Exports
 *    • processPreviewAssets   Firestore → orange MP4 + JPG previews
 *    • buildShareGif          Callable helper (unchanged)
 *    • eventMeta              SSR for /event/<eventID>
 */

const functions     = require('firebase-functions/v1');       // ← only v1 builder
const { onRequest } = require('firebase-functions/v2/https'); // v2 *only* for HTTPS
const admin         = require('firebase-admin');

const { spawn }   = require('child_process');
const { join }    = require('path');
const { tmpdir }  = require('os');
const fs          = require('fs/promises');
const url         = require('url');
const { v4: uuidv4 } = require('uuid');
const fetch       = (...a) => import('node-fetch').then(({default:f}) => f(...a));

const { buildRichMeta } = require('./shared/buildRichMeta');

/* ─── Initialise Admin once ─── */
if (!admin.apps.length) admin.initializeApp();
const db     = admin.firestore();
const bucket = admin.storage().bucket();

/* ──────────────────────────────────────────────────────────────
   1. Firestore trigger → generate orange preview MP4 & JPG
   ────────────────────────────────────────────────────────────── */
const FFMPEG_GCS   = 'bin/ffmpeg';              // static binary stored in GCS
const LOCAL_FFMPEG = join(tmpdir(), 'ffmpeg');

async function ensureFfmpeg () {
  try { await fs.access(LOCAL_FFMPEG); }
  catch {
    await bucket.file(FFMPEG_GCS).download({ destination: LOCAL_FFMPEG });
    await fs.chmod(LOCAL_FFMPEG, 0o755);
  }
}
const gcsPath = urlStr =>
  decodeURIComponent(new url.URL(urlStr).pathname.split('/o/')[1] || '');

exports.processPreviewAssets = functions
  .region('us-central1')
  .runWith({
    memory        : '2GB',
    timeoutSeconds: 120,     // 2 minutes is plenty for 5s -> 2.5s conversion
    minInstances  : 1,       // keeps one warm instance
    maxInstances  : 10      // increased from 3 to handle more concurrent requests
  })
  .firestore
  .document('events/{eventId}')
  .onWrite(async (change, ctx) => {
    const { eventId } = ctx.params;
    const after = change.after.exists ? change.after.data() : null;
    if (!after?.event_video) return null;

    const before = change.before.exists ? change.before.data() : {};
    const needsPreview =
      before.event_video !== after.event_video ||
      !(after.event_preview_vid && after.event_preview_image);
    if (!needsPreview) return null;

    console.log(`[processPreviewAssets] Starting preview generation for event ${eventId}`);
    console.log(`[processPreviewAssets] Event title: ${after.event_title}`);

    await ensureFfmpeg();

    const workDir = join(tmpdir(), `prev-${eventId}-${Date.now()}`);
    await fs.mkdir(workDir, { recursive: true });

    const mp4In  = join(workDir, 'src.mp4');
    const logo   = join(workDir, 'logo.png');
    const mp4Out = join(workDir, 'output.mp4');
    const jpgOut = join(workDir, 'fallback.jpg');
    const gcsSrc = gcsPath(after.event_video);

    await Promise.all([
      bucket.file(gcsSrc).download({ destination: mp4In }),
      bucket.file('overlays/logo.png').download({ destination: logo })
    ]);

    /* ── FFmpeg: orange background (#FF6400) + centred logo ── */
    const filter =
      `[1]scale='min(360,iw)':'min(640,ih)'[lg];` +
      `color=0xff6400:size=360x640:rate=10[bg];` +
      `[bg][lg]overlay=(W-w)/2:(H-h)/2`;

    // MP4 trailer (≈2.5 s @ 10 fps)
    console.log(`[processPreviewAssets] Starting FFmpeg conversion: 2.5s @ 360x640 (9:16)`);
    const startTime = Date.now();
    
    await new Promise((ok, bad) =>
      spawn(LOCAL_FFMPEG, [
        '-ss', '0',             // start at beginning
        '-t', '2.5',            // limit input to 2.5 seconds
        '-i', mp4In,            // input video (only first 2.5s will be read)
        '-i', logo,             // logo overlay
        '-t', '2.5',            // also limit output to 2.5 seconds (redundant but safe)
        '-r', '10',             // 10 fps
        '-filter_complex', filter,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-pix_fmt', 'yuv420p',
        '-an',                  // no audio
        '-y', mp4Out
      ], { stdio: 'inherit' })
      .on('exit', code => code ? bad(new Error(`ffmpeg-mp4 exit ${code}`)) : ok())
    );
    
    const processingTime = Date.now() - startTime;
    console.log(`[processPreviewAssets] FFmpeg completed in ${processingTime}ms`);

    // JPG thumbnail (quality 4 ≈ 100–150 kB)
    await new Promise((ok, bad) =>
      spawn(LOCAL_FFMPEG, [
        '-i', mp4Out, '-frames:v', '1', '-q:v', '4', '-y', jpgOut
      ], { stdio: 'inherit' })
      .on('exit', code => code ? bad(new Error(`ffmpeg-jpg exit ${code}`)) : ok())
    );

    // Upload to Storage with stable tokens
    const vidToken = uuidv4();
    const imgToken = uuidv4();
    const vidDest  = `events/${eventId}/output.mp4`;
    const imgDest  = `events/${eventId}/fallback.jpg`;

    await bucket.upload(mp4Out, {
      destination: vidDest,
      metadata: {
        contentType : 'video/mp4',
        cacheControl: 'public,max-age=31536000',
        metadata    : { firebaseStorageDownloadTokens: vidToken }
      }
    });
    await bucket.upload(jpgOut, {
      destination: imgDest,
      metadata: {
        contentType : 'image/jpeg',
        cacheControl: 'public,max-age=31536000',
        metadata    : { firebaseStorageDownloadTokens: imgToken }
      }
    });

    const previewVid =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(vidDest)}?alt=media&token=${vidToken}`;
    const previewImg =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(imgDest)}?alt=media&token=${imgToken}`;

    await change.after.ref.update({
      event_preview_vid  : previewVid,
      event_preview_image: previewImg
    });

    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return null;
  });

/* ─────────────────────────────────────────────────────────────
   2. buildShareGif – callable helper (existing file)
   ───────────────────────────────────────────────────────────── */
exports.buildShareGif = require('./buildShareGif').buildShareGif;

/* ─────────────────────────────────────────────────────────────
   3. eventMeta – Server-side render rich meta for crawlers
   ───────────────────────────────────────────────────────────── */
exports.eventMeta = onRequest({ region: 'us-central1' }, async (req, res) => {
  try {
    // Debug logging
    console.log('Request path:', req.path);
    console.log('Request originalUrl:', req.originalUrl);
    console.log('Request url:', req.url);
    
    // Extract event ID from the path - handle both direct function calls and rewrites
    let eventKey = '';
    if (req.path.includes('/event/')) {
      eventKey = req.path.split('/event/')[1]?.split('/')[0] || '';
    } else if (req.originalUrl.includes('/event/')) {
      eventKey = req.originalUrl.split('/event/')[1]?.split('/')[0] || '';
    } else {
      // Fallback to original logic
      eventKey = (req.path.split('/').pop() || '').trim();
    }
    
    console.log('Extracted eventKey:', eventKey);
    
    if (!eventKey) {
      console.log('No eventKey found, redirecting to /');
      return res.redirect(302, '/');
    }

    // Look-up by the *eventID* field (not doc ID) with retry logic
    console.log('Querying for eventID:', eventKey);
    let q = null;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      q = await db.collection('events')
                  .where('eventID', '==', eventKey)
                  .limit(1)
                  .get();
      
      console.log(`Query attempt ${attempts + 1}: result empty: ${q.empty}`);
      
      if (!q.empty) {
        break; // Found the event, exit retry loop
      }
      
      attempts++;
      if (attempts < maxAttempts) {
        console.log(`Event not found on attempt ${attempts}, retrying in 500ms...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    if (q.empty) {
      console.log('Event not found after all retries, serving fallback SPA');
      // Don't redirect - serve the SPA so the frontend can handle the missing event
      const upstream = await fetch('https://ville.social/index.html');
      let html = await upstream.text();
      
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); // Don't cache failed lookups
      return res.status(200).send(html);
    }

    const d       = q.docs[0].data();
    const pageUrl = `https://ville.social${req.originalUrl}`;  // Fixed URL
    const head    = buildRichMeta(d, pageUrl);

    const ua  = req.headers['user-agent'] || '';
    const bot = /facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|pinterest|telegrambot|whatsapp/i.test(ua) ||
                req.method === 'HEAD';

    console.log('User agent:', ua);
    console.log('Is bot:', bot);

    if (bot) {
      console.log('Serving bot response');
      res.set('Cache-Control', 'public,max-age=300,s-maxage=300');
      return res.status(200)
                .send(`<!DOCTYPE html><html><head>${head}</head><body></body></html>`);
    }

    // Human browser – inject into SPA index.html
    console.log('Fetching upstream HTML');
    const upstream = await fetch('https://ville.social/index.html');
    let html       = await upstream.text();
    
    // Remove ALL duplicate meta tags
    html = html.replace(/<meta name=["']theme-color["'][^>]*>/gi, '');
    html = html.replace(/<meta property=["']og:[^"']+["'][^>]*>/gi, '');
    html = html.replace(/<meta name=["']twitter:[^"']+["'][^>]*>/gi, '');
    html = html.replace(/<meta name=["']description["'][^>]*>/gi, '');
    html = html.replace(/<meta name=["']keywords["'][^>]*>/gi, '');
    html = html.replace(/<title>[^<]*<\/title>/i, '');
    
    // Insert our meta tags RIGHT AFTER <head> opening tag (at the very beginning)
    html = html.replace(/<head[^>]*>/i, (match) => `${match}\n  ${head}\n`);

    console.log('Serving human browser response');
    res.set('Cache-Control', 'public,max-age=300,s-maxage=300');
    return res.status(200).send(html);
  } catch (err) {
    console.error('Error in eventMeta:', err);
    return res.redirect(302, '/');
  }
});

/* ─────────────────────────────────────────────────────────────
   4. userMeta – Handle deep linking for user profiles /u/
   ───────────────────────────────────────────────────────────── */
exports.userMeta = onRequest({ region: 'us-central1' }, async (req, res) => {
  try {
    // Extract username from path
    let username = '';
    if (req.path.includes('/u/')) {
      username = req.path.split('/u/')[1]?.split('/')[0] || '';
    } else if (req.originalUrl.includes('/u/')) {
      username = req.originalUrl.split('/u/')[1]?.split('/')[0] || '';
    }
    
    if (!username) {
      return res.redirect(302, '/');
    }

    const pageUrl = `https://ville.social${req.originalUrl}`;
    const ua = req.headers['user-agent'] || '';
    const bot = /facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|pinterest|telegrambot|whatsapp/i.test(ua) ||
                req.method === 'HEAD';

    // Build simple meta tags for user profile with deep linking
    const head = `
<!-- Essential Meta Tags -->
<meta charset="UTF-8">
<title>${username} - Ville Profile</title>
<meta name="description" content="View ${username}'s profile on Ville - Find events near you, for you.">
<meta name="viewport" content="width=device-width, initial-scale=1">

<!-- Open Graph Meta Tags -->
<meta property="og:title" content="${username} - Ville Profile">
<meta property="og:description" content="View ${username}'s profile on Ville - Find events near you, for you.">
<meta property="og:url" content="${pageUrl}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="Ville">

<!-- Deep-link tags -->
<meta property="al:ios:app_store_id" content="${process.env.VILLE_IOS_APP_ID || '6618138529'}">
<meta property="al:ios:url" content="ville://u/${username}">
<meta name="apple-itunes-app" content="app-id=${process.env.VILLE_IOS_APP_ID || '6618138529'}, app-argument=ville://u/${username}">
<meta property="al:android:package" content="${process.env.VILLE_ANDROID_PKG || 'com.ville.ville'}">
<meta property="al:android:url" content="ville://u/${username}">

<!-- Deep Link Auto-Redirect Script -->
<script>
(function() {
  var deepLink = 'ville://u/${username}';
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  var isAndroid = /Android/.test(navigator.userAgent);
  
  if ((isIOS || isAndroid) && deepLink) {
    var startTime = Date.now();
    var appOpened = false;
    
    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = deepLink;
    document.body.appendChild(iframe);
    
    setTimeout(function() {
      window.location.href = deepLink;
    }, 100);
    
    var checkInterval = setInterval(function() {
      if (document.hidden || document.webkitHidden) {
        appOpened = true;
        clearInterval(checkInterval);
      }
    }, 200);
    
    setTimeout(function() {
      clearInterval(checkInterval);
      if (!appOpened && (Date.now() - startTime) < 3000) {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
      }
    }, 2500);
  }
})();
</script>`;

    if (bot) {
      res.set('Cache-Control', 'public,max-age=300,s-maxage=300');
      return res.status(200)
                .send(`<!DOCTYPE html><html><head>${head}</head><body></body></html>`);
    }

    // Human browser – inject into SPA
    const upstream = await fetch('https://ville.social/index.html');
    let html = await upstream.text();
    html = html.replace(/<head[^>]*>/i, (match) => `${match}\n  ${head}\n`);
    
    res.set('Cache-Control', 'public,max-age=300,s-maxage=300');
    return res.status(200).send(html);
  } catch (err) {
    console.error('Error in userMeta:', err);
    return res.redirect(302, '/');
  }
});

/* ─────────────────────────────────────────────────────────────
   5. videoMeta – Handle deep linking for videos /v/
   ───────────────────────────────────────────────────────────── */
exports.videoMeta = onRequest({ region: 'us-central1' }, async (req, res) => {
  try {
    // Extract video ID from path
    let videoId = '';
    if (req.path.includes('/v/')) {
      videoId = req.path.split('/v/')[1]?.split('/')[0] || '';
    } else if (req.originalUrl.includes('/v/')) {
      videoId = req.originalUrl.split('/v/')[1]?.split('/')[0] || '';
    }
    
    if (!videoId) {
      return res.redirect(302, '/');
    }

    const pageUrl = `https://ville.social${req.originalUrl}`;
    const ua = req.headers['user-agent'] || '';
    const bot = /facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|pinterest|telegrambot|whatsapp/i.test(ua) ||
                req.method === 'HEAD';

    // Build simple meta tags for video with deep linking
    const head = `
<!-- Essential Meta Tags -->
<meta charset="UTF-8">
<title>Video - Ville</title>
<meta name="description" content="Watch this video on Ville - Find events near you, for you.">
<meta name="viewport" content="width=device-width, initial-scale=1">

<!-- Open Graph Meta Tags -->
<meta property="og:title" content="Video - Ville">
<meta property="og:description" content="Watch this video on Ville - Find events near you, for you.">
<meta property="og:url" content="${pageUrl}">
<meta property="og:type" content="video.other">
<meta property="og:site_name" content="Ville">

<!-- Deep-link tags -->
<meta property="al:ios:app_store_id" content="${process.env.VILLE_IOS_APP_ID || '6618138529'}">
<meta property="al:ios:url" content="ville://v/${videoId}">
<meta name="apple-itunes-app" content="app-id=${process.env.VILLE_IOS_APP_ID || '6618138529'}, app-argument=ville://v/${videoId}">
<meta property="al:android:package" content="${process.env.VILLE_ANDROID_PKG || 'com.ville.ville'}">
<meta property="al:android:url" content="ville://v/${videoId}">

<!-- Deep Link Auto-Redirect Script -->
<script>
(function() {
  var deepLink = 'ville://v/${videoId}';
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  var isAndroid = /Android/.test(navigator.userAgent);
  
  if ((isIOS || isAndroid) && deepLink) {
    var startTime = Date.now();
    var appOpened = false;
    
    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = deepLink;
    document.body.appendChild(iframe);
    
    setTimeout(function() {
      window.location.href = deepLink;
    }, 100);
    
    var checkInterval = setInterval(function() {
      if (document.hidden || document.webkitHidden) {
        appOpened = true;
        clearInterval(checkInterval);
      }
    }, 200);
    
    setTimeout(function() {
      clearInterval(checkInterval);
      if (!appOpened && (Date.now() - startTime) < 3000) {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
      }
    }, 2500);
  }
})();
</script>`;

    if (bot) {
      res.set('Cache-Control', 'public,max-age=300,s-maxage=300');
      return res.status(200)
                .send(`<!DOCTYPE html><html><head>${head}</head><body></body></html>`);
    }

    // Human browser – inject into SPA
    const upstream = await fetch('https://ville.social/index.html');
    let html = await upstream.text();
    html = html.replace(/<head[^>]*>/i, (match) => `${match}\n  ${head}\n`);
    
    res.set('Cache-Control', 'public,max-age=300,s-maxage=300');
    return res.status(200).send(html);
  } catch (err) {
    console.error('Error in videoMeta:', err);
    return res.redirect(302, '/');
  }
});
