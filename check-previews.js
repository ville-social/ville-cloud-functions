const admin = require('firebase-admin');
admin.initializeApp();

async function checkPreviews() {
  const db = admin.firestore();
  const events = await db.collection('events')
    .where('event_video', '!=', null)
    .limit(10)
    .get();
  
  console.log(`Found ${events.size} events with videos`);
  
  for (const doc of events.docs) {
    const data = doc.data();
    console.log(`\nEvent ID: ${doc.id}`);
    console.log(`Event Title: ${data.event_title}`);
    console.log(`Has video: ${!!data.event_video}`);
    console.log(`Has preview video: ${!!data.event_preview_vid}`);
    console.log(`Has preview image: ${!!data.event_preview_image}`);
    
    if (data.event_video && (!data.event_preview_vid || !data.event_preview_image)) {
      console.log('⚠️  This event needs preview generation!');
    }
  }
  
  process.exit(0);
}

checkPreviews().catch(console.error); 