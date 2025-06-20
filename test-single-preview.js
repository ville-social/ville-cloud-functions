/**
 * test-single-preview.js
 * 
 * Tests preview generation for a single event and returns the URLs
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

async function testSinglePreview(specificEventId = null) {
  console.log('\n🧪 SINGLE EVENT PREVIEW TEST');
  console.log('============================\n');

  try {
    let query;
    
    if (specificEventId) {
      // Test specific event
      query = db.collection('events')
        .where('eventID', '==', specificEventId)
        .limit(1);
    } else {
      // Get a random event with video
      query = db.collection('events')
        .where('event_video', '!=', null)
        .limit(1);
    }

    const snapshot = await query.get();
    
    if (snapshot.empty) {
      console.log('❌ No event found with video.');
      return;
    }

    const doc = snapshot.docs[0];
    const data = doc.data();
    
    console.log('📋 Event Details:');
    console.log(`   Title: ${data.event_title}`);
    console.log(`   Event ID: ${data.eventID || doc.id}`);
    console.log(`   Has video: ${!!data.event_video}`);
    console.log(`   Current preview: ${data.event_preview_vid ? 'Yes' : 'No'}\n`);

    // Clear existing previews to force regeneration
    console.log('🗑️  Clearing existing previews...');
    await doc.ref.update({
      event_preview_vid: admin.firestore.FieldValue.delete(),
      event_preview_image: admin.firestore.FieldValue.delete(),
      _test_regeneration: Date.now()
    });

    console.log('✅ Preview fields cleared. Regeneration triggered.\n');
    console.log('⏳ Waiting for processPreviewAssets to complete...');
    console.log('   (This usually takes 10-30 seconds)\n');

    // Poll for completion
    let attempts = 0;
    const maxAttempts = 30; // 30 * 2 seconds = 60 seconds max wait
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      
      const updatedDoc = await doc.ref.get();
      const updatedData = updatedDoc.data();
      
      if (updatedData.event_preview_vid && updatedData.event_preview_image) {
        console.log('✅ PREVIEW GENERATION COMPLETE!\n');
        console.log('🎬 Preview Video URL:');
        console.log(`   ${updatedData.event_preview_vid}\n`);
        console.log('🖼️  Preview Image URL:');
        console.log(`   ${updatedData.event_preview_image}\n`);
        console.log('🔗 Event Page URL:');
        console.log(`   https://ville.social/event/${data.eventID || doc.id}\n`);
        
        // Test the URLs
        console.log('🔍 Checking preview files...');
        try {
          const videoResponse = await fetch(updatedData.event_preview_vid, { method: 'HEAD' });
          const imageResponse = await fetch(updatedData.event_preview_image, { method: 'HEAD' });
          
          console.log(`   Video: ${videoResponse.status === 200 ? '✅ Accessible' : '❌ Not accessible'}`);
          console.log(`   Image: ${imageResponse.status === 200 ? '✅ Accessible' : '❌ Not accessible'}\n`);
          
          if (videoResponse.status === 200) {
            const contentLength = videoResponse.headers.get('content-length');
            console.log(`   Video size: ${(contentLength / 1024).toFixed(1)} KB`);
          }
        } catch (error) {
          console.log('   Could not verify URLs');
        }
        
        return;
      }
      
      attempts++;
      if (attempts % 5 === 0) {
        console.log(`   Still processing... (${attempts * 2} seconds elapsed)`);
      }
    }

    console.log('⏱️  Timeout: Preview generation is taking longer than expected.');
    console.log('   Check the function logs for errors:');
    console.log('   https://console.firebase.google.com/project/ville-9fe9d/functions/logs');

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Check if event ID was provided as command line argument
const eventId = process.argv[2];

// Import fetch for Node.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Run the test
testSinglePreview(eventId).then(() => process.exit()); 