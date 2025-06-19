const functions  = require('firebase-functions/v2/https');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { spawn }  = require('child_process');
const { tmpdir } = require('os');
const { join }   = require('path');
const admin      = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');

if (!admin.apps.length) admin.initializeApp();
const gcs = new Storage();

exports.buildShareGif = functions.onCall(
  { memory: '2GiB', cpu: 2, timeoutSeconds: 540 },
  async ({ eventId }) => {
    if (!eventId) throw new functions.https.HttpsError('invalid-argument', 'eventId missing');

    const bucket   = gcs.bucket();
    const scratch  = join(tmpdir(), eventId);
    const mp4Src   = join(scratch, 'src.mp4');
    const pngSrc   = join(scratch, 'ov.png');
    const gifOut   = join(scratch, 'out.gif');

    await Promise.all([
      bucket.file(`events/${eventId}.mp4`).download({ destination: mp4Src }),
      bucket.file('overlays/logo.png').download({ destination: pngSrc })
    ]);

    await new Promise((ok, err) =>
      spawn(ffmpegPath, [
        '-i', mp4Src, '-i', pngSrc,
        '-filter_complex',
        `[1]format=rgba,colorchannelmixer=aa=1[o];` +
        `[0][o]overlay=W-w-20:H-h-20,split[a][b];` +
        `[a]palettegen[p];[b][p]paletteuse`,
        '-gifflags','-transdiff','-y', gifOut
      ], { stdio:'inherit' })
      .on('exit', c => c ? err(new Error('ffmpeg '+c)) : ok())
    );

    await bucket.upload(gifOut, {
      destination:`events/${eventId}.gif`,
      metadata:{ contentType:'image/gif', cacheControl:'public,max-age=31536000' }
    });

    const url=`https://storage.googleapis.com/${bucket.name}/events/${eventId}.gif`;
    await admin.firestore().doc(`events/${eventId}`).update({ shareGifUrl:url, gifReady:true });
    return { shareGifUrl:url };
  });
