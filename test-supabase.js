// Test Supabase connection directly
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

console.log('Testing Supabase connection...\n');

// Try a simple query
supabase
  .from('kb_sources')
  .select('count')
  .limit(1)
  .then(({ data, error }) => {
    if (error) {
      console.error('❌ Supabase Error:');
      console.error('Message:', error.message);
      console.error('Code:', error.code);
      console.error('Details:', error.details);
      console.error('Hint:', error.hint);
      process.exit(1);
    } else {
      console.log('✓ Supabase connection successful!');
      console.log('Response:', data);
      process.exit(0);
    }
  })
  .catch(err => {
    console.error('❌ Unexpected error:', err);
    process.exit(1);
  });

