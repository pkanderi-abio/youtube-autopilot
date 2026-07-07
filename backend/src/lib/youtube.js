// Builds an authenticated googleapis client for a channel, using a
// long-lived refresh token (see scripts/get-refresh-token.js).
import { google } from 'googleapis';

export function getYoutubeClient(channel) {
  const refreshToken = process.env[channel.refreshTokenEnv];
  if (!refreshToken) {
    throw new Error(`Missing env var ${channel.refreshTokenEnv} for channel ${channel.id}`);
  }
  const oauth2 = new google.auth.OAuth2(
    process.env.YT_CLIENT_ID,
    process.env.YT_CLIENT_SECRET,
    'http://localhost:8765/oauth2callback'
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.youtube({ version: 'v3', auth: oauth2 });
}
