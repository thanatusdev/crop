export const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const WS_URL: string = API_URL.replace(/^http/, "ws");
