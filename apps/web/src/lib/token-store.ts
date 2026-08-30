const ACCESS_KEY = "crop.accessToken";
const REFRESH_KEY = "crop.refreshToken";

/**
 * localStorage, not an httpOnly cookie: this is a deliberate MVP tradeoff (simpler to wire
 * for a Socket.io + raw-WebSocket-ticket architecture that already needs the token in JS to
 * attach to `socket.handshake.auth`), not an oversight. A production hardening pass would
 * move the refresh token to an httpOnly cookie and keep only the short-lived access token
 * in memory.
 */
export const tokenStore = {
  getAccessToken: (): string | null => localStorage.getItem(ACCESS_KEY),
  getRefreshToken: (): string | null => localStorage.getItem(REFRESH_KEY),
  setTokens: (accessToken: string, refreshToken: string): void => {
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear: (): void => {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};
