// Usage:
// 1) Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment
// 2) Run: npm run get-google-token
// 3) Open the URL, authorize, paste redirect URL, then copy REFRESH TOKEN into .env

import 'dotenv/config';
import { google } from 'googleapis';
import readline from 'readline';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// IMPORTANT:
// This must match EXACTLY one of the "Authorized redirect URIs"
// in your Google Cloud OAuth client settings.
// If your Supabase project URL is different, update this string accordingly
// or set GOOGLE_OAUTH_REDIRECT_URI in your environment.
const REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI ||
  'https://beeoeabecjhxrkozacce.supabase.co/auth/v1/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in environment');
  console.error(
    '   Example: $env:GOOGLE_CLIENT_ID="your-id"; $env:GOOGLE_CLIENT_SECRET="your-secret"; npm run get-google-token'
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const scopes = ['https://www.googleapis.com/auth/calendar'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
  prompt: 'consent', // Force consent screen to get refresh token
});

console.log('\n========================================');
console.log('Google OAuth2 Authorization');
console.log('========================================\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl + '\n');
console.log('After authorizing, you will be redirected to something like:');
console.log(REDIRECT_URI + '?code=...\n');
console.log('Paste the FULL redirect URL here:\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Redirect URL: ', async (redirectUrl) => {
  rl.close();

  try {
    // Extract code from redirect URL
    const url = new URL(redirectUrl.trim());
    const code = url.searchParams.get('code');

    if (!code) {
      console.error('\n❌ Error: No code parameter found in redirect URL');
      console.error('   Make sure you paste the complete URL including ?code=...');
      process.exit(1);
    }

    console.log('\n🔐 Exchanging code for tokens...\n');

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.error('\n❌ Error: No refresh_token received');
      console.error('   Make sure you authorized the app and that prompt=consent is used');
      console.error('   Access token:', tokens.access_token ? '✓ Received' : '✗ Missing');
      process.exit(1);
    }

    console.log('========================================');
    console.log('✅ SUCCESS! Copy this refresh token:');
    console.log('========================================\n');
    console.log(tokens.refresh_token);
    console.log('\n========================================');
    console.log('Add this to your .env file:');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('========================================\n');

    if (tokens.access_token) {
      console.log('ℹ️  Access token also received (valid for 1 hour)');
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error exchanging code for tokens:');
    console.error('   Message:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Body:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
});













