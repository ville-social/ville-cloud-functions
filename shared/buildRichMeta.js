/* ───────── buildRichMeta.js ───────── */
const IOS_APP_ID  = process.env.VILLE_IOS_APP_ID  || '6618138529';
const ANDROID_PKG = process.env.VILLE_ANDROID_PKG || 'com.ville.ville';
const THEME_COLOR = '#FFAB31';
const MAX_DESC    = 160;
const DEFAULT_IMAGE = 'https://ville.social/assets/assets/images/Ville_share-image.jpg';

const sanitize = s => String(s ?? '').replace(/\s+/g, ' ').replace(/"/g, '&quot;').trim();
const iso      = ts => ts?.toDate ? ts.toDate().toISOString() : '';

/**
 * Builds the full <head> inner-HTML for an event page.
 * @param {Object} d       Firestore event doc
 * @param {string} pageUrl Canonical URL of this page
 */
function buildRichMeta(d, pageUrl) {
  const titleRaw = sanitize(d.event_title);
  const title    = `${titleRaw} - Ville - Find events near you, for you.`;
  const descRaw  = sanitize(d.event_description);
  const desc160  = descRaw.length > MAX_DESC ? descRaw.slice(0, MAX_DESC - 1) + '…' : descRaw;
  
  // Fix keywords handling
  const keywords = Array.isArray(d.interests) 
    ? d.interests.map(i => sanitize(typeof i === 'object' ? (i.name || i.label || '') : i)).filter(k => k).join(', ') 
    : '';

  // Use fallback image if none exists
  const imageUrl = d.event_preview_image || DEFAULT_IMAGE;
  const videoUrl = d.event_preview_vid || '';

  // Extract coordinates from geopoint
  const latitude = d.event_location?._latitude || d.event_location?.latitude;
  const longitude = d.event_location?._longitude || d.event_location?.longitude;

  // Determine if free
  const isFree = !d.feeMin || d.feeMin === 0;

  // Age restriction text
  const ageRestriction = d.minAge && d.minAge > 0 ? `${d.minAge}+` : 'All ages';

  /* ---------- Schema.org Event (JSON-LD) with 2025 enhancements ---------- */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type"   : "Event",
    "@id"     : pageUrl,
    name      : titleRaw,
    description: descRaw,
    keywords,
    startDate : iso(d.start_date),
    endDate   : iso(d.end_date),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode", // Always offline for Ville
    location: {
      "@type": "Place",
      name: d.event_venue || '',
      address: {
        "@type": "PostalAddress",
        streetAddress  : d.event_address || '',
        addressLocality: d.event_city || '',
        addressRegion  : d.event_state || '',
        postalCode     : d.event_zip || '',
        addressCountry : "US"
      },
      geo: latitude && longitude ? {
        "@type": "GeoCoordinates",
        latitude: latitude,
        longitude: longitude
      } : undefined
    },
    image: [imageUrl],
    organizer: {
      "@type": "Person",
      name: d.event_creator_displayname || '',
      url: "https://ville.social?creator"
    },
    offers: {
      "@type" : "Offer",
      price   : d.feeMin || 0,
      priceRange: d.feeMax ? `$${d.feeMin || 0}-$${d.feeMax}` : `$${d.feeMin || 0}`,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: pageUrl,
      validFrom: iso(d.created_time)
    },
    isAccessibleForFree: isFree,
    typicalAgeRange: d.minAge && d.minAge > 0 ? `${d.minAge}-` : undefined
  };

  // Add video to JSON-LD if available
  if (videoUrl) {
    jsonLd.video = {
      "@type": "VideoObject",
      name: `${titleRaw} Preview`,
      description: descRaw,
      thumbnailUrl: imageUrl,
      contentUrl: videoUrl,
      uploadDate: iso(d.created_time),
      duration: "PT2.5S"  // 2.5 seconds
    };
  }

  // FAQ schema
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [{
      "@type": "Question",
      "name": "How much does this event cost?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": isFree ? "This event is free!" : (d.feeMax ? `$${d.feeMin}-$${d.feeMax}` : `$${d.feeMin}`)
      }
    }, {
      "@type": "Question",
      "name": "Is this event age-restricted?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": d.minAge && d.minAge > 0 ? `Yes, this event is ${d.minAge}+` : "No, this event is open to all ages"
      }
    }]
  };

  // BreadcrumbList for better navigation understanding
  const breadcrumbList = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [{
      "@type": "ListItem",
      "position": 1,
      "name": "Home",
      "item": "https://ville.social"
    }, {
      "@type": "ListItem",
      "position": 2,
      "name": "Events",
      "item": "https://ville.social/events"
    }, {
      "@type": "ListItem",
      "position": 3,
      "name": titleRaw,
      "item": pageUrl
    }]
  };

  // Organization schema for brand recognition
  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Ville Technologies",
    "alternateName": "Ville",
    "url": "https://ville.social",
    "logo": "https://ville.social/assets/assets/images/Ville_share-image.jpg",
    "sameAs": [
      "https://www.instagram.com/ville.social_orange",
      "https://www.linkedin.com/company/ville-find-nearby-events/",
      "https://www.facebook.com/ville.social"
    ],
    "contactPoint": {
      "@type": "ContactPoint",
      "contactType": "customer service",
      "availableLanguage": "English"
    }
  };

  /* ---------- Assemble head block (PRIORITY ORDER) ---------- */
  return `
<!-- Essential SEO Meta Tags (First Priority) -->
<meta charset="UTF-8">
<title>${title}</title>
<meta name="description" content="${desc160}">
<meta name="viewport" content="width=device-width, initial-scale=1">

<!-- Open Graph Meta Tags (Second Priority - Critical for Social Media) -->
<meta property="og:title"       content="${title}">
<meta property="og:description" content="${descRaw}">
<meta property="og:image"       content="${imageUrl}">
<meta property="og:url"         content="${pageUrl}">
<meta property="og:type"        content="event">
<meta property="og:site_name"   content="Ville">
<meta property="og:locale"      content="en_US">
<meta property="og:image:width"  content="1280">
<meta property="og:image:height" content="720">
<meta property="og:image:alt"    content="${titleRaw} event preview">
${videoUrl ? `
<!-- Open Graph Video Tags (for platforms that support video previews) -->
<meta property="og:video"             content="${videoUrl}">
<meta property="og:video:url"         content="${videoUrl}">
<meta property="og:video:secure_url"  content="${videoUrl}">
<meta property="og:video:type"        content="video/mp4">
<meta property="og:video:width"       content="1080">
<meta property="og:video:height"      content="1920">` : ''}

<!-- Twitter Card Meta Tags (Third Priority) -->
<meta name="twitter:card"        content="${videoUrl ? 'player' : 'summary_large_image'}">
<meta name="twitter:title"       content="${title}">
<meta name="twitter:description" content="${descRaw}">
<meta name="twitter:image"       content="${imageUrl}">
<meta name="twitter:image:alt"   content="${titleRaw} event preview">
${videoUrl ? `
<!-- Twitter Video Player Card -->
<meta name="twitter:player"             content="${videoUrl}">
<meta name="twitter:player:width"       content="1080">
<meta name="twitter:player:height"      content="1920">
<meta name="twitter:player:stream"      content="${videoUrl}">
<meta name="twitter:player:stream:content_type" content="video/mp4">` : ''}

<!-- Additional SEO Meta Tags -->
<link rel="canonical" href="${pageUrl}">
<link rel="alternate" href="${pageUrl.replace('ville.social', 'ville.live')}" hreflang="en">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1">
${keywords ? `<meta name="keywords" content="${keywords}">` : ''}

<!-- AI/LLM Optimization Meta Tags (2025 Best Practices) -->
<meta name="author" content="${d.event_creator_displayname || 'Ville'}">
<meta name="publisher" content="Ville Technologies">
<meta name="language" content="en-US">
<meta name="geo.region" content="US-${d.event_state || ''}">
<meta name="geo.placename" content="${d.event_city || ''}">
${latitude && longitude ? `<meta name="geo.position" content="${latitude};${longitude}">
<meta name="ICBM" content="${latitude}, ${longitude}">` : ''}
<meta name="category" content="Events, Social, ${keywords}">
<meta name="topic" content="${titleRaw}">
<meta name="summary" content="${desc160}">
<meta name="classification" content="Event">
<meta name="subject" content="${titleRaw} - ${keywords}">
<meta name="revised" content="${new Date().toISOString()}">
<meta name="date" content="${iso(d.start_date)}">
<meta name="price" content="${isFree ? 'Free' : `$${d.feeMin}${d.feeMax ? `-$${d.feeMax}` : ''}`}">
<meta name="age-restriction" content="${ageRestriction}">

<!-- Structured Data (JSON-LD) - Multiple schemas for comprehensive coverage -->
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbList)}</script>
<script type="application/ld+json">${JSON.stringify(organization)}</script>

<!-- Deep-link banners -->
<meta property="al:ios:app_store_id" content="${IOS_APP_ID}">
<meta property="al:ios:url" content="ville://event/${d.eventID || ''}">
<meta name="apple-itunes-app"        content="app-id=${IOS_APP_ID}, app-argument=ville://event/${d.eventID || ''}">
<meta property="al:android:package"  content="${ANDROID_PKG}">
<meta property="al:android:url" content="ville://event/${d.eventID || ''}">
<meta name="google-play-app"         content="app-id=${ANDROID_PKG}">

<!-- App Store Links -->
<link rel="alternate" href="https://apps.apple.com/app/id${IOS_APP_ID}" hreflang="en">
<link rel="alternate" href="https://play.google.com/store/apps/details?id=${ANDROID_PKG}" hreflang="en">

<!-- Performance & Security Headers -->
<link rel="preconnect" href="https://firebasestorage.googleapis.com">
<link rel="dns-prefetch" href="https://firebasestorage.googleapis.com">

<!-- Theme and Icons -->
<meta name="theme-color" content="${THEME_COLOR}">
<link rel="icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
`.trim();
}

module.exports = { buildRichMeta };