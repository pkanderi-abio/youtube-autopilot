// One-time local helper: run this once PER CHANNEL to mint a YouTube
// OAuth refresh token, using the channel's own Google/YouTube login.
// Usage: node scripts/get-refresh-token.js
//
// Prereqs: a Google Cloud project with the YouTube Data API v3 enabled,
// and an OAuth 2.0 Client ID of type "Desktop app". Put its client id/
// secret in .env as YT_CLIENT_ID / YT_CLIENT_SECRET (see README for the
// full walkthrough).
import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import open from 'open';

const REDIRECT_URI = 'http://localhost:8765/oauth2callback';

async function main() {
  const oauth2 = new google.auth.OAuth2(
    process.env.YT_CLIENT_ID,
    process.env.YT_CLIENT_SECRET,
    REDIRECT_URI
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token every time
    scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube']
  });

  console.log('\nOpen this URL and sign in with the Google account that owns the channel');
  console.log('you want a token for (a browser tab will also open automatically):\n');
  console.log(authUrl + '\n');
  open(authUrl);

  const code = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      if (code) {
        res.end('Success! You can close this tab and return to the terminal.');
        server.close();
        resolve(code);
      }
    });
    server.listen(8765);
  });

  const { tokens } = await oauth2.getToken(code);
  console.log('\nSave this as a GitHub repo secret for this channel (e.g. YT_REFRESH_TOKEN_CHANNEL1):\n');
  console.log(tokens.refresh_token);
  console.log('\n(YT_CLIENT_ID and YT_CLIENT_SECRET are shared across all channels - store those as secrets too.)');
}

main();
