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
const nodemailer = require('nodemailer');

const { buildRichMeta } = require('./shared/buildRichMeta');

/**
 * Send email using SMTP (Gmail App Password or SendGrid)
 */
async function sendEmailDirect(to, subject, html) {
  try {
    // You can use either Gmail App Password or SendGrid
    // For Gmail: Go to Google Account > Security > 2-Step Verification > App Passwords
    // Generate an app password for "Mail" and set it as environment variable
    
    let transporter;
    
    const config = functions.config();
    
    if (config.gmail?.app_password) {
      // Gmail SMTP with App Password
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: 'danny@ville.social',
          pass: config.gmail.app_password, // App password from Google Account settings
        },
      });
    } else if (config.sendgrid?.api_key) {
      // SendGrid SMTP
      transporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        secure: false,
        auth: {
          user: 'apikey',
          pass: config.sendgrid.api_key,
        },
      });
    } else {
      // Fallback to a simple SMTP service (for testing only)
      console.log('⚠️  No email credentials configured, using ethereal email for testing');
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransporter({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
    }
    
    const mailOptions = {
      from: '"Ville Alert System" <danny@ville.social>',
      to: to,
      subject: subject,
      html: html,
    };
    
    const result = await transporter.sendMail(mailOptions);
    console.log('📧 Email sent successfully:', result.messageId);
    
    // If using Ethereal, log the preview URL
    if (!config.gmail?.app_password && !config.sendgrid?.api_key) {
      console.log('📧 Preview URL:', nodemailer.getTestMessageUrl(result));
    }
    
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    console.error('❌ Email send failed:', error);
    return { success: false, error: error.message };
  }
}

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
    const upstream = await fetch('https://ville-9fe9d.firebaseapp.com/index.html');
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
    const upstream = await fetch('https://ville-9fe9d.firebaseapp.com/index.html');
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
    const upstream = await fetch('https://ville-9fe9d.firebaseapp.com/index.html');
    let html = await upstream.text();
    html = html.replace(/<head[^>]*>/i, (match) => `${match}\n  ${head}\n`);
    
    res.set('Cache-Control', 'public,max-age=300,s-maxage=300');
    return res.status(200).send(html);
  } catch (err) {
    console.error('Error in videoMeta:', err);
    return res.redirect(302, '/');
  }
});

/* ─────────────────────────────────────────────────────────────
   6. Event Health Monitor – Monitor new events and test URLs
   ───────────────────────────────────────────────────────────── */
exports.monitorEventHealth = functions
  .region('us-central1')
  .firestore
  .document('events/{eventId}')
  .onCreate(async (snap, context) => {
    const docId = context.params.eventId;
    const eventData = snap.data();
    
    // Use the eventID field from the document data, not the document ID
    const eventId = eventData.eventID;
    
    if (!eventId) {
      console.error(`❌ No eventID field found in document ${docId}`);
      return;
    }
    
    console.log(`🔍 Monitoring new event: ${eventId} (doc: ${docId})`);
    
    try {
      // Test the event URL with retry logic
      const eventUrl = `https://ville.social/event/${eventId}`;
      const testResult = await testEventUrlWithRetries(eventUrl, eventId);
      
      if (!testResult.success) {
        console.error(`❌ Event URL test failed after all retries for ${eventId}:`, testResult.error);
        
        // Store alert in Firestore
        await db.collection('eventHealthAlerts').add({
          eventId,
          docId,
          eventUrl,
          error: testResult.error,
          attempts: testResult.attempts,
          eventData: {
            title: eventData.title || 'Unknown',
            createdAt: eventData.createdAt || 'Unknown'
          },
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          resolved: false
        });
        
        console.log(`📧 Alert stored for failed event ${eventId}`);
      } else {
        console.log(`✅ Event URL test passed for ${eventId} (attempt ${testResult.successAttempt})`);
      }
      
    } catch (error) {
      console.error(`💥 Error monitoring event ${eventId}:`, error);
    }
  });

/**
 * Test event URL with retry logic - 3 attempts, 45 seconds apart
 */
async function testEventUrlWithRetries(url, eventId) {
  const maxAttempts = 3;
  const retryDelay = 45000; // 45 seconds
  let attempts = [];
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`🔄 Attempt ${attempt}/${maxAttempts} for event ${eventId}`);
    
    // Wait 45 seconds before each attempt
    console.log(`⏳ Waiting 45 seconds before testing...`);
    await new Promise(resolve => setTimeout(resolve, retryDelay));
    
    const result = await testEventUrl(url, eventId);
    attempts.push({
      attempt,
      timestamp: new Date().toISOString(),
      success: result.success,
      error: result.error || null
    });
    
    if (result.success) {
      console.log(`✅ Event URL test succeeded on attempt ${attempt}`);
      return {
        success: true,
        successAttempt: attempt,
        attempts,
        message: result.message
      };
    } else {
      console.log(`❌ Attempt ${attempt} failed: ${result.error}`);
      
      // If this is the last attempt, return failure
      if (attempt === maxAttempts) {
        console.log(`💥 All ${maxAttempts} attempts failed for event ${eventId}`);
        return {
          success: false,
          error: `Failed after ${maxAttempts} attempts. Last error: ${result.error}`,
          attempts
        };
      }
      
      // Continue to next attempt
      console.log(`🔄 Will retry in 45 seconds... (${maxAttempts - attempt} attempts remaining)`);
    }
  }
}

/**
 * Test if an event URL loads correctly and video URLs are accessible
 */
async function testEventUrl(url, eventId) {
  try {
    console.log(`🌐 Testing URL: ${url}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Event-Health-Monitor/1.0'
      }
    });
    
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }
    
    const html = await response.text();
    
    // Check if page loaded properly - should be substantial content
    if (html.length < 5000) {
      return {
        success: false,
        error: `Page too small: ${html.length} bytes - likely blank page or error`
      };
    }
    
    // Check if this is the Flutter web app (not a blank page, error, or fallback)
    const hasFlutterBootstrap = html.includes('_flutter.loader.load') || html.includes('flutter_bootstrap.js');
    const hasFlutterBuildConfig = html.includes('_flutter.buildConfig');
    const hasEventTitle = html.includes('<title>') && !html.includes('<title></title>');
    
    if (!hasFlutterBootstrap) {
      return {
        success: false,
        error: `No Flutter bootstrap detected - page may be showing error or fallback content`
      };
    }
    
    if (!hasFlutterBuildConfig) {
      return {
        success: false,
        error: `No Flutter build config detected - Flutter app may not be properly configured`
      };
    }
    
    if (!hasEventTitle) {
      return {
        success: false,
        error: `No event title detected - eventMeta function may have failed to load event data`
      };
    }
    
    console.log(`✅ Flutter web app appears to be properly loaded with event content`);
    
    return { 
      success: true, 
      message: `Event page loaded successfully with Flutter app running`
    };
    
  } catch (error) {
    return {
      success: false,
      error: `Fetch error: ${error.message}`
    };
  }
}



/**
 * Test if a video URL is accessible
 */
async function testVideoUrl(videoUrl) {
  try {
    console.log(`🎥 Testing video URL: ${videoUrl}`);
    
    const response = await fetch(videoUrl, {
      method: 'HEAD', // Only get headers, not the full video
      headers: {
        'User-Agent': 'Event-Health-Monitor/1.0'
      }
    });
    
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }
    
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('video')) {
      return {
        success: false,
        error: `Invalid content type: ${contentType} (expected video/*)`
      };
    }
    
    return { success: true };
    
  } catch (error) {
    return {
      success: false,
      error: `Video fetch error: ${error.message}`
    };
  }
}

/**
 * Manual function to test a specific event URL
 * Call this via HTTP: https://us-central1-ville-9fe9d.cloudfunctions.net/testEventUrl?eventId=EVENT_ID
 */
exports.testEventUrl = onRequest({ region: 'us-central1' }, async (req, res) => {
  const eventId = req.query.eventId;
  
  if (!eventId) {
    return res.status(400).json({ error: 'Missing eventId parameter' });
  }
  
  const eventUrl = `https://ville.social/event/${eventId}`;
  const result = await testEventUrl(eventUrl, eventId);
  
  res.json({
    eventId,
    eventUrl,
    result,
    timestamp: new Date().toISOString()
  });
});

/**
 * Manual function to test event URL and create alert if it fails
 * Call this via HTTP: https://us-central1-ville-9fe9d.cloudfunctions.net/testEventUrlWithAlert?eventId=EVENT_ID
 */
exports.testEventUrlWithAlert = onRequest({ region: 'us-central1' }, async (req, res) => {
  const eventId = req.query.eventId;
  
  if (!eventId) {
    return res.status(400).json({ error: 'Missing eventId parameter' });
  }
  
  const eventUrl = `https://ville.social/event/${eventId}`;
  const result = await testEventUrl(eventUrl, eventId);
  
  // If test failed, create an alert (which will trigger email)
  if (!result.success) {
    try {
      const alertRef = await db.collection('eventHealthAlerts').add({
        eventId,
        eventUrl,
        error: result.error,
        eventData: {
          title: 'Manual Test Event',
          createdAt: new Date().toISOString()
        },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        resolved: false,
        source: 'manual-test'
      });
      
      res.json({
        eventId,
        eventUrl,
        result,
        alertCreated: true,
        alertId: alertRef.id,
        message: 'Test failed - alert created and email should be sent',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.json({
        eventId,
        eventUrl,
        result,
        alertCreated: false,
        alertError: error.message,
        timestamp: new Date().toISOString()
      });
    }
  } else {
    res.json({
      eventId,
      eventUrl,
      result,
      alertCreated: false,
      message: 'Test passed - no alert needed',
      timestamp: new Date().toISOString()
    });
  }
});

/* ─────────────────────────────────────────────────────────────
   7. Email Alerts for Event Health Issues
   ───────────────────────────────────────────────────────────── */
exports.sendEventHealthEmail = functions
  .region('us-central1')
  .firestore
  .document('eventHealthAlerts/{alertId}')
  .onCreate(async (snap, context) => {
    const alertData = snap.data();
    const alertId = context.params.alertId;
    
    console.log(`📧 Sending email alert for event: ${alertData.eventId}`);
    
    try {
      // Create email document for Firebase Extension "Trigger Email"
      // Make sure to install the extension and configure it first
      const emailData = {
        to: ['danny@ville.social'],
        message: {
          subject: `🚨 Event URL Health Alert - ${alertData.eventId}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #d32f2f;">🚨 Event URL Health Alert</h2>
              
              <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3>Event Details</h3>
                <p><strong>Event ID:</strong> ${alertData.eventId}</p>
                <p><strong>Event Title:</strong> ${alertData.eventData?.title || 'Unknown'}</p>
                <p><strong>Event URL:</strong> <a href="${alertData.eventUrl}" target="_blank">${alertData.eventUrl}</a></p>
                <p><strong>Error:</strong> ${alertData.error}</p>
                <p><strong>Time:</strong> ${new Date().toISOString()}</p>
              </div>
              
              <div style="background-color: #e3f2fd; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3>🔧 Troubleshooting Steps</h3>
                <ol>
                  <li><strong>Test the URL manually:</strong> <a href="${alertData.eventUrl}" target="_blank">Open ${alertData.eventUrl}</a></li>
                  <li><strong>Check Firestore:</strong> Verify the event exists in your events collection</li>
                  <li><strong>Check Cloud Functions:</strong> Look at eventMeta function logs in Firebase Console</li>
                  <li><strong>Check Firebase Hosting:</strong> Verify the /event/** rewrite is working</li>
                  <li><strong>Manual Test:</strong> <a href="https://us-central1-ville-9fe9d.cloudfunctions.net/testEventUrl?eventId=${alertData.eventId}" target="_blank">Test Event URL</a></li>
                </ol>
              </div>
              
              <p style="color: #666; font-size: 12px; margin-top: 30px;">
                This alert was generated automatically by your Event Health Monitor.<br>
                Alert ID: ${alertId}
              </p>
            </div>
          `
        }
      };
      
      // Log the email content for debugging
      console.log('📧 EMAIL CONTENT:', JSON.stringify(emailData, null, 2));
      
      // Send email directly using Nodemailer (no extension needed)
      await sendEmailDirect(emailData.to[0], emailData.message.subject, emailData.message.html);
      
      console.log(`✅ Email queued for event health alert: ${alertData.eventId}`);
      
    } catch (error) {
      console.error('❌ Failed to send email alert:', error);
    }
  });

/**
 * Manual function to test email alerts
 * Call this via HTTP: https://us-central1-ville-9fe9d.cloudfunctions.net/testEmailAlert
 */
exports.testEmailAlert = onRequest({ region: 'us-central1' }, async (req, res) => {
  try {
    // Create a test alert
    const testAlert = {
      eventId: 'TEST_EVENT_123',
      eventUrl: 'https://ville.social/event/TEST_EVENT_123',
      error: 'Test error for email notification',
      eventData: {
        title: 'Test Event',
        createdAt: new Date().toISOString()
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      resolved: false
    };
    
    // Add to alerts collection (this will trigger the email)
    const alertRef = await db.collection('eventHealthAlerts').add(testAlert);
    
    res.json({
      success: true,
      message: 'Test email alert created',
      alertId: alertRef.id,
      testAlert
    });
    
  } catch (error) {
    console.error('Failed to create test email alert:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
