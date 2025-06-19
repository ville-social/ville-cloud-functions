/* ───────── buildRichMeta.js ───────── */
const IOS_APP_ID  = process.env.VILLE_IOS_APP_ID  || '6618138529';
const ANDROID_PKG = process.env.VILLE_ANDROID_PKG || 'com.ville.ville';
const THEME_COLOR = '#FFAB31';
const MAX_DESC    = 160;

const sanitize = s => String(s ?? '').replace(/\s+/g, ' ').replace(/"/g, '&quot;').trim();
const iso      = ts => ts?.toDate().toISOString() ?? '';

/**
 * Builds the full <head> inner-HTML for an event page.
 * @param {Object} d       Firestore event doc
 * @param {string} pageUrl Canonical URL of this page
 */
function buildRichMeta(d, pageUrl) {
  const titleRaw = sanitize(d.event_title);
  const title    = `${titleRaw} - Ville`;        // ← suffix added here
  const descRaw  = sanitize(d.event_description);
  const desc160  = descRaw.length > MAX_DESC ? descRaw.slice(0, MAX_DESC - 1) + '…' : descRaw;
  const keywords = Array.isArray(d.interests) ? d.interests.map(sanitize).join(', ') : '';

  /* ---------- Open Graph & Twitter ---------- */
  const og = `
<meta property="og:type"        content="event">
<meta property="og:url"         content="${pageUrl}">
<meta property="og:title"       content="${title}">
<meta property="og:description" content="${descRaw}">
<meta property="og:image"       content="${d.event_preview_image}">
<meta property="og:video"       content="${d.event_preview_vid || ''}">
<meta property="og:image:width"  content="1280">
<meta property="og:image:height" content="720">

<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:title"       content="${title}">
<meta name="twitter:description" content="${descRaw}">
<meta name="twitter:image"       content="${d.event_preview_image}">
`.trim();

  /* ---------- Schema.org Event (JSON-LD) ---------- */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type"   : "Event",
    "@id"     : pageUrl,
    name      : title,
    description: descRaw,
    keywords,
    startDate : iso(d.start_date),
    endDate   : iso(d.end_date),
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: {
      "@type": "Place",
      name: d.event_venue,
      address: {
        "@type": "PostalAddress",
        streetAddress  : d.event_address,
        addressLocality: d.event_city,
        addressRegion  : d.event_state,
        postalCode     : d.event_zip,
        addressCountry : "US"
      }
    },
    image: [d.event_preview_image],
    organizer: { "@type": "Person", name: d.event_creator_displayname },
    offers: {
      "@type" : "Offer",
      price   : d.feeMin,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock"
    }
  };

  /* ---------- Assemble head block ---------- */
  return `
<title>${title}</title>
<meta name="description" content="${desc160}">
<link rel="canonical" href="${pageUrl}">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1">
${keywords && `<meta name="keywords" content="${keywords}">`}

${og}

<!-- Deep-link banners -->
<meta property="al:ios:app_store_id" content="${IOS_APP_ID}">
<meta name="apple-itunes-app"        content="app-id=${IOS_APP_ID}">
<meta property="al:android:package"  content="${ANDROID_PKG}">
<meta name="google-play-app"         content="app-id=${ANDROID_PKG}">

<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>

<link rel="icon" href="/favicon.ico">
<meta name="theme-color" content="${THEME_COLOR}">
`.trim();
}

module.exports = { buildRichMeta };
