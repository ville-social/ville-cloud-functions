/**
  * Run in Google Cloud shell with: node regenerateAllEventPreviews.js --days 60
 * regenerateAllEventPreviews.js
 * 
 * Standalone script to regenerate event preview videos and images
 * with the new 9:16 format (360x640, 2.5 seconds) with actual video content
 * 
 * Usage:
 *   Test mode (10 events):      node regenerateAllEventPreviews.js test
 *   Last N days:                node regenerateAllEventPreviews.js --days 10
 *   Test mode with days:        node regenerateAllEventPreviews.js test --days 5
 *   Full mode (all events):     node regenerateAllEventPreviews.js
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

async function regenerateAllEventPreviews(testMode = false, daysBack = null) {
  console.log('\n🎬 VILLE EVENT PREVIEW REGENERATION');
  console.log('=====================================');
  console.log('Format: 360x640 (9:16 vertical)');
  console.log('Duration: 2.5 seconds');
  console.log('Effect: Video content with 10% dark tint + logo overlay');
  
  if (daysBack) {
    console.log(`Time Range: Last ${daysBack} days`);
  }
  console.log(`Mode: ${testMode ? 'TEST MODE (max 10 events)' : 'FULL REGENERATION'}`);
  console.log('=====================================\n');

  try {
    // Build query for events with videos
    let query = db.collection('events')
      .where('event_video', '!=', null);
    
    // Add date filter if specified
    if (daysBack) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      console.log(`🗓️  Filtering events created after: ${cutoffDate.toISOString()}\n`);
      
      query = query
        .where('event_posted', '>=', admin.firestore.Timestamp.fromDate(cutoffDate))
        .orderBy('event_posted', 'desc')
        .orderBy('event_video');
    } else {
      query = query.orderBy('event_video');
    }
    
    if (testMode) {
      query = query.limit(10);
    }

    // Get all matching events
    console.log('🔍 Fetching events with videos...');
    const snapshot = await query.get();
    
    if (snapshot.empty) {
      if (daysBack) {
        console.log(`❌ No events found with videos in the last ${daysBack} days.`);
      } else {
        console.log('❌ No events found with videos.');
      }
      return;
    }

    console.log(`✅ Found ${snapshot.size} events with videos\n`);

    // Show sample of events that will be processed
    console.log('📋 Sample events to be processed:');
    snapshot.docs.slice(0, 5).forEach(doc => {
      const data = doc.data();
      const createdDate = data.event_posted ? data.event_posted.toDate().toLocaleDateString() : 'Unknown date';
      console.log(`   - ${data.event_title || 'Untitled'} (${data.eventID || doc.id}) - Created: ${createdDate}`);
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
    let skippedCount = 0;
    
    for (let i = 0; i < snapshot.docs.length; i += batchSize) {
      const batch = db.batch();
      const batchDocs = snapshot.docs.slice(i, i + batchSize);
      const currentBatchSize = batchDocs.length;
      let batchUpdated = 0;
      
      console.log(`📦 Processing batch ${Math.floor(i/batchSize) + 1} (${currentBatchSize} events)...`);
      
      batchDocs.forEach(doc => {
        const data = doc.data();
        
        // Check if event actually has a video URL
        if (!data.event_video || data.event_video === '') {
          console.log(`   ⚠️  Skipping ${data.event_title || doc.id}: No video URL`);
          skippedCount++;
          return;
        }
        
        // Force regeneration for events with videos
        // Clear preview fields and add timestamp to trigger processPreviewAssets
        batch.update(doc.ref, {
          event_preview_vid: admin.firestore.FieldValue.delete(),
          event_preview_image: admin.firestore.FieldValue.delete(),
          preview_regenerated_at: admin.firestore.FieldValue.serverTimestamp(),
          // Add a small random value to ensure the document is seen as "changed"
          _preview_force_regen: Math.random()
        });
        batchUpdated++;
        totalUpdated++;
      });

      // Only commit if there are updates
      if (batchUpdated > 0) {
        await batch.commit();
        console.log(`   ✅ Batch complete: ${batchUpdated} events marked for regeneration`);
      } else {
        console.log(`   ⏭️  Batch skipped: No valid events to update`);
      }
      
      totalProcessed += currentBatchSize;
      console.log(`   📊 Progress: ${totalProcessed}/${snapshot.size} events processed\n`);
      
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
    console.log(`🔄 Events marked for regeneration: ${totalUpdated}`);
    if (skippedCount > 0) {
      console.log(`⏭️  Events skipped (no video): ${skippedCount}`);
    }
    console.log('');
    
    if (totalUpdated > 0) {
      console.log('📝 NEXT STEPS:');
      console.log('1. The processPreviewAssets function will automatically');
      console.log('   detect the missing preview fields and regenerate them.');
      console.log('2. New previews will show actual video content with:');
      console.log('   - 360x640 resolution (9:16 aspect ratio)');
      console.log('   - 10% dark tint for better logo visibility');
      console.log('   - Logo overlay centered on video');
      console.log('3. Monitor regeneration progress in Firebase Console:');
      console.log('   https://console.firebase.google.com/project/ville-9fe9d/functions/logs\n');
      
      const estimatedTime = Math.ceil((totalUpdated * 3) / 60); // ~3 seconds per video
      console.log(`⏱️  Estimated regeneration time: ~${estimatedTime} minutes`);
      console.log('   (Depends on Cloud Function concurrency and video sizes)\n');
    } else {
      console.log('ℹ️  No events needed regeneration.\n');
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

// Parse days parameter
let daysBack = null;
const daysIndex = args.findIndex(arg => arg === '--days' || arg === '-d');
if (daysIndex !== -1 && args[daysIndex + 1]) {
  daysBack = parseInt(args[daysIndex + 1]);
  if (isNaN(daysBack) || daysBack <= 0) {
    console.error('❌ Invalid days value. Must be a positive number.');
    process.exit(1);
  }
}

// Show help if requested
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node regenerateAllEventPreviews.js [options]

Options:
  test, --test         Run in test mode (process only 10 events)
  --days N, -d N       Regenerate previews for events from last N days
  --help, -h           Show this help message

Examples:
  node regenerateAllEventPreviews.js                    # Regenerate all previews
  node regenerateAllEventPreviews.js test               # Test with 10 events
  node regenerateAllEventPreviews.js --days 10          # Regenerate last 10 days
  node regenerateAllEventPreviews.js test --days 5      # Test mode for last 5 days

Notes:
  - New previews will show actual video content (not orange background)
  - Videos are scaled to cover 360x640 (9:16) with 10% dark tint
  - Logo overlay is centered on the video
`);
  process.exit(0);
}

// Run the regeneration
regenerateAllEventPreviews(testMode, daysBack);

