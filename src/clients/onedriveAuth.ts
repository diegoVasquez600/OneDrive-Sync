import { CryptoProvider, PublicClientApplication } from "@azure/msal-node";
import { request } from "obsidian";
import {
  SCOPES,
  OnedriveFullConfig,
  AccessCodeResponseSuccessfulType,
  AccessCodeResponseFailedType,
  REDIRECT_URI,
  OAUTH2_FORCE_EXPIRE_MILLISECONDS,
} from "./onedriveTypes";

/**
 * Genera el authUrl y el codeVerifier (PKCE)
 */
export async function getAuthUrlAndVerifier(clientID: string, authority: string) {
  const cryptoProvider = new CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

  const pkceCodes = {
    challengeMethod: "S256",
    verifier: verifier,
    challenge: challenge,
  };

  const authCodeUrlParams = {
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    codeChallenge: pkceCodes.challenge,
    codeChallengeMethod: pkceCodes.challengeMethod,
  };

  const pca = new PublicClientApplication({
    auth: {
      clientId: clientID,
      authority: authority,
    },
  });
  const authCodeUrl = await pca.getAuthCodeUrl(authCodeUrlParams);

  return {
    authUrl: authCodeUrl,
    verifier: verifier,
  };
}

/**
 * Intercambia el authorization code por tokens (accessToken, refreshToken...)
 * usando una petición HTTP directa con Obsidian request.
 */
export async function sendAuthReq(
  clientID: string,
  authority: string,
  authCode: string,
  verifier: string
) {
  try {
    const rspRaw = await request({
      url: `${authority}/oauth2/v2.0/token`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        tenant: "consumers",
        client_id: clientID,
        scope: SCOPES.join(" "),
        code: authCode,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });

    const rsp = JSON.parse(rspRaw);
    if (rsp.error) {
      return rsp as AccessCodeResponseFailedType;
    } else {
      return rsp as AccessCodeResponseSuccessfulType;
    }
  } catch (e) {
    console.error("Error en sendAuthReq:", e);
    throw e;
  }
}

/**
 * Refresca el accessToken usando el refreshToken.
 */
export async function sendRefreshTokenReq(
  clientID: string,
  authority: string,
  refreshToken: string
) {
  try {
    const rspRaw = await request({
      url: `${authority}/oauth2/v2.0/token`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        tenant: "consumers",
        client_id: clientID,
        scope: SCOPES.join(" "),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });

    const rsp = JSON.parse(rspRaw);
    if (rsp.error) {
      return rsp as AccessCodeResponseFailedType;
    } else {
      return rsp as AccessCodeResponseSuccessfulType;
    }
  } catch (e) {
    console.error("Error en sendRefreshTokenReq:", e);
    throw e;
  }
}

/**
 * Actualiza la configuración local (OnedriveFullConfig) con los tokens
 * obtenidos tras la autenticación exitosa.
 */
export async function setConfigBySuccessfulAuthInplace(
  config: OnedriveFullConfig,
  authRes: AccessCodeResponseSuccessfulType,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) {
  console.info("Actualizando la config local de OneDrive tokens");
  config.accessToken = authRes.access_token;
  config.accessTokenExpiresAtTime = Date.now() + authRes.expires_in * 1000 - 5 * 60 * 1000;
  config.accessTokenExpiresInSeconds = authRes.expires_in;
  config.refreshToken = authRes.refresh_token || "";

  // Forzar “expiración total” tras X días (para regenerar tokens).
  config.credentialsShouldBeDeletedAtTime = Date.now() + OAUTH2_FORCE_EXPIRE_MILLISECONDS;

  if (saveUpdatedConfigFunc) {
    await saveUpdatedConfigFunc();
  }
  console.info("Finalizada la actualización de tokens OneDrive");
}
