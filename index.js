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
    timeoutSeconds: 540,     // 9 min (v1 limit) – plenty for 1.5 s clip
    minInstances  : 1,       // keeps one warm instance (~$7 / month)
    maxInstances  : 3
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
    await new Promise((ok, bad) =>
      spawn(LOCAL_FFMPEG, [
        '-t', '2.5',            // length
        '-i', mp4In,
        '-i', logo,
        '-r', '10',
        '-filter_complex', filter,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-pix_fmt', 'yuv420p',
        '-y', mp4Out
      ], { stdio: 'inherit' })
      .on('exit', code => code ? bad(new Error(`ffmpeg-mp4 exit ${code}`)) : ok())
    );

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

    // Look-up by the *eventID* field (not doc ID)
    console.log('Querying for eventID:', eventKey);
    const q = await db.collection('events')
                      .where('eventID', '==', eventKey)
                      .limit(1)
                      .get();
    
    console.log('Query result empty:', q.empty);
    if (q.empty) {
      console.log('Event not found, redirecting to /');
      return res.redirect(302, '/');
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
