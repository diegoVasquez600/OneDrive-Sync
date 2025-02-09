/**
 * onedriveClient.ts
 * Encargado de la autenticación con OneDrive (PKCE) y las operaciones de subida/descarga/listado.
 */

import { request } from "obsidian";
import type { DriveItem } from "@microsoft/microsoft-graph-types";

// Tipos básicos
export interface OneDriveConfig {
  clientId: string;
  authority: string;            // p.ej. "https://login.microsoftonline.com/consumers"
  redirectUri: string;          // "obsidian://onedrive-auth"
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;

  /** Carpeta remota donde sincronizar (dentro de /drive/root:/...). */
  remoteBaseFolder: string;
}

// Respuestas de OAuth
export interface AuthSuccessResponse {
  token_type: string;
  expires_in: number;
  ext_expires_in?: number;
  scope: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export interface AuthErrorResponse {
  error: string;
  error_description: string;
  error_codes?: number[];
}

// Scopes requeridos
const SCOPES = ["User.Read", "Files.ReadWrite", "offline_access"];
// Tamaño de chunk para archivos grandes (ej. 5MB)
const CHUNK_SIZE = 5 * 1024 * 1024;

/************************************************
 * PKCE: Obtener codeVerifier y codeChallenge
 ***********************************************/

async function generatePkceCodes(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const codeVerifier = base64URLEncode(array);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64URLEncode(new Uint8Array(digest));

  return { codeVerifier, codeChallenge };
}

function base64URLEncode(buffer: Uint8Array): string {
  let str = "";
  for (let i = 0; i < buffer.length; i++) {
    str += String.fromCharCode(buffer[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/************************************************
 * URL de autorización y canje de código
 ***********************************************/

export async function getAuthUrlAndVerifier(config: OneDriveConfig): Promise<{ authUrl: string; codeVerifier: string }> {
  const { codeVerifier, codeChallenge } = await generatePkceCodes();

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    response_mode: "query",
    scope: SCOPES.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${config.authority}/oauth2/v2.0/authorize?${params.toString()}`;
  return { authUrl, codeVerifier };
}

export async function exchangeAuthCodeForTokens(
  config: OneDriveConfig,
  code: string,
  codeVerifier: string
): Promise<AuthSuccessResponse | AuthErrorResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
    scope: SCOPES.join(" "),
  });

  const respText = await request({
    url: `${config.authority}/oauth2/v2.0/token`,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: body.toString(),
  });

  return JSON.parse(respText);
}

/************************************************
 * Refresco de token
 ***********************************************/

export async function refreshAccessToken(
  config: OneDriveConfig
): Promise<AuthSuccessResponse | AuthErrorResponse> {
  if (!config.refreshToken) {
    throw new Error("No refreshToken. El usuario debe autenticarse primero.");
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
    scope: SCOPES.join(" "),
  });

  const respText = await request({
    url: `${config.authority}/oauth2/v2.0/token`,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: body.toString(),
  });

  return JSON.parse(respText);
}

/************************************************
 * Clase principal de OneDrive
 ***********************************************/

export class OneDriveClient {
  config: OneDriveConfig;

  constructor(config: OneDriveConfig) {
    this.config = config;
  }

  /**
   * Retorna un token válido, refrescando si está caducado.
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.config.accessToken && this.config.accessTokenExpiresAt > now) {
      return this.config.accessToken;
    }
    const result = await refreshAccessToken(this.config);
    if ("error" in result) {
      throw new Error(`Refresh token error: ${result.error_description || result.error}`);
    }

    this.config.accessToken = result.access_token;
    this.config.refreshToken = result.refresh_token ?? "";
    const expiresInMs = (result.expires_in || 3600) * 1000;
    this.config.accessTokenExpiresAt = Date.now() + expiresInMs - 120000;

    return this.config.accessToken;
  }

  /**
   * Lista archivos en la carpeta remota (this.config.remoteBaseFolder).
   */
  async listRemoteFolder(): Promise<DriveItem[]> {
    const token = await this.getAccessToken();

    let path = "/drive/root/children";
    if (this.config.remoteBaseFolder) {
      // /drive/root:/Carpeta:/children
      path = `/drive/root:/${this.config.remoteBaseFolder}:/children`;
    }

    const url = `https://graph.microsoft.com/v1.0${path}`;
    const respText = await request({
      url,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = JSON.parse(respText) as { value?: DriveItem[] };
    return data.value ?? [];
  }

  /**
   * Sube un archivo (arrayBuffer) de tamaño arbitrario.
   */
  async uploadFile(relativePath: string, content: ArrayBuffer): Promise<DriveItem> {
    const token = await this.getAccessToken();
    // Creamos la ruta: /drive/root:/remoteBaseFolder/relativePath:/createUploadSession
    let fullPath = `/drive/root:`;
    if (this.config.remoteBaseFolder) {
      fullPath += `/${this.config.remoteBaseFolder}`;
    }
    fullPath += `/${relativePath}:/createUploadSession`;

    const createSessionUrl = `https://graph.microsoft.com/v1.0${encodeURI(fullPath)}`;
    const sessionBody = {
      item: {
        "@microsoft.graph.conflictBehavior": "replace",
      },
    };
    const sessionResp = await fetch(createSessionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sessionBody),
    });
    if (!sessionResp.ok) {
      throw new Error(`Error al crear UploadSession: ${sessionResp.status} - ${await sessionResp.text()}`);
    }
    const sessionData = await sessionResp.json();
    const uploadUrl = sessionData.uploadUrl as string;
    if (!uploadUrl) {
      throw new Error("No se obtuvo uploadUrl de la sesión.");
    }

    const uint8 = new Uint8Array(content);
    let offset = 0;
    const fileSize = content.byteLength;
    let finalItem: DriveItem | null = null;

    while (offset < fileSize) {
      const chunkEnd = Math.min(offset + CHUNK_SIZE, fileSize);
      const chunk = uint8.subarray(offset, chunkEnd);

      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${offset}-${chunkEnd - 1}/${fileSize}`,
      };

      const resp = await fetch(uploadUrl, {
        method: "PUT",
        headers,
        body: chunk,
      });
      if (!resp.ok) {
        throw new Error(`Error subiendo chunk. HTTP ${resp.status}`);
      }
      const rjson = await resp.json();
      if (rjson.id) {
        finalItem = rjson as DriveItem; // Subida completada
      }
      offset = chunkEnd;
    }

    if (!finalItem) {
      throw new Error("No se obtuvo DriveItem final tras la subida.");
    }
    return finalItem;
  }

  /**
   * Elimina un archivo/carpeta en la carpeta remota base.
   */
  async deleteItem(relativePath: string): Promise<void> {
    const token = await this.getAccessToken();
    let fullPath = `/drive/root:`;
    if (this.config.remoteBaseFolder) {
      fullPath += `/${this.config.remoteBaseFolder}`;
    }
    fullPath += `/${relativePath}`;

    const deleteUrl = `https://graph.microsoft.com/v1.0${encodeURI(fullPath)}`;
    const res = await fetch(deleteUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Error eliminando item: HTTP ${res.status}`);
    }
  }

  /**
   * Ejemplo para leer un archivo (descargar).
   */
  async readFile(relativePath: string): Promise<ArrayBuffer> {
    const token = await this.getAccessToken();
    let fullPath = `/drive/root:`;
    if (this.config.remoteBaseFolder) {
      fullPath += `/${this.config.remoteBaseFolder}`;
    }
    fullPath += `/${relativePath}:/`;

    const metaUrl = `https://graph.microsoft.com/v1.0${encodeURI(fullPath)}?select=@microsoft.graph.downloadUrl`;

    const metaText = await request({
      url: metaUrl,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const meta = JSON.parse(metaText) as DriveItem & { [key: string]: any };
    const downloadUrl = meta["@microsoft.graph.downloadUrl"] as string | undefined;
    if (!downloadUrl) {
      throw new Error("No se encontró la propiedad @microsoft.graph.downloadUrl.");
    }

    const fileBuffer = await fetch(downloadUrl).then((r) => r.arrayBuffer());
    return fileBuffer;
  }
}
