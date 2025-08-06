/**
 * regenerateAllEventPreviews.js
 * 
 * Standalone script to regenerate all event preview videos and images
 * with the new 9:16 format (360x640, 2.5 seconds)
 * 
 * Usage:
 *   Test mode (10 events):  node regenerateAllEventPreviews.js test
 *   Full mode (all events): node regenerateAllEventPreviews.js
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

async function regenerateAllEventPreviews(testMode = false) {
  console.log('\n🎬 VILLE EVENT PREVIEW REGENERATION');
  console.log('=====================================');
  console.log('Format: 360x640 (9:16 vertical)');
  console.log('Duration: 2.5 seconds');
  console.log('Background: Orange (#FF6400)');
  console.log(`Mode: ${testMode ? 'TEST MODE (max 10 events)' : 'FULL REGENERATION'}`);
  console.log('=====================================\n');

  try {
    // Build query for events with videos
    let query = db.collection('events')
      .where('event_video', '!=', null)
      .orderBy('event_video');
    
    if (testMode) {
      query = query.limit(10);
    }

    // Get all matching events
    console.log('🔍 Fetching events with videos...');
    const snapshot = await query.get();
    
    if (snapshot.empty) {
      console.log('❌ No events found with videos.');
      return;
    }

    console.log(`✅ Found ${snapshot.size} events with videos\n`);

    // Show sample of events that will be processed
    console.log('📋 Sample events to be processed:');
    snapshot.docs.slice(0, 5).forEach(doc => {
      const data = doc.data();
      console.log(`   - ${data.event_title || 'Untitled'} (${data.eventID || doc.id})`);
    });
    if (snapshot.size > 5) {
      console.log(`   ... and ${snapshot.size - 5} more\n`);
    } else {
      console.log('');
    }

    // Confirm before proceeding in full mode
    if (!testMode && snapshot.size > 50) {
      console.log(`⚠️  WARNING: This will regenerate ${snapshot.size} preview videos!`);
      console.log('   Each regeneration triggers a Cloud Function.');
      console.log('   This process may take several minutes.\n');
      
      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const answer = await new Promise(resolve => {
        readline.question('Continue? (yes/no): ', resolve);
      });
      readline.close();
      
      if (answer.toLowerCase() !== 'yes') {
        console.log('\n❌ Regeneration cancelled.');
        return;
      }
    }

    // Process in batches to avoid overwhelming Firestore
    console.log('\n🔄 Processing events in batches...\n');
    const batchSize = 100;
    let totalProcessed = 0;
    let totalUpdated = 0;
    
    for (let i = 0; i < snapshot.docs.length; i += batchSize) {
      const batch = db.batch();
      const batchDocs = snapshot.docs.slice(i, i + batchSize);
      const currentBatchSize = batchDocs.length;
      
      console.log(`📦 Processing batch ${Math.floor(i/batchSize) + 1} (${currentBatchSize} events)...`);
      
      batchDocs.forEach(doc => {
        const data = doc.data();
        
        // Force regeneration for ALL events with videos
        // Clear preview fields and add timestamp to trigger processPreviewAssets
        batch.update(doc.ref, {
          event_preview_vid: admin.firestore.FieldValue.delete(),
          event_preview_image: admin.firestore.FieldValue.delete(),
          preview_regenerated_at: admin.firestore.FieldValue.serverTimestamp(),
          // Add a small random value to ensure the document is seen as "changed"
          _preview_force_regen: Math.random()
        });
        totalUpdated++;
      });

      // Commit the batch
      await batch.commit();
      totalProcessed += currentBatchSize;
      
      console.log(`   ✅ Batch complete: ${totalProcessed}/${snapshot.size} events processed`);
      console.log(`   🔄 All ${currentBatchSize} events marked for regeneration\n`);
      
      // Small delay between batches to be nice to the system
      if (i + batchSize < snapshot.docs.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Final summary
    console.log('=====================================');
    console.log('✅ REGENERATION COMPLETE!');
    console.log('=====================================');
    console.log(`📊 Total events processed: ${totalProcessed}`);
    console.log(`🔄 All ${totalUpdated} events marked for regeneration\n`);
    
    console.log('📝 NEXT STEPS:');
    console.log('1. The processPreviewAssets function will automatically');
    console.log('   detect the missing preview fields and regenerate them.');
    console.log('2. Monitor regeneration progress in Firebase Console:');
    console.log('   https://console.firebase.google.com/project/ville-9fe9d/functions/logs\n');
    
    if (totalUpdated > 0) {
      const estimatedTime = Math.ceil((totalUpdated * 3) / 60); // ~3 seconds per video
      console.log(`⏱️  Estimated regeneration time: ~${estimatedTime} minutes`);
      console.log('   (Depends on Cloud Function concurrency and video sizes)\n');
    }

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('Full error:', error);
  } finally {
    process.exit();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const testMode = args.includes('test') || args.includes('--test');

// Show help if requested
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node regenerateAllEventPreviews.js [options]

Options:
  test, --test    Run in test mode (process only 10 events)
  --help, -h      Show this help message

Examples:
  node regenerateAllEventPreviews.js          # Regenerate all previews
  node regenerateAllEventPreviews.js test     # Test with 10 events
`);
  process.exit(0);
}

// Run the regeneration
regenerateAllEventPreviews(testMode);
