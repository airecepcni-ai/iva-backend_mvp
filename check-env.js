// Quick script to check .env file format
import 'dotenv/config';

console.log('\n=== ENVIRONMENT VARIABLES CHECK ===\n');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE;

console.log('SUPABASE_URL:');
if (url) {
  console.log(`  ✓ Present: ${url}`);
  console.log(`  Length: ${url.length} characters`);
} else {
  console.log('  ❌ MISSING!');
}

console.log('\nSUPABASE_SERVICE_ROLE:');
if (key) {
  console.log(`  ✓ Present`);
  console.log(`  Length: ${key.length} characters`);
  console.log(`  Starts with: ${key.slice(0, 20)}...`);
  console.log(`  Ends with: ...${key.slice(-20)}`);
  
  // Check if it looks like a JWT
  if (key.startsWith('eyJ')) {
    console.log('  ✓ Looks like a valid JWT token');
  } else {
    console.log('  ⚠️  Warning: Does not start with "eyJ" (typical JWT format)');
  }
  
  // Check for common issues
  if (key.includes(' ')) {
    console.log('  ⚠️  WARNING: Key contains spaces!');
  }
  if (key.includes('\n') || key.includes('\r')) {
    console.log('  ⚠️  WARNING: Key contains newlines!');
  }
} else {
  console.log('  ❌ MISSING!');
}

console.log('\n=== RECOMMENDATIONS ===');
if (!url || !key) {
  console.log('❌ Missing environment variables. Check your .env file.');
} else if (key.length < 100) {
  console.log('⚠️  Service Role Key seems too short. Make sure you copied the FULL key.');
} else {
  console.log('✓ Environment variables look OK!');
  console.log('If you still get "Invalid API key" error:');
  console.log('1. Make sure you\'re using the SERVICE ROLE key (not Anon key)');
  console.log('2. Copy the key again from Supabase Dashboard → Settings → API');
  console.log('3. Make sure there are no spaces around = in .env file');
}

console.log('\n');

