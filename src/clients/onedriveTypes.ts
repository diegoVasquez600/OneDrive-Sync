export const SCOPES = ["User.Read", "Files.ReadWrite", "offline_access"];

export interface AccessCodeResponseSuccessfulType {
  token_type: "Bearer" | "bearer";
  expires_in: number;
  ext_expires_in?: number;
  scope: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}
export interface AccessCodeResponseFailedType {
  error: string;
  error_description: string;
  error_codes: number[];
  timestamp: string;
  trace_id: string;
  correlation_id: string;
}

export interface OnedriveFullConfig {
  accessToken: string;
  clientID: string;
  authority: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  accessTokenExpiresAtTime: number;
  deltaLink: string;
  username: string;
  credentialsShouldBeDeletedAtTime: number;
  emptyFile: "skip" | "error";
  kind: "onedrivefull";
  remoteBaseDir?: string;
}

// Ajusta a tus necesidades
export const REDIRECT_URI = "obsidian://my-callback";
export const OAUTH2_FORCE_EXPIRE_MILLISECONDS = 1000 * 60 * 60 * 24 * 80; // 80 días, ejemplo
